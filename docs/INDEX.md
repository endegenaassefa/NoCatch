# Documentation index

Every document in this repository, categorized. Start at the top and follow
the pointers — nothing here is a dead end.

## Start here

| Doc | What it covers |
|---|---|
| [`ROOT-EXAM-MODE.md`](ROOT-EXAM-MODE.md) | **Current state.** Cluely itself runs as root (kill-immune); the one-command `cluely` launcher, its kill design, and the honest unknowns |
| [`TIMELINE.md`](TIMELINE.md) | Master chronological record of the whole project, every entry sourced to evidence |

## Operating Cluely

| Doc | What it covers |
|---|---|
| [`UNIFIED-CHAT-SURFACE.md`](UNIFIED-CHAT-SURFACE.md) | Chat-first answer surface: capture routing into chat, question-type switching, root-mode UI states |
| [`RUNBOOK.md`](RUNBOOK.md) | Operating procedures: armored launch, scanner lifecycle, stop/analyze, after-action checks |
| [`RUN-PROTOCOL-2026-09-18-G1G2.md`](RUN-PROTOCOL-2026-09-18-G1G2.md) | Step-by-step protocol used for the Sep 18 G1/G2 exam runs |
| [`G3A-RUNBOOK.md`](G3A-RUNBOOK.md) | G3A go/no-go experiment kit: rig, canary, expose, arm script, runbook |
| [`G0-SMOKE-2026-09-19.md`](G0-SMOKE-2026-09-19.md) | G0 pre-exam smoke evidence |
| [`EXAM-CAPTURE-2026-09-18.md`](EXAM-CAPTURE-2026-09-18.md) | The real exam recording: verdicts on every Cluely↔LockDown Browser interaction |

## Architecture & design

| Doc | What it covers |
|---|---|
| [`BUILDING.md`](BUILDING.md) | Cross-platform build commands, signing inputs, artifact verification, draft-release behavior and remaining qualification gates |
| [`CROSS-PLATFORM-DESIGN.md`](CROSS-PLATFORM-DESIGN.md) | Proposed full-feature Windows/macOS design: managed sign-in, parity inventory, platform boundaries, setup recovery, migration and release gates |
| [`CROSS-PLATFORM-REVIEW.md`](CROSS-PLATFORM-REVIEW.md) | Isolated Codex design review and source-verified findings; initial scope superseded by the full-parity requirement |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Both systems: Cluely's process tree/stealth/TCC mechanics, and the scanner's dimensions + structural rules |
| [`SOLUTION-DESIGN.md`](SOLUTION-DESIGN.md) | "Cluely Shield" engineering design: threat model, Brain/root-helper split, verification plan |
| [`HANDOFF-SHIELD.md`](HANDOFF-SHIELD.md) | Handoff for shield work: code state, file map, open threads |

## Research (adversary recon & platform mechanics)

| Doc | What it covers |
|---|---|
| [`research/ldb-static-recon.md`](research/ldb-static-recon.md) | LockDown Browser binary recon: kill loop, SecCode, Electron-family ban list |
| [`research/capture-signature-probes.md`](research/capture-signature-probes.md) | SCK-only capture probes; CG checks blind to SCK |
| [`research/platform-research.md`](research/platform-research.md) | macOS capture/stealth platform research |
| [`research/design-review-1.md`](research/design-review-1.md) | Adversarial review of the shield design (same-model, reconciled) |

Probe *code* lives in [`../research/probes/`](../research/probes/) — Swift
experiments (g3a-rig, canary, expose, shield-smoke, sck-pixels) referenced by
the runbooks.

## Incidents (forensic records)

| Doc | What it covers |
|---|---|
| [`INCIDENT-2026-09-18-144138.md`](INCIDENT-2026-09-18-144138.md) | Cluely died at question-1 load; corrected verdict: LDB SIGKILL |
| [`INCIDENT-2026-09-18-160938-LDB-SIGKILL.md`](INCIDENT-2026-09-18-160938-LDB-SIGKILL.md) | Smoking gun: LDB's SIGKILL kill-loop on tape; three incidents unified |
| [`INCIDENT-2026-09-18-1105-FORENSICS.md`](INCIDENT-2026-09-18-1105-FORENSICS.md) | Morning shutdown forensics (10:04–11:45) |
| [`INCIDENT-2026-09-19-135148-LDB-SIGKILL.md`](INCIDENT-2026-09-19-135148-LDB-SIGKILL.md) | Sender-attributed kill via EndpointSecurity; capture proven as trigger |
| [`INCIDENT-2026-09-19-HOTKEY-RACE.md`](INCIDENT-2026-09-19-HOTKEY-RACE.md) | Shield hotkey never fired during the real exam; race class + structural fixes |

## Historical archive

[`history/`](history/) — engineering briefs, audit rounds, and handoff
prompts from Sep 16–17 (pre-shield era). Kept for provenance; superseded by
the docs above.
