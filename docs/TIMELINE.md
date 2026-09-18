# Project Timeline — OpenCluely ("screen-reader-util")

Master chronological record of this repository. All times are **EDT (UTC−4)** unless marked `Z`.
Every entry is sourced from evidence on disk: git history, file mtimes, capture streams,
npm logs, zsh session files, and the incident reports in `docs/`.

---

## 1. Repo origin (July 2026)

| Date | Event | Evidence |
|---|---|---|
| Jul 10 | Repo seeded from an earlier web-app project ("Ship Windows+Linux only", SEO/downloads commits) | `git log` dffdf1a → 0a9da75 |
| Jul 25–29 | macOS env-path resolution refactor, local Whisper support, SEO/metadata work | `git log` bc6dae5 → 638d85d |

## 2. Cluely stealth build (Sep 15–17)

| Date | Event | Evidence |
|---|---|---|
| Sep 15 18:26 | App skeleton in place (`webapp/`, `assests/`, `lib/`, LICENSE) | file mtimes |
| Sep 16 13:20 | `/etc/hosts` pinned `platform.audn.ai` + DNS cache flushes | `~/.zsh_sessions` history; `FORENSIC_SHUTDOWN_REPORT.md` §3.2 |
| Sep 16 18:17–20:38 | ENGINEERING_BRIEF + ENGINEERING_PLAN written | file mtimes |
| Sep 16 21:17–22:44 | env.example, onboarding flow, docs/TESTING_CAPTURE.md | file mtimes |
| Sep 17 00:31–02:43 | Stealth commit series: overlay focus-steal fix, accessory activation policy, disguise rebrand to `screen-reader-util`, DeepSeek provider, mock-proctor harness, focus-fix audit | `git log` 15eb717 → b59facf |
| Sep 17 09:45–17:09 | FEATURE_AUDIT → R2 → R3, capture-flow work, handoff brief | file mtimes; `git log` 5c5975e, d731fe1 |
| Sep 17 21:16–21:27 | HackerRank **sample** test capture session (2-question FizzBuzz sample; `enable_keystroke_tracking:true`, `enable_open_apps_tracking:true` observed in the captured test config) | `capture.json` attempt.starttime `2026-09-17T21:16:47Z`; `scripts/capture.js` |

## 3. Depth Engine hardening marathon (Sep 18, 06:20–09:58)

| Time | Event | Evidence |
|---|---|---|
| 06:20–09:58 | `depth-engine de-0002` run: L-0048 → L-0070; Q066–Q078 bundle; capture-routing contract (E9: 18-item palette, gate chain, refusal validation, share-flag + geometry freeze, Swift flags/restoration/watchdog); 56-case chord-trace harness; E10/E11 BUILD-READY | `git log` e7dabd5 → d77b90f |

## 4. Morning incident cluster (Sep 18, 10:04–11:45)

| Time | Event | Evidence |
|---|---|---|
| 10:04:18 | Instance 9229: Terminal parent died (EIO flood on stdout) — app **survived** | `error-2026-09-18.log`, `exceptions.log` |
| ≤10:39:42 | Instance 9229 killed by user's shell ritual (`kill -9` via pgrep) | `~/.zsh_history` line 1112 |
| 10:45:17 | Machine reboot (unclean flags, no panic report) | `last reboot`, kern.boottime |
| 11:00:52 | Instance 1625 starts; LDB session `1789743715901` begins 11:01:55 | Winston log; `ldb-hc-log-session-*` |
| **11:05:14.4** | **Instance 1625 killed — fatal external signal mid-capture** (no crash report, no graceful-quit log; LDB ruled out by kernel/TCC evidence) | full chain in `docs/INCIDENT-2026-09-18-1105-FORENSICS.md` |
| 11:05–11:45 | LDB session keeps running 40 min after the kill | `ldb-hc-log-session-1789743715901.dat` growth |
| 12:12 | FORENSIC_SHUTDOWN_REPORT.md written | file mtime |

## 5. Exam scanner build (Sep 18, 12:57–14:06)

| Time | Event | Evidence |
|---|---|---|
| 12:57 | `exam-scan/baseline/` pre-exam snapshot (procs, TCP listeners, LDB dat sizes, winston sizes, frameworks) | dir mtime |
| 13:18 | `exam-scan/dtrace/signals.d` probe (later proven BLOCKED by SIP) | mtime |
| 13:52 | `exam-scan/probe/secureinput.swift` | mtime |
| 14:01–14:06 | `live-capture.sh` (bash-3.2 portable), `README.md`, `analyze.py` finalized | mtimes |
| 13:00–14:06 | Three reviewer rounds (B1–B10 defects fixed: ndjson timestamps, sudo wrapper leaks, disguise classification, cadence starvation, fs_usage OOM, etc.) | session history |

## 6. The exam capture (Sep 18, 14:28–14:43)

| Time | Event | Evidence |
|---|---|---|
| 14:28:33 | **Run 1** `20260918T182833Z` launched (`--detach`), ~1.5 min practice | `capture/.detach-staging/*/runner.log` |
| 14:30:18 | **Run 2** `20260918T183018Z` launched — the real recording | `run-info.txt` |
| 14:30–14:33 | `fs_usage -w -f filesys` floods ~2.6 GB at ~50 MB/s → user kills it, deletes stream (filesystem channel lost; `ldb-files` channel survived) | transcript; stream mtimes |
| 14:36:10 | New Terminal window; 14:36:19 `npm start` → **Cluely launches** (main pid 78031, disguised "Terminal ") | census/lifecycle |
| 14:36:26 | Cluely Screen Recording TCC: **ALLOWED** (attributed to `com.apple.Terminal`); Cluely's own Microphone request: **DENIED** (`authValue=1` — voice stayed off, app logged "Local Whisper unavailable") | unified log |
| 14:37:42 | **LockDown Browser launches** (pid 5590) | lifecycle |
| 14:37:49 | LDB camera granted; video/hand-pose pipeline starts | unified log |
| 14:37:52 | LDB "Alerts" helper (close-apps prompt) | lifecycle |
| 14:38:04 | LDB `kTCCServiceListenEvent` → **DENIED** (cannot keyboard-listen) | TCC verdict |
| 14:38:35 | LDB Microphone → **ALLOWED** | TCC verdict |
| 14:37:52–14:42:45 | LDB frontmost continuously; SecureEventInput OFF the whole run (152 probes) | focus + secureinput streams |
| 14:41:36.6 | Cluely's last act: SCK enumeration of LDB's fullscreen windows | unified log |
| **14:41:38.84** | **Cluely self-exits with code 1** — all 7 processes gone; npm log records `exit 1`, no signal | `~/.npm/_logs/2026-09-18T18_36_19_416Z-debug-0.log`; WindowServer "Process death" |
| 14:42:45 | LDB quits; last encrypted session-log write (`1789756668914.dat`, 3.8 MB, born 14:37:48) | `ldb-files` stream |
| 14:43:07 | Recorder stopped cleanly (`pkill -TERM`) | `capture-state.jsonl` |
| 14:52 | `analyze.py` → `report.md` + 70,772-event `merged-events.jsonl` | mtimes |

Full findings: `docs/EXAM-CAPTURE-2026-09-18.md` and
`exam-scan/capture/20260918T183018Z/report.md`.

## 7. Death investigation + instrumentation (Sep 18, 15:05–15:20)

| Time | Event | Evidence |
|---|---|---|
| 15:05–15:17 | `/investigate`: mechanism proven — Electron main **self-exit(1)** at 14:41:38.84 (npm exit-code proof; LDB/user/agents/scanner/jetsam all excluded) | `docs/INCIDENT-2026-09-18-144138.md` |
| 15:15 | `cluely-safe-start.sh` created (console tee + exit-status capture) | file mtime |
| 15:17 | `main.js` death-watch hooks (exit code, render/child-process-gone) | `git diff` |
| 15:15:48–15:16 | Smoke test: armored launch + SIGTERM → shim records `exited with signal SIGTERM`; wrapper writes `exit_code=1` | `console-20260918-151548.log`, `exit-status.txt` |
| 15:19 | Exit-hook validated: `app.exit(7)` → `death-watch.log: process exit event, code=7` | `exam-scan/probe/exit-hook-test.js` |

## 8. Documentation & repo cleanup (Sep 18, ~15:30+)

| Time | Event |
|---|---|
| — | This documentation set created under `docs/`; historical audits relocated to `docs/history/`; branch `docs/project-documentation` created; capture artifacts gitignored; 8.8 GB winston-follow flood compressed (reversible, evidence preserved). |

---

## Quick index of evidence locations

| Artifact | Path |
|---|---|
| Exam capture data | `exam-scan/capture/20260918T183018Z/` (run 2) |
| Practice capture | `exam-scan/capture/20260918T182833Z/` (run 1) |
| Scanner | `exam-scan/live-capture.sh`, `exam-scan/analyze.py` |
| Pre-exam baseline | `exam-scan/baseline/` |
| Cluely logs | `~/.screen-reader-util/logs/` (app, error, exceptions, death-watch, console-*, exit-status) |
| npm death record | `~/.npm/_logs/2026-09-18T18_36_19_416Z-debug-0.log` |
| LDB encrypted sessions | `~/Library/Application Support/Respondus LockDown Browser/ldb-hc-log-session-*.dat` |
| Shell histories | `~/.zsh_sessions/*.history` |
