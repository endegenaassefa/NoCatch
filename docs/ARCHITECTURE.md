# Architecture — OpenCluely + Exam Scanner

Two independent systems live in this repo. This document describes both so a
practitioner can work on either without guessing.

---

## Part A — Cluely (the Electron screen-reader app)

### Purpose
A stealth screen-reader/keystroke assistant (Electron) that helps the operator
during a proctored exam. It disguises itself as Apple's Terminal.

### Process tree (dev run)
```
Terminal (real, pid 691)
 └─ login → -zsh
     └─ npm start  (node)
         └─ node (electron npm shim)
             └─ Electron main            ← disguised "Terminal " (process.title)
                 ├─ Electron Helper (GPU)
                 ├─ Electron Helper (network)
                 └─ Electron Helper (Renderer) ×N   ← overlay/chat/settings UI
```

### Key components

| File | Role |
|---|---|
| `main.js` (~2,700 lines) | Main process: stealth disguise, capture hotkeys, IPC, LLM/speech wiring, death-watch instrumentation (Sep 18) |
| `src/managers/window.manager.js` | Window lifecycle, screen-share guard, 5 s ScreenCaptureKit availability watcher |
| `src/services/capture.service.js` | Screenshot capture (`desktopCapturer.getSources` → ScreenCaptureKit) |
| `src/capture-routing.js` | Depth Engine E9 gate chain for mid-capture key routing |
| `scripts/keystroke-capture/main.swift` | Swift CGEventTap helper: global key capture, SecureEventInput probe, modifier restoration, orphan watchdog |
| `preload.js`, `index.html`, `settings.html`, `onboarding.html`, `llm-response.html`, `chat.html` | UI surfaces |

### Stealth mechanics (as observed by the scanner)
- `app.setName` / `process.title` → shows as **"Terminal "** (trailing space) in `ps`.
- Activation policy `accessory` (no Dock icon); windows non-activating panels.
- **TCC attribution rides on this**: every Screen-Recording check is attributed to
  `com.apple.Terminal` (the real Terminal that launched it), because TCC resolves
  the *responsible process* up the launch chain. macOS therefore records
  "Terminal" as the screen recorder, not Cluely.
- No network activity observed at all during the exam session.

### Known failure modes (sourced, not speculative)
1. **Silent death by external signal** — no signal handlers; a kill leaves zero
   trace. Fixed for *visibility* only: `death-watch.log` hooks + armored launcher.
2. **Self exit(1) from Electron native code** — the 14:41:38.84 exam incident;
   exact native fatal line still unknown (stderr was not captured that run).
3. **EIO logging loop** — when the launching Terminal dies, winston console
   writes fail with EIO and the uncaught-exception handler keeps the app alive
   while logging floods (10:04 incident).
4. **Single-instance-lock zombies** — partial kills leave helper trees that block
   relaunch (Sep 17 cleanup).
5. **GPU helper fragility** — two `Electron Helper (GPU)` SIGABRT crashes on
   Sep 17 (`bug_type 309`).

---

## Part B — Exam scanner (`exam-scan/`)

### Purpose
Record, at machine level, what happens *between* Cluely and LockDown Browser
during a proctored exam: an interaction forensics recorder, not a business app.

### Components

| File | Role |
|---|---|
| `live-capture.sh` (647 lines) | Orchestrator. bash-3.2 portable (no assoc arrays, no `setsid`). Census + 16 stream collectors, sudo branch, detach mode, clean shutdown |
| `analyze.py` (770 lines) | Merges streams → `report.md` + `merged-events.jsonl`; generation registry, coverage manifest, coincidence windows |
| `dtrace/signals.d` | `proc:::signal-send / exec-success / exit` — **BLOCKED by SIP on this machine** (honest MISSING) |
| `probe/secureinput.swift` | `IsSecureEventInputEnabled()` probe, compiled at capture start |
| `probe/exit-hook-test.js` | Validation harness for Cluely's death-watch hooks |
| `baseline/` | Pre-exam reference snapshots for diffing |

### The ten scan dimensions
1. **Identity/generation registry** — classify every pid by executable path
   (undisguisable), track births/deaths; a death hard-closes a generation.
2. **Signals** — dtrace (SIP-blocked here → MISSING).
3. **IPC** — `lsof -U` unix sockets, XPC/AppleEvents via filtered `log stream`.
4. **TCC attribution** — accessor vs responsible-process chains.
5. **Focus & SecureEventInput** — `lsappinfo front`, compiled secureinput probe.
6. **Network** — metadata only (lsof + nettop); never payloads.
7. **Filesystem** — `fs_usage` (sudo; flood-prone), `ldb-files` session-log
   growth watcher (this one saved the exam run).
8. **Resource/power** — top/cpu/memory/power streams.
9. **On-disk diffs** — start/end snapshots.
10. **Coverage telemetry** — heartbeat-per-stream; absence = gap, never a
    negative finding.

### Structural rules (reviewer-mandated)
- Coverage manifest: a missing stream is DEGRADED/MISSING, never "nothing happened".
- Generation registry keys on `pid + lstart + exe`; classified by executable path.
- Verified channels (same file/socket/pid) are separated from temporal-coincidence.
- Observer exclusion: scanner consumes no TCC, low CPU, never signals foreign pids
  (cleanup only touches its own children).
- Monotonic-ish time: cadence via elapsed-since-last-fire, not wall-clock modulo.

### Known harness defects (fixed or mitigated)
| Defect | Status |
|---|---|
| `fs_usage -w -f filesys` whole-system flood (~50 MB/s, 2.6 GB in 2 min) | stream deleted mid-run by operator; post-exam fix planned (live filter by target pids) |
| winston-follow re-dump loop (8.8 GB, 127 M lines of duplicated 11 MB source) | data preserved (gzip); follower EOF-tracking fix pending |
| dtrace blocked by SIP | documented MISSING (unavoidable) |
| bash 3.2 assoc-array / `setsid` / `+=` incompatibilities | worked around (file-backed state, `nohup`, `printf %q`) |

### Artifacts layout
```
exam-scan/
  live-capture.sh      analyze.py       README.md
  baseline/            dtrace/          probe/
  capture/<UTC-timestamp>/        ← one dir per run (gitignored)
    streams/*.jsonl|.ndjson
    census/{census,lifecycle}.jsonl
    start/ end/            (system snapshots)
    logs/                  (winston follow, dtrace.err, sudo.log)
    run-info.txt  capture.pid  stop  bg-map.txt  .seen-state
    report.md  merged-events.jsonl   (after analyze.py)
```
