# Native task dispatch with real skill bundles

Use this route for substantial work delegated through the current host. It works on native Windows because the host owns agent execution; it is distinct from the Linux/WSL managed supervisor. Do not attach both to the same work. The dispatcher does not launch a service or rewrite the skill.

## Prepare, execute, verify

1. Identify independent tasks, actual prerequisites and observable outcomes. Read the host's currently available models/tools and available concurrency. Reserve one slot for the coordinator. Classify complexity and consequence using the actual task, not just keywords. A task with unclear success criteria is not a cheap extraction task.
2. Write a compact spec and host catalog under the task's existing evidence directory. Include only task facts, not chat/history/memory. Model IDs must be the exact values this host supports; the script does not discover account entitlements. Match tiers to the current model capabilities, not a permanent price ranking. The user's model choice takes priority: provide only eligible models if they specify one.
3. Run the compiler with a fresh output directory:

```text
py <skill>/scripts/dispatch.py --spec <spec.json> --host <host.json> --output <fresh-packets-directory>
```

4. Read `plan.json`. For each ready task, run its packet's `verification_argv`, then call the host's spawn tool with `spawn_args` (fresh context, exact selected model/effort and embedded message). Workers repeat the integrity check before using support files. Other hosts may need an equivalent task API; preserve the selected role, content and model only when supported. If no native delegation API exists, execute useful work directly and disclose lost independence; do not pretend the packet launched an agent. Review packets deliberately omit `spawn_args`: use the isolated [review helper](review.md) with raw evidence.
5. Inspect actual returned artifacts and checks. A task's completion claim does not satisfy its dependents. Dispatch subsequent batches only after prerequisite outcomes are established; replan after failures or new requirements. Keep shared source edits single-owner. On repeated failures, find the missing evidence/tool/requirement before escalating the model; upgrading the model cannot install a missing tool.

The dispatcher validates the dependency graph, limits each batch to available slots, and places at most one builder in a batch. This does not enforce an OS sandbox, verify task success, or prevent a human from launching extra workers. Root owns integration and progress updates.

## Input contract

`spec.json` uses an existing absolute project directory and tasks with these fields:

```json
{
  "project": "/absolute/project",
  "max_parallel": 3,
  "tasks": [{
    "id": "inspect-failure",
    "role": "research",
    "domain": "development",
    "mode": "debug",
    "complexity": "medium",
    "risk": "normal",
    "instruction": "Reproduce the reported local save failure and identify its real entry point. Source is read-only.",
    "criteria": ["Recorded actual expected/observed behavior and source location"],
    "depends_on": []
  }]
}
```

Roles: `research`, `build`, `qa`, `review`. Domains: `development`, `research`, `frontend`, `devops`. Modes: `feature`, `debug`, `refactor`, `research`, `design`, `verify`, `operations`. Complexity: `low`, `medium`, `high`; risk: `normal`, `high`. Optional `skills` selects explicit registered IDs; otherwise all matching automatic registry entries are used. Optional `attempts_without_progress` records observed attempts, not an invented urgency score.

QA defaults to execution with production and frozen checks read-only. Before freezing a new contract, create its authorized QA workspace, then give a QA-author task `qa_phase: "author"` and explicit absolute existing directories in `write_paths`, contained in the spec's existing absolute `qa_root`. This is the designated QA workspace, not permission to edit production or tests of an already-running contract. The coordinator chooses that scope from actual authorization. The compiler validates path containment and rejects symlink/junction paths; the host must enforce permissions for stronger isolation.

`host.json` has `max_parallel` and `models`, each with `id`, `tier` (`fast`, `standard`, `strong`) and supported `efforts`. Supply current host capabilities. On the host used for this upgrade, Luna is suitable for bounded inspection, Sol for implementation/research, and Astra for difficult judgment; this is a routing choice, not an assertion of permanent pricing or availability.

Low-complexity, normal-risk research/QA with explicit outcomes uses the fast tier. Build/medium work uses standard. High complexity, high consequence or independent review selects strong. Two observed attempts without progress raise the requirement one tier. If that tier is missing, the compiler can choose an available stronger tier and reports it; it will not silently choose a weaker one. Effort must be supported by the selected model. Fast/strong prefer high, standard prefers medium; current user instructions may narrow the supplied catalog.

## What is actually installed

`registry.json` is the execution inventory. The six upstream bundles live under `vendor/` with their supporting files and licenses. `vendor/provenance.json` records exact repository commits and our adaptations. The compiler verifies the complete selected bundle's recorded hashes before embedding its entrypoint text into the worker message; support paths are absolute. `dispatch.py --verify-packet <packet.json>` checks the pinned registry and live files again at dispatch/use time. Changed/missing selected content fails visibly. These are point-in-time checks, not continuous monitoring or adversarial write prevention. Recheck/review before updating hashes, never regenerate them merely to silence a mismatch.

Automatic routes include Matt Pocock's diagnosis for development debugging, codebase design for refactoring, and TDD for independent QA; Anthropic's frontend design for requested visual design; and Depth Engine's research, operations and product playbooks. The two pstack verification skills are explicit selections: choose `pstack-create-verification-skill` when a project has no usable verification map, or `pstack-maintain-verification-skill` when an existing map has drifted. This prevents every QA task from creating another harness.

Install the registry and its complete file inventory together. Missing files in any registered bundle invalidate the installation, even when that bundle is not selected for the current task. To intentionally remove a bundle, review and update the registry as part of that change. Selected bundles additionally receive content-hash checks. Final serialized task packets must fit the verifier's 2 MB input limit; excessive packets are rejected before creating the output directory. Verification checks the exact worker message, model and effort against the packet's authoritative fields; it is a consistency check, not a signature authenticating an original specification.

Raw upstream content retains attribution. The packet's adaptation controls replace incompatible Cursor-only paths, nested delegation, mandatory publication and builder-owned tests. Upstream helpers are not automatically executed. The existing managed CLI runtime remains unchanged and uses its older provider-default model selection; these native packets are not silently injected into active managed runs.
