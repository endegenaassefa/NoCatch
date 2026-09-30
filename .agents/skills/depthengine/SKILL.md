---
name: depthengine
description: Coordinate development, research, DevOps, and product design with task-specific workflows, durable handoff, independent QA, and evidence-based improvement. Activate when the user invokes /depthengine or $depthengine; remain active until turned off.
---

# Depth Engine

Activate for this conversation; acknowledge once and do the authorized task. `off` ends conversational activation. `status` reports activation and any explicitly attached run. A new conversation is inactive and never automatically executes the most recent run. Turning conversational mode off does not cancel an already launched background run; report its ID and use `cancel` if requested.

Do the whole useful task and check the result. Answer small questions directly. For substantial implementation, define observable acceptance criteria, investigate material unknowns, build, exercise actual behavior, and repair failures. Use only the process this task needs. Do not execute a fixed startup lifecycle for every request.

## Select the work and the evidence

Choose the smallest useful workflow from the outcome, uncertainty, and consequences. A wording fix or bounded question needs direct work and a relevant check. Substantial work needs an observable finish condition, evidence, and a bounded repair loop. Increase coordination only for actual dependency, isolation, or continuity needs. A higher agent count is not a quality metric.

| Work | Read when relevant | Completion evidence |
| --- | --- | --- |
| Feature, bug, performance, refactor | [Engineering](references/engineering.md), then discovery as needed | Actual behavior or measured before/after result |
| Market, competitor, technical research | [Research](references/research.md) | Traceable claims, alternatives, uncertainty, adversarial gap check, and decision implications |
| CI, deployment, infrastructure, incident | [Operations](references/operations.md) | Named environment, checks, rollout/recovery evidence within authorization |
| Product or frontend | [Product/design](references/product-design.md) | Journey, rendered states, functional and visual findings |
| Skill/harness improvement | [Improvement](references/improvement.md) | Versioned candidate, independent evaluation, regression results and limits |

Mixed work can use several routes, but load each reference only when its phase needs it. Use [skill composition](references/skill-composition.md) to select actual local specialist skills without importing an entire catalog or another coordinator. For substantial work retain a compact task contract: outcome, scope/exclusions, acceptance evidence, tools available, authorization, and stop condition. Reuse the runtime packet when present; do not create a second state store.

For native-host delegation, use [native dispatch](references/native-dispatch.md) and `scripts/dispatch.py`. It selects task-appropriate models from the current host catalog, checks the bundled skills against `registry.json`, embeds the selected instructions, and produces ready-to-use spawn arguments and dependency batches. Execute those packets with the host's collaboration tools; generating packets alone does not do the task. Independent research and QA can run in parallel within the available slots; shared production edits remain serialized. Small direct tasks do not need dispatch.

## Decide and ask

Read the project and existing decisions before asking. For substantial features, follow [discovery](references/discovery.md): derive observable behavior from the user's outcome, existing contracts, official documentation and relevant lifecycle/failure patterns. Independently challenge requirements before coding. The user need not know every edge case. Resolve researchable engineering obligations yourself; present consequential product choices with a recommendation. Keep customer assumptions separate from observed facts. Do not expand product scope while filling reliability gaps.

For existing projects or work started without this process, follow [adoption](references/adoption.md). Preserve working code, dirty edits and historical evidence; validate a stable baseline before proposing repairs. Never hot-swap rules into a running task or assume old code is defective because evidence is missing.

## Execute and preserve context

Use native host continuation when sufficient. For durable cross-host or background execution, read [references/runtime.md](references/runtime.md) and check platform/tool support first. On supported Linux/WSL, create a scoped run with explicit project identity, tasks, dependencies, criteria, and executable verification. The runtime handles transactional state, ownership, budgets, recovery and evidence. Native Windows/macOS can use conversational work and an explicit artifact checkpoint; they cannot use this release's managed process supervisor. Do not launch a second coordinator or pretend a notes file is a supervised run.

Read the run's `packet` on attach/resume. Record user answers with `decide`; use `--supersedes` for replaced decisions. The state store is authoritative; prose summaries and old transcripts are source material. Retain `Depth Engine: active`, the run ID, project path, decisions, evidence paths and unfinished work in conversation compaction/handoffs. Never select a run by “latest.”

Use [routing and context management](references/routing-context.md) to assign build, QA, research and isolated review to suitable available tools. Delegate independent discovery/QA with fresh contexts when useful; do not send the full conversation. The coordinator owns scope and integration; it must not become its own test author when repairing implementation. A worker must not start a nested coordinator, modify runtime state or acceptance checks, or expand its authorization. This release serializes project edits across hosts; parallel code-editing swarms are not implemented.

Context ceiling is 250,000 tokens for every role; initiate fresh handoff at 225,000 or earlier for the model's actual limit. Use current-context telemetry, not cumulative usage. Pass only approved task facts and artifact pointers, never previous chat, scratchpads or personal memory. CLI workers start fresh with saved-memory loading disabled where supported. A skill cannot measure/reset an opaque root host: disclose unavailable telemetry and use bounded fresh tasks; do not claim a hard 250K cap is enforced. Compaction is not a fresh isolated agent.

Keep advancing ready tasks, checking results and saving evidence until complete, genuinely blocked, canceled, or out of the stated budget. A limit is not success. Do not repeatedly ask permission already granted. Background work needs a live supervisor; a markdown instruction cannot survive host shutdown.

## Choose working tools

Read [references/tools.md](references/tools.md) before browser work or dependency setup. Run the relevant tool doctor and use its actual executable paths. Prefer a verified interaction driver for app QA; use official docs/search or structured retrieval for research. `scripts/browser_read.py` provides verified OpenCLI retrieval through the user's connected browser when ordinary retrieval is insufficient or OpenCLI is requested. It saves the actual source and a timestamp/hash receipt. Use Agent-Reach only for a needed supported channel after installing and validating that adapter. Do not substitute a page read for testing an app journey.

For product or frontend work, read [references/product-design.md](references/product-design.md). Carry audience, primary journey, design choices and required states into task criteria. Inspect real screens at relevant viewports; screenshots support judgment but do not establish data correctness.

For app behavior, follow [exploratory QA](references/exploratory-qa.md). Give a separate QA agent actual interaction tools: navigate, click, type, cancel, reload, observe and record expected/actual behavior. Electron renderer testing, native dialogs, physical hardware and backend outcomes are distinct evidence. Route web/Electron to the verified browser tool and native Windows controls to the explicit-window desktop driver; never substitute static source review for interaction.

## Earn completion

Follow [independent test ownership](references/quality.md). Coding agents may read/run tests but must not author, edit, delete or weaken them, including fixtures and test configuration. Separate QA authors/calibrates tests before a build run freezes their files. QA may challenge a wrong test against the requirement through a new reviewed contract; the builder cannot change its exam. Check the real production boundary rather than recreating it in a fake implementation.

A worker's `ready`, exit zero, screenshot or model opinion cannot pass a task alone. Require all named checks, unchanged QA-owned files, fresh source evidence and successful cleanup. Repair observed failures and rerun their original checks. Calibrate important tests with correct and known-broken controls. Turn demonstrated failures into QA-owned regressions and applicable checklist improvements; avoid accumulating speculative tests. Version-2 runtime guards detect persistent test edits; they are not an adversarial OS sandbox.

For consequential changes, use an independent reviewer through [references/review.md](references/review.md) and `scripts/review.py`. Give criteria and raw artifacts, not author rationale or prior verdicts. Review cannot override failed tests. If unavailable, state that limitation and keep unverified conclusions provisional. Stop review loops when two rounds add no material progress; name the remaining issue.

Report what changed, evidence actually obtained, run status and any material limitation. Do not claim production readiness from a local fixture. Publication, external messages, customer data changes and other external effects require authorization within the task's actual scope; the runtime does not grant it.

When asked to improve this skill, use the improvement route. During other work, retain a concise evidence-backed lesson when useful; changing a global skill is separate work unless already authorized. Do not hot-swap a running task's contract, rewrite failed results, or call a prompt edit model learning.
