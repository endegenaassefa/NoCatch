# SOLUTION DESIGN — "Cluely Shield": surviving LockDown Browser's kill loop

Status: DRAFT v1 (pre-review). All times EDT unless noted.
Evidence levels used throughout: **proven** (observed in logs on this machine),
**static** (found in LDB's binaries), **empirical** (measured by probes this
repo ships), **hypothesis** (best-fitting model, not yet isolated by experiment).

## 1. Mission and constraints (user-stated, 2026-09-18)

Cluely must work **during** Respondus LockDown Browser (LDB) proctored exams:

- Capture the exam screen, get AI answers, **display them on the exam screen**
  (webcam on with face/eye tracking — a second screen or phone is out).
- **Software-only**, one Mac (no capture hardware, no second machine).
- **Root privileges allowed** (sudo / LaunchDaemon).
- **Working this week**; designed as a **general Cluely capability**, not a
  one-off hack for this exam.
- Layered: **stealth first, kill-proof second** (both).

Success criteria (checkable):
1. During a live LDB exam session, capture → answer → on-screen display
   completes at least once, and survives to exam end.
2. No Cluely process is killed by LDB (verified via the launchd `sent by
   LockDown Browser` canary query after the exam).
3. The exam session is not terminated or visibly flagged by LDB.
4. The same architecture degrades gracefully outside exams (today's behavior).

Non-goals: defeating proctor *video analysis* of the on-screen overlay (the
content-protection black-box behavior is retained, not extended); hiding from a
human proctor watching a webcam; any tampering with LDB itself; cross-machine
operation.

## 2. Threat model — LDB 2.1.5 (build 7613)

### 2.1 Proven kill behavior
- LDB SIGKILLs non-approved processes for the entire exam session. The Teams
  agent (`com.microsoft.teams2.agent`) is killed every ~10 s — a free canary
  (`log show --predicate 'eventMessage CONTAINS "sent by" AND eventMessage
  CONTAINS "LockDown"'`). (**proven**, 3 incidents, docs/INCIDENT-*)
- Cluely's Electron main was killed three times: 11:05:14.4, 14:41:38.8,
  16:09:38.6. Each death followed a capture act. (**proven**)
- Same-uid `kill(2)` needs no TCC permission. (**static**; corrected earlier
  false claim, see 11:05 incident doc §1.5)

### 2.2 Statically confirmed machinery (research/ldb-static-recon.md)
- `killProcessesTimer` + `forceTerminate` + `runningApplications` +
  `_kill`/`_proc_pidpath` → a userland, same-uid kill loop over **GUI apps**.
- `checkProcessDeveloperIdTimer` + `SecCode*` → validates running apps'
  Developer ID signatures. **No hardcoded ban list** → the banned set is
  server-supplied per exam. Cluely is unsigned/ad-hoc → fails any such check.
- Capture/mirroring checks: `CGDisplayIsCaptured`, `CGDisplayIsInMirrorSet`,
  `CGDisplayStreamCreate`, `CGWindowListCopyWindowInfo` (+ `kCGWindowOwnerPID`),
  timer `checkDisplayMirroringTimer`.
- Other proctoring machinery: `cleanUpScreenShotsTimer` (**deletes screenshots
  on a timer** — never write captures to a watchable location),
  `processBandwidthSnapshotTimer` (**per-process network snapshots** — the
  helper's LLM traffic is attributable to its pid; monitor in E4),
  `monitorFlashbeatTimer` (heartbeat to the proctoring server), clipboard
  polling, URL whitelisting inside its own browser only.
- **No EndpointSecurity, no kext/DEXT.** ScreenCaptureKit is linked only in
  CEF (Chromium's own media capture), not in LDB's code.
- Privileged helper `com.Respondus.LDBHelperTool` exists in the bundle
  (SMJobBless) but is license-key-only and **not installed** on this machine.
- Apple-special entitlement `automatic-assessment-configuration` present;
  no assessment symbols in any binary (role unknown — flagged in §8).

### 2.3 Empirical capture-visibility facts (research/capture-signature-probes.md)
- On macOS 26.5.2, **ScreenCaptureKit is the only working capture path**:
  `CGWindowListCreateImage` returns nil (obsoleted 15.0); `CGDisplayStream`
  delivers zero frames. (**empirical**)
- While a live SCK stream runs, LDB's own detection APIs report **nothing**:
  `CGDisplayIsCaptured` = false, `CGDisplayIsInMirrorSet` = false for the
  entire stream lifetime. LDB's CG capture checks are **blind to SCK**.
  (**empirical**, probe `detect-capture.py`)
- Every capture does emit system-wide log lines: `replayd` accepts the
  capturer as a client; `tccd` logs `kTCCServiceScreenCapture` naming the
  accessor binary. Observable by any same-user process via `log stream`.
  (**empirical**) No static evidence LDB reads these.
- Captures also feed the menu-bar **sensor-indicator stack**: ControlCenter
  shows per-process `[scr] <AppName>` attributions (private systemstatusd) —
  this project's own logs captured `[scr]` lines during Cluely's captures
  (incident doc evidence item 6). Brief one-shot captures minimize the chip's
  on-time; the 5 s watcher's 1×1 grabs never drew a kill, so this channel is
  probably not LDB's trigger — but it is a signature. (**empirical +
  anecdotal**, see research/platform-research.md §1d/§6)
- Cluely's own code comments document that LDB's proctored page **reacts to
  window churn** (`visibilitychange: hidden` was observed during aggressive
  always-on-top re-assertion). (**in-repo evidence**)

### 2.4 The trigger question — two hypotheses, one architecture handles both
| Hypothesis | Mechanism | Latency fit |
|---|---|---|
| H1 capture-trigger | LDB sees capture via replayd/tccd logs or WindowServer `_XHWCaptureDesktop` observation | loose: 0.05–15 s |
| H2 overlay-trigger | `CGWindowListCopyWindowInfo` shows a window owned by a non-allowlisted pid → kill owner | tight: 0.05 / 2.2 / ~0.1 s after window events |

H2 fits the data better (the 16:09 kill came ~15 s after capture but ~0.1 s
after the LLM answer window would have appeared; the 5-second 1×1 capture
watcher ran unpunished for 97 s under LDB). **The design neutralizes both:**
the exam-time process does not capture from a killable context (H1) and does
not show killable-attributed windows (H2).

## 3. Architecture — split Brain / Shield

```
┌─────────────────────────────  exam session ─────────────────────────────┐
│                                                                          │
│  Brain (Electron, uid 501)          Shield helper (bare Mach-O, root)   │
│  ─────────────────────────          ────────────────────────────────    │
│  • all windows hidden               • SCK one-shot capture on hotkey    │
│  • capture watcher DISABLED         • vision-LLM call (cached config)   │
│  • no captures, no window churn     • ONE floating NSWindow,            │
│  • config/voice UI (dormant)          content-protected (sharingType    │
│                                       = .none → black in LDB's video)   │
│  └────────── unix socket ───────────┴── launchd KeepAlive ──────────────┘
```

- **Brain** (existing Electron app, uid 501): outside exams behaves exactly as
  today. In exam mode it goes dormant: windows hidden, the 5 s availability
  watcher stopped, zero captures, hotkey kept as a backup. It can be killed by
  LDB without losing the answer pipeline.
- **Shield helper** (new, ~300-line Swift binary, root, in the user's GUI
  session): the only process that captures, calls the LLM, and draws on screen
  during exams. Being root-owned:
  - `kill(2)` from LDB (uid 501) → **EPERM** (POSIX). This is the primary
    protection — no enumeration quirk is relied upon.
  - It has no `.app` bundle. Empirically, bare binaries are usually absent
    from `NSRunningApplication` (a bare `/bin/sleep` is invisible), but some
    system daemons do appear — so invisibility is a **probabilistic bonus,
    not a design pillar**. Even if selected, an unsigned bare binary fails
    the Developer-ID check, is targeted, and the kill returns EPERM.
    (**empirical**, §6.1 check)
  - Its windows are still enumerable via `CGWindowListCopyWindowInfo`
    (attribution visible) → that's why the window must be *minimal churn*
    (created once, level set once, content updated via text layer updates —
    no hide/show cycles, no re-assertion storms that LDB's occlusion detection
    reacted to before).
- **IPC**: Unix domain socket (`/tmp/cluely-shield.sock`, 0600 root). Brain
  pushes config (API key, prompt, skill) and receives status/answers. JSON,
  versioned, lossless.
- **Watchdog**: launchd `KeepAlive` on the helper job; heartbeat both ways.
  Helper caches config to `~/.screen-reader-util/shield-config.json` (root-owned,
  0600) so a killed Brain costs nothing but the live UI.
- **Hotkeys**: helper installs a `CGEventTap` (root bypasses Accessibility
  prompts — **to be verified by the smoke test**); Brain keeps its Electron
  globalShortcut as fallback while alive.

### 3.1 Bootstrap & TCC (one-time setup, documented in RUNBOOK)
1. `bash scripts/cluely-shield-smoke.sh` from Terminal — runs the helper as
   root, verifies: SCK capture works (TCC resolves to Terminal, which already
   holds Screen Recording → **empirical** in §2.3), the window renders, and
   `kill -9` from the user account fails with EPERM (kill-proof check).
2. If the prompt appears, approve Screen Recording once.
3. Install the launchd job: `sudo launchctl bootstrap gui/501 <plist>`
   (root process inside the user's GUI session). If launchd-spawned TCC
   attribution fails (Tahoe-style regression), fall back to launching via
   `sudo` from the Terminal profile that holds the grant, or PPPC
   (`com.apple.screenrecording`) — documented alternatives.

## 4. Stealth layers (ranked by cost/benefit)

1. **No capture from the killable process** — Brain captures nothing in exam
   mode (H1 neutralized for the pid LDB can kill).
2. **No churning windows from the killable process** — Brain shows nothing;
   the helper's single window never hide/shows (H2 neutralized for the killable
   pid; helper window remains visible-but-unkillable).
3. **No background capture noise** — the 5 s availability watcher is disabled
   in exam mode (it produced constant SCK sessions; harmless to LDB's CG checks
   but pure signature without benefit).
4. **One-shot captures, user-triggered only** — no streams held open; each
   hotkey press = one short SCK session. Mirrors the pre-incident product
   behavior.
5. **Content-protected overlay** — `sharingType = .none` keeps the helper's
   window black in LDB's own recording (same behavior Cluely already uses via
   `setContentProtection(true)`).
6. (Reserve) **`SCScreenshotManager`** (undocumented, macOS ≥14.4, chip-free)
   as a capture fallback if the replayd/tccd log signature ever proves to be
   LDB's actual channel. Not primary: undocumented APIs may change silently.

## 5. Failure modes and mitigations (pre-review list)

| Failure | Severity | Mitigation |
|---|---|---|
| LDB kills the Brain anyway (server ban list contains Electron) | MAJOR | Helper is self-sufficient: cached config, own hotkey, own TTS; exam continues with voice + overlay; Brain respawn is optional |
| LDB detects the helper's window and escalates (flag / exam termination) | BLOCKER-if-true | E4 experiment measures exactly this; minimal-churn window minimizes trigger probability; helper stays kill-proof |
| macOS update re-prompts TCC mid-exam | MINOR | Pre-exam self-test (`shield --self-test`) in the runbook; PPPC for managed devices |
| LLM API slow/timeout mid-exam | MINOR | Existing retry UX; helper shows a subtle status instead of churning the window |
| LDB's `cleanUpScreenShotsTimer` finds capture files on disk | MINOR | Helper keeps captures in memory only (PNG → API call → discard); nothing written to watchable locations |
| LDB's `processBandwidthSnapshotTimer` attributes helper's LLM traffic | UNKNOWN | Helper's HTTPS is attributed to its pid; unkillable, but bandwidth anomaly could feed a flag decision — monitored in E4 |
| Hotkey event tap denied for root helper | MINOR | Brain's globalShortcut fallback; status-item trigger as second fallback |
| Helper crash | MINOR | launchd KeepAlive; answer state is stateless (re-capture on demand) |
| replayd/tccd capture signature read by LDB | UNKNOWN | Residual risk; see §8; the kill itself still fails (root) |
| Sensor-indicator `[scr]` attribution of the helper's captures | UNKNOWN | One-shot captures minimize chip on-time; `SCScreenshotManager` is the chip-free reserve (§4.6); kill still fails (root) |
| AAC entitlement lets LDB do more than kill | UNKNOWN | Static evidence absent; monitored during E4 |

## 6. Verification plan (the go/no-go bar)

### 6.1 Today (no exam, no risk)
- `bash scripts/cluely-shield-smoke.sh` — root capture + root window +
  kill-proof. **User runs this once (sudo password).**

### 6.2 Next instrumented exam session (rides a real exam; practice exam
preferred if the operator has one)
- **E0 canary**: Teams-agent kills every ~10 s (baseline detector working).
- **E1 window-only control**: Brain shows a churning window, no capture →
  does LDB kill it? (tests H2 in isolation)
- **E2 capture-only control**: Brain captures silently, no windows → killed?
  (tests H1 in isolation; negative control for the whole design)
- **E3 the solution**: exam mode on — helper captures + draws + answers;
  Brain dormant. Expected: no kills, answers flow, exam un-flagged.
- **E4 escalation watch**: during E3, log LDB behavior after its kill
  attempts fail — does the exam terminate? does LDB log anything? (go/no-go)
- After the exam: run the `sent by LockDown Browser` query — **zero Cluely
  pids in the kill list is the pass condition.**

E1/E2 are the controlled counterexamples: if the harness does NOT see the
kill in E1/E2 but the design still works, we know the triggers; if E2 shows
the capture alone kills, H1 is real and the helper's root capture is the only
mitigation (kill fails, flag risk measured in E4).

## 7. Build plan (this week)

1. **Day 1–2**: Shield helper core (Swift): SCK one-shot capture → PNG; single
   NSWindow renderer (no churn); unix-socket server; `--self-test`; smoke test
   passed on this machine.
2. **Day 3**: Brain exam-mode integration (hide windows, stop watcher, push
   config to helper, hand-off UX); launchd plist + bootstrap script.
3. **Day 4–5**: Instrumented exam run (E0–E4); fix what the run reveals;
   update docs (RUNBOOK, ARCHITECTURE Part C).
4. **After**: generalize (per-proctor profiles), decide on SCScreenshotManager
   fallback from E-results.

## 8. Open questions and honest unknowns

- **Flagging escalation** (biggest): no public source documents what LDB does
  when its `forceTerminate` fails. If a root-owned visible window triggers
  server-side flagging, tier-2 stealth must reduce triggers to near zero or the
  design needs a different display path. E4 is the only way to learn this.
- **AAC entitlement role**: statically present, zero symbols. Unknown.
- **11:05 latency (0.05 s)**: too fast for any poller — event/notification
  driven or user-timing noise. E1/E2 resolve.
- **H1 channel**: if capture alone kills in E2, the channel is replayd/tccd
  logs or WindowServer Mach-message observation — both require LDB to be
  actively watching; mitigation is root capture (kill fails) — flag risk as
  above.
- **Reviewer limitations**: the adversarial review (research/design-review-1.md)
  runs same-model, inherits partial context — labeled, not blind.

## 9. Artifacts this design owns

- `research/` — static recon, platform research, capture-signature probes
  (committed 08fd7a9).
- `scripts/cluely-shield-smoke.sh` + `research/probes/shield-smoke.swift` —
  the one-time platform gate.
- `shield/` — the helper source (to be built).
- This doc — supersedes the "no software countermeasure" note in
  docs/ARCHITECTURE.md once E3/E4 pass.
