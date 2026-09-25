# Discover behavior before implementation

The coordinator performs this brief investigation; the user is not expected to supply senior-engineer failure knowledge. Use it for consequential features and unfamiliar existing work, not every wording change.

1. State the user's outcome and primary journey. Read relevant source, current decisions, interfaces, tests and issue evidence. Existing behavior is evidence, not automatically the intended behavior.
2. Identify resources and boundaries touched: hardware, data, account/session, network, files, long-running work or external effects. Read official API docs for material unknowns. Record source paths/URLs alongside derived obligations.
3. Walk through relevant states and transitions: before start, waiting, active, success, failure, stop/cancel, retry, reload/close, concurrent or late operations. Consider resource release, duplicate actions, partial work and recovery where those boundaries exist. Select by impact and plausibility; do not generate an exhaustive cross-product.
4. Write observable behavior, not a predetermined implementation. Separate (a) explicit user/current product decisions, (b) derived engineering obligations, (c) consequential product choices, and (d) unvalidated customer hypotheses. Preserve this provenance in each requirement's basis.
5. A fresh QA/discovery agent reviews the original goal and raw source/docs, challenging missing transitions, conflicting requirements, scope growth and unverifiable claims. It must be able to say unknown. One initial challenge pass; revisit only material new evidence. Do not let two agents' agreement stand in for user evidence.
6. Resolve researchable obligations automatically. For genuine product choices, provide a recommended behavior, concrete tradeoff and the smallest necessary question; continue independent work. An assumption is not permission. Do not ask users to choose obscure implementation details.

Examples of reusable patterns (apply only when relevant):

| Boundary | Questions to investigate |
|---|---|
| Camera/microphone | Who owns acquisition? What happens after denial, ignored permission, late grant, stop, disconnect, restart and window destruction? Does this app release its own tracks? |
| Async/network | What wins if cancel and response race? Can retry duplicate a charge/action? What happens offline, on expiry and partial response? |
| Persistence | What survives restart? What must never persist? How is interrupted/corrupt data handled? |
| Identity | Can one account's stale operation affect another? Does sign-out invalidate outstanding work? |
| Upload/preview | Are selected bytes the submitted bytes? What proves no upload before the required user action? |
| Install/update | Can the promised user install and start with their actual permissions/dependencies? What preserves data on failure? |

Use a small requirement set with IDs, behavior, provenance, priority and verification method. Objective requirements feed `quality.requirements`; native/manual requirements feed QA charters and remain unverified until exercised. Customer hypotheses need observation or an experiment, not invented tests proving demand.

QA writes the tests and records positive/negative controls. A baseline failing because the feature is absent is not yet proof that a test distinguishes a subtle incorrect implementation. Use known-broken examples where practical, in disposable fixtures only.

References: [Anthropic planner/evaluator experiment](https://www.anthropic.com/engineering/harness-design-long-running-apps), [requirements enrichment](https://www.thoughtworks.com/ai/works/technical-guide), [evaluation design](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). These are patterns and case studies, not a universal proof that more agents are faster.
