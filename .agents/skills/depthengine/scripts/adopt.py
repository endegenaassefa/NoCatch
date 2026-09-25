"""Read-only legacy-project inventory and opt-in source checkpoint.

Does not attach, schedule, pause, resume, regrade, or repair existing agent work.
Reports require a fresh output directory outside the source tree.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import zipfile

EXCLUDED = {'.git', '.depthengine', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', 'dist'}


def source_files(root):
    def fail(error):
        raise error
    total = count = 0
    for directory, folders, names in os.walk(root, onerror=fail):
        folders[:] = sorted(n for n in folders if n not in EXCLUDED)
        for name in folders:
            if (Path(directory)/name).is_symlink():
                raise ValueError('Adoption requires explicit handling of source symlinks')
        for name in sorted(names):
            normalized = name.lower()
            if (normalized == '.env' or normalized.startswith('.env.') and normalized not in ('.env.example', '.env.sample')
                    or normalized.endswith(('.pem', '.key', '.p12', '.pfx'))):
                continue
            path = Path(directory)/name
            if path.is_symlink() or not path.is_file():
                raise ValueError('Adoption only inventories regular source files')
            count += 1
            total += path.stat().st_size
            if count > 20000 or total > 256*1024*1024:
                raise ValueError('Adoption source exceeds 20000 files/256MiB; narrow the project')
            yield path


def manifest(project):
    result = {}
    for path in source_files(project):
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024*1024), b''):
                digest.update(chunk)
        result[path.relative_to(project).as_posix()] = digest.hexdigest()
    return result


def runtime_state(project):
    path = project/'.depthengine/state.sqlite3'
    if not path.exists():
        return []
    # Even SQLite mode=ro may create shared-memory sidecars for WAL databases.
    # Query a stable byte copy so SQLite never opens the original project files.
    def snapshot():
        content = {}
        for file in (path, path.with_name(path.name+'-wal')):
            if file.exists():
                if file.is_symlink() or file.stat().st_size > 256*1024*1024:
                    raise ValueError('Runtime snapshot requires regular files under 256MiB')
                content[file.name] = file.read_bytes()
        return content
    first = snapshot()
    if first != snapshot():
        raise ValueError('Runtime changed during inspection; retry at handoff')
    snapshot_hash = hashlib.sha256(b''.join(name.encode()+b'\0'+hashlib.sha256(data).digest()
                                           for name, data in sorted(first.items()))).hexdigest()
    with tempfile.TemporaryDirectory(prefix='depth-adoption-') as directory:
        copy = Path(directory)/path.name
        for name, data in first.items():
            (Path(directory)/name).write_bytes(data)
        db = sqlite3.connect(copy.as_uri()+'?mode=ro', uri=True, timeout=5)
        try:
            result = []
            for (body,) in db.execute('SELECT body FROM runs ORDER BY id'):
                run = json.loads(body)
                item = {key:run.get(key) for key in ('id','status','active','updated_at','remaining_seconds','remaining_steps')}
                item['body_sha256'] = hashlib.sha256(body.encode()).hexdigest()
                item['database_sha256'] = snapshot_hash
                result.append(item)
        finally:
            db.close()
    if first != snapshot():
        raise ValueError('Runtime changed during inspection; retry at handoff')
    return result


def inspect_project(project):
    root = Path(project).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('Project must be a directory')
    before = manifest(root)
    runs = runtime_state(root)
    try:
        env = {**os.environ, 'GIT_OPTIONAL_LOCKS':'0'}
        status = subprocess.run(['git','-C',str(root),'status','--porcelain=v1','--untracked-files=normal'],
                                capture_output=True,text=True,timeout=15,env=env)
        git = {'available':status.returncode == 0, 'status':status.stdout if status.returncode == 0 else ''}
    except (OSError, subprocess.TimeoutExpired):
        git = {'available':False, 'status':''}
    after = manifest(root)
    later_runs = runtime_state(root)
    return {'project':str(root), 'checked_at':datetime.now(timezone.utc).isoformat(),
            'stable':before == after and runs == later_runs, 'files':after, 'runs':later_runs,
            'active_runs':[r['id'] for r in later_runs if r['status']=='running' or r['active'] is not None],
            'git':git, 'scope':'Source-only baseline; excludes git metadata, generated state, dependencies, dist, caches and common secret-file names. No correctness or release claim. Active conversational editors cannot be inferred from runtime state.'}


def write_report(project, output, checkpoint=False):
    root = Path(project).resolve(strict=True)
    out = Path(output).resolve()
    if out == root or root in out.parents:
        raise ValueError('Adoption output must be outside the project')
    if out.exists():
        raise ValueError('Adoption output must be a fresh directory')
    report = inspect_project(root)
    if checkpoint and (report['active_runs'] or not report['stable']):
        raise ValueError('Cannot checkpoint an active or changing project; wait for an explicit handoff')
    out.mkdir(parents=True)
    if checkpoint:
        from quality import preflight
        temp = out/'source.zip.partial'
        try:
            total = sum((root/name).stat().st_size for name in report['files'])
            preflight(out, total + 256*1024*1024)
            with zipfile.ZipFile(temp,'w',zipfile.ZIP_DEFLATED) as archive:
                for name, expected in report['files'].items():
                    data = (root/name).read_bytes()
                    if hashlib.sha256(data).hexdigest() != expected:
                        raise ValueError('Source changed during checkpoint')
                    archive.writestr(name,data)
            if manifest(root) != report['files'] or runtime_state(root) != report['runs']:
                raise ValueError('Source/runtime changed during checkpoint')
            temp.replace(out/'source.zip')
            report['checkpoint'] = str(out/'source.zip')
        finally:
            temp.unlink(missing_ok=True)
            # Only remove our newly created empty directory, never recurse into
            # an existing output or erase evidence added by another process.
            if not (out/'source.zip').exists():
                try:
                    out.rmdir()
                except OSError:
                    pass
    try:
        (out/'baseline.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    except OSError:
        # Only artifacts created by this invocation in its exclusive fresh output.
        (out/'baseline.json').unlink(missing_ok=True)
        if checkpoint:
            (out/'source.zip').unlink(missing_ok=True)
        try:
            out.rmdir()
        except OSError:
            pass
        raise
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--checkpoint',action='store_true')
    args=parser.parse_args()
    report=write_report(args.project,args.output,args.checkpoint)
    print(json.dumps({'project':report['project'],'stable':report['stable'],'active_runs':report['active_runs'],
                      'files':len(report['files']),'report':str(args.output/'baseline.json'),'checkpoint':report.get('checkpoint')},indent=2))


if __name__=='__main__':
    main()
