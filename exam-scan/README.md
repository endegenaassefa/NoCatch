# exam-scan — Cluely ↔ LockDown Browser interaction scanner

Live, OS-level capture of what happens **between** Cluely (the Electron
screen-reader app) and Respondus LockDown Browser while they run at the same
time during an exam session. It answers, with evidence, questions like:

- does either tree ever signal/kill the other? (the open question from the
  09-18 shutdown forensics)
- what files, sockets, and IPC endpoints do they share?
- what TCC permissions does each request while the other is active?
- does LDB's kiosk/secure-input mode silence Cluely's keystroke tap?
- who talks to whom on the network, when, and how much?
- what changed on disk between exam start and exam end?

## Files

| file | role |
|---|---|
| `live-capture.sh` | orchestrator: census, identity registry, 18 event streams, snapshots, cleanup |
| `analyze.py` | merges a capture into one timeline + `report.md` |
| `dtrace/signals.d` | records every signal sent/handled system-wide (sudo branch) |
| `baseline/` | pre-exam reference snapshot (already captured) |
| `capture/<ts>/` | one run's data: streams, census, start/end snapshots, report |

## Usage

```bash
# in Terminal, BEFORE launching LockDown Browser:
cd ~/Desktop/OpenCluely/exam-scan
bash live-capture.sh              # stop with Ctrl+C when the exam is over
#   --detach                      # RECOMMENDED for exam day — see below
#   --duration 600                # or auto-stop after N seconds
#   --no-sudo                     # skip elevation (loses dtrace + fs_usage)
#   --selftest 25                 # 25-second smoke test, no exam needed

# after the exam:
python3 analyze.py capture/<timestamp>/
open capture/<timestamp>/report.md
```

`--detach` re-execs itself in a new session with stdio redirected, so closing
the Terminal window cannot kill the scan. Stop a detached run cleanly:
`pkill -TERM -f 'live-capture.sh'` (the TERM trap flushes the end snapshot).

### The "close other applications" prompt — what happens and what we capture

LockDown Browser shows a blocking "close these applications" screen before an
exam. Verified from the 09-18 forensics on this machine: **LDB cannot itself
terminate other processes** (no privileged helper, no Accessibility/AppleEvents
permission, and macOS gives userland apps no kill API for foreign pids). The
prompt lists apps and *you* close them. That moment is exactly what this scan
exists to record:

- the scanner is windowless and runs in the background — it does not appear
  in LDB's app list and is not closed by the prompt;
- `--detach` means even closing Terminal (or LDB demanding it) cannot kill
  the capture — all data lands on disk continuously;
- the report timeline then shows the sequence: focus flips to LDB → census
  proves Cluely is still alive underneath the prompt → the closure action →
  death events, signals (with sudo), and Cluely's own final log lines
  (winston-follow) with attribution to whoever/whatever performed the close.

## What is captured (by dimension)

1. **Identity & lineage** — per-second census of both process trees; each pid
   classified by *executable path* (immune to argv/comm disguises — the
   disguised "Terminal " main is found by comm sweep + parent-chain walk)
   with start-time generation tracking and death-hard boundaries, so pid
   reuse can't conflate actors. `codesign` identity + entitlements of both
   apps at start and end.
2. **Lifecycle & signals** — births/deaths/generations, plus (sudo) a dtrace
   stream recording **every signal sent and handled** with sender/recipient
   pids, launched inside a self-terminating root wrapper — the only way to
   catch a cross-tree kill live.
3. **IPC** — per-tree open files, unix-domain sockets (`lsof -U`), a targeted
   `com.apple.xpc` + `appleeventsd` log stream, lsappinfo registrations.
4. **TCC** — every tccd AUTHREQ/attribution line for both bundles and their
   disguises, classified registry-first (accessor/responsible pids) with
   keyword fallback flagged as lower confidence.
5. **Input & display contention** — frontmost-app polling via `lsappinfo
   front` (no Automation TCC consumed — the old osascript sampler was
   observed injecting TCC requests into the very stream it observes), a
   compiled `IsSecureEventInputEnabled()` probe, and a live follow of
   Cluely's own Winston logs (tap status / capture availability lines).
6. **Network, metadata only** — per-pid TCP/UDP peers, ports, states; per-app
   byte flows via nettop. **No payloads, ever.**
7. **Filesystem** — per-pid file activity (`fs_usage`, sudo) post-filtered by
   the identity registry; paths touched by both trees are flagged.
8. **Resource & power** — per-app top samples (pid,cpu,mem,state,command),
   vm_stat, iostat, pmset sleep assertions, low-power-mode state.
9. **On-disk change** — crash-report watcher (each new file emitted once),
   LDB encrypted-session-log size growth, shell-history hash/size (catches a
   kill ritual as it is written), plist/hosts/TCC.db/LaunchAgent/kext diffs
   between start and end.
10. **Coverage telemetry** — capability manifest + per-stream heartbeats;
    coverage is judged as spans over the actual run window (start → end), so
    a stream that dies mid-exam renders DEGRADED with the death time — never
    as "nothing happened".

## Safety & honesty boundary

- The scan is **read-only with respect to the two apps**; it only writes into
  `capture/<ts>/` and reads system diagnostics.
- Network capture is IP/port/byte-count metadata. Exam content is never
  captured.
- LDB's `ldb-hc-log-session-*.dat` files are encrypted; only their size/mtime
  is observed.
- Nothing here requires disabling SIP or granting the scanner any TCC
  permission. `dtrace`/`fs_usage` need sudo and may be refused even then
  (SIP on Apple Silicon); the coverage table reports exactly what ran.
- Temporal co-occurrence (both apps busy in the same 2 s window) is reported
  as a *candidate*, distinct from verified channels (signals, shared files,
  socket peers, TCC attribution).

## Known limitations

- lsof/fd samples are point-in-time; sub-second opens between samples are
  missed.
- `nettop` keys by process name; two same-named processes can merge in its
  output (mitigated by pid-keyed lsof sampling).
- SecureEventInput is read via the compiled IsSecureEventInputEnabled probe;
  if the probe fails to compile, the stream records `unknown` and Cluely's
  own tap-status logs are the fallback.
- The analyzer aligns streams on wall clock; sleep/lid-close gaps appear in
  the coverage table as gap spans, and ordering claims spanning a gap should
  be treated as suspect.
- dtrace and fs_usage need sudo. On Apple Silicon with SIP enabled, dtrace's
  proc provider may be refused even as root — the coverage table and
  `logs/dtrace.err` say exactly what happened, and the report never pretends
  the signal channel ran when it didn't.
- Analyzer memory is bounded: fs_usage events are aggregated per
  (app, path, minute) and the merged timeline caps at 300k records (raw
  streams always remain intact on disk).
