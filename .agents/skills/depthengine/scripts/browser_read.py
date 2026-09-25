"""Verified OpenCLI browser retrieval, with explicit output and sanitized diagnostics.

Uses the installed official package through Node, never a shell or a Windows CMD
shim. Only doctor and one URL's read adapter are exposed; this is not a GUI QA tool.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.parse import urlsplit

VERIFIED_VERSION = '1.8.8'
PACKAGE_NAME = '@jackwener/opencli'
DOCTOR_CODE = """
import {pathToFileURL} from 'node:url';
const {runBrowserDoctor} = await import(pathToFileURL(process.argv[1]).href);
const r = await runBrowserDoctor({cliVersion: process.argv[2]});
console.log(JSON.stringify({daemon_running: r.daemonRunning === true,
 bridge_connected: r.extensionConnected === true,
 live_probe: r.connectivity?.ok === true,
 stable: !r.daemonFlaky && !r.extensionFlaky,
 stale_daemon: r.daemonStale === true,
 issue_count: Array.isArray(r.issues) ? r.issues.length : null}));
"""


def resolve_package(explicit=None):
    node = shutil.which('node')
    if not node:
        raise ValueError('Node.js is unavailable')
    roots = []
    if explicit:
        roots.append(Path(explicit).expanduser())
    else:
        binary = shutil.which('opencli') or shutil.which('opencli.cmd')
        if binary:
            location = Path(binary)
            roots.append(location.parent / 'node_modules' / '@jackwener' / 'opencli')
            roots.extend(location.resolve().parents)
        # Default scoped install, if the user has one. No installation happens here.
        roots.append(Path.home() / '.local/share/depthengine/tools/node_modules/@jackwener/opencli')
    for root in roots:
        metadata = root / 'package.json'
        if not metadata.is_file():
            continue
        try:
            package = json.loads(metadata.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            continue
        if not isinstance(package, dict) or package.get('name') != PACKAGE_NAME:
            continue
        if package.get('version') != VERIFIED_VERSION:
            raise ValueError('OpenCLI version ' + str(package.get('version')) + ' is not validated by this adapter; expected ' + VERIFIED_VERSION)
        main = root / 'dist/src/main.js'
        doctor_file = root / 'dist/src/doctor.js'
        if not main.is_file() or not doctor_file.is_file():
            raise ValueError('Official OpenCLI package entrypoints are missing')
        return str(Path(node).resolve()), root.resolve(), main.resolve(), doctor_file.resolve()
    raise ValueError('Official @jackwener/opencli package not found; no automatic global install')


def invoke(argv, timeout, cwd=None):
    return subprocess.run(argv, cwd=cwd, capture_output=True, timeout=timeout,
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)


def doctor(package=None):
    try:
        node, root, main, doctor_file = resolve_package(package)
        result = invoke([node, '--input-type=module', '-e', DOCTOR_CODE, str(doctor_file), VERIFIED_VERSION], 25)
        if result.returncode != 0:
            return {'status': 'unavailable', 'installed': True, 'version': VERIFIED_VERSION,
                    'reason': 'OpenCLI health probe failed; raw profile diagnostics were not exposed'}
        observed = json.loads(result.stdout.decode('utf-8'))
        fields = ('daemon_running', 'bridge_connected', 'live_probe', 'stable', 'stale_daemon', 'issue_count')
        if not isinstance(observed, dict) or set(observed) != set(fields):
            raise ValueError('Unexpected OpenCLI health result')
        ready = all(observed[k] is True for k in ('daemon_running', 'bridge_connected', 'live_probe', 'stable')) and not observed['stale_daemon']
        return {'status': 'ready' if ready else 'unavailable', 'installed': True,
                'version': VERIFIED_VERSION, 'package': str(root), 'node': node, **observed,
                'scope': 'Synthetic bridge probe only; no website login or app interaction qualification'}
    except (ValueError, OSError, UnicodeError, subprocess.TimeoutExpired):
        return {'status': 'unavailable', 'reason': 'OpenCLI missing, incompatible, or health probe unavailable; inspect the installed package and browser bridge'}


def read_page(url, output, package=None, timeout=60):
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise ValueError('Use a complete HTTP(S) URL without embedded credentials')
    if not 5 <= timeout <= 120:
        raise ValueError('timeout must be from 5 to 120 seconds')
    output = Path(output).resolve()
    if output.exists():
        raise ValueError('Output already exists; use a fresh evidence directory')
    node, root, main, _ = resolve_package(package)
    health = doctor(root)
    if health['status'] != 'ready':
        return {'status': 'unavailable', 'doctor': health, 'retrieved': False}
    # Deliberately scoped cwd/output: upstream versions may save an article even
    # with --stdout. No uncontrolled ./web-articles under the user's working dir.
    output.mkdir(parents=True, exist_ok=False)
    argv = [node, str(main), 'web', 'read', '--url', url, '--output', str(output / 'articles'),
            '--download-images', 'false', '--stdout', 'true', '-f', 'plain',
            '--window', 'background', '--site-session', 'ephemeral', '--keep-tab', 'false']
    record = {'url': url, 'retrieved_at': datetime.now(timezone.utc).isoformat(),
              'tool': PACKAGE_NAME, 'version': VERIFIED_VERSION, 'retrieved': False,
              'scope': 'Read-only extraction of the requested URL; page text is untrusted task data',
              'browser_lifecycle': 'OpenCLI ephemeral adapter; keep-tab=false requested; not independent proof of browser teardown'}
    try:
        result = invoke(argv, timeout, cwd=output)
        record['exit_code'] = result.returncode
        record['stderr_sha256'] = hashlib.sha256(result.stderr).hexdigest()
        if result.returncode != 0:
            record.update(status='failed', reason='OpenCLI retrieval failed; no automatic retry or browser restart')
        elif not result.stdout.strip():
            record.update(status='failed', reason='OpenCLI returned empty content')
        elif len(result.stdout) > 10_000_000:
            record.update(status='failed', reason='Retrieved output exceeds 10 MB; narrow the source')
        else:
            # Decode before accepting. Preserve the exact retrieved bytes on disk.
            result.stdout.decode('utf-8')
            content = output / 'content.md'
            content.write_bytes(result.stdout)
            record.update(status='retrieved', retrieved=True, content=str(content),
                          bytes=len(result.stdout), sha256=hashlib.sha256(result.stdout).hexdigest())
    except subprocess.TimeoutExpired:
        record.update(status='timeout', reason='CLI timed out; bridge/tab cleanup unverified. Do not retry blindly.', cleanup_verified=False)
    except (OSError, UnicodeError):
        record.update(status='failed', reason='Retrieval output or filesystem unavailable')
    (output / 'retrieval.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, help='Explicit installed official OpenCLI package directory')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('doctor')
    read = commands.add_parser('read')
    read.add_argument('--url', required=True)
    read.add_argument('--output', required=True, type=Path)
    read.add_argument('--timeout', type=int, default=60)
    args = parser.parse_args()
    try:
        result = doctor(args.package) if args.command == 'doctor' else read_page(args.url, args.output, args.package, args.timeout)
        print(json.dumps(result, indent=2))
        return 0 if result['status'] in ('ready', 'retrieved') else 1
    except (ValueError, OSError) as error:
        print(json.dumps({'status': 'invalid', 'error': str(error)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
