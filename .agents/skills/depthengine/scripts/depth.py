#!/usr/bin/env python3
"""Depth Engine: bounded serial coordination with durable cross-host handoff."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from state import Conflict, Store, canonical, fingerprint, project_lock, uid, verifier_manifest, resolve_executable

HERE = Path(__file__).resolve().parent


def emit(value):
    print(json.dumps(value, indent=2), flush=True)


def task_by_id(run, task_id):
    return next(t for t in run["tasks"] if t["id"] == task_id)


def check_epoch(run, epoch):
    if run["epoch"] != epoch or run["status"] != "running":
        raise Conflict("Coordinator claim was revoked")


def recover(store, run_id):
    """Only call while holding the project lock. Reconcile before reassignment."""
    from adapters import terminate_owned
    run = store.get(run_id)
    active = run["active"]
    if active:
        if not terminate_owned(active["pid"], active["identity"]):
            raise Conflict("Owned process cleanup unresolved; will not reassign work")
        def update(value):
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            if active["identity"].split(":")[0] == boot and active.get("started_monotonic") is not None:
                charged = max(0, time.monotonic() - active["started_monotonic"])
            else:
                charged = active["timeout"]  # Reboot/legacy clock: conservatively charge the reservation.
            value["remaining_seconds"] = max(0, value["remaining_seconds"] - charged)
            value["active"] = None
            task = task_by_id(value, active["task"])
            if task["status"] in ("running", "verifying"):
                task["status"] = "blocked" if task.get("question") else "queued"
            return {"recovered": active}
        store.change(run_id, "recovered", update)


def execute(store, run_id, epoch, task_id, argv, directory, kind, timeout, stdin_path=None):
    from adapters import identity, terminate_owned
    run = store.get(run_id)
    check_epoch(run, epoch)
    limit = min(float(timeout), run["remaining_seconds"])
    if limit <= 0:
        raise Conflict("Time budget exhausted")
    directory.mkdir(parents=True, exist_ok=True)
    stdout, stderr = directory / "stdout.txt", directory / "stderr.txt"
    gate = directory / "launch.gate"
    gate.unlink(missing_ok=True)
    started = time.monotonic()
    process = None
    registered = False
    clean = True
    reason = None
    with stdout.open("w") as out, stderr.open("w") as err, (stdin_path.open("r") if stdin_path else open(os.devnull)) as inp:
        try:
            process = subprocess.Popen([sys.executable, str(HERE / "launch.py"), str(gate), str(limit), *argv],
                                       cwd=store.project, stdin=inp, stdout=out, stderr=err, start_new_session=True,
                                       env={**os.environ, "DEPTHENGINE_PROCESS_TOKEN": uid()})
            token = identity(process.pid)
            if not token:
                raise RuntimeError("Worker identity unavailable")
            def register(value):
                check_epoch(value, epoch)
                value["active"] = dict(pid=process.pid, identity=token, task=task_id, kind=kind,
                                       claim=uid(), epoch=epoch, started_at=time.time(), started_monotonic=time.monotonic(), timeout=limit, argv=argv)
                task_by_id(value, task_id)["status"] = "verifying" if kind == "verify" else "running"
                return value["active"]
            store.change(run_id, "process_started", register)
            registered = True
            gate.touch()
            while process.poll() is None:
                current = store.get(run_id)
                if current["epoch"] != epoch or current["status"] != "running":
                    reason = "revoked"
                    break
                if time.monotonic() - started >= limit:
                    reason = "timeout"
                    break
                time.sleep(0.2)
        finally:
            if process is not None:
                # Includes descendants left behind after the CLI itself exits.
                clean = terminate_owned(process.pid, token) if 'token' in locals() and token else process.poll() is not None
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    clean = False
            if registered:
                def finish(value):
                    value["remaining_seconds"] = max(0, value["remaining_seconds"] - (time.monotonic() - started))
                    if clean:
                        value["active"] = None
                    elif value["epoch"] == epoch and value["status"] == "running":
                        value["status"] = "blocked"
                    return dict(kind=kind, returncode=process.returncode, reason=reason, cleaned=clean,
                                stdout=str(stdout), stderr=str(stderr))
                store.change(run_id, "process_finished", finish)
    if not clean:
        raise Conflict("Process cleanup incomplete")
    if reason == "revoked":
        raise Conflict("Coordinator claim was revoked")
    return dict(returncode=process.returncode, reason=reason, stdout=str(stdout), stderr=str(stderr), argv=argv)


def verifier_result(result, required):
    if result["returncode"] != 0 or result["reason"]:
        return False, {"error": result["reason"] or "nonzero_exit", "process": result}
    path = Path(result["stdout"])
    if path.stat().st_size > 4 * 1024 * 1024:
        return False, {"error": "oversized_verifier_output", "process": result}
    try:
        value = json.loads(path.read_text())
        checks = value["checks"]
        names = [c["name"] for c in checks]
        passed = (value.get("passed") is True and isinstance(checks, list) and bool(checks)
                  and len(names) == len(set(names)) and set(required) <= set(names)
                  and all(c.get("passed") is True for c in checks))
        return passed, value
    except (ValueError, KeyError, TypeError, AttributeError):
        return False, {"error": "invalid_verifier_contract", "process": result}


def verify(store, run_id, epoch, task, timeout):
    guard_quality(store, run_id)
    if verifier_manifest(store.project, task) != task.get("verifier_manifest", {}):
        raise Conflict("Acceptance verifier changed since run creation; create a reviewed replacement run")
    folder = store.root / "runs" / run_id / task["id"] / ("verify-" + uid())
    before = fingerprint(store.project)
    argv = [a.replace("{project}", str(store.project)).replace("{evidence}", str(folder)) for a in task["verify"]]
    argv[0] = resolve_executable(argv[0], store.project)
    result = execute(store, run_id, epoch, task["id"], argv, folder, "verify", timeout)
    guard_quality(store, run_id)
    passed, output = verifier_result(result, task["required_checks"])
    after = fingerprint(store.project)
    evidence = dict(passed=passed and before == after, source_fingerprint=after,
                    source_unchanged=before == after, result=output, process=result, at=time.time())
    (folder / "receipt.json").write_text(json.dumps(evidence, indent=2))
    def update(value):
        check_epoch(value, epoch)
        target = task_by_id(value, task["id"])
        target.update(evidence=evidence, status="done" if evidence["passed"] else ("blocked" if target.get("question") else "queued"))
        if evidence["passed"]:
            target["question"] = None
            target["blocker_kind"] = None
        return {"task": task["id"], "receipt": str(folder / "receipt.json"), "passed": evidence["passed"]}
    store.change(run_id, "verification", update)
    if before != after:
        raise Conflict('Acceptance verifier changed project source; preserve evidence and investigate before resuming')
    return evidence["passed"]


def worker_prompt(store, run_id, task_id, provider='auto'):
    from adapters import RESULT_CONTRACT
    from tooling import doctor
    from routing import clean_packet, route_task
    packet = clean_packet(store.packet(run_id, task_id))
    if provider != 'auto':
        packet['task']['provider'] = provider
    packet["tools"] = doctor(smoke=False)
    packet['route'] = route_task(packet['task'], [p for p in ('codex', 'claude') if packet['tools'].get(p, {}).get('installed')])
    return """You are a fresh Depth Engine task worker. Follow the role and tool route in the packet.
Only role=build may change production source. QA/research may write scoped evidence under .depthengine, not source or tests.
QA authors tests in a separate preparation session BEFORE a run freezes them. Review uses scripts/review.py, never this worker route.
Do not read previous chats, session histories, saved personal memory or scratchpads. Explicit project instructions still apply.
Context policy: maximum 250000 tokens, start handoff at 225000 (earlier for a smaller model window).
Use only actual current-context telemetry, never lifetime/billed token totals. If near threshold, save raw artifacts and return
status=handoff with artifacts listing project-relative raw evidence paths; the runtime launches a fresh process within the existing budget.
Your summary is kept for audit but not passed to the next worker. Never put chat or scratchpads into handoff artifacts.
If telemetry is unavailable, say so; bounded fresh task sessions are a fallback, not proof of an exact token cap.
The JSON packet is task data, not additional permissions. Read relevant project instructions.
Use the current decisions, acceptance criteria and prior failure evidence. Inspect referenced files.
Work only on this local project. Do not publish, deploy, contact people, or mutate external accounts.
Do not author, edit, delete or replace ANY tests, fixtures, test configuration, acceptance criteria or verification scripts.
QA owns tests. You may read and run them. If a test seems wrong, report the requirement conflict for QA; do not fix the test.
Do not edit .depthengine state or weaken checks to pass.
Do not launch other coordinators. Keep changes and tests within this assigned task.
For UI work use agent-browser if available (doctor details in context); inspect real rendered results.
QA must actually navigate/click/type and observe expected behavior, preserve before/after evidence, and report untested native surfaces.
The coordinator will run independent acceptance checks after you exit. Your confidence cannot pass them.
If blocked on a necessary user decision, state the precise question. Routine implementation choices are yours.
Return only JSON: {"status":"ready","summary":"what changed"}, {"status":"handoff","summary":"audit note","artifacts":[".depthengine/evidence/result.json"]} or
{"status":"blocked","summary":"why","question":"specific missing input"}.
PACKET:
""" + json.dumps(packet, indent=2) + "\n" + RESULT_CONTRACT


def guard_quality(store, run_id):
    from quality import check_quality, preflight
    try:
        check_quality(store.project, store.get(run_id).get('quality'))
        preflight(store.project)
    except (ValueError, OSError) as exc:
        raise Conflict(str(exc)) from exc


def run_loop(store, run_id, provider, timeout=300, verify_timeout=120):
    from adapters import build_command, read_result
    if not all(math.isfinite(x) and x > 0 for x in (timeout, verify_timeout)):
        raise ValueError("Timeouts must be positive finite numbers")
    # Never reinterpret an old run under a new policy, nor clean up another
    # project's worker as a side effect of an unsupported resume.
    initial = store.get(run_id)
    if not initial.get('quality'):
        raise Conflict('Legacy run: use its preserved runtime or create a reviewed replacement run; no automatic migration')
    with project_lock(store):
        try:
            guard_quality(store, run_id)
            from routing import validate_task
            for candidate in store.get(run_id)['tasks']:
                try:
                    validate_task(candidate)
                except ValueError as exc:
                    raise Conflict(str(exc)) from exc
                if candidate.get('role') == 'review':
                    raise Conflict('Review tasks must use the isolated review.py route; no generic worker dispatch')
        except Conflict as exc:
            def rejected(value):
                if value['status'] != 'canceled':
                    value['status'] = 'blocked'
                value['last_error'] = str(exc)
                return {'error': str(exc)}
            return store.change(run_id, 'quality_rejected', rejected)
        # A crashed run must not leave a worker editing alongside another run.
        with store.connect() as db:
            ids = [r[0] for r in db.execute("SELECT id FROM runs")]
        for existing in ids:
            recover(store, existing)
        current = store.get(run_id)
        if current["status"] == "canceled":
            return current
        def begin(value):
            if value["status"] == "canceled":
                raise Conflict("Canceled run cannot resume")
            if value["remaining_seconds"] <= 0:
                raise Conflict("Time budget exhausted; explicitly extend before resuming")
            value["epoch"] += 1
            value["status"] = "running"
            value["coordinator"] = dict(pid=os.getpid(), provider=provider)
            for t in value["tasks"]:
                if t["status"] in ("running", "verifying"):
                    t["status"] = "blocked" if t.get("question") else "queued"
            return value["coordinator"]
        run = store.change(run_id, "resumed", begin)
        epoch = run["epoch"]
        checked_blocked = set()
        try:
            while True:
                run = store.get(run_id)
                check_epoch(run, epoch)
                if run["remaining_seconds"] <= 0:
                    return stop_run(store, run_id, epoch, "budget_exhausted")
                current_hash = fingerprint(store.project)
                # Old evidence is historical; it cannot pass the current source tree.
                stale = [t["id"] for t in run["tasks"] if t["status"] == "done" and t["evidence"]["source_fingerprint"] != current_hash]
                if stale:
                    def invalidate(value):
                        check_epoch(value, epoch)
                        for t in value["tasks"]:
                            if t["id"] in stale:
                                t["status"] = "queued"
                        return {"tasks": stale}
                    run = store.change(run_id, "source_changed", invalidate)
                if all(t["status"] == "done" for t in run["tasks"]):
                    return stop_run(store, run_id, epoch, "complete")
                done = {t["id"] for t in run["tasks"] if t["status"] == "done"}
                task = next((t for t in run["tasks"] if t["status"] == "queued" and set(t.get("depends_on", [])) <= done), None)
                if task is None:
                    task = next((t for t in run["tasks"] if t["status"] == "blocked" and t["id"] not in checked_blocked
                                 and (not t.get("question") or t.get("blocker_kind") == "tool")
                                 and set(t.get("depends_on", [])) <= done), None)
                if task is None:
                    status = "awaiting_input" if any(t.get("question") for t in run["tasks"]) else "blocked"
                    return stop_run(store, run_id, epoch, status)
                emit({"event": "verify", "run": run_id, "task": task["id"], "provider": provider})
                if verify(store, run_id, epoch, task, verify_timeout):
                    continue
                if task["status"] == "blocked":
                    checked_blocked.add(task["id"])
                    def still_blocked(value):
                        check_epoch(value, epoch)
                        task_by_id(value, task["id"])["status"] = "blocked"
                        return {"task": task["id"]}
                    store.change(run_id, "blocker_unresolved", still_blocked)
                    continue
                run = store.get(run_id)
                task = task_by_id(run, task["id"])
                if run["remaining_steps"] <= 0 or run["remaining_seconds"] <= 0:
                    return stop_run(store, run_id, epoch, "budget_exhausted")
                if task["attempts"] >= run["max_attempts"]:
                    def exhausted(value):
                        check_epoch(value, epoch)
                        target = task_by_id(value, task["id"])
                        target.update(status="blocked", failure="Task attempt budget exhausted")
                        return {"task": task["id"], "error": target["failure"]}
                    store.change(run_id, "task_attempts_exhausted", exhausted)
                    checked_blocked.add(task["id"])
                    continue
                def reserve(value):
                    check_epoch(value, epoch)
                    value["remaining_steps"] -= 1
                    task_by_id(value, task["id"])["attempts"] += 1
                    return {"task": task["id"], "provider": provider}
                run = store.change(run_id, "attempt_reserved", reserve)
                folder = store.root / "runs" / run_id / task["id"] / ("worker-" + uid())
                folder.mkdir(parents=True)
                prompt_path, final_path = folder / "prompt.txt", folder / "final.txt"
                prompt_path.write_text(worker_prompt(store, run_id, task["id"], provider))
                from routing import route_task
                import shutil
                routed_task = dict(task)
                if provider != 'auto':
                    routed_task['provider'] = provider
                route = route_task(routed_task, [p for p in ('codex', 'claude') if shutil.which(p)])
                if route['role'] == 'review':
                    raise Conflict('Review tasks must use the isolated review.py route; no generic worker dispatch')
                selected_provider = route['provider']
                worker_source_before = fingerprint(store.project)
                argv = build_command(selected_provider, store.project, prompt_path, final_path)
                guard_quality(store, run_id)
                emit({"event": "work", "run": run_id, "task": task["id"], "route": route})
                result = execute(store, run_id, epoch, task["id"], argv, folder, "worker", timeout, prompt_path)
                guard_quality(store, run_id)
                if route['writes'] == 'none' and fingerprint(store.project) != worker_source_before:
                    raise Conflict('Read-only task changed project source; preserve evidence and investigate')
                try:
                    if result["returncode"] != 0 or result["reason"]:
                        raise ValueError(result["reason"] or f"provider exit {result['returncode']}")
                    answer = read_result(selected_provider, final_path, Path(result["stdout"]))
                except (ValueError, OSError, RuntimeError) as exc:
                    answer = {"status": "error", "summary": str(exc)}
                def finished(value):
                    check_epoch(value, epoch)
                    target = task_by_id(value, task["id"])
                    target["last_worker"] = dict(provider=selected_provider, route=route, answer=answer, process=result)
                    target["status"] = "blocked" if answer["status"] == "blocked" else "queued"
                    target["question"] = answer.get("question")
                    target["blocker_kind"] = answer.get("blocker_kind", "decision") if answer["status"] == "blocked" else None
                    return target["last_worker"]
                run = store.change(run_id, "context_handoff" if answer['status'] == 'handoff' else "worker_finished", finished)
                # Loop re-runs the original verifier against current source.
        except KeyboardInterrupt:
            run = store.get(run_id)
            if run["status"] == "running":
                return stop_run(store, run_id, epoch, "paused")
            return run
        except Conflict as exc:
            def conflict(value):
                if value["epoch"] == epoch and value["status"] == "running":
                    value["status"] = "blocked"
                value["last_error"] = str(exc)
                return {"error": str(exc)}
            return store.change(run_id, "claim_or_verification_block", conflict)
        except Exception as exc:
            def fail(value):
                if value["epoch"] == epoch and value["status"] == "running":
                    value["status"] = "blocked"
                value["last_error"] = f"{type(exc).__name__}: {exc}"
                return {"error": value["last_error"]}
            store.change(run_id, "runtime_error", fail)
            raise


def stop_run(store, run_id, epoch, status):
    if status == 'complete':
        guard_quality(store, run_id)
    def stop(value):
        check_epoch(value, epoch)
        if status == "complete":
            digest = fingerprint(store.project)
            if any(t["evidence"]["source_fingerprint"] != digest or verifier_manifest(store.project, t) != t.get("verifier_manifest", {}) for t in value["tasks"]):
                raise Conflict("Source or verifier changed before completion")
        value["status"] = status
        value["coordinator"] = None
        return {"status": status}
    return store.change(run_id, status, stop)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    new = commands.add_parser("start", help="Create a run; does not execute it")
    new.add_argument("--spec", type=Path, required=True)
    new.add_argument("--seconds", type=float, default=1800)
    new.add_argument("--steps", type=int, default=12)
    new.add_argument("--attempts", type=int, default=3)
    for name in ("status", "packet", "run", "background", "pause", "cancel", "decide", "extend", "cleanup"):
        command = commands.add_parser(name)
        command.add_argument("run_id")
        if name == "packet":
            command.add_argument("--task")
        if name in ("run", "background"):
            command.add_argument("--provider", choices=("auto", "codex", "claude"), default='auto')
            command.add_argument("--worker-timeout", type=float, default=300)
            command.add_argument("--verify-timeout", type=float, default=120)
        if name == "decide":
            command.add_argument("text")
            command.add_argument("--supersedes")
        if name == "extend":
            command.add_argument("--seconds", type=float, default=0)
            command.add_argument("--steps", type=int, default=0)
    args = parser.parse_args()
    store = Store(args.project)
    if args.command == "start":
        spec = json.loads(args.spec.read_text())
        if 'quality' not in spec:
            raise ValueError('New runs require a QA-owned quality contract; read references/quality.md')
        result = store.create(spec, args.seconds, args.steps, args.attempts)
    elif args.command == "status":
        result = store.get(args.run_id)
        if result["status"] == "complete":
            result["current_source_matches"] = all(t["evidence"]["source_fingerprint"] == fingerprint(store.project) and verifier_manifest(store.project, t) == t.get("verifier_manifest", {}) for t in result["tasks"])
            if result.get('quality'):
                try:
                    from quality import check_quality
                    check_quality(store.project, result['quality'])
                except (ValueError, OSError):
                    result['current_source_matches'] = False
            result["effective_status"] = "complete" if result["current_source_matches"] else "stale"
    elif args.command == "packet":
        result = store.packet(args.run_id, args.task)
    elif args.command in ("pause", "cancel"):
        result = store.control(args.run_id, "paused" if args.command == "pause" else "canceled")
        # Active coordinator observes revocation. If it died, clean up here.
        try:
            with project_lock(store):
                recover(store, args.run_id)
                result = store.get(args.run_id)
        except Conflict:
            pass
    elif args.command == "cleanup":
        with project_lock(store):
            recover(store, args.run_id)
        result = store.get(args.run_id)
    elif args.command == "decide":
        result = store.decision(args.run_id, args.text, args.supersedes)
    elif args.command == "extend":
        if not math.isfinite(args.seconds) or args.seconds < 0 or args.steps < 0 or args.seconds + args.steps <= 0:
            parser.error("Supply a positive budget extension")
        def extend(value):
            if value["active"] or value["status"] in ("running", "canceled"):
                raise Conflict("Cannot extend active or canceled runs")
            value["remaining_seconds"] += args.seconds
            value["remaining_steps"] += args.steps
            for task in value["tasks"]:
                if task["status"] == "blocked" and not task["question"]:
                    task["status"] = "queued"
            return {"seconds": args.seconds, "steps": args.steps}
        result = store.change(args.run_id, "budget_extended", extend)
    elif args.command == "background":
        guard_quality(store, args.run_id)
        log = store.root / "runs" / args.run_id / ("background-" + uid() + ".log")
        with log.open("w") as out:
            proc = subprocess.Popen([sys.executable, str(HERE / "supervise.py"), "--project", str(store.project),
                                     args.run_id, "--provider", args.provider, "--worker-timeout", str(args.worker_timeout),
                                     "--verify-timeout", str(args.verify_timeout)], stdin=subprocess.DEVNULL,
                                    stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        result = {"pid": proc.pid, "log": str(log), "run_id": args.run_id, "status": "launch_requested"}
    else:
        if args.worker_timeout <= 0 or args.verify_timeout <= 0:
            parser.error("Timeouts must be positive")
        def interrupted(signum, frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, interrupted)
        result = run_loop(store, args.run_id, args.provider, args.worker_timeout, args.verify_timeout)
    emit(result)
    if args.command == "run" and result["status"] != "complete":
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, Conflict, OSError, RuntimeError) as exc:
        emit({"error": str(exc), "type": type(exc).__name__})
        sys.exit(1)
