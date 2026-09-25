# DevOps and operational changes

Start by identifying the actual system, account/environment, artifact revision, affected service and desired result. Inspect existing deployment/CI/configuration conventions, status, logs, metrics and recent changes. A local config that parses proves less than a successful staging rollout; a staging pass proves less than production health. State the boundary tested.

## Prepare a verifiable change

Use current official provider documentation for unfamiliar commands and changing behavior. Determine the blast radius, data/state affected, existing authorization, and the recovery path before mutation. Never infer permission to deploy production from permission to fix CI or prepare a plan. Conversely, do not ask again when the exact target/action is already authorized.

For a consequential rollout, make a compact change record using existing project/run artifacts:

- Target and artifact/config revision; dependencies and preconditions.
- Expected change, meaningful preflight checks, and plan/diff or dry-run output where supported.
- Rollout sequence appropriate to the system, with named health signals, observation interval and abort thresholds grounded in existing SLOs/baselines.
- Rollback/recovery command or procedure, prerequisites, and who/what can execute it. For irreversible data changes, describe a forward repair or tested restore path; do not pretend reverting code restores data.
- Evidence paths, current status, and exact remaining authorization if any.

Validate/build and exercise an isolated or staging environment when available. Check that a supposed dry-run is actually non-mutating. Prepare everything already authorized before asking for a missing production decision; the user should see a concrete result.

## Execute and observe

Use the existing deployment system and secret handling. Keep credentials out of packets, logs and shared artifacts. Capture sanitized command/result, time, target, artifact identity and remote operation/request ID where available. Prefer a staged/canary rollout when the system supports meaningful comparison; do not invent a canary platform for a small task.

After mutation, observe actual service behavior and relevant error/latency/saturation signals for the agreed interval. A CLI exit zero or green pipeline alone does not establish application health. If thresholds fail, execute the preauthorized recovery or surface the precise missing decision; preserve the evidence.

On timeout or ambiguous response, inspect remote status using the operation ID and desired state before considering a retry. A failed client response does not establish that the server did nothing. Use documented idempotency only where it exists. Do not dispatch deployment, migration, payment or communication actions into the CLI runtime's automatic retry loop; it has no exactly-once remote guarantee.

For incidents, stabilize the affected service within authority, preserve a timeline, test competing explanations against logs/metrics, and separate mitigation from root-cause confidence. Record follow-up defects without expanding the incident into an unrelated refactor.

Sources: [Google SRE canarying](https://sre.google/workbook/canarying-releases/) and [overload/retry behavior](https://sre.google/sre-book/handling-overload/). Apply their operational principles to the actual deployment system; provider-specific commands must be verified separately.
