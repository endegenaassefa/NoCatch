# Development through observable feedback

Select the relevant path; these are not mandatory stages for every edit. Read existing project instructions, entry points, domain vocabulary, decisions and checks before inventing conventions. Use existing architecture and build commands. Record a small glossary or decision note only when ambiguity actually causes mistakes; do not manufacture a new documentation system.

## Features and refactors

Choose a thin end-to-end slice that proves the risky boundary early: input through the real interface to an observable result. Complete and verify it before expanding the next slice. List actual dependencies; parallelize independent investigation, not coupled source edits in the current runtime.

Apply [independent test ownership](quality.md): QA authors and calibrates the checks; builders implement and run them unchanged. For iterative test-first work, prepare a small slice's checks before its build run. New acceptance behavior requires a new reviewed contract/run; do not change a frozen exam midway. Simple low-impact edits do not require new tests merely to use this workflow.

For refactors, name the behavior that must remain stable and its public boundary. Seek a simpler interface or a clear ownership boundary. Do not replace working architecture because a source recommends a fashionable pattern. Prefer existing type/lint/build checks to prose reminders when the repository already supports enforcing an invariant; QA owns changes to test/configuration under the current quality policy.

## Bugs and performance

1. Capture the reported symptom in the actual environment, including input, source version, and expected/actual result. Read source to locate the real path; distinguish an observed cause from a hypothesis.
2. Find the cheapest useful feedback loop: existing failing test, actual API/CLI invocation, browser journey, or captured trace. QA creates a regression when needed. Reduce a reproduction only while it still exercises the original failure.
3. For a difficult bug, state plausible causes and a distinguishing probe for each. Test the most informative probe, then change one material variable. Record evidence that eliminates a cause rather than repeating the same edit with different wording.
4. Repair the cause; rerun the original symptom and relevant checks. For performance, compare equivalent workloads and environments, retain raw measurements and sample variation, and check correctness. A single fast run is not a reliable performance win.
5. Remove temporary instrumentation and clean up owned processes. Preserve the useful reproduction/evidence and explain the causal fix.

If reproduction is unavailable, continue useful read-only diagnosis and label proposed causes unconfirmed; do not report a fix as verified. Ask only for the missing environment/artifact if essential. When repeated attempts yield no new evidence, change the probe or reduce scope to a diagnostic deliverable. Honor actual run budgets; do not convert exhaustion into completion.

For repeated projects, maintain the small [feature map](exploratory-qa.md#project-verification-map) that makes the real path discoverable to the next agent.

Sources: [Matt Pocock's TDD](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md) and [diagnosis](https://github.com/mattpocock/skills/blob/main/skills/engineering/diagnosing-bugs/SKILL.md). These supply patterns; Depth Engine retains separate QA ownership and does not require the user to approve routine test-interface choices.
