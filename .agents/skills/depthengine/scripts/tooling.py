"""Pinned, local browser setup and honest capability checks (no account mutations)."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid
from urllib.parse import quote

import adapters

DEFAULT_PREFIX = Path.home() / ".local/share/depthengine/tools"
BROWSER_VERSION = "0.38.1"


def resolve_browser(prefix: Path = DEFAULT_PREFIX) -> str | None:
    path = shutil.which("agent-browser")
    local = Path(prefix).expanduser() / "node_modules/.bin/agent-browser"
    return path or (str(local) if local.is_file() and os.access(local, os.X_OK) else None)


def browser_environment() -> dict[str, str]:
    """Return only selected browser overrides, never expose the full environment."""
    configured = os.environ.get("AGENT_BROWSER_EXECUTABLE_PATH")
    if configured:
        return {"AGENT_BROWSER_EXECUTABLE_PATH": configured}
    candidates = list((Path.home() / ".cache/ms-playwright").glob("chromium*/chrome-linux64/chrome"))
    candidates += list((Path.home() / ".cache/ms-playwright").glob("chromium*/chrome-linux/chrome"))
    candidates = [path for path in candidates if path.is_file() and os.access(path, os.X_OK)]
    if candidates:
        selected = max(candidates, key=lambda path: path.stat().st_mtime)
        return {"AGENT_BROWSER_EXECUTABLE_PATH": str(selected)}
    return {}


def _command(command: list[str], timeout: float = 30, env: dict | None = None) -> dict:
    try:
        result = subprocess.run(command, capture_output=True, text=True, env=env, timeout=timeout)
        return {"argv": command, "exit_code": result.returncode,
                "stdout": result.stdout[-12000:], "stderr": result.stderr[-4000:]}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"argv": command, "exit_code": None, "error": str(error)}


def smoke_browser(browser: str, executable_path: str | None = None) -> dict:
    """Actually navigate, inspect DOM, interact and close one isolated session."""
    session = "depth-doctor-" + uuid.uuid4().hex[:12]
    commands = []
    functional = False
    cleanup_ok = False
    with tempfile.TemporaryDirectory(prefix="depth-browser-") as socket_dir:
        overrides = browser_environment()
        if executable_path:
            overrides["AGENT_BROWSER_EXECUTABLE_PATH"] = executable_path
        env = {**os.environ, **overrides, "AGENT_BROWSER_SOCKET_DIR": socket_dir}
        html = '''<!doctype html><html lang="en"><title>Depth browser check</title>
<button onclick="document.querySelector('p').textContent='Interaction verified'">Check browser</button>
<p>Waiting for interaction</p></html>'''
        def call(*args: str) -> dict:
            result = _command([browser, "--session", session, *args], env=env)
            commands.append(result)
            return result
        try:
            opened = call("open", "data:text/html;charset=utf-8," + quote(html))
            if opened["exit_code"] == 0:
                snapshot = call("snapshot", "-i")
                if snapshot["exit_code"] == 0 and "Check browser" in snapshot.get("stdout", ""):
                    clicked = call("click", "button")
                    after = call("snapshot")
                    functional = (clicked["exit_code"] == 0 and after["exit_code"] == 0
                                  and "Interaction verified" in after.get("stdout", ""))
        finally:
            closed = call("close")
            cleanup_ok = closed["exit_code"] == 0
    return {"status": "passed" if functional and cleanup_ok else "failed", "session": session,
            "interaction_verified": functional, "cleanup_verified": cleanup_ok,
            "browser": browser, "environment": overrides, "commands": commands,
            "scope": "Local synthetic page only; website authentication and application journeys not checked"}


def doctor(prefix: Path = DEFAULT_PREFIX, smoke: bool = False) -> dict:
    result = adapters.doctor()
    browser = resolve_browser(prefix)
    info = {"installed": bool(browser), "path": browser,
            "environment": browser_environment(), "authentication": "not_applicable_local_browser",
            "functional": {"status": "not_checked"}}
    if browser:
        version = _command([browser, "--version"], timeout=10)
        info["version"] = version.get("stdout", "").strip()
        info["version_exit_code"] = version["exit_code"]
        if "error" in version:
            info["error"] = version["error"]
        if smoke:
            info["functional"] = smoke_browser(browser)
    elif smoke:
        info["functional"] = {"status": "failed", "reason": "agent-browser is not installed"}
    result["agent-browser"] = info
    return result


def setup_browser(prefix: Path = DEFAULT_PREFIX, install_chromium: bool = False) -> dict:
    prefix = Path(prefix).expanduser().resolve()
    npm = shutil.which("npm")
    if not npm:
        return {"status": "failed", "reason": "npm is required for the local browser installation"}
    prefix.mkdir(parents=True, exist_ok=True)
    install = _command([npm, "install", "--prefix", str(prefix), "--no-audit", "--no-fund",
                        "--save-exact", f"agent-browser@{BROWSER_VERSION}"], timeout=180)
    report = {"prefix": str(prefix), "requested_version": BROWSER_VERSION, "install": install}
    if install["exit_code"] != 0:
        return {**report, "status": "failed", "reason": "npm installation failed"}
    browser = str(prefix / "node_modules/.bin/agent-browser")
    version = _command([browser, "--version"], timeout=10)
    report["version"] = version
    if version["exit_code"] != 0 or version.get("stdout", "").strip().split()[-1:] != [BROWSER_VERSION]:
        return {**report, "status": "failed", "reason": "Installed browser version did not match the pin"}
    if install_chromium:
        report["chromium_install"] = _command([browser, "install"], timeout=240)
        if report["chromium_install"]["exit_code"] != 0:
            return {**report, "status": "failed", "reason": "Chromium installation failed"}
    report["functional"] = smoke_browser(browser)
    report["status"] = report["functional"]["status"]
    report["worker_context"] = {"browser": browser, "environment": browser_environment(),
                                "core_skill_command": [browser, "skills", "get", "core", "--full"]}
    if report["status"] != "passed":
        report["reason"] = "Browser installed but functional check failed; inspect logs or retry with --install-chromium"
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("doctor", help="Versions and availability; add --smoke for a real browser check")
    inspect.add_argument("--smoke", action="store_true")
    inspect.add_argument("--prefix", type=Path, default=DEFAULT_PREFIX)
    setup = commands.add_parser("setup-browser", help="Install pinned agent-browser into a local directory and exercise it")
    setup.add_argument("--prefix", type=Path, default=DEFAULT_PREFIX)
    setup.add_argument("--install-chromium", action="store_true")
    args = parser.parse_args()
    if args.command == "doctor":
        report = doctor(args.prefix, args.smoke)
        failed = args.smoke and report["agent-browser"]["functional"]["status"] != "passed"
    else:
        report = setup_browser(args.prefix, args.install_chromium)
        failed = report["status"] != "passed"
    print(json.dumps(report, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
