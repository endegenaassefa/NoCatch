"""Independent acceptance ownership and cooperative, fail-closed change guards.

These guards detect persistent changes; they are not an OS sandbox or proof that
two actor labels belong to independent models. Host permissions remain required.
"""
from __future__ import annotations

import fnmatch
import hashlib
import json
import os
from pathlib import Path
import shutil

VERSION = 2
IGNORED = {'.git', '.depthengine', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache'}
TEST_DIRS = {'test', 'tests', '__tests__', '__mocks__', 'fixtures', 'e2e', 'acceptance', 'cypress'}
TEST_NAMES = ('test_*.py', '*_test.py', 'test-*.js', 'test-*.cjs', 'test-*.mjs',
              '*.test.*', '*.spec.*', '*_test.go', 'test_*.rs', '*Test.java')
CONFIG_NAMES = ('pytest.ini', 'conftest.py', 'tox.ini', '.coveragerc', 'pyproject.toml', 'jest.config.*',
                'vitest.config.*', 'playwright.config.*', 'cypress.config.*', 'karma.conf.*')


def _text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{name} must be nonempty text')
    return value


def _digest(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'Acceptance path is missing, nonregular or a symlink: {path}')
    # Linux rejects symlink substitutions at open time. Windows guards are
    # advisory; supervised execution continues to require Linux/WSL.
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    import stat
    fd = os.open(path, flags)
    with os.fdopen(fd, 'rb') as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode):
            raise ValueError(f'Acceptance path must be regular: {path}')
        digest = hashlib.sha256(str(meta.st_mode & 0o111).encode() + b'\0')
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _relative(value):
    path = Path(_text(value, 'protected path'))
    if path.is_absolute() or '..' in path.parts or value in ('', '.'):
        raise ValueError('protected_paths must be nonempty project-relative paths without ..')
    return path.as_posix().rstrip('/')


def _protected(name, explicit):
    parts = Path(name).parts
    return (any(name == p or name.startswith(p + '/') for p in explicit)
            or any(p.lower() in TEST_DIRS for p in parts[:-1])
            or name.startswith('.github/workflows/')
            or any(fnmatch.fnmatch(parts[-1], pattern) for pattern in TEST_NAMES + CONFIG_NAMES))


def protected_manifest(project, protected_paths):
    root = Path(project).resolve()
    explicit = [_relative(p) for p in protected_paths]
    result = {}
    count = 0
    def onerror(error):
        raise error
    for directory, folders, files in os.walk(root, onerror=onerror):
        folders[:] = sorted(n for n in folders if n not in IGNORED)
        for folder in folders:
            path = Path(directory) / folder
            if path.is_symlink():
                raise ValueError(f'Source directory symlinks require explicit handling: {path}')
        for filename in sorted(files):
            count += 1
            if count > 20000:
                raise ValueError('Source exceeds 20,000 files; narrow the project')
            path = Path(directory) / filename
            name = path.relative_to(root).as_posix()
            if _protected(name, explicit):
                result[name] = _digest(path)
            elif filename == 'package.json':
                # Dependency/version edits remain possible; test commands do not.
                if path.is_symlink():
                    raise ValueError(f'Package configuration cannot be a symlink: {name}')
                data = json.loads(path.read_text(encoding='utf-8-sig'))
                result[name + '#scripts'] = hashlib.sha256(json.dumps(
                    data.get('scripts', {}), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
                # Embedded test/coverage config can weaken assertions as easily
                # as a command edit. Pin membership too, catching newly added keys.
                configs = {k: v for k, v in data.items() if k not in {
                    'name', 'version', 'description', 'license', 'author', 'contributors',
                    'homepage', 'repository', 'bugs', 'keywords', 'private', 'dependencies',
                    'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts'}}
                result[name + '#configuration'] = hashlib.sha256(json.dumps(
                    configs, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    # Protected directories hidden by normal exclusions must not silently evade
    # protection. Explicit files remain checked through the acceptance manifest.
    for name in explicit:
        if any(part in IGNORED for part in Path(name).parts):
            raise ValueError('protected_paths cannot use excluded directories; use acceptance_files for external evidence')
    return result


def prepare_quality(project, spec):
    raw = spec.get('quality')
    if not isinstance(raw, dict):
        raise ValueError('New runs require a QA-owned quality contract; read references/quality.md')
    builder = _text(raw.get('builder'), 'quality.builder')
    qa = _text(raw.get('qa_author'), 'quality.qa_author')
    if builder.strip() == qa.strip():
        raise ValueError('The implementation author cannot own acceptance tests')
    required = {name for task in spec['tasks'] for name in task['required_checks']}
    requirements = raw.get('requirements')
    if not isinstance(requirements, list) or not requirements:
        raise ValueError('quality.requirements must contain discovered behavior')
    covered, ids = set(), set()
    for requirement in requirements:
        if not isinstance(requirement, dict):
            raise ValueError('Each requirement must be an object')
        name = _text(requirement.get('id'), 'requirement.id')
        if name in ids:
            raise ValueError('Requirement IDs must be unique')
        ids.add(name)
        _text(requirement.get('behavior'), 'requirement.behavior')
        _text(requirement.get('basis'), 'requirement.basis')
        checks = requirement.get('checks')
        if not isinstance(checks, list) or not checks or any(not isinstance(c, str) or c not in required for c in checks):
            raise ValueError('Every requirement must map to declared required_checks')
        covered.update(checks)
    if covered != required:
        raise ValueError('Every required check must map to a discovered requirement')
    calibration = raw.get('calibration')
    if not isinstance(calibration, dict):
        raise ValueError('QA must record positive and negative calibration evidence')
    for kind in ('positive', 'negative'):
        _text(calibration.get(kind), 'quality.calibration.' + kind)
    files = raw.get('acceptance_files')
    if not isinstance(files, list) or not files:
        raise ValueError('QA must declare acceptance_files including helpers and test configuration')
    paths = raw.get('protected_paths', [])
    if not isinstance(paths, list):
        raise ValueError('protected_paths must be a list')
    explicit = [_relative(p) for p in paths]
    root = Path(project).resolve()
    acceptance = {}
    for name in files:
        path = Path(_text(name, 'acceptance file').replace('{project}', str(root)))
        if not path.is_absolute():
            path = root / path
        if path.is_symlink():
            raise ValueError('Acceptance files cannot be symlinks')
        acceptance[str(path.absolute())] = _digest(path)
    return dict(version=VERSION, builder=builder, qa_author=qa, requirements=requirements,
                calibration=calibration, protected_paths=explicit,
                acceptance_manifest=acceptance, protected_manifest=protected_manifest(root, explicit))


def check_quality(project, quality):
    if not isinstance(quality, dict) or quality.get('version') != VERSION:
        raise ValueError('Legacy run: preserve its evidence and create a reviewed replacement run; no in-place policy migration')
    for name, expected in quality['acceptance_manifest'].items():
        if _digest(name) != expected:
            raise ValueError(f'QA-owned acceptance file changed: {name}')
    current = protected_manifest(project, quality['protected_paths'])
    expected = quality['protected_manifest']
    if current != expected:
        changed = sorted(k for k in set(current) | set(expected) if current.get(k) != expected.get(k))
        raise ValueError('Protected tests/configuration changed: ' + ', '.join(changed[:20]))


def preflight(project, minimum_free_bytes=256 * 1024 * 1024):
    free = shutil.disk_usage(project).free
    if free < minimum_free_bytes:
        raise ValueError(f'Insufficient free disk space: {free} bytes; need at least {minimum_free_bytes}')
    return {'free_bytes': free, 'minimum_free_bytes': minimum_free_bytes}
