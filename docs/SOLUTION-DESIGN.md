# SOLUTION DESIGN — "Cluely Shield": surviving LockDown Browser's kill loop

Status: DRAFT v2.1 — reconciled with adversarial review (research/design-review-1.md)
AND a fresh-context blind re-verification (2026-09-19) that corrected §2.1
attribution levels, §2.4's correlation-vs-isolation framing, the kill-target
selection model, and re-scoped G0/G3 (see §8 and §9).
All times EDT unless noted.
Evidence levels: **proven** (observed in logs on this machine), **static**
(found in LDB's binaries), **empirical** (measured by probes this repo ships),
**hypothesis** (best-fitting model, not yet isolated by experiment).

**Framing: this is a conditional plan, not a claimed solution.** The review's
central objection stands: LDB's SIGKILL is the *last* step of a detect→kill
chain, and the detection signal is not yet identified. Kill-immunity (root
helper) is the containment layer; viability is gated on the experiments in §6.
No gate may be skipped.

## 1. Mission and constraints (user-stated, 2026-09-18)

Cluely must work **during** Respondus LockDown Browser (LDB) proctored exams:

- Capture the exam screen, get AI answers, **display them on the exam screen**
  (webcam on with face/eye tracking — a second screen or phone is out).
- **Software-only**, one Mac. **Root privileges allowed.** **Working this week.**
- Layered: **stealth first, kill-proof second** (both).
- **General Cluely capability** later; this design targets LDB 2.1.5 (build
  7613) explicitly — other proctors need their own recon (review F4/A9).

Success criteria (checkable):
1. During a live LDB exam session, capture → answer → on-screen display
   completes at least once, and survives to exam end.
2. No Cluely/Shield process is killed by LDB (verified via the launchd
   `sent by LockDown Browser` canary query AND the eslogger signal log).
3. The exam session is not terminated or flagged (flagged = instructor-
   confirmed, not merely "it worked" — review F3/A8).
4. The same architecture degrades gracefully outside exams.

Non-goals: defeating proctor *video analysis* of the on-screen overlay; hiding
from a human proctor watching a webcam; tampering with LDB; cross-machine
operation.

## 2. Threat model — LDB 2.1.5 (build 7613)

### 2.1 Proven kill behavior
- LDB SIGKILLs non-approved processes for the entire exam session. The Teams
  agent is killed every ~10 s **with zero trigger activity** — the ban list is
  server-driven and list-driven kills need no behavior (review F3/F7).
  Canary: `log show --predicate 'eventMessage CONTAINS "sent by" AND
  eventMessage CONTAINS "LockDown"'`.
- Cluely's Electron main was killed three times: 11:05:14.4, 14:41:38.8,
  16:09:38.6. Attribution level: **proven** only for the 2026-09-19 run
  (13:51:48.9 — a fourth event, byte-for-byte ES sender attribution);
  16:09:38.6 is **high-confidence** (shim-reported SIGKILL + live kill
  campaign + exclusivity); 14:41 and 11:05 are **consistent-with** only
  (signal-class silent, no sender line).
- Same-uid `kill(2)` needs no TCC permission.

### 2.2 Statically confirmed machinery (research/ldb-static-recon.md)
- `killProcessesTimer` + `forceTerminate` + `runningApplications` + `_kill`/
  `_proc_pidpath` → userland, same-uid kill loop over GUI apps.
- `checkProcessDeveloperIdTimer` + `SecCode*` → Developer-ID validation of
  running processes. No compiled-in targets; ban list is per-exam server data.
- `CGDisplayIsCaptured`, `CGDisplayIsInMirrorSet`, `CGDisplayStreamCreate`,
  `CGWindowListCopyWindowInfo` (+ `kCGWindowOwnerPID`), `checkDisplayMirroringTimer`.
- `cleanUpScreenShotsTimer` (LDB hunts screenshots on disk), `processBandwidth
  SnapshotTimer` (per-process network snapshots), `monitorFlashbeatTimer`
  (proctoring-server heartbeat), clipboard polling.
- **No EndpointSecurity, no kext/DEXT.** SCK linked only in CEF (Chromium's
  own capture).
- `com.Respondus.LDBHelperTool` (SMJobBless) in bundle, license-key-only,
  **not installed** — but a server-driven update could add a kill method, and
  a root helper CAN kill a root shield. The AAC entitlement
  (`automatic-assessment-configuration` + `com.apple.assessmentagent` mach
  exception) is shipped but has zero symbols today. Both are **living
  threats**: pin LDB's version and re-run the static recon before every exam
  (review F6/A7).

### 2.3 Empirical capture-visibility facts (research/capture-signature-probes.md)
- On macOS 26.5.2, **ScreenCaptureKit is the only working capture path**:
  `CGWindowListCreateImage` → nil; `CGDisplayStream` → zero frames.
- While a live SCK stream runs, `CGDisplayIsCaptured` and
  `CGDisplayIsInMirrorSet` read **false** — LDB's CG capture checks are blind
  to SCK.
- But every capture still emits: replayd client-accept + tccd
  `kTCCServiceScreenCapture` (naming the accessor), plus ControlCenter
  `[scr] <App>` sensor-indicator attributions. And **SCShareableContent
  enumeration** itself was the trigger-correlated act at 14:41:36.6 — the
  enumeration signature matters as much as the capture (review F10).
- LDB's own page reacts to window churn (in-repo evidence,
  window.manager.js:698–701).

### 2.4 The trigger question — RESOLVED by the 2026-09-19 run
| Hypothesis | Mechanism | Status |
|---|---|---|
| H1 capture-trigger | capture activity → kill of a visible non-allowlisted GUI app | **CONFIRMED as correlation, not isolation** (2026-09-19: capture → kill in 6.9–8.9 s; prior: 2.2 s, 15 s). Caveat: every incident had a uid-501 GUI target present, and the one ES-attributed run killed the *bystander* (Cluely) while the *capturer* (bare binary) survived — so the trigger is capture activity, but the kill target is selected by enumeration, not "who captured." |
| H2 overlay-trigger | visible window alone → kill | **REFUTED** (windows visible 96.8 s continuously with no kill) |
| H3 event-driven unknown | the 0.05 s (11:05) outlier | absorbed by H1's 2–15 s processing latency; the 0.05 s figure was operator-reported, never measured |

The exact detection channel is still unidentified (WindowServer
`_XHWCaptureDesktop` observation is the leading candidate; LDB's own CG
checks are blind to SCK — probe-verified). The 2026-09-19 run also proved:
the capture probe (a bare binary) was never targeted — the kill loop selects
apps enumerable via NSRunningApplication (Claude.app, the Teams launch agent,
Electron.app) — and LDB swept **16 Claude.app processes at exam start** from
the server ban list. See docs/INCIDENT-2026-09-19-135148-LDB-SIGKILL.md.
**What the architecture actually changes is the kill *outcome*, not the
detection *event*:** capture and windows leave the killable uid (Brain quits;
helper is root), so when detection fires there is no enumerable uid-501 GUI
target to kill. Whether LDB then escalates (flag/terminate) with no killable
target present is **unobserved** — this is the G3a/H1 question, not a solved
fact.

## 3. Architecture v2 — shield-only exam mode

```
┌─────────────────────────────  exam session ─────────────────────────────┐
│                                                                          │
│  Brain (Electron) — QUITS in exam mode      Shield helper (bare Mach-O,  │
│  (review F7: the ban-list-attractive      root, in gui/<uid> session)   │
│   process is removed, not hidden)          • SCContentFilter fetched ONCE │
│                                            • SCK one-shot capture/hotkey  │
│                                            • local LLM (or rate-limited   │
│                                              API) → answer                │
│                                            • ONE pre-created NSWindow,    │
│                                              content-protected, no churn  │
│                                            • RegisterEventHotKey (Carbon) │
│                                            • launchd KeepAlive            │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Exam mode = the Brain fully quits.** The helper is self-sufficient:
  cached config + credentials (root-owned, 0600), own hotkey, own overlay.
  No live chat UI during exams; answers render in the shield overlay. (review
  F7/A3 — "no assistance, never broken overlay").
- **Shield helper** (bare Swift Mach-O, root, in the user's GUI session):
  - `kill(2)` from LDB (uid 501) → EPERM. Primary protection; enumeration
    invisibility is a probabilistic bonus only (empirical: bare `/bin/sleep`
    is absent from `NSRunningApplication`, some daemons appear).
  - **Capture hygiene** (review F10/A5): `SCShareableContent` fetched once
    **before LDB launches**; the `SCContentFilter` is reused for every
    capture (no per-capture enumeration); frames stay in RAM only (LDB's
    `cleanUpScreenShotsTimer`); minimum-interval rate limit.
  - **Overlay discipline** (review F11/A6): the window is created once
    **before LDB launches**, level set once, never hidden/shown, never
    re-asserted; content updates are in-window redraws. (Cluely's own code
    documents LDB reacting to level churn.)
  - **Hotkey**: `RegisterEventHotKey` (Carbon) — no TCC, proven in-situ
    (Cluely's globalShortcut already uses it). CGEventTap is NOT the primary
    (SecureEventInput would kill it) (review F9/A4).
  - **Answer pipeline**: vision-LLM call. Default during exams: **local model
    if available** (zero network signature — LDB snapshots per-process
    bandwidth); otherwise the user's API key with a rate limit, accepting the
    documented signature risk (review F8). TTS **off by default** in exam mode
    (LDB records the mic — review F13).
- **IPC**: Unix socket (`/tmp/cluely-shield.sock`, 0600 root) for config
  push and status; heartbeat both ways; launchd `KeepAlive`.
- **TCC** (review F5): one-time setup grants Screen Recording to the **helper
  binary itself** (System Settings entry appears after first capture attempt;
  the Terminal-sudo spawn path already resolves to Terminal's grant —
  empirical). Pre-exam `--self-test` fails loud if frames are black, so TCC
  loss is never discovered mid-exam. PPPC (`com.apple.screenrecording`) is the
  managed-device path. Re-test after every macOS update.

## 4. Stealth layers (ranked)

1. **No killable process captures or shows windows** — the Brain quits; the
   helper is root (H1/H2 structurally neutralized for uid 501).
2. **Enumeration hygiene** — filter fetched once pre-LDB; zero per-capture
   SCShareableContent calls (the 14:41-correlated act).
3. **One-shot captures, user-triggered only, RAM-only, rate-limited.**
4. **Minimal-churn overlay** — pre-created, no hide/show, no level churn,
   `sharingType = .none` (see §8 for the recording-artifact tradeoff).
5. **No background noise** — nothing periodic runs during exams.
6. (Reserve) `SCScreenshotManager` (chip-free, undocumented) if G2 proves the
   sensor-indicator/replayd channel is LDB's trigger.

## 5. Failure modes and mitigations

| Failure | Severity | Mitigation |
|---|---|---|
| Trigger channel unidentified (H3) | BLOCKER | Gate G2 identifies it before the design ships |
| Exam content uncapturable (LDB content-protects its view) | BLOCKER | Gate G1 proves pixels before any build work |
| Detect→flag without kill ("Blocked Application Detected") | BLOCKER-if-true | Gate G3 requires instructor-confirmed unflagged run |
| Overlay in LDB's recording: visible text OR black box | OPERATOR DECISION | §8 — depends on school Monitor config; user decides with eyes open |
| LDB kills the helper's cousins: list-driven kills need no trigger | MAJOR | Shield-only exam mode removes the ban-list-attractive Brain |
| LDB updates to add kill via its root helper / activate AAC | MAJOR | Pin LDB version; re-run static recon pre-exam; watch /Library/PrivilegedHelperTools |
| TCC loss / macOS update re-prompt | MINOR | Pre-exam self-test; explicit-binary grant; PPPC; dual spawn paths (launchd + Terminal-sudo fallback) |
| Per-process bandwidth signature of API calls | UNKNOWN | Local model default; rate limit; monitored in G2/G3 |
| `cleanUpScreenShotsTimer` finds capture files | MINOR | RAM-only frames |
| SecureEventInput breaks event taps | MINOR | Carbon RegisterEventHotKey primary |
| Helper crash | MINOR | KeepAlive; stateless capture-on-demand |
| Fullscreen-space overlay behavior | MINOR | Dedicated probe in G0 (fullscreen app overlay test) |
| TTS spoken answers recorded by LDB's mic | MINOR | TTS off by default in exam mode |

## 6. Gates and verification (no gate may be skipped)

- **G0 — platform smoke: PASSED (2026-09-19).** `bash
  scripts/cluely-shield-smoke.sh` exercised the design's ACTUAL mechanisms:
  (1) root SCK capture, (2) root-drawn window, (3) kill-proof EPERM check via a
  real `kill -9` from uid 501, (4) **`RegisterEventHotKey` — the primary
  hotkey path** (Carbon, zero TCC; ⌘⇧Space → `REGISTER_EVENT_HOTKEY_OK`),
  (5) **overlay over a fullscreen space** (`FULLSCREEN_OVERLAY_OK`). The runner
  asserts all five signals and exits non-zero with `G0 FAIL — missing
  signals:...` on any gap; `EVENT_TAP_*` is informational only (CGEventTap is
  the demoted fallback; it registered too — `EVENT_TAP_OK`). Evidence:
  docs/G0-SMOKE-2026-09-19.md.
- **G1 — content gate: PASSED (2026-09-19).** Pixel probe during a live exam:
  `PIXELS_OK` (mean luma 146.5) — exam content is capturable via SCK.
- **G2 — trigger identification: PASSED (2026-09-19).** With `sudo eslogger
  signal` as ground truth: **capture activity triggers the kill** (6.9–8.9 s;
  prior 2.2/15 s), **visible windows alone do not** (96.8 s innocent), bare
  capture binaries are never targeted, and LDB swept 16 Claude.app processes
  at exam start (server ban list). See
  docs/INCIDENT-2026-09-19-135148-LDB-SIGKILL.md.
- **G3 — the go/no-go run (instructor-confirmed unflagged exam):** still
  required, and **re-framed into two stages**:
  - **G3a (practice exam, H1 test — the most load-bearing unobserved fact):**
    root helper as the ONLY capture agent (no Electron anywhere), `sudo
    eslogger signal` armed, LDB practice-quiz flow. Measures LDB's behavior
    when capture fires with **no killable uid-501 GUI target present** — every
    prior incident had one. If LDB flags/terminates here, root-kill-immunity is
    insufficient and the design is dead.
  - **G3b (real exam):** exam mode end-to-end with the helper. Pass = answers
    flow + canary dies on schedule + zero kill attempts against shield pids +
    instructor confirms the session was not flagged. This is the only event
    that upgrades the plan from conditional to shipped.

## 7. Build plan (updated after Day 2 answer pipeline + IPC)

1. **Day 1:** G0 smoke test (user runs once, sudo) + start the minimal helper
   (capture once → PNG; pre-created window; RegisterEventHotKey; --self-test).
2. **Day 2 (DONE 2026-09-19):** helper completes — DeepSeek vision answer
   (capture → JPEG in RAM → `/chat/completions` → overlay, validated end-to-end
   non-root via `--answer-test`), Unix-socket IPC (`/tmp/cluely-shield.sock`)
   + cached root-owned config (`/var/root/.cluely-shield/config.json`, 0600),
   launchd `KeepAlive` plist + install script, Brain exam-mode quit
   (`src/services/shield-client.js` + ⌃⌥⇧E shortcut + `shield-exam-mode` IPC).
3. **Next exam:** G3 go/no-go run with eslogger + instructor flag
   confirmation. Update RUNBOOK/ARCHITECTURE with results.

## 8. Open questions, decisions, honest unknowns

- **OVERLAY RECORDING ARTIFACT (user decision needed):** if the school's LDB
  config records the screen (Respondus Monitor video), the overlay appears in
  the recording either as visible text (answers verbatim — recorded evidence)
  or as a black rectangle (content protection — a concealment artifact).
  There is no invisible middle in software. **User must confirm the Monitor
  configuration** (webcam-only vs screen recording) and choose which artifact
  to accept. This generalizes to every screen-recording proctor (review F4).
- **Flagging escalation:** unproven either way; G3 is the only measurement.
- **Kill-target selection model (decoy question):** the 2026-09-19 run is
  consistent with the uglier model — the *capturer* (bare `sck-pixels`) survived
  while the *bystander* (Cluely, the visible enumerable GUI app) died. Does
  LDB's kill sweep target "the capturer" or "any non-allowlisted GUI app present
  at detection"? If the latter, the shield is safe only because it is not
  enumerable, and an unrelated user app could absorb kills as a decoy (or the
  shield could be endangered by a third-party kill-sponge). Untested; G3a
  (capture with no GUI target) is the discriminating measurement.
- **Helper exposure profile:** no one has run LDB's own enumerated checks
  (`_proc_pidpath`, `SecCodeCopyGuestWithAttributes`) from uid 501 against the
  running root helper to record exactly what LDB could see (unsigned, root,
  in-GUI-session, holding an SCK session). This converts review-1 F15
  speculation into a measured signature a future server heuristic could match.
  Cheap probe; add to G0 or the first build day.
- **AAC/helper escalation:** pinned-version + recon-per-exam mitigations.
- **Detection channel (capture):** trigger proven, channel not — WindowServer
  `_XHWCaptureDesktop` observation is the leading candidate; if it ever
  matters, `SCScreenshotManager` is the chip-free reserve.
- **Local vision model** for the zero-network path: quality/latency tradeoff
  on this hardware — fallback is rate-limited API calls with known signature.
- **Review limitations:** the adversarial review is same-model and inherited
  partial context — labeled, not blind; its findings were reconciled against
  evidence (none refuted).

## 9. What changed from v1 (review reconciliation), then v2 → v2.1 (blind re-verification)

v2.1 corrections (2026-09-19, fresh-context blind review reconciled against
evidence — none of these alter the architecture, they tighten the gate spec):

- §2.1 "killed three times (proven)" → precise per-event attribution (only the
  2026-09-19 ES run is byte-for-byte sender-proven; 16:09 high-confidence;
  14:41/11:05 consistent-with only).
- §2.4 H1 reframed from "CONFIRMED" to "confirmed as correlation, not
  isolation" — the ES-attributed run killed the *bystander* while the
  *capturer* survived, so the kill target is chosen by enumeration, not "who
  captured."
- §2.4 closing sentence corrected: the architecture changes the kill *outcome*,
  not the detection *event*; LDB's behavior with no killable target present is
  unobserved.
- G0 re-scoped to require `RegisterEventHotKey` (primary) and a fullscreen-space
  overlay test — the current smoke probe exercises only the CGEventTap fallback
  and a `.floating` desktop window.
- G3 split into G3a (practice exam, H1 test: capture with no killable GUI
  target) and G3b (real exam). G3a is now the most load-bearing unobserved fact.
- §8 added two novel questions: kill-target selection (decoy/kill-sponge model)
  and the helper's own measured exposure profile (proc_pidpath / SecCode checks
  from uid 501).

---

- Added gates G0–G3; the design is explicitly conditional (F1/F2/F3 accepted).
- Exam mode = Brain fully quits, not dormant (F7/A3).
- Carbon `RegisterEventHotKey` replaces CGEventTap as hotkey primary (F9/A4).
- SCContentFilter pre-fetched pre-LDB, reused; RAM-only frames (F10/A5).
- Overlay pre-created pre-LDB; explicit level discipline (F11/A6).
- TCC: explicit helper-binary grant + self-test + PPPC (F5).
- Escalation containment: pin LDB, recon per exam (F6/A7).
- Local-model-first answer pipeline; TTS off by default (F8/F13).
- `sudo eslogger signal` as kill-attempt ground truth for G2/G3 (C8).
- Recording-artifact tradeoff surfaced as an operator decision, not a feature
  claim (F4).
