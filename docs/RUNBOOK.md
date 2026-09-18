# Runbook — operating the scanner and the armored app

Procedures, in order. Read this before an exam, not during.

---

## 1. Launch Cluely (armored)

```bash
cd ~/Desktop/OpenCluely
bash cluely-safe-start.sh
```

- Console output tee'd to `~/.screen-reader-util/logs/console-<ts>.log`.
- Final exit status written to `~/.screen-reader-util/logs/exit-status.txt`
  (137=SIGKILL, 143=SIGTERM, 1=self-exit, 0=clean).
- Exit code + renderer/GPU deaths logged to `~/.screen-reader-util/logs/death-watch.log`.
- If `death-watch.log` ever shows `child-process-gone type=GPU`, try
  `npm run dev` (`--disable-gpu`) as a mitigation experiment.

## 2. Start the scanner (detached)

```bash
cd ~/Desktop/OpenCluely/exam-scan
sudo -v                          # pre-heat sudo for the privileged streams
bash live-capture.sh --detach
```
- Capture dir and stop instructions print inside
  `capture/.detach-staging/<ts>/runner.log`.
- **Do not edit `live-capture.sh` or `analyze.py` while a run is active**
  (bash reads the file incrementally; mid-run edits corrupt the capture).

## 3. During the exam
- Launch order: **Cluely first, then LockDown Browser** (scanner auto-discovers
  both regardless).
- LDB's "close other applications" screen is expected; it cannot touch the
  scanner or Cluely (proven; see incident docs).
- **Watch for the fs_usage flood**: if disk fills fast in the first minutes,
  `sudo pkill fs_usage` and `sudo rm -f capture/<ts>/streams/fs-usage.txt`.
  The `ldb-files` stream keeps running and still tracks LDB's session logs.

## 4. Stop and analyze
```bash
pkill -TERM -f 'live-capture.sh'      # clean stop, keeps all data
cd ~/Desktop/OpenCluely/exam-scan
python3 analyze.py capture/<ts>/
open capture/<ts>/report.md
```
Expected coverage lines: `dtrace=MISSING` (SIP) and possibly `fs_usage=MISSING`
— those are honest gaps, not failures.

## 5. After-action checks
```bash
cat ~/.screen-reader-util/logs/exit-status.txt
cat ~/.screen-reader-util/logs/death-watch.log
ls -t ~/.screen-reader-util/logs/console-*.log | head -1
```

## Safety notes
- `sudo` here requires a password per call; `sudo -v` only caches for a few
  minutes.
- The scanner is windowless and immune to closing Terminal (`--detach`).
- Capture directories are gitignored; compress the winston-follow flood with
  `gzip` after each run if it re-bloats (follower EOF-tracking fix is pending).
- Never commit `.env`, `capture.json(l)`, or anything under `exam-scan/capture/`
  — the `.gitignore` already covers them.

## 6. Known adversary behavior (LDB — discovered 2026-09-18 16:09)
- **LockDown Browser SIGKILLs non-approved apps during the whole exam.**
  Verify per incident:
  `log show --predicate 'eventMessage CONTAINS "sent by" AND eventMessage CONTAINS "LockDown"'`
  (launchd records each kill with sender + victim; the Teams agent is a free canary).
- Static recon (research/ldb-static-recon.md) confirms the machinery:
  `killProcessesTimer` + `forceTerminate` over `NSRunningApplication` +
  Developer-ID signature checks (ban list is server-supplied), plus
  CoreGraphics observation (`CGDisplayIsCaptured`, `CGWindowListCopyWindowInfo`
  with owner PIDs). No EndpointSecurity.
- The kill trigger has two rival hypotheses (docs/SOLUTION-DESIGN.md §2.4):
  capture activity, or a visible overlay window owned by a non-approved pid.
  **Both are fatal with today's single-process app** — Cluely captures and
  shows windows from one killable process. Until the Shield helper exists:
  **treat any capture AND any overlay display during the exam as fatal.**
- The 16:09:38.6 retest validated the recorder chain end-to-end: shim SIGKILL
  line in the tee'd console log + `exit-status.txt` + death-watch silence
  (correct for SIGKILL). **Always launch via `bash cluely-safe-start.sh`,
  never bare `npm start`.**

## 7. Shield mode (exam operations) — per docs/SOLUTION-DESIGN.md
Once the Shield helper is built (`shield/`), exam operations change:
1. **One-time setup:** `bash scripts/cluely-shield-smoke.sh` (asks sudo
   password once) — verifies root capture works, the root-drawn overlay
   renders, an event tap works, and `kill -9` from your account fails with
   "operation not permitted" (the kill-proof guarantee).
2. **Pre-exam flight check:** start the helper (launchd job or
   `sudo ./shield/helper --daemon`), run `./shield/helper --self-test`, enable
   **exam mode** in Cluely (hides all Brain windows, stops the 5 s capture
   watcher, hands config to the helper). Keep Teams running as the canary.
3. **During the exam:** press the capture hotkey as usual — the helper (root)
   captures, calls the LLM, and draws the answer overlay. The Brain stays
   dormant. If LDB kills the Brain, answers keep flowing from the helper
   (voice included).
4. **After the exam:** run the `sent by LockDown Browser` query — **zero
   Cluely/helper pids in the kill list is the pass condition.** Record whether
   the exam flagged/terminated (the E4 escalation watch).
