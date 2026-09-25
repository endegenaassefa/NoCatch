#!/usr/bin/env python3
"""Keep a background coordinator alive across a bounded number of crashes.

This process must itself remain alive; machine/reboot recovery needs a host service.
Saved budgets are never replenished by restarting.
"""
import argparse
import json
import math
import signal
import subprocess
import sys
import time
from pathlib import Path

from state import Conflict, Store, project_lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("run_id")
    parser.add_argument("--provider", required=True, choices=("codex", "claude"))
    parser.add_argument("--worker-timeout", type=float, default=300)
    parser.add_argument("--verify-timeout", type=float, default=120)
    parser.add_argument("--restarts", type=int, default=2)
    args = parser.parse_args()
    if args.restarts < 0 or not all(math.isfinite(x) and x > 0 for x in (args.worker_timeout, args.verify_timeout)):
        parser.error("Invalid restart or timeout limit")
    store = Store(args.project)
    child = None
    stopped = False
    def stop(signum, frame):
        nonlocal stopped
        stopped = True
        if child and child.poll() is None:
            child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    for restart in range(args.restarts + 1):
        if stopped:
            return 2
        run = store.get(args.run_id)
        if run["status"] in ("canceled", "awaiting_input", "budget_exhausted", "blocked"):
            return 2
        command = [sys.executable, str(Path(__file__).with_name("depth.py")), "--project", str(store.project),
                   "run", args.run_id, "--provider", args.provider,
                   "--worker-timeout", str(args.worker_timeout), "--verify-timeout", str(args.verify_timeout)]
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL)
        print(json.dumps({"supervisor": "coordinator_started", "pid": child.pid, "restart": restart}), flush=True)
        code = child.wait()
        if stopped or code >= 0:
            return code if code >= 0 else 2
        if store.get(args.run_id)["status"] == "paused":
            return 2
        print(json.dumps({"supervisor": "coordinator_crashed", "returncode": code, "restart": restart}), flush=True)
        time.sleep(min(1 + restart, 3))
    from depth import recover
    try:
        with project_lock(store):
            recover(store, args.run_id)
            def exhausted(value):
                if value["status"] == "running":
                    value["status"] = "blocked"
                    value["epoch"] += 1
                value["coordinator"] = None
                value["last_error"] = "Background coordinator restart budget exhausted"
                return {"error": value["last_error"]}
            store.change(args.run_id, "restart_budget_exhausted", exhausted)
    except Conflict as exc:
        print(json.dumps({"supervisor": "cleanup_pending", "error": str(exc)}), flush=True)
    print(json.dumps({"supervisor": "restart_budget_exhausted", "run": args.run_id}), flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(main())
