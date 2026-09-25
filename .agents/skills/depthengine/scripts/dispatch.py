"""Compile validated local skills and task-aware model routes into host task packets.

This prepares native-host delegation; it does not launch models, grant permission,
or claim that a prepared task ran. No dependency beyond Python's standard library.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath

TIERS = ('fast', 'standard', 'strong')
ROLES = {'research', 'build', 'qa', 'review'}
DOMAINS = {'development', 'research', 'frontend', 'devops'}
MODES = {'feature', 'debug', 'refactor', 'research', 'design', 'verify', 'operations'}
IDENTIFIER = re.compile(r'^[a-z][a-z0-9_-]{0,63}$')
HASH = re.compile(r'^[0-9a-f]{64}$')
MAX_FILE = 256_000
MAX_JSON = 2_000_000


def read_json(path):
    raw = Path(path).read_bytes()
    if len(raw) > MAX_JSON:
        raise ValueError('JSON input exceeds 2 MB')
    value = json.loads(raw.decode('utf-8-sig'))
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON object')
    return value


def positive(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(label + ' must be a positive integer')
    return value


def strings(value, label, nonempty=False):
    if not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
        raise ValueError(label + ' must be a list of nonempty strings')
    if nonempty and not value:
        raise ValueError(label + ' must not be empty')
    if len(value) != len(set(value)):
        raise ValueError(label + ' contains duplicates')
    return value


def local_file(root, relative):
    if (not isinstance(relative, str) or not relative or '\\' in relative or ':' in relative
            or PurePosixPath(relative).is_absolute()
            or any(part in ('..', '.') for part in relative.split('/'))):
        raise ValueError('Skill file must be a contained relative POSIX path')
    path = root
    for part in PurePosixPath(relative).parts:
        path = path / part
        if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
            raise ValueError('Linked skill paths are not accepted: ' + relative)
    if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Missing or escaped skill file: ' + relative)
    return path


def load_registry(path):
    registry_path = Path(path).resolve()
    registry = read_json(registry_path)
    if registry.get('version') != 1 or not isinstance(registry.get('skills'), list):
        raise ValueError('Expected version 1 skill registry')
    found = {}
    for entry in registry['skills']:
        if not isinstance(entry, dict) or not IDENTIFIER.fullmatch(str(entry.get('id', ''))):
            raise ValueError('Invalid skill ID')
        key = entry['id']
        if key in found:
            raise ValueError('Duplicate skill ID: ' + key)
        files = entry.get('files')
        if not isinstance(files, dict) or entry.get('entrypoint') not in files:
            raise ValueError('Skill entrypoint must be in its hash inventory: ' + key)
        for field, allowed in (('domains', DOMAINS), ('modes', MODES), ('roles', ROLES)):
            if not set(strings(entry.get(field, []), key + '.' + field)) <= allowed:
                raise ValueError('Unsupported selector in ' + key + '.' + field)
        adaptation = entry.get('adaptation', '')
        if not isinstance(adaptation, str):
            raise ValueError('Skill adaptation must be text')
        # Validate metadata immediately; file contents are read only for selected skills.
        for name, digest in files.items():
            if not isinstance(digest, str) or not HASH.fullmatch(digest):
                raise ValueError('Invalid skill SHA-256: ' + key)
            local_file(registry_path.parent, name)
        found[key] = entry
    return registry_path.parent, found


def bundle_skill(root, entry):
    inventory = []
    content = None
    total = 0
    for relative, expected in sorted(entry['files'].items()):
        path = local_file(root, relative)
        raw = path.read_bytes()
        total += len(raw)
        if len(raw) > MAX_FILE or total > 2_000_000:
            raise ValueError('Selected skill exceeds size limit: ' + entry['id'])
        digest = hashlib.sha256(raw).hexdigest()
        if digest != expected:
            raise ValueError('Skill integrity mismatch: ' + relative)
        inventory.append({'path': str(path.resolve()), 'sha256': digest})
        if relative == entry['entrypoint']:
            content = raw.decode('utf-8-sig')
    if not content or not content.strip():
        raise ValueError('Skill entrypoint is empty: ' + entry['id'])
    return {'id': entry['id'], 'entrypoint': str(local_file(root, entry['entrypoint']).resolve()),
            'content': content, 'adaptation': entry.get('adaptation', ''), 'files': inventory}


def model_route(task, host):
    models = host.get('models')
    if not isinstance(models, list) or not models:
        raise ValueError('No host models supplied; use the current host capability catalog')
    names = set()
    for model in models:
        if not isinstance(model, dict) or not isinstance(model.get('id'), str) or not model['id'].strip():
            raise ValueError('Invalid host model')
        if model['id'] in names or model.get('tier') not in TIERS:
            raise ValueError('Duplicate model or unsupported model tier')
        names.add(model['id'])
        strings(model.get('efforts'), 'model.efforts', nonempty=True)
        if not set(model['efforts']) <= {'low', 'medium', 'high', 'xhigh', 'max', 'ultra'}:
            raise ValueError('Unsupported model effort')
    if task['risk'] == 'high' or task['complexity'] == 'high' or task['role'] == 'review':
        tier, reason = 'strong', 'High consequence, complex reasoning, or independent review'
    elif task['complexity'] == 'low' and task['role'] != 'build':
        tier, reason = 'fast', 'Bounded low-risk task with explicit observable criteria'
    else:
        tier, reason = 'standard', 'Implementation or multi-step work'
    index = TIERS.index(tier)
    attempts = task.get('attempts_without_progress', 0)
    if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 0:
        raise ValueError('attempts_without_progress must be a nonnegative integer')
    if attempts >= 2:
        index = min(2, index + 1)
        reason += '; escalated after repeated attempts without progress'
    available = [model for model in models if TIERS.index(model['tier']) >= index]
    if not available:
        raise ValueError('No available model satisfies required tier ' + TIERS[index])
    model = min(available, key=lambda item: TIERS.index(item['tier']))
    preferred = ('high', 'medium', 'low') if model['tier'] in ('fast', 'strong') else ('medium', 'high', 'low')
    effort = next((e for e in preferred if e in model['efforts']), model['efforts'][0])
    return {'model': model['id'], 'reasoning_effort': effort, 'required_tier': TIERS[index],
            'selected_tier': model['tier'], 'reason': reason,
            'availability_basis': 'Caller-supplied current host catalog; account access not independently inferred'}


def validate_tasks(spec):
    project = Path(spec.get('project', ''))
    if not project.is_absolute() or not project.is_dir():
        raise ValueError('project must be an existing absolute directory')
    tasks = spec.get('tasks')
    if not isinstance(tasks, list) or not tasks or len(tasks) > 100:
        raise ValueError('tasks must contain 1 to 100 tasks')
    found = {}
    allowed = {'id', 'role', 'domain', 'mode', 'complexity', 'risk', 'instruction', 'criteria',
               'depends_on', 'skills', 'attempts_without_progress', 'qa_phase', 'write_paths'}
    for task in tasks:
        if not isinstance(task, dict) or set(task) - allowed:
            raise ValueError('Unknown task fields; pass task facts, not conversation history')
        key = task.get('id', '')
        if not isinstance(key, str) or not IDENTIFIER.fullmatch(key) or key in found:
            raise ValueError('Invalid or duplicate task ID')
        for field, choices in (('role', ROLES), ('domain', DOMAINS), ('mode', MODES),
                               ('complexity', {'low', 'medium', 'high'}), ('risk', {'normal', 'high'})):
            if task.get(field) not in choices:
                raise ValueError('Invalid task ' + field)
        if not isinstance(task.get('instruction'), str) or not task['instruction'].strip():
            raise ValueError('Task instruction is required')
        strings(task.get('criteria'), 'criteria', nonempty=True)
        strings(task.get('depends_on', []), 'depends_on')
        if 'skills' in task:
            strings(task['skills'], 'skills')
        if task.get('qa_phase', 'execute') not in ('author', 'execute'):
            raise ValueError('qa_phase must be author or execute')
        if 'qa_phase' in task and task['role'] != 'qa':
            raise ValueError('qa_phase applies only to QA tasks')
        if task.get('qa_phase') == 'author':
            qa_root = Path(spec.get('qa_root', ''))
            if not qa_root.is_absolute() or not qa_root.is_dir():
                raise ValueError('QA authoring requires an existing absolute qa_root')
            for supplied in strings(task.get('write_paths'), 'QA write_paths', nonempty=True):
                owned = Path(supplied)
                if not owned.is_absolute() or not owned.is_dir() or not owned.resolve().is_relative_to(qa_root.resolve()):
                    raise ValueError('QA write path must be an existing directory within qa_root')
                for component in (owned, *owned.parents):
                    if component.is_symlink() or (hasattr(component, 'is_junction') and component.is_junction()):
                        raise ValueError('QA write paths may not cross filesystem links')
        elif task.get('write_paths'):
            raise ValueError('write_paths applies only to QA authoring tasks')
        found[key] = task
    for task in tasks:
        if not set(task.get('depends_on', [])) <= found.keys() or task['id'] in task.get('depends_on', []):
            raise ValueError('Missing or self dependency')
    return project.resolve(), found


def batches(tasks, limit):
    done, result = set(), []
    while len(done) < len(tasks):
        ready = [t for t in tasks.values() if t['id'] not in done and set(t.get('depends_on', [])) <= done]
        if not ready:
            raise ValueError('Task dependencies contain a cycle')
        group = []
        builder = False
        for task in ready:
            if len(group) >= limit:
                break
            if task['role'] == 'build' and builder:
                continue
            builder = builder or task['role'] == 'build'
            group.append(task['id'])
        done.update(group)
        result.append(group)
    return result


def select_skills(task, registry):
    if not isinstance(task, dict):
        raise ValueError('Packet task is malformed')
    selected = task.get('skills')
    if selected is None:
        if not all(task.get(field) in choices for field, choices in (('domain', DOMAINS), ('mode', MODES), ('role', ROLES))):
            raise ValueError('Task skill selectors are malformed')
        selected = [entry['id'] for entry in registry.values()
                    if entry.get('automatic', True) and (not entry.get('domains') or task['domain'] in entry['domains'])
                    and (not entry.get('modes') or task['mode'] in entry['modes'])
                    and (not entry.get('roles') or task['role'] in entry['roles'])]
    strings(selected, 'selected skills')
    if len(selected) > 8 or any(skill not in registry for skill in selected):
        raise ValueError('Unknown or excessive selected skills')
    return selected


def spawn_arguments(packet):
    """Derive the worker's entire input from the authoritative packet fields."""
    payload = {field: packet[field] for field in
               ('status', 'project', 'task', 'model_route', 'skills', 'registry',
                'write_policy', 'limitations', 'qa_root', 'write_scope') if field in packet}
    prefix = ''
    if 'verification_argv' in packet:
        prefix = ('Before using these skills, run the integrity check with argv '
                  + json.dumps(packet['verification_argv'])
                  + '. Stop and report changed inputs on failure. Recheck before later support-file reads.\n')
    message = (prefix + 'Execute this bounded Depth Engine task. Read and use the selected local skill contents below; '
               'resolve their support files relative to each absolute entrypoint. Apply the stated Depth Engine '
               'adaptations instead of incompatible upstream host/permission/QA conventions. Do not create a '
               'nested coordinator or delegate further. Do not read conversation history or unrelated memory. '
               'Report observed outcomes, artifacts, blockers and remaining checks; ready is not verified complete.\n'
               + json.dumps(payload, ensure_ascii=False, indent=2))
    return {'task_name': packet['task']['id'], 'fork_turns': 'none',
            'model': packet['model_route']['model'],
            'reasoning_effort': packet['model_route']['reasoning_effort'], 'message': message}


def prepare(spec, host, registry_path):
    project, tasks = validate_tasks(spec)
    limit = min(positive(spec.get('max_parallel', 1), 'spec.max_parallel'),
                positive(host.get('max_parallel', 1), 'host.max_parallel'))
    waves = batches(tasks, limit)
    root, registry = load_registry(registry_path)
    registry_pin = {'path': str(Path(registry_path).resolve()),
                    'sha256': hashlib.sha256(Path(registry_path).read_bytes()).hexdigest()}
    packets = {}
    for key, task in tasks.items():
        selected = select_skills(task, registry)
        skills = [bundle_skill(root, registry[skill]) for skill in selected]
        route = model_route(task, host)
        packet = {'status': 'prepared', 'project': str(project), 'task': task,
                  'model_route': route, 'skills': skills, 'registry': registry_pin,
                  'write_policy': 'production only; QA-owned tests/config protected' if task['role'] == 'build'
                                  else 'assigned evidence only; production and frozen checks read-only',
                  'limitations': ['Task packet preparation is not task execution.',
                                 'Write scope is cooperative; host permissions remain authoritative.',
                                 'Independent review must use review.py; a native subagent is not a tool-free reviewer.']}
        if task.get('qa_phase') == 'author':
            packet['write_policy'] = ('Independent QA authoring before freeze: may author/calibrate checks only within '
                                      + json.dumps(task['write_paths']) + '. Production source stays read-only. '
                                      'Do not edit already frozen acceptance assets; a new contract is required.')
            packet['qa_root'] = str(Path(spec['qa_root']).resolve())
            packet['write_scope'] = {'kind': 'qa-authoring',
                                     'paths': [str(Path(p).resolve()) for p in task['write_paths']],
                                     'production': False, 'frozen_checks_writable': False,
                                     'phase': 'before-new-contract-freeze'}
        if task['role'] == 'review':
            packet['execution'] = {'kind': 'isolated-review', 'script': str(Path(__file__).resolve().with_name('review.py')),
                                   'instruction': 'Prepare the allowlisted raw evidence packet and invoke review.py; do not use generic native spawn.'}
        else:
            packet['spawn_args'] = spawn_arguments(packet)
            packet['execution'] = {'kind': 'native-host', 'instruction': 'Use spawn_args with the available collaboration spawn tool after dependencies pass.'}
        packets[key] = packet
    return {'status': 'prepared', 'project': str(project), 'max_parallel': limit,
            'batches': waves, 'tasks': [{'id': key, 'model_route': value['model_route'],
                                       'skills': [s['id'] for s in value['skills']],
                                       'packet': 'task-' + key + '.json'} for key, value in packets.items()],
            'execution_rule': 'Start a dependent batch only after prerequisite outcomes are verified; replan after failures. Batches are eligibility, not success.',
            'managed_run': None}, packets


def verify_packet(path):
    packet = read_json(path)
    pin = packet.get('registry')
    if not isinstance(pin, dict) or not isinstance(pin.get('path'), str) or not isinstance(pin.get('sha256'), str):
        raise ValueError('Packet is missing its registry pin')
    registry_path = Path(pin['path'])
    if not registry_path.is_absolute() or hashlib.sha256(registry_path.read_bytes()).hexdigest() != pin['sha256']:
        raise ValueError('Packet registry changed since preparation')
    root, registry = load_registry(registry_path)
    selected = packet.get('skills')
    if not isinstance(selected, list):
        raise ValueError('Packet skills are malformed')
    expected = select_skills(packet.get('task'), registry)
    if [skill.get('id') if isinstance(skill, dict) else None for skill in selected] != expected:
        raise ValueError('Packet selected skill set changed')
    seen = set()
    for skill in selected:
        if not isinstance(skill, dict) or skill.get('id') not in registry or skill['id'] in seen:
            raise ValueError('Packet references an unknown or duplicate skill')
        seen.add(skill['id'])
        if bundle_skill(root, registry[skill['id']]) != skill:
            raise ValueError('Packet skill content or live inventory changed: ' + skill['id'])
    expected_argv = [sys.executable, str(Path(__file__).resolve()), '--verify-packet', str(Path(path).resolve())]
    if packet.get('verification_argv') != expected_argv:
        raise ValueError('Packet integrity-check command changed')
    if packet['task'].get('role') != 'review' and packet.get('spawn_args') != spawn_arguments(packet):
        raise ValueError('Packet worker instructions or model route changed')
    return {'status': 'valid_at_check', 'skills': sorted(seen),
            'limitation': 'Point-in-time cooperative integrity check; no write prevention or continuous monitoring'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', type=Path)
    parser.add_argument('--host', type=Path)
    parser.add_argument('--registry', type=Path, default=Path(__file__).resolve().parents[1] / 'registry.json')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--verify-packet', type=Path)
    args = parser.parse_args()
    try:
        if args.verify_packet:
            if args.spec or args.host or args.output:
                raise ValueError('--verify-packet is a standalone operation')
            print(json.dumps(verify_packet(args.verify_packet)))
            return 0
        if not args.spec or not args.host or not args.output:
            raise ValueError('--spec, --host and --output are required for preparation')
        if args.output.exists():
            raise ValueError('Output already exists; use a fresh directory')
        plan, packets = prepare(read_json(args.spec), read_json(args.host), args.registry)
        encoded = {}
        for key, packet in packets.items():
            packet_path = (args.output / ('task-' + key + '.json')).resolve()
            packet['verification_argv'] = [sys.executable, str(Path(__file__).resolve()), '--verify-packet', str(packet_path)]
            if 'spawn_args' in packet:
                packet['spawn_args'] = spawn_arguments(packet)
            raw = (json.dumps(packet, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            if len(raw) > MAX_JSON:
                raise ValueError('Final task packet exceeds 2 MB: ' + key)
            encoded[packet_path] = raw
        args.output.mkdir(parents=True, exist_ok=False)
        for packet_path, raw in encoded.items():
            packet_path.write_bytes(raw)
        (args.output / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'status': 'prepared', 'plan': str((args.output / 'plan.json').resolve()),
                          'tasks': len(packets), 'batches': plan['batches']}))
        return 0
    except (ValueError, OSError, UnicodeError, TypeError, KeyError) as error:
        print(json.dumps({'status': 'invalid', 'error': str(error)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
