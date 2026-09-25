# Independent test ownership

Use separate authoring sessions/agents for implementation and QA. Give QA the original goal, discovered requirements and relevant real interfaces. Give the builder the approved requirements and read/run access to tests, not write ownership. A coordinator doing production repairs counts as a builder. Existing tests can be adopted after independent inspection; do not discard useful tests because an earlier builder authored them.

Before `start`, QA must author/calibrate the acceptance suite and inspect its helpers/configuration. No source changes by QA; broken-variant calibration belongs in disposable copies. Use deterministic checks for objective behavior, exploratory interaction for usability/real integration, and packet review for additional code judgment. Fixtures should replace unavailable external systems, not reimplement the production logic being evaluated.

Each new CLI run requires `quality` beside `goal`, `context` and `tasks`:

```json
{
  "builder": "builder-session-id",
  "qa_author": "different-qa-session-id",
  "requirements": [{
    "id": "cancel-ownership",
    "behavior": "Cancelling setup leaves unrelated chat running.",
    "basis": "Existing product decision; source path and API documentation pointer",
    "checks": ["setup_cancel_preserves_chat"]
  }],
  "acceptance_files": ["/absolute/qa/check.py", "/absolute/qa/fixtures.json"],
  "protected_paths": ["tests", "scripts/test-onboarding.js", ".github/workflows"],
  "calibration": {
    "positive": "Path to raw run demonstrating known-correct behavior passes",
    "negative": "Path to raw run demonstrating the reproduced/seeded defect fails"
  }
}
```

Every required check must map to a behavior. Declare ALL transitive test helpers, fixtures, snapshots and runner configuration in `acceptance_files` or `protected_paths`, including files outside the project. Existing `verify_files` remains useful for each verifier. Actor labels and calibration descriptions record provenance; the runtime cannot prove the honesty or semantic adequacy of those assertions.

The runtime snapshots explicit acceptance files, protected directories (including membership within the source traversal scope), conventional test files, test configuration, workflow files and package scripts/configuration. Traversal excludes `.git`, `.depthengine`, dependency/venv directories and Python caches, even inside protected directories; declare any needed files there explicitly in `acceptance_files`. It checks before/after workers and verifiers and before completion. Changed, added or removed protected content blocks completion; it is preserved for investigation, not automatically rolled back. Descriptive metadata and dependency/version changes in package.json remain possible; other configuration keys are frozen to cover embedded test configuration. Use an independently reviewed replacement run for legitimate config changes. No bypass flag is provided by CLI start.

These are cooperative change-detection guards, not write-prevention or an adversarial sandbox. A worker with broad filesystem access could transiently modify/restore files or tamper with the runtime. For stronger isolation, mount QA assets read-only in the execution environment or keep their trusted checkout outside builder-writable roots. Permissions must be configured and verified by the host; never claim a path name or hash gives OS isolation.

QA execution after tests are frozen may write evidence under `.depthengine`, but cannot change production or acceptance source. A QA worker's model opinion cannot override executable failures. For GUI requirements include an executable check of the actual interaction artifacts/outcomes, rather than a checker accepting an arbitrary `passed:true` report. Where independent automation cannot verify a native behavior, leave that requirement explicitly unqualified.

Report exact source/test versions, named results, unavailable coverage and repair attempts. Track elapsed time, coordinator rework and retained defect fixes before claiming delegation saved time. Do not use aggregate billed tokens as current context size.
