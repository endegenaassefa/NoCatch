# Product and frontend decisions

Before consequential product work, establish the audience, problem, current alternatives, primary outcome and actual evidence. Distinguish observed customer facts from assumptions or generated personas. Choose the cheapest useful experiment when demand or usability is unknown; more code is not always the next step.

For a screen or flow, carry a compact design contract into task criteria: intended user and primary action, information hierarchy, reference/current design system, visual direction, content, loading/empty/error/success states, responsive behavior, keyboard interaction and roles. Reuse an established system before inventing a new one. Ask about design direction when the answer changes the result; infer routine spacing and component decisions from the project.

Use questions continuously at decision points: before choosing a materially different direction, when user testing contradicts assumptions, or when a new constraint affects the flow. Offer a recommendation and concrete tradeoff. Do not make the user answer researchable questions, repeat saved decisions, or select three mockups for every minor fix.

Inspect the running interface at the intended viewport/state/theme. Compare against the design contract, check realistic content lengths and failure states, and use screenshots to support visual judgment. A DOM assertion cannot establish visual quality. Preserve any visual findings as explicit task criteria or review artifacts; the runtime's automatic completion covers only checks actually encoded in the verifier.

Use [research](research.md) when the decision depends on demand, competitors or pricing. Use [skill composition](skill-composition.md) to select installed Product Design capabilities for design exploration, audits or faithful visual implementation. Keep ordinary implementation proportionate.

Before a consequential visual iteration, derive a short rubric from the actual brief and references: hierarchy and legibility, coherence with the chosen visual direction, interaction clarity, responsive behavior and accessibility. Use observable examples or reference screenshots to anchor judgment. Distinctiveness matters when requested; do not penalize a restrained enterprise UI for avoiding novelty.

An independent interaction-capable QA agent should inspect real screens and the primary journey, recording concrete visual and behavioral defects separately. A tool-free reviewer can assess supplied screenshots/observations only; it cannot claim to have navigated. Preserve the best verified candidate while iterating. Fix material findings, stop on acceptance or the review/budget limit, and do not optimize an aesthetic score while breaking usability.

Sources: [Anthropic's design evaluator experiment](https://www.anthropic.com/engineering/harness-design-long-running-apps). Its rubric is an example, not a universal aesthetic or a reason to run many design iterations on every task. Launch, revenue and support integrations are not installed by these instructions.
