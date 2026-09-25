"""CLI adapters and Linux/WSL process ownership; standard library only.

Caller supplies prompt_path on stdin, cwd=project and start_new_session=True,
and env DEPTHENGINE_PROCESS_TOKEN set to a fresh uuid4 hex per launched process.
Persist identity immediately after Popen and BEFORE waiting. Never use shell=True.
Claims/results are not permission boundaries: the host's tool policies still apply.
Children must not daemonize: a process escaping its session before a crash cannot
be attributed safely from only the persisted leader identity. Use a cgroup for
hostile workloads; these helpers manage cooperative CLI workers.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

RESULT_CONTRACT = '''End with one JSON object, without markdown:
{"status":"ready"|"blocked"|"handoff","summary":"what changed and what was observed","artifacts":["project-relative raw evidence paths for a handoff"],"question":"specific blocker, only when blocked","blocker_kind":"decision"|"tool"}.
For blocked results, use decision for missing user input and tool for an unavailable or denied tool.
ready means ready for independent verification, not task completion. Do not claim
tests passed unless you ran them. If a required tool is denied or unavailable,
report blocked with the command/tool and action needed. Do not weaken permissions,
daemonize processes, or modify the coordinator's state/evidence files.
'''


def build_command(provider: str, project: Path, prompt_path: Path, output_path: Path) -> list[str]:
    """Build argv. Authentication/model stay with the installed host defaults."""
    if provider not in {"codex", "claude"}:
        raise ValueError(f"Unsupported provider: {provider}")
    if not Path(project).is_dir() or not Path(prompt_path).is_file():
        raise ValueError("An existing project directory and prompt file are required")
    executable = shutil.which(provider)
    if executable is None:
        raise FileNotFoundError(f"{provider} is not installed/on PATH; run doctor")
    if provider == "codex":
        return [executable, "exec", "--cd", str(Path(project).resolve()),
                "--ephemeral", "--disable", "memories", "-c", "memories.use_memories=false", "-c", "memories.generate_memories=false",
                "--sandbox", "workspace-write", "--skip-git-repo-check",
                "--color", "never", "--output-last-message", str(Path(output_path).resolve()), "-"]
    # acceptEdits permits project edits; shell permissions remain the host's policy.
    # No blanket Bash allow: a denied command must become a visible blocker.
    return [executable, "--print", "--output-format", "json",
            "--no-session-persistence", "--settings", '{"autoMemoryEnabled":false,"disableAllHooks":true}',
            "--permission-mode", "acceptEdits", "--permission-prompts", "none"]


def _object(text: str) -> dict:
    text = text.strip()
    if text.startswith("```json\n") and text.endswith("```"):
        text = text[8:-3].strip()
    elif text.startswith("```\n") and text.endswith("```"):
        text = text[4:-3].strip()
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


def read_result(provider: str, output_path: Path, stdout_path: Path) -> dict:
    """Fail closed on missing/malformed output. Caller must also require exit 0."""
    if provider == "codex":
        result = _object(Path(output_path).read_text())
    elif provider == "claude":
        envelope = _object(Path(stdout_path).read_text())
        if envelope.get("is_error") or envelope.get("subtype") not in (None, "success"):
            raise ValueError("Claude reported an unsuccessful turn")
        if envelope.get("permission_denials"):
            return {"status": "blocked", "summary": "Claude reported tool permission denials",
                    "blocker_kind": "tool",
                    "question": "Resolve the required tool permissions shown in the worker log. If implementation remains, record the resolution with decide to authorize a fresh attempt, then resume; resume alone only rechecks acceptance."}
        result = envelope.get("structured_output")
        if result is None:
            result = _object(envelope.get("result", ""))
    else:
        raise ValueError(f"Unsupported provider: {provider}")
    if not isinstance(result, dict) or result.get("status") not in {"ready", "blocked", "handoff"}:
        raise ValueError("Worker must report status ready, blocked or handoff")
    if not isinstance(result.get("summary"), str) or not result["summary"].strip():
        raise ValueError("Worker result requires a nonempty summary")
    if result["status"] == "blocked" and (not isinstance(result.get("question"), str)
                                            or not result["question"].strip()):
        raise ValueError("Blocked result requires a nonempty question")
    if result["status"] == "blocked":
        result["blocker_kind"] = result.get("blocker_kind", "decision")
        if result["blocker_kind"] not in ("decision", "tool"):
            raise ValueError("blocker_kind must be decision or tool")
    if 'artifacts' in result:
        paths = result['artifacts']
        if (not isinstance(paths, list) or len(paths) > 30 or any(
                not isinstance(p, str) or not p.strip() or len(p) > 1024
                or Path(p).is_absolute() or '..' in Path(p).parts or '\\' in p or ':' in p
                for p in paths)):
            raise ValueError('Handoff artifacts must be at most 30 project-relative paths without ..')
    return {key: result[key] for key in ("status", "summary", "question", "blocker_kind", "artifacts") if key in result}


def _proc(pid: int) -> dict | None:
    if not sys.platform.startswith("linux"):
        raise RuntimeError("Process lifecycle currently supports Linux/WSL only")
    if not isinstance(pid, int) or pid <= 1:
        return None
    try:
        # comm may contain spaces and parentheses; fields after its final ')' start at field 3.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"state": fields[0], "ppid": int(fields[1]), "group": int(fields[2]),
                "session": int(fields[3]), "start": int(fields[19])}
    except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError, ValueError):
        return None


def identity(pid: int) -> str | None:
    proc = _proc(pid)
    if proc is None:
        return None
    token = _marker(pid)
    base = f"{Path('/proc/sys/kernel/random/boot_id').read_text().strip()}:{proc['start']}"
    return f"{base}:{token}" if token else base


def _marker(pid: int) -> str | None:
    try:
        for entry in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
            if entry.startswith(b"DEPTHENGINE_PROCESS_TOKEN="):
                token = entry.partition(b"=")[2].decode("ascii")
                if len(token) == 32 and all(char in "0123456789abcdef" for char in token):
                    return token
    except (OSError, UnicodeError):
        pass
    return None


def alive(pid: int, expected_identity: str | None) -> bool:
    proc = _proc(pid)
    return bool(proc and proc["state"] not in {"Z", "X"} and expected_identity
                and identity(pid) == expected_identity)


def _session_members(leader: int, start: int) -> dict[int, str]:
    members = {}
    for path in Path("/proc").iterdir():
        if path.name.isdigit():
            pid = int(path.name)
            proc = _proc(pid)
            if proc and proc["session"] == leader and proc["start"] >= start and proc["state"] not in {"Z", "X"}:
                token = identity(pid)
                if token:
                    members[pid] = token
    return members


def terminate_owned(pid: int, expected_identity: str | None, grace: float = 2,
                    *, keep_leader: bool = False) -> bool:
    """Stop a recorded session, including descendants in different process groups.

    Reject mismatched/reused PIDs. If the leader has already exited, the inherited
    random marker distinguishes its remnants from a later reused session ID.
    Normally refuse the caller's session. A session-leading watchdog may pass
    keep_leader=True to terminate its descendants while remaining alive to report
    failure. This exception requires its own PID and exact current identity.
    True means no attributable live members (excluding the retained watchdog).
    """
    if not expected_identity or pid <= 1:
        return False
    if keep_leader:
        if pid != os.getpid() or identity(pid) != expected_identity:
            return False
    elif pid == os.getsid(0):
        return False
    try:
        parts = expected_identity.split(":")
        boot, tick = parts[:2]
        marker = parts[2] if len(parts) == 3 else None
        start = int(tick)
    except (ValueError, AttributeError):
        return False
    if boot != Path("/proc/sys/kernel/random/boot_id").read_text().strip():
        # A validated persisted token from another boot cannot own a live process.
        import uuid
        try:
            uuid.UUID(boot)
        except ValueError:
            return False
        return True
    proc = _proc(pid)
    if proc and (identity(pid) != expected_identity or proc["session"] != pid or proc["group"] != pid):
        return False
    def session_targets() -> dict[int, str]:
        members = _session_members(pid, start)
        if keep_leader:
            members.pop(pid, None)
        return members

    targets = session_targets()
    if not proc and targets:
        # Identity of a dead leader alone cannot establish ownership of remnants.
        # Fail closed when wrappers scrubbed the inherited marker.
        if not marker or any(_marker(child) != marker for child in targets):
            return False
    def refresh_targets() -> None:
        targets.update(session_targets())
        # Include children that changed session while still attributable through
        # live parents. The retained watchdog is a discovery root, never a target.
        changed = True
        while changed:
            changed = False
            parents = {child for child, token in targets.items() if alive(child, token)}
            if keep_leader:
                parents.add(pid)
            for path in Path("/proc").iterdir():
                if path.name.isdigit():
                    child = int(path.name)
                    info = _proc(child)
                    if (child != pid and info and child not in targets
                            and info["ppid"] in parents and info["state"] not in {"Z", "X"}):
                        token = identity(child)
                        if token:
                            targets[child] = token
                            changed = True

    def deliver(sig: int) -> None:
        refresh_targets()
        for child, token in list(targets.items()):
            if alive(child, token):
                try:
                    # pidfd avoids a check/kill PID-reuse race on supported kernels.
                    fd = os.pidfd_open(child)
                    try:
                        if alive(child, token):
                            signal.pidfd_send_signal(fd, sig)
                    finally:
                        os.close(fd)
                except ProcessLookupError:
                    pass
    deliver(signal.SIGTERM)
    deadline = time.monotonic() + max(0, grace)
    while time.monotonic() < deadline:
        if not any(alive(child, token) for child, token in targets.items()) and not session_targets():
            return True
        time.sleep(0.025)
    deliver(signal.SIGKILL)
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        if not any(alive(child, token) for child, token in targets.items()) and not session_targets():
            return True
        time.sleep(0.025)
    return False


def doctor() -> dict:
    result = {"platform": sys.platform, "process_lifecycle": sys.platform.startswith("linux")
              and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")}
    for provider in ("codex", "claude"):
        executable = shutil.which(provider)
        info = {"installed": bool(executable), "path": executable, "authentication": "not_checked"}
        if executable:
            try:
                check = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=10)
                info.update(version=check.stdout.strip(), exit_code=check.returncode)
            except (OSError, subprocess.TimeoutExpired) as error:
                info["error"] = str(error)
        result[provider] = info
    return result
