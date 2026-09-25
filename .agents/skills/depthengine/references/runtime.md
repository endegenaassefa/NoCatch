# Running and resuming work

This release supports Python 3.10+ on Linux/WSL with Linux pidfds, SQLite, and installed authenticated Codex/Claude CLIs. Native Windows/macOS process supervision is not implemented. The skill can still guide conversational work there. Use one project folder containing the editable source; generated evidence belongs under `.depthengine` and is excluded from source hashes. Do not put secrets in task packets.

Choose conversational execution when the current host can complete the task without managed cross-host/background coordination. On unsupported native Windows/macOS, save an explicit artifact checkpoint for substantial work: project identity, outcome/criteria, decisions, source/evidence pointers, available tools, current owner, remaining work and next action. Label it `execution: conversational; managed run: none`. This is continuity documentation, not transactional state or a persistent supervisor. Never invent a run ID. A deliberate WSL handoff needs its own verified tools, paths, ownership checkpoint and new/explicitly selected run; do not silently translate a live Windows task into WSL.

Resolve `scripts/depth.py` relative to this skill's actual installation directory. All examples below abbreviate that absolute path as `DEPTH`; substitute it rather than assuming PATH registration.

## Prepare a run

Write a JSON specification, with a meaningful check program outside the worker's editable source where practical:

```json
{
  "goal": "Fix signup and verify the user can return after reloading",
  "context": {"audience": "new members", "constraints": "local development only"},
  "quality": {
    "builder": "signup-builder",
    "qa_author": "independent-signup-qa",
    "requirements": [
      {"id": "signup-behavior", "behavior": "Valid signup survives reload; invalid input shows a usable error", "basis": "Approved signup outcome and session lifecycle", "checks": ["valid_signup", "session_reload", "invalid_input"]}
    ],
    "acceptance_files": ["/absolute/check_signup.py"],
    "protected_paths": ["tests"],
    "calibration": {"positive": "/absolute/evidence/known-correct.json", "negative": "/absolute/evidence/known-broken.json"}
  },
  "tasks": [{
    "id": "signup",
    "role": "build",
    "surface": "web",
    "instruction": "Reproduce and fix the signup failure, preserving the existing design.",
    "criteria": ["Valid signup succeeds", "Reload preserves the session", "Invalid input shows a usable error"],
    "depends_on": [],
    "verify": ["python3", "/absolute/check_signup.py", "--project", "{project}", "--evidence", "{evidence}"],
    "required_checks": ["valid_signup", "session_reload", "invalid_input"]
  }]
}
```

The verifier must actually perform those checks, exit zero only on success, and emit only this JSON to stdout (diagnostic chatter goes to stderr):

```json
{"passed": true, "checks": [{"name": "valid_signup", "passed": true}, {"name": "session_reload", "passed": true}, {"name": "invalid_input", "passed": true}]}
```

False, skipped, missing, duplicated or malformed checks fail. Specify required checks before dispatch. Inspect the checker independently of the implementation; the runtime validates the result protocol, not the checker’s semantic quality. The executable and existing file arguments (absolute, relative or using `{project}`) are pinned by content and executable bits at run creation. Declare additional imported check helpers in `verify_files`. Undeclared transitive imports and external services are not fully attested. A changed checker requires a reviewed new run.

```text
python3 DEPTH --project /absolute/app start --spec /absolute/spec.json --seconds 1800 --steps 12 --attempts 3
python3 DEPTH --project /absolute/app run RUN_ID --provider codex
python3 DEPTH --project /absolute/app status RUN_ID
python3 DEPTH --project /absolute/app packet RUN_ID --task signup
python3 DEPTH --project /absolute/app run RUN_ID --provider claude
```

`start` only records work; `run` explicitly executes/resumes it. `packet` and `status` do not schedule workers. `run` exits 0 only for completion, 2 for an unfinished outcome, and 1 for an invocation/runtime error. Status shows `current_source_matches` and `effective_status` for a previously completed run; historical completion is not evidence for later edits. Completion records checks at a point in time, not a frozen filesystem snapshot or protection against later external edits.

## Background work, steering, limits

New execution requires the [quality contract](quality.md). A separate QA agent authors and calibrates acceptance files before `start`; actor labels and calibration descriptions record provenance, not cryptographic proof of independence. Guards check acceptance/test/config integrity before and after workers/verifiers. Changed checks block execution. Legacy runs can still be inspected or controlled, but require a reviewed replacement run for execution; never silently retrofit a running task. Follow [adoption](adoption.md).

Provider defaults to `auto`; an explicit CLI provider overrides task preference. See [routing/context](routing-context.md) for roles, tools and fresh task packets. `handoff` launches a fresh worker within the original budgets. The 250K policy is not a hard cutoff without host current-context telemetry and per-request interception.

```text
python3 DEPTH --project /absolute/app background RUN_ID --provider codex
python3 DEPTH --project /absolute/app pause RUN_ID
python3 DEPTH --project /absolute/app decide RUN_ID "The primary audience is solo founders."
python3 DEPTH --project /absolute/app decide RUN_ID "Use team admins as the audience." --supersedes DECISION_ID
python3 DEPTH --project /absolute/app run RUN_ID --provider claude
python3 DEPTH --project /absolute/app cancel RUN_ID
```

`background` launches a supervisor and returns a PID/log path. The supervisor restarts an unexpectedly killed coordinator at most twice; it does not restart semantic failures, canceled work or pending questions. It needs to remain running and is not an OS boot service. After terminal or machine shutdown, explicitly resume the known run; no unattended boot startup is installed. The same saved budgets apply after restarts.

Pause/cancel revoke the epoch immediately. Active workers are then stopped and reconciled. `active != null` means cleanup is still pending: do not claim all work stopped yet. `cleanup RUN_ID` reconciles a crashed worker under the project lock. Cancel is terminal. Pause and decide do not silently restart execution. A decision invalidates prior completion, revokes active work and resets attempts; resume explicitly. Changes to task scope/checks need a new reviewed specification, not just a contradictory decision.

Questions are stored on blocked tasks; independent ready tasks continue, including when another task has exhausted its attempts. Surface the specific question to the user and record the answer with `decide`. The background runtime stores questions in state/logs; it has no push-notification integration. Worker blockers default to `blocker_kind: decision` and require an answer. A `tool` blocker can be rechecked without relaunching its worker; this lets coordinator verification establish success when a worker could edit but could not execute tests. Failed rechecks and crash recovery preserve the blocker. A passing test never answers a pending product/user decision.

Default budget: 30 minutes of managed process time, 12 worker invocations total, 3 attempts per task. Worker timeout 300 seconds; verifier timeout 120 seconds; both configurable on run/background. Each launched process has a watchdog independent of the coordinator. Recovery charges elapsed monotonic time; after reboot or for legacy clocks it conservatively charges the reservation. These bound managed invocations/time, not dollars, tokens, coordinator overhead or user waiting time. Do not automatically replenish them. When authorized, `extend RUN_ID --seconds 600 --steps 2` adds budget; recording a substantive decision resets task attempts. Provider failures have bounded retries and retained logs, not endless retry loops.

## Recovery and evidence

`.depthengine/state.sqlite3` stores canonical state and unique audit events. `.depthengine/runs/RUN_ID/` stores packets, process output, receipts and screenshots. Keep that directory out of Git/public uploads; it can contain project context and authenticated CLI output. Back it up using SQLite's backup API while idle or via a consistent database backup.

Transactions prevent lost updates; a stable OS file lock permits one coordinator across all runs in a project. A gated launcher records the process identity before releasing work. Recovery terminates prior owned processes before reuse. Epoch checks reject late results. Source fingerprints include untracked files and exclude `.git`, `.depthengine`, dependencies/venvs and Python caches; source symlinks and projects exceeding the configured 20,000-file/256MiB limits are rejected. Narrow the working root for larger projects.

These are cooperative local-agent controls, not an adversarial sandbox. Host tools can still write outside the state protocol if their permissions allow it. The engine preserves host permission controls; it does not bypass them. Daemons that escape/reparent before a coordinator crash may need a stronger container/cgroup boundary. External mutations are outside this release's automatic retry contract: don't dispatch payments, production deployments, communications or migrations as repeatable worker tasks. There is no exactly-once remote-operation guarantee.
