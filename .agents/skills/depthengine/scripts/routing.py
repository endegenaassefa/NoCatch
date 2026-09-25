"""Small explicit role/tool routes and observable context handoff decisions.

No provider token-usage sum is interpreted as the current context. This module
cannot intercept model requests inside a CLI or reset the interactive root host.
"""
from __future__ import annotations
import argparse
import json

CONTEXT_LIMIT = 250000
HANDOFF_RESERVE = 25000


def context_action(current_tokens=None, model_limit=None, limit=CONTEXT_LIMIT, reserve=HANDOFF_RESERVE):
    for name, value in (('limit', limit), ('reserve', reserve), ('model_limit', model_limit), ('current_tokens', current_tokens)):
        if value is None and name in ('model_limit', 'current_tokens'):
            continue
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or (name in ('limit', 'model_limit') and value == 0):
            raise ValueError(f'{name} must be a nonnegative integer (limits positive)')
    maximum = min(limit, model_limit) if model_limit is not None else limit
    threshold = max(0, maximum - reserve)
    return {'status': 'unavailable' if current_tokens is None else ('handoff' if current_tokens >= threshold else 'continue'),
            'current_tokens': current_tokens, 'limit': maximum, 'threshold': threshold,
            'enforcement': 'unavailable' if current_tokens is None else 'observed_boundary_only',
            'limitation': 'Hard per-request enforcement requires host token telemetry and a pre-request hook; CLI totals are not current context.'}


def validate_task(task):
    role = task.get('role', 'build')
    surface = task.get('surface', 'library')
    if role not in ('build', 'qa', 'research', 'review'):
        raise ValueError('Unknown task role')
    if surface not in ('web', 'electron', 'native', 'api', 'cli', 'library'):
        raise ValueError('Unknown application surface')
    if task.get('provider', 'auto') not in ('auto', 'codex', 'claude'):
        raise ValueError('Unknown task provider')


def route_task(task, available_providers=('codex', 'claude')):
    validate_task(task)
    role, surface = task.get('role', 'build'), task.get('surface', 'library')
    requested = task.get('provider', 'auto')
    available = [p for p in ('codex', 'claude') if p in available_providers]
    if requested == 'auto':
        if not available:
            raise ValueError('No installed supported provider; run doctor')
        provider = available[0]
    elif requested in available:
        provider = requested
    else:
        raise ValueError('Requested provider is unsupported or unavailable')
    tool = ('isolated-review' if role == 'review' else 'structured-client' if role == 'research'
            else {'web': 'agent-browser', 'electron': 'agent-browser', 'native': 'desktop-driver',
                  'api': 'structured-client', 'cli': 'shell', 'library': 'shell'}[surface])
    return {'role': role, 'surface': surface, 'provider': provider, 'tool': tool,
            'writes': 'production' if role == 'build' else 'none',
            'reason': 'Explicit task role/surface and installed host availability; models and permissions remain host-owned.'}


def _pick(data, names):
    return {key: data[key] for key in names if key in data}


def _evidence(value):
    if not isinstance(value, dict):
        return None
    out = _pick(value, ('passed', 'source_fingerprint', 'source_unchanged', 'at'))
    process = value.get('process')
    if isinstance(process, dict):
        out['process'] = _pick(process, ('stdout', 'stderr', 'returncode', 'reason'))
    result = value.get('result')
    if isinstance(result, dict):
        out['result'] = _pick(result, ('passed', 'error'))
        if isinstance(result.get('checks'), list):
            out['result']['checks'] = [_pick(c, ('name', 'passed')) for c in result['checks'] if isinstance(c, dict)]
    return out


def clean_packet(packet):
    """Allowlisted task data, never a transcript or freeform agent scratchpad.

Semantic inspection is still necessary: an allowed instruction string can carry
arbitrary text. This is data minimization, not adversarial content sanitization.
"""
    out = _pick(packet, ('run_id', 'project', 'epoch', 'revision', 'goal', 'remaining_seconds', 'remaining_steps', 'max_attempts'))
    out['context'] = _pick(packet.get('context', {}), ('audience', 'constraints', 'design', 'projectIdentity', 'sourceRepository'))
    out['context_omitted_keys'] = sorted(set(packet.get('context', {})) - set(out['context']))
    out['decisions'] = [_pick(d, ('id', 'text', 'supersedes', 'at')) for d in packet.get('decisions', []) if isinstance(d, dict)]
    task = packet.get('task')
    if isinstance(task, dict):
        out['task'] = _pick(task, ('id', 'status', 'attempts', 'instruction', 'criteria', 'depends_on', 'verify', 'verify_files', 'required_checks', 'role', 'provider', 'surface', 'question', 'blocker_kind'))
        if task.get('evidence'):
            out['task']['evidence'] = _evidence(task['evidence'])
        answer = task.get('last_worker', {}).get('answer', {})
        if answer.get('status') == 'handoff':
            out['task']['handoff_artifacts'] = answer.get('artifacts', [])
    else:
        out['task'] = None
    out['tasks'] = [dict(_pick(t, ('id', 'status')), evidence=_evidence(t.get('evidence')))
                    for t in packet.get('tasks', []) if isinstance(t, dict)]
    quality = packet.get('quality')
    if isinstance(quality, dict):
        out['quality'] = _pick(quality, ('version', 'builder', 'qa_author', 'protected_paths'))
        out['quality']['requirements'] = [_pick(r, ('id', 'behavior', 'basis', 'checks'))
                                           for r in quality.get('requirements', []) if isinstance(r, dict)]
        out['quality']['acceptance_files'] = list(quality.get('acceptance_manifest', {}))
    out['context_policy'] = context_action()
    def scrub(value):
        if isinstance(value, dict):
            return {key: scrub(item) for key, item in value.items()
                    if key.lower().replace('-', '_') not in {
                        'chat', 'chats', 'history', 'transcript', 'transcripts', 'scratchpad',
                        'scratchpads', 'memory', 'memories', 'conversation', 'conversations', 'chat_history'}}
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return value
    return scrub(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    context = sub.add_parser('context')
    context.add_argument('--current-tokens', type=int)
    context.add_argument('--model-limit', type=int)
    route = sub.add_parser('route')
    route.add_argument('--role', default='build')
    route.add_argument('--surface', default='library')
    route.add_argument('--provider', default='auto')
    args = parser.parse_args()
    if args.command == 'context':
        result = context_action(args.current_tokens, args.model_limit)
    else:
        import shutil
        result = route_task(vars(args), [p for p in ('codex', 'claude') if shutil.which(p)])
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
