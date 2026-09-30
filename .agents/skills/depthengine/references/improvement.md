# Improve the harness using evidence

Use when the user authorizes changing a skill/harness, or to prepare an evidence-backed proposal. This improves instructions, tools and environment; it does not train model weights or create unattended self-evolution. For ordinary project work, retain a useful lesson without silently changing the user's global skill.

## Diagnose before adding rules

Start from a demonstrated failure, repeated friction, or a concrete unsupported task. Classify the cause: unclear requirement, missing context, unavailable tool/environment, poor action selection, weak verifier, faulty implementation, or stale handoff. Distinguish a missing documented process from a measured behavioral failure. Fix the right layer: a broken launch command needs tooling work; another paragraph will not install a browser.

State one falsifiable hypothesis: on a named class of tasks, this change should improve a specified outcome without worsening a named regression. Prefer a local feature map, existing lint/check or tool repair when it directly removes the failure. Add a global rule only when it generalizes. Remove redundant rules when evidence supports doing so.

## Freeze and compare

This installation includes independent executable checks for its new integration boundaries:

```text
py <skill>/evals/test_dispatch.py
py <skill>/evals/test_browser_read.py
py <skill>/evals/test_walls.py
```

They exercise the real Python CLIs using isolated fixtures; the browser suite also checks the installed OpenCLI doctor when available. The wall suite checks the three-tier report and negative controls; a separate `scripts/walls.py doctor` run reports actual local tier readiness. Results go to temporary evidence directories and report their location. Read each suite's reported limits: command/packet correctness does not establish the quality of a model's work or the success of a live app journey. The [behavioral scenarios](../evals/scenarios.md) and [paired-evaluation protocol](../evals/protocol.md) support broader task trials when an authorized change warrants them. Keep authoring/grading ownership independent from production repairs.

1. Preserve the current skill and record hashes/version for its entrypoint, relevant references and scripts. Pin the host/model when exposed, available tools, fixture/source version and trial limits. Use [adoption](adoption.md) for existing work. Never replace a running task's frozen contract.
2. Independent QA authors representative requests and outcome rubrics before candidate execution. Include the motivating failure, a simple task that should stay cheap, a relevant boundary/failure case and an adjacent task that should not regress. Withhold some cases from tuning where practical. Grade actions and artifacts, not whether the answer repeats the desired words.
3. Run baseline and candidate in separate fresh sessions/workspaces with the same inputs, tools and limits. Use anonymous A/B labels and randomize order for subjective judgment. Keep each arm away from the other arm's artifacts. Do not pass author rationale or previous verdicts to a grader. Tool-free scenarios can test decisions; actual development/browser/operations capability requires real execution evidence.
4. Preserve per-trial outputs and failures, including unavailable tools, timeouts and incomplete results. Compare task completion, escaped defects, unsupported claims, unauthorized effects, user interruptions and observed elapsed time/tool usage. Record tokens/cost only when measured; unavailable values stay unknown. For variable or close results, repeat comparable trials before asserting a performance gain.
5. Independently grade the decisive artifacts. Deterministic checks take precedence where available; calibrated judgment handles subjective quality. No automatic pass from a model's score or a schema validator. An unauthorized external action, weakened test, fabricated evidence or false completion is a critical failure, not something an average can hide.
6. Keep the candidate only when it addresses the targeted gap without material regression on the tested scope. Record the evidence, limits and rollback location. If capability trials cannot run, distinguish a reviewed documentation improvement from an experimentally demonstrated capability gain; never claim the latter. Install authorized documentation changes with that limitation explicit. Freeze the final candidate after repairs and recheck affected cases before promotion.

## Reusable experiment record

Use an existing project evidence directory, or an external local folder for global-skill upgrades. Keep private task context out of published skill resources. A compact record needs:

```text
Change/hypothesis; motivating artifact and classification
Baseline/candidate hashes; host/model/tools; fixture and rubric versions
Case/trial ID; arm; result (pass/fail/unavailable/incomplete)
Raw artifact pointers; independent grader and reasons
Observed elapsed/tool usage; tokens/cost if exposed
Regressions; decision (keep/revise/reject); limitations; rollback location
```

The record is an experiment artifact, not another task scheduler. Managed runs still use the runtime state store. In conversational mode state explicitly that no managed run exists; preserve the task contract, decisions, evidence, owner and next action in the checkpoint.

Stop when the scoped improvement is verified, budgets are exhausted, or two review rounds add no material progress. Preserve unresolved failures; do not tune a rubric until the candidate wins. Future unrelated work does not implicitly authorize recurring paid evals or global edits.

Sources: [Anthropic on agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [Cursor on harness iteration](https://cursor.com/blog/continually-improving-agent-harness), and [Anthropic's harness simplification experiments](https://www.anthropic.com/engineering/harness-design-long-running-apps). These motivate the measurement loop; gains must be established on the user's own tasks.
