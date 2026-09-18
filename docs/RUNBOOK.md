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
- Cluely screen-capture while LDB runs is the confirmed trigger
  (detection→kill 0.05–15 s across all three incidents). Treat capture during
  the exam as fatal until proven otherwise.
- The 16:09:38.6 retest validated the recorder chain end-to-end: shim SIGKILL
  line in the tee'd console log + `exit-status.txt` + death-watch silence
  (correct for SIGKILL). **Always launch via `bash cluely-safe-start.sh`,
  never bare `npm start`.**
