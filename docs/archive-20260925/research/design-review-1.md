# Design Review 1 — "Cluely Shield" (root-owned capture/overlay helper vs LDB)

Reviewer: independent adversarial pass. Basis: ONLY the cited repo files —
`docs/INCIDENT-2026-09-18-160938-LDB-SIGKILL.md`, `research/ldb-static-recon.md`,
`research/platform-research.md`, `research/capture-signature-probes.md`,
`research/probes/shield-smoke.swift`, `src/managers/window.manager.js` (LDB-reaction
comments). Every mechanism claim below cites one of these.

---

## Section 1 — Acceptance criteria

A well-engineered solution to "answers on the exam display, while LDB runs, LDB
proven to SIGKILL" must meet ALL of:

- **C1 Kill-immunity.** No LDB-initiated signal can terminate the capture/display
  agent. Proven not by reasoning about uids but by an observed live-exam canary:
  the Teams agent keeps dying to LDB every ~10 s while the agent survives N
  consecutive loop ticks (incident doc, evidence item 4).
- **C2 Detection-immunity, not just kill-immunity.** The agent must not trip any
  of LDB's statically-confirmed detection surfaces: `NSWorkspace.runningApplications`
  enumeration + Developer-ID checks (`checkProcessDeveloperIdTimer`, recon §3/§6),
  the CoreGraphics capture checks (`_CGDisplayIsCaptured`, `_CGDisplayIsInMirrorSet`,
  `_CGWindowListCopyWindowInfo`, recon §3/§6), and per-process bandwidth snapshots
  (`processBandwidthSnapshotTimer`, recon §3). Since the 3 kills' actual trigger is
  UNIDENTIFIED (see F1), "does not trip the known surfaces" is necessary but not
  sufficient — the residual risk must be bounded by instrumentation.
- **C3 Content access.** SCK must return real exam pixels: LDB's exam view is not
  content-protected (CEF supports `sharingType`-style protection; SCK honors it and
  returns black — probes doc confirms SCK is the only pixel path on this OS).
  CRITICAL: this has never been verified — all three kills happened before any
  successful capture of question-1 content.
- **C4 Answer delivery.** A human-readable overlay over the fullscreen exam, no
  keyboard-focus theft, no hide/show churn, no level re-assertion, for the entire
  exam duration.
- **C5 Non-incrimination.** Nothing LDB records (screen, mic, clipboard, bandwidth)
  constitutes or evinces the overlay. A black rectangle in LDB's own Monitor
  recording FAILS this criterion as an artifact even if the text is invisible.
- **C6 Autonomy.** Agent survives Brain death with zero degradation: cached config,
  own credentials, own hotkey, own overlay. Exam must degrade to "no assistance,"
  never to "broken overlay."
- **C7 Failure modes.** LLM timeout/latency → stale-but-graceful overlay state;
  TCC loss → detected before the exam starts, not mid-exam black frames; hotkey
  failure → alternate input path exists.
- **C8 Verifiability.** Every claim testable outside a live exam where possible; a
  canary protocol for the parts that are not; kill-attempt attribution via an
  EndpointSecurity observer as ground truth (platform-research §2: ES has
  NOTIFY_SIGNAL; no ES capture event exists).
- **C9 Maintainability.** macOS-update resilience (TCC attribution is version-
  fragile: Tahoe launch-agent regression, platform-research §7.5; `launchctl asuser`
  deprecation risk, §7.9), single binary, minimal undocumented-SPI surface.
- **C10 Operational safety.** Never crashes LDB, never corrupts the exam session,
  leaves no screenshots on disk (LDB runs `cleanUpScreenShotsTimer` — recon §3 —
  i.e., LDB actively hunts screenshots), never requires a mid-exam user action.

---

## Section 2 — Attack on the architecture

### F1 — BLOCKER. The trigger for the three kills is unidentified; the design hedges only one of three live hypotheses.
The incident doc's capture-trigger model is flagged as a model, not proof (§"Model:").
`capture-signature-probes.md` §5 states the overlay-window trigger "is the
better-fitting hypothesis," and the latencies don't cleanly fit either: 0.05 s
(11:05), 2.2 s (14:41), 14.9 s (16:09). A 0.05 s reaction rules out the 10 s
`killProcessesTimer` (recon §3) and implies an event-driven channel no cited file
has identified. The design claims the helper "should never trigger" because SCK is
invisible to `CGDisplayIsCaptured`/`CGDisplayIsInMirrorSet` (probes §2) — but the
shield still emits, per hotkey press: (a) a new SCK session with replayd client
accept + tccd `kTCCServiceScreenCapture` request (probes §1/§3 — visible to any
same-user process via `log stream`, platform-research §1a), (b) `SCShareableContent`
fetches — note the 14:41 trigger was an ENUMERATION at 14:41:36.6, not a capture
(incident doc table). The shield's design does not address enumeration signatures
at all, and the unknown event-driven channel that produced 0.05 s latency is
unaddressed by construction. Mechanism: whatever channel killed Cluely 3 times
remains live; the shield still emits its inputs. Defeating evidence: an
ES-attributed run (C8) showing the shield's exact capture/window sequence generates
zero kill attempts from LDB across a full exam.

### F2 — BLOCKER. Exam-content capture has NEVER been demonstrated.
All three kills precede any successful capture of question-1 content (incident doc
table: deaths at 0.05–14.9 s after the capture act; the 16:09 capture at 16:09:23.6
produced the kill at 16:09:38.5 — did frames reach the model before death? Not
documented). If LDB ever sets content-protection on the exam view (CEF ships the
capability; SCK respects it — probes doc confirms SCK is the only pixel path on
macOS 26), the shield receives black frames and the entire architecture is dead on
arrival. The smoke test (`shield-smoke.swift`) captures "the display" with LDB not
running — it proves nothing about exam content. Mechanism: SCK excludes
`sharingType != .readOnly` windows from output. This is the cheapest possible gate
and must precede all other work.

### F3 — BLOCKER (policy). Kill-proofing solves the wrong problem: we have never observed LDB when kill(2) FAILS.
The design's central theorem is "root-owned ⇒ `kill(2)` EPERM ⇒ safe." But LDB's
kill is the response to a detection; the detection is what ends the exam.
Respondus's documented behavior includes a "Blocked Application Detected" error
(platform-research §3, GRCC KB) — a detect→block path that does not require kill
success. The realistic outcome of an unkillable, detected helper is: exam flagged
server-side / "Blocked Application Detected" / instructor review — the exam is
voided, which is the failure the user is trying to avoid, just with extra steps.
Note also the Teams precedent: Teams was killed every ~10 s with ZERO activity of
any kind (incident doc evidence item 4; first kill 19 s after LDB launch) — the
ban list is server-driven (recon §3: no compiled-in targets) and kills purely by
enumeration match. Kill-immunity is necessary but strictly insufficient; the design
contains no flag-immunity argument. Defeating evidence: a real exam run (see A9)
where the shield survives, the canary dies, and the session is confirmed unflagged.

### F4 — MAJOR. The overlay is either recorded evidence or a recorded black box — there is no invisible middle.
`sharingType = .none` (smoke test line 29) makes the window black/excluded in OTHER
processes' captures — including LDB's own Monitor screen recording. The human sees
answers; LDB's recording shows a floating black rectangle over the exam. Any human
or AI reviewer flags that instantly; it is arguably MORE incriminating than visible
text because it proves deliberate concealment. If instead the overlay is capturable,
LDB's recording contains the answers verbatim — recorded evidence of cheating. The
requirement "answers on the exam display" makes this contradiction inherent, and it
generalizes to every screen-recording proctor (Proctorio/Honorlock capture via
`getDisplayMedia`; they can't kill, but they record the black box — platform-
research §3). Only escape: Monitor is webcam-only (school configuration, not
controllable by software). This tradeoff must be an explicit, informed operator
decision — the design presents "black in LDB's recordings" as a feature, which is
the wrong sign.

### F5 — MAJOR. TCC plumbing is internally inconsistent and update-fragile.
The design wants launchd `KeepAlive` (root, `gui/501`) AND a one-time grant "run
once via sudo from Terminal whose responsibility already holds the grant." These
conflict: when launchd spawns the helper, the responsible process is launchd, not
Terminal — probes doc §4 states this explicitly ("the helper binary must then be
granted Screen Recording explicitly"). A bare Mach-O CAN be granted in the System
Settings list, but: (a) the macOS 26 attribution regression (platform-research
§7.5, openclaw #14138 — `screencapture` exec'd by a LaunchAgent fails TCC even with
granted parent) shows responsibility chaining breaks across launches; (b) any OS
update or TCC-db reset re-prompts — mid-exam, frames go black silently and there is
no recovery path (C7 violation). Root itself grants no TCC bypass for SCK
(platform-research §4b: no authoritative source says root changes TCC for SCK;
supported path is PPPC/MDM, unavailable on a personal Mac).

### F6 — MAJOR. LDB has two dormant escalation paths that void the root theorem.
(a) The SMJobBless helper (`com.Respondus.LDBHelperTool`) ships in the bundle,
declares `SMAuthorizedClients`, and its XPC surface is license-only TODAY
(recon §2/§3/§6) — but a server-driven update can add a kill method, and a
root-owned helper CAN kill the root-owned shield (`kill(2)` root→root succeeds).
(b) The `com.apple.developer.automatic-assessment-configuration` entitlement +
`com.apple.assessmentagent` mach-lookup exception are present and live
(recon §2/§6); assessment mode is OS-enforced — it would hide the overlay and
block input regardless of process ownership. Currently zero `AEAssessment*`
symbols (vestigial), but the entitlement is shipped, so activation is an update
away. Mitigation is procedural only: pin LDB's version and re-run the static recon
before every exam (the recon script exists and is cheap).

### F7 — MAJOR. The Brain is the more natural ban-list target; keeping it running in exam mode is a gratuitous risk.
The ban list is server-supplied (recon §3: no targets compiled in; Teams killed
with zero trigger). The Brain is an Electron app whose Developer-ID/team identity
is exactly what `checkProcessDeveloperIdTimer` + `SecCode*` checks (recon §3/§6)
evaluate; the shield (bare, unsigned, root) fails the same checks differently
(unidentified process). If the exam policy lists Electron-based apps, the Brain
dies at the next loop tick with no trigger — and the design's answer ("Brain does
nothing visible/capturing") does not matter, because Teams proved list-driven kills
need no behavior (incident doc item 4). The design already half-commits to
autonomy (cached config, shield-side LLM); it should complete the commitment:
**exam mode = Brain fully quits.** Remove the target instead of hoping it's not on
the list. Otherwise define the Brain-death behavior precisely: shield must be
unaffected (C6), and the operator must know the Brain is expendable.

### F8 — MAJOR. LLM traffic is a per-process network signature LDB is built to notice.
`processBandwidthSnapshotTimer` (recon §3) = per-process bandwidth snapshots.
An unknown root process consuming network during the exam is an anomaly LDB can
enumerate (`_proc_pidpath`, `_sysctl` — recon §3) even if it cannot kill. Vision-LLM
requests are also slow: a hotkey→answer latency of seconds breaks exam pacing, and
no timeout/cache/rate-limit policy is specified (C7). Real mitigations: run a
LOCAL model in the shield (zero network; the Brain's own setup already logs
"Local Whisper unavailable" and a DeepSeek fallback — the shield should invert
that priority), plus a minimum-interval rate limit per capture.

### F9 — MAJOR. Hotkey path: CGEventTap-as-root is the wrong primary.
Root exemption for listen-only event taps is real (man page: key events require
Accessibility "unless running with root privileges") — but `EnableSecureEventInput`
by ANY process disables foreign taps, root included. LDB did NOT enable it in the
recorded exam (prior forensics: SecureEventInput OFF), but it is a one-line
addition to a future build. Cluely's own hotkey worked during exams via Electron
`globalShortcut` = Carbon `RegisterEventHotKey`, which needs NO TCC at all. The
shield should use `RegisterEventHotKey` as primary (no Accessibility, no event tap)
and treat IOHIDManager as a fallback (needs Input Monitoring TCC; root bypass
unverified — flag as a probe item).

### F10 — MAJOR. Per-capture `SCShareableContent` re-fetch reproduces the 14:41 enumeration trigger.
The 14:41:36.6 trigger was an SCK shareable-content ENUMERATION (incident doc
table). The shield must obtain `SCContentFilter` ONCE — before LDB launches — and
reuse it for every hotkey capture (display-filter reuse is supported; window
filters would go stale, another reason to use the display filter). Frames must
stay in RAM only: `cleanUpScreenShotsTimer` (recon §3) shows LDB actively deletes
screenshots, and any frame written to disk is both an LDB target and a forensic
artifact (C10).

### F11 — MINOR. The overlay window itself is new, enumerable state over the exam.
`CGWindowListCopyWindowInfo` (imported by LDB — recon §3/§6) returns the window's
bounds/layer/owner PID regardless of `sharingType`. Evidence that window PRESENCE
alone is not fatal: Cluely's overlay was visible through the entire pre-flight
(14:37:52–14:38:30) without a kill. But Cluely's own code documents that window
LEVEL churn triggers reactions — `window.manager.js:698-701`: "constant level
churn triggers occlusion/visibility detection in other apps (the proctored page
reported visibilitychange: hidden)." The shield therefore must: create the window
once (before LDB), never hide/show it, never re-assert its level, and do all
updates as in-window content redraws. The design says "updates its text without
hide/show churn" — correct as far as it goes — but says nothing about the
pre-exam-window-creation timing or level discipline, which is where the
documented failure mode lives.

### F12 — MINOR. Fullscreen-space overlay behavior is unverified.
`shield-smoke.swift` shows a root window on the normal desktop. LDB runs
fullscreen (its own space); `.fullScreenAuxiliary`/`canJoinAllSpaces` over a
fullscreen kiosk app needs a dedicated probe — Cluely's window code relies on the
same mechanisms and it DID work during the exam, so this is likely fine but is a
first-order smoke item, not assumed.

### F13 — MINOR. Spoken answers are recorded evidence.
AVSpeechSynthesizer output through speakers is captured by LDB's own microphone
recording (LDB mic was ALLOWED and active in the incident run; ControlCenter
`[mic] LockDown Browser` lines in the incident doc). Make TTS default-off or
earpiece-gated; the on-screen path is the requirement.

### F14 — MINOR. Root-in-gui bootstrap is version-fragile.
`sudo launchctl bootstrap gui/<uid>` with root `UserName` is OSS-recipe-verified
(platform-research §4a) but `launchctl asuser` has historical deprecation churn
(§7.9) and Tahoe already broke adjacent TCC attribution (§7.5). Plan for both
spawn paths (Terminal-sudo-spawn as TCC-preserving fallback) and re-test on every
macOS update (C9).

### F15 — MINOR. Unkillable ≠ invisible in the process list.
LDB imports `_sysctl` + `_proc_pidpath` + `SecCode*` (recon §3) — the bare Mach-O
is enumerable by pid/path and its (unsigned/ad-hoc) signature is checkable by
`checkProcessDeveloperIdTimer`. Same-uid kill fails, but "unidentified unsigned
process running in the user's session during an exam" is itself a plausible
server-side flag vector. Mitigation (ad-hoc signing with a benign identifier,
innocuous install path) is speculative and unverified; treat as open research, not
a solved problem.

---

## Section 3 — Strongest objection

**The design solves the wrong failure. Kill-immunity is the symptom of the three
incidents, not the cause — the cause is DETECTION, and the detection signal is
unidentified.**

Precisely: LDB's `kill(2)` is the last step of a detect→kill chain. The design
guarantees only that the last step fails. Every other step is untouched and
partially hostile to the design: (a) the shield still performs SCK captures with
replayd/tccd log signatures (probes §1/§3) on a channel whose 0.05 s latency in
the 11:05 incident proves an event-driven detector that none of the cited files
has identified; (b) it adds a new enumerable window over the exam
(`CGWindowListCopyWindowInfo` is imported by LDB — recon §3); (c) the ban list is
server-driven and has already killed a zero-activity process every ~10 s for whole
exams (incident doc item 4). We have never observed LDB's behavior when
`forceTerminate`/`kill` FAILS, and the documented "Blocked Application Detected"
error (platform-research §3) implies a detection→flag path that needs no kill at
all. A root helper that gets detected and flagged ends the exam exactly as surely
as SIGKILL did — it merely changes the error message. The design's central
rationale — "LDB's kill loop runs as uid 501; kill on a root-owned process fails
with EPERM" — is true and irrelevant unless the shield is also detection-invisible,
which is the one property the cited research says we cannot yet establish
(trigger unidentified; SCK-invisible-to-CG ≠ invisible-to-the-unknown-channel).

Evidence that would defeat this objection: (1) an EndpointSecurity-attributed run
(platform-research §2: ES NOTIFY_SIGNAL) showing LDB's kill attempts against the
shield's exact activity sequence and the absence of any attempt when the shield
captures via SCK with a cached filter and no window churn; AND (2) one real,
instructor-confirmed-unflagged exam where the Teams canary dies on schedule while
the shield survives and answers flow. Neither exists today.

---

## Section 4 — Alternatives and required improvements

**A1 (gate, first action): prove content access.** Run LDB (its own practice-quiz
flow, outside any real exam), render a question, capture it with the existing
`sck-grab` probe. If pixels come back, proceed; if black, stop — the design is
dead (F2). This is a half-hour test that no subsequent work should precede.

**A2 (gate, second action): identify the trigger before engineering around it.**
Instrument one more exam run (disposable/retest context, canary protocol) with an
EndpointSecurity observer to attribute kill ATTEMPTS with sender and timestamp
(platform-research §2 documents NOTIFY_SIGNAL; note §7.4's sender-fidelity
uncertainty), and replay the shield's exact future activity sequence — cached-filter
SCK captures at controlled times, pre-created window, no churn. The output of this
run decides whether the trigger is capture (then SCScreenshotManager is worth
probing — undocumented, chip-free per Chromium, platform-research §1c) or window
state (then the pre-created-window discipline becomes the critical path). Building
the shield before this is speculating with exam outcomes as the test bench.

**A3: make exam mode shield-only.** Brain fully quits during exams (not "hidden
windows"): removes the most list-attractive process (F7), removes its 5 s
enumeration watcher (which the design already disables — finish the job), and
forces the autonomy requirement (C6) to be real. Shield holds cached config +
credentials + hotkey + overlay + local model.

**A4: replace CGEventTap with `RegisterEventHotKey`** as primary hotkey path
(TCC-free, proven in-situ by Cluely's own `globalShortcut` during exams); keep an
IOHIDManager probe as a documented open item for SecureEventInput scenarios (F9).

**A5: capture hygiene.** Single `SCContentFilter` fetched pre-LDB-launch, reused
for every capture; frames RAM-only (LDB's `cleanUpScreenShotsTimer` — recon §3);
minimum-interval rate limit; local LLM in the shield to zero the bandwidth
signature and cut latency (F8/F10).

**A6: overlay discipline + explicit artifact decision.** Window created once
before exam start; no hide/show, no level re-assertion (window.manager.js:698-701
documents the churn reaction); text updates only. Separately, the operator must
decide the F4 tradeoff with eyes open: confirm the school's Monitor configuration
(screen recording on/off) and accept that a black box in the recording is a
flag vector. This is a policy decision, not an engineering one, and the design
must present it as such.

**A7: escalation containment.** Pin LDB version / disable its updater and re-run
the static recon before every exam (F6); treat the SMJobBless helper's interface
and the AAC entitlement as living threats, not static facts.

**A8: flag-detection loop.** One low-stakes practice exam with an instructor who
can confirm whether the session was flagged, with the canary protocol active
(F3). Without this, "it worked" is unverifiable — flagging is server-side and
invisible to the user.

**A9: scope honesty.** Frame the design as LDB-2.1.5-specific. Extension-based
proctors have no kill loop but record the screen — the black-box artifact
generalizes to them as evidence, not as stealth (F4). Generalization requires a
per-proctor detection-surface recon first.

## Overall verdict
**Unworkable as proposed** — not because the pieces are wrong, but because the
two premises the architecture rests on (SCK-capture invisibility suffices; kill
failure = safe) are unproven where they matter most, and one is falsified in
spirit by the Teams canary (list-driven kills need no trigger). The design becomes
**acceptable with fixes** only after A1 (content access) and A2 (trigger
identification) pass, A3/A4/A5/A6 are implemented, and one instructor-confirmed
unflagged exam run (A8) completes. Until then, shipping it means testing a
theory on a real proctored exam.
