# Routing and fresh context

Use a small explicit routing table before adding a planner that chooses other planners. The coordinator reads the outcome and assigns each task a role and application surface. `scripts/routing.py` returns the role, available provider, interaction tool and write scope. The runtime records that route before launching a worker.

| Role | Responsibility | Code access |
| --- | --- | --- |
| Discovery/research | Derive behavior, investigate contracts, challenge assumptions | Read only during a frozen run |
| Build | Implement the approved behavior | Production source; acceptance files protected |
| QA | Independently author and calibrate checks before freezing; exercise the app afterward | QA-owned checks before freezing; read-only source during the run |
| Review | Challenge a raw evidence packet | Tool-free isolated `review.py`, never a generic worker |

Use separate fresh agents for discovery/QA when they add useful independence. A small change does not need a swarm. The coordinator may integrate production changes but cannot author or weaken their acceptance tests. QA test creation happens before `start`; the runtime's `qa` role is execution-only and cannot change the frozen project. If a requirement or test is wrong, QA reviews the correction and creates a new contract/run instead of silently modifying the old one.

Tasks may set `role`, `surface`, and `provider`. Supported surfaces are `web`, `electron`, `native`, `api`, `cli`, and `library`. Browser tools handle web and Electron renderers; the Windows desktop driver handles visible native controls. Research uses official search/structured clients. A tool route is an instruction, not an installed capability: confirm actual availability with doctor and a real smoke test. A browser executable cannot handle every OS dialog or hardware failure.

`--provider auto` uses the task's explicit provider, otherwise the first installed supported provider (Codex, then Claude). An explicit CLI `--provider` overrides task preference. This is deterministic capability routing, not a learned cost/quality model selector. Authentication and model selection remain with the host. Failed authentication becomes a visible bounded failure. Only one worker edits a project at a time. Parallel discovery can be useful; parallel source edits need separate worktrees and integration checks, which this runtime does not implement.

## Context policy and actual enforcement

Put task context under `audience`, `constraints`, `design`, `projectIdentity`, or `sourceRepository`. Other keys are named in `context_omitted_keys` but their values do not reach a worker. Before dispatch, move necessary task facts into the approved brief/constraints; never copy conversation material to preserve a dropped field. Workers needing an omitted fact must report it rather than guess. Acceptance helper paths and protected paths remain visible in the packet. Handoff artifact syntax is checked, but artifact contents, existence and symlink targets need inspection; never forward a prior prompt or transcript as an artifact.

The requested ceiling is 250,000 current-context tokens for every role, including the coordinator. Begin replacement at 225,000, or earlier if the model's context limit is lower. `routing.py context --current-tokens 225000 --model-limit 250000` returns `handoff`. With no current-context telemetry it returns `unavailable`, not an invented measurement. Lifetime billed tokens, output tokens and context tokens are different numbers.

CLI workers start a new process for each task/attempt; no resume/fork session is used. Codex runs ephemeral with memories disabled. Claude disables automatic memory and hooks and does not persist its session. The approved task packet contains scope, requirements, decisions and evidence pointers. Chat transcripts, scratchpads and personal memories are not intentionally passed; nested memory/history fields are removed. Inspect allowed free-text fields too: a key filter cannot recognize a transcript pasted into an instruction. Project source, project instructions and provider/system instructions remain available; this is not an empty machine or adversarial isolation.

A worker can return `status: handoff` with `artifacts`, a list of project-relative raw evidence paths. The coordinator queues a new fresh process while retaining the same attempts, steps and time budget. Remaining budgets and `task.handoff_artifacts` reach the next packet; the prior worker's summary stays in the audit record only. Evidence and source files survive; the next worker reads the contract and artifacts, not the previous conversation. Repeated handoffs exhaust the budget instead of creating an infinite relay. Record material decisions and evidence paths before handing off. A zero-memory replacement with no task facts would have no way to know what to do.

**The current CLI runtime cannot guarantee a hard 250K cutoff inside an opaque CLI or replace the interactive root host.** `context_action` evaluates supplied telemetry; it is not a per-model-request interceptor. Root/CLI telemetry must be marked unavailable when the host does not expose it. Bounded tasks, fresh processes and timeouts limit work but do not prove a token ceiling. Host compaction is also not a fresh independent agent.

For a strict ceiling, an API-owned runner must intercept every model request (including root/planner/QA), count the fully assembled context including tool schemas/results, reserve maximum response space, and start a fresh session before sending an over-limit request. That runner must own the root lifecycle too. Do not represent installing a markdown skill as installing that infrastructure.

Sources: [Anthropic's workflow guidance](https://www.anthropic.com/engineering/building-effective-agents), [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), and [Lost in the Middle](https://arxiv.org/abs/2307.03172). The paper supports evaluating long-context reliability; it does not establish a universal 250K threshold.
