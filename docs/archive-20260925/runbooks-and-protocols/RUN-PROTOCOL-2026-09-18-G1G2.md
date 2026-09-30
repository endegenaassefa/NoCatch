# RUN PROTOCOL — G1/G2 measurement run (2026-09-18, exam session)

Purpose: the fix (Shield helper) is NOT built yet. This run collects the two
gate measurements the fix depends on, with sender-attributed kill ground truth:

- **G1 (content gate):** does the exam screen yield real pixels when captured?
- **G2 (trigger identification):** is the kill trigger capture, overlay
  windows, or something else? `sudo eslogger signal` records EVERY signal with
  sender + target, closing the anon-pid attribution gap from earlier incidents.

## Roles
- **User:** drives Cluely + LDB; runs two terminal commands before the exam.
- **Agent:** runs all watchers, the scheduled capture probe, and post-exam
  analysis. No manual capture/window actions needed from the user mid-exam.

## Before the exam (user, in Terminal)
1. **Terminal A** — armored Cluely launch (leave open):
   `bash cluely-safe-start.sh`
   → overlay appears. Then **⌘⇧V** to hide Cluely's windows (⌘⇧V again toggles).
   Cluely stays RUNNING but hidden for the whole exam — whether LDB kills a
   hidden, non-capturing Electron is itself data.
2. **Terminal B** — the signal ground truth (leave open; password prompt,
   approve any permission dialog mentioning eslogger):
   `sudo eslogger signal | tee -a ~/.screen-reader-util/logs/eslogger-$(date +%Y%m%d-%H%M%S).jsonl`
3. Open LockDown Browser, enter the exam as usual.

## During the exam (user)
- Nothing required. Optional, at a moment of your choosing (mid-exam, when you
  can spare 90 seconds): **⌘⇧V** (show windows) → wait ~90 s → **⌘⇧V** (hide).
  This tests whether windows alone trigger a kill. Skip it if you'd rather not.

## During the exam (agent — automatic)
- Presence poller logs LDB/Electron every 5 s; 120 s after LDB first appears
  it runs the pixel-verdict probe once (invisible: no window, no files).
- Signal stream logs: LDB `sent by` kills, WindowServer process deaths,
  replayd/tccd ScreenCapture events — all timestamped.
- Post-exam: `log show` queries (launchd kills, deaths, capture TCC events),
  correlation against the eslogger JSONL, and a findings write-up.

## What each outcome means
| Observation | Verdict |
|---|---|
| Probe prints `VERDICT PIXELS_OK` during exam | G1 passes — exam content is capturable |
| Probe prints `PIXELS_BLACK` | F2 confirmed — design dead, stop |
| Hidden Cluely killed with no capture/windows | Electron is on the server ban list (list-driven kill) |
| Cluely killed within ~90 s of ⌘⇧V (windows, no capture) | H2: overlay-window trigger |
| Probe killed right after the capture | H1: capture trigger |
| Nothing dies at all | Trigger is narrower than both hypotheses (re-run needed) |

## Experimental option (only if you want to try "the fix" tonight)
If `bash scripts/cluely-shield-smoke.sh` passed earlier, you may launch Cluely
**as root** instead of step 1:
`bash scripts/cluely-safe-start-root.sh`
→ LDB cannot SIGKILL a root process. Unverified flag risk; after the exam run:
`sudo chown -R "$USER" "$HOME/.screen-reader-util"`

## After the exam (user)
- Say "done" in chat. The agent runs the analysis and writes it up.
- If the root option was used: run the chown command above.
