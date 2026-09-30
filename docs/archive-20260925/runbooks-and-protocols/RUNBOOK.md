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
- Static recon (docs/research/ldb-static-recon.md) confirms the machinery:
  `killProcessesTimer` + `forceTerminate` over `NSRunningApplication` +
  Developer-ID signature checks (ban list is server-supplied), plus
  CoreGraphics observation (`CGDisplayIsCaptured`, `CGWindowListCopyWindowInfo`
  with owner PIDs). No EndpointSecurity.
- The kill trigger is now **proven to be screen-capture activity**
  (2026-09-19: capture → kill in 6.9–8.9 s; prior 2.2/15 s). **Visible windows
  alone are innocent** (96.8 s visible, no kill) — but with today's
  single-process app the capture and the windows live in the same killable
  process, so **any capture during the exam is fatal.**
- LDB also **sweeps the server ban list at exam start** (killed 16 Claude.app
  processes in one burst at 13:50:07 on 2026-09-19). Keep ban-list-attractive
  apps (Claude, other AI assistants) closed before entering.
- The 16:09:38.6 retest validated the recorder chain end-to-end: shim SIGKILL
  line in the tee'd console log + `exit-status.txt` + death-watch silence
  (correct for SIGKILL). **Always launch via `bash cluely-safe-start.sh`,
  never bare `npm start`.**

### 6.1 Kill attribution with Apple's ES logger (ground truth, added 2026-09-19)
`sudo eslogger signal` records **every** signal with sender + target audit
tokens — it named LDB[66693] → Electron[66031] byte-for-byte on 2026-09-19.
Prerequisites: Full Disk Access for Terminal (System Settings → Privacy &
Security → Full Disk Access; then **quit and reopen Terminal** — a running
Terminal does not pick up the grant). Usage (leave running during the exam):
```
sudo eslogger signal | tee -a ~/.screen-reader-util/logs/eslogger-$(date +%Y%m%d-%H%M%S).jsonl
```
Extraction:
```
python3 - <<'EOF'   # or see research/probes/ for the parse script
import json
F = "<eslogger file>"
for line in open(F):
    e = json.loads(line)
    sig = e.get("event", {}).get("signal", {})
    if sig.get("sig") == 9:
        t = sig["target"]; s = e["process"]
        print(sig.get("time", e["time"])[:23], "target", t["audit_token"]["pid"],
              t["executable"]["path"], "<- sender", s["audit_token"]["pid"],
              s["executable"]["path"])
EOF
```
Note: quitting Terminal kills its session's processes — including any
recorders launched from that terminal. Leave the eslogger terminal alone.

## 7. Shield mode (exam operations) — per docs/SOLUTION-DESIGN.md
Once the Shield helper is built (`shield/`), exam operations change:
1. **One-time setup:** `sudo bash scripts/install-shield.sh` — builds the
   helper, installs it to `/usr/local/bin/cluely-shield`, and seeds the shared
   socket token. Optionally run `bash scripts/cluely-shield-smoke.sh` once to
   verify the platform assumptions (root capture, kill-proof, hotkey).
2. **Pre-exam flight check:** start the helper in a terminal (it must run in
   your Aqua session — there is no launchd daemon):
   `sudo -E /usr/local/bin/cluely-shield`. Verify
   `sudo /usr/local/bin/cluely-shield --self-test` prints `PIXELS_OK`. Keep
   Teams running as the canary.
3. **Enter exam mode:** use the ⌃⌥⇧E shortcut or Settings → "Cluely Shield
   (Exam Mode)". This pushes the DeepSeek config to the helper and the Brain
   fully quits (no dormant Brain — no killable uid-501 GUI target remains).
4. **During the exam:** press ⌘⇧Space — the helper (root) captures, calls the
   LLM, and draws the answer overlay. The Brain is gone; answers flow only from
   the helper.
5. **After the exam:** run the `sent by LockDown Browser` query — **zero
   Cluely/helper pids in the kill list is the pass condition.** With the
   helper installed, also collect the kill-attempt ground truth from Apple's
   ES logger (`sudo eslogger signal` — records every signal with sender and
   target; one consent prompt). Record whether the exam flagged/terminated
   (the G3 gate: instructor confirmation, not self-assessment).
