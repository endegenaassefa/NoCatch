"""Build-only Windows x64 CPython/Whisper payload. No global installation.

Run with Windows CPython 3.13.2 and pip 25.3 / setuptools 78.1.0.
Inputs are a checked-in hash lock and downloaded upstream artifacts.
No model, pip, activation script, or absolute-path console launcher is shipped.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import urllib.request
import zipfile

def add_vc_runtime(lock, out, cache):
    item = lock['vcRuntime']
    archive = fetch(item, cache)
    work = cache / 'vc-runtime-extracted'
    work.mkdir(exist_ok=True)
    expand = str(Path(os.environ['SystemRoot']) / 'System32/expand.exe')
    data = archive.read_bytes()
    for label in ('ux', 'payload'):
        offset, size = item[label + 'CabOffset'], item[label + 'CabSize']
        cab = work / (label + '.cab')
        cab.write_bytes(data[offset:offset + size])
        dest = work / label
        dest.mkdir(exist_ok=True)
        subprocess.run([expand, '-F:*', str(cab), str(dest)], check=True, stdout=subprocess.DEVNULL)
    dll_dir = work / 'dlls'
    dll_dir.mkdir(exist_ok=True)
    subprocess.run([expand, '-F:*', str(work / 'payload' / item['runtimeCab']), str(dll_dir)],
                   check=True, stdout=subprocess.DEVNULL)
    for dll in dll_dir.glob('*.dll_amd64'):
        shutil.copyfile(dll, out / dll.name.removesuffix('_amd64'))
    notices = out / 'licenses'
    notices.mkdir(exist_ok=True)
    shutil.copyfile(work / 'ux' / item['licenseMember'], notices / 'Microsoft-VC-Runtime-license.rtf')

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def fetch(item, cache):
    target = cache / item['filename']
    if not target.exists():
        print('Download', item['name'], item['url'], flush=True)
        partial = target.with_suffix(target.suffix + '.partial')
        urllib.request.urlretrieve(item['url'], partial)
        if sha(partial) != item['sha256']:
            raise RuntimeError('Download digest mismatch: ' + item['filename'])
        partial.replace(target)
    if sha(target) != item['sha256']:
        raise RuntimeError('Cached digest mismatch: ' + item['filename'])
    return target

def extract(archive, target):
    with zipfile.ZipFile(archive) as z:
        members = []
        for info in z.infolist():
            path = PurePosixPath(info.filename)
            if path.is_absolute() or '..' in path.parts or ':' in info.filename:
                raise RuntimeError('Unsafe archive member: ' + info.filename)
            if ((info.external_attr >> 16) & 0o170000) == 0o120000:
                raise RuntimeError('Archive symlink: ' + info.filename)
            if any(part.endswith('.data') for part in path.parts):
                if len(path.parts) >= 2 and path.parts[1] == 'scripts':
                    # Application invokes the worker/module; console scripts would
                    # carry build-host paths and are intentionally not installed.
                    continue
                if len(path.parts) < 2 or path.parts[1] != 'data':
                    raise RuntimeError('Unhandled wheel data directory: ' + info.filename)
                # Preserve non-executable documentation data with the wheel.
            members.append(info)
        z.extractall(target, members)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lock', type=Path, default=Path(__file__).resolve().parent.parent / 'resources/speech-runtime/payload.lock.json')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parent.parent / '.depthengine/speech-runtime/windows-x64')
    parser.add_argument('--cache', type=Path, default=Path(__file__).resolve().parent.parent / '.depthengine/speech-runtime-downloads')
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text(encoding='utf-8'))
    if sys.platform != 'win32' or sys.version_info[:3] != (3, 13, 2):
        raise RuntimeError('Builder requires Windows CPython 3.13.2 x64')
    import struct
    if struct.calcsize('P') != 8:
        raise RuntimeError('Builder requires x64 Python')
    for name, version in lock['buildTools'].items():
        if importlib.metadata.version(name) != version:
            raise RuntimeError('Builder requires ' + name + '==' + version)
    out, cache = args.output.resolve(), args.cache.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    if out.exists():
        raise RuntimeError('Output must be absent; refusing to overwrite ' + str(out))
    free = shutil.disk_usage(out.parent).free
    required = 3 * 1024**3
    if free < required:
        raise RuntimeError(f'Build requires {required} free bytes; available {free}')
    sources = [(item, fetch(item, cache)) for item in [lock['python']] + lock['packages']]
    out.mkdir()
    extract(sources[0][1], out)
    site = out / 'Lib/site-packages'
    site.mkdir(parents=True)
    built = cache / 'built-wheels'
    built.mkdir(exist_ok=True)
    artifacts = []
    for item, path in sources[1:]:
        if not path.name.endswith('.whl'):
            # Build pinned upstream sdist using the explicitly recorded builder tools.
            env = dict(os.environ, SOURCE_DATE_EPOCH='1750809600')
            subprocess.run([sys.executable, '-m', 'pip', '--no-cache-dir', 'wheel', '--no-deps',
                            '--no-build-isolation', '--no-index', '--wheel-dir', str(built), str(path)],
                           check=True, env=env)
            matches = list(built.glob('openai_whisper-20250625-*.whl'))
            if len(matches) != 1:
                raise RuntimeError('Expected one built Whisper wheel')
            path = matches[0]
            if sha(path) != item['builtWheel']['sha256']:
                raise RuntimeError('Built wheel digest mismatch: ' + path.name)
        print('Extract', path.name, flush=True)
        extract(path, site)
        artifacts.append(dict(name=item['name'], version=item['version'], filename=path.name, sha256=sha(path)))
    add_vc_runtime(lock, out, cache)
    (out / 'python313._pth').write_text('python313.zip\n.\nLib/site-packages\n', encoding='ascii')
    notices = out / 'licenses'
    notices.mkdir(exist_ok=True)
    shutil.copy2(out / 'LICENSE.txt', notices / 'CPython-LICENSE.txt')
    license_files = []
    for p in sorted(site.rglob('*')):
        if p.is_file() and any(word in p.name.lower() for word in ('license', 'copying', 'notice', 'copyright')):
            license_files.append(p.relative_to(out).as_posix())
    license_files.append('licenses/Microsoft-VC-Runtime-license.rtf')
    inventory = dict(components=[lock['python'], lock['vcRuntime']] + lock['packages'], retainedLicenseFiles=license_files,
                     note='Upstream wheel license texts/notices retained verbatim. Inventory is engineering evidence, not legal clearance. Native bundled third-party terms require distribution review.')
    (notices / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')
    (out / 'build-artifacts.json').write_text(json.dumps(artifacts, indent=2) + '\n', encoding='utf-8')
    files = {p.relative_to(out).as_posix(): dict(sha256=sha(p), size=p.stat().st_size)
             for p in sorted(out.rglob('*')) if p.is_file()}
    manifest = dict(schemaVersion=1, id=lock['id'], platform='win32', arch='x64', python='python.exe',
                    files=files, components=[lock['python'], lock['vcRuntime']] + lock['packages'])
    expected_path = Path(__file__).resolve().parent.parent / 'resources/speech-runtime/payload.manifest.json'
    expected_bytes = expected_path.read_bytes()
    if manifest != json.loads(expected_bytes):
        raise RuntimeError('Rebuilt payload differs from the reviewed release inventory. Preserve output for investigation; do not package it.')
    # Preserve the reviewed serialization as well as every component/file hash.
    (out / 'manifest.json').write_bytes(expected_bytes)
    print(json.dumps(dict(output=str(out), files=len(files), bytes=sum(i['size'] for i in files.values()))), flush=True)

if __name__ == '__main__':
    main()
