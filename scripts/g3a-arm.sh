#!/bin/bash
# g3a-arm.sh — arm the G3A go/no-go experiment (run ONCE, before a PRACTICE quiz).
#
# What it does (each step fails loud and stops if it cannot be verified):
#   1. compiles the rig, canary, and expose probes into /tmp/g3a-kit/
#   2. pre-flight: LDB must NOT be running; warns about killable GUI apps
#   3. --arm-check: one root capture -> PIXELS_OK gate (TCC verified NOW,
#      never discovered mid-exam)
#   4. starts `eslogger signal` detached (kill ground truth) + a live
#      self-check that the stream actually records a test signal
#   5. starts the rig detached (root, GUI session, heartbeat + phases)
#   6. runs the exposure probe as your user (what LDB's checks can see)
#   7. starts caffeinate (no mid-exam sleep) and prints the timeline
#
# Then: QUIT Terminal, open LockDown Browser, take the PRACTICE quiz.
# During the quiz you do nothing — the rig runs the phases automatically.
# Full protocol + interpretation: docs/G3A-RUNBOOK.md
#
# Usage: bash scripts/g3a-arm.sh [--dry-run]
set -u
cd "$(dirname "$0")/.." || exit 1

KIT=/tmp/g3a-kit
RIG=$KIT/g3a-rig
CANARY=$KIT/g3a-canary
EXPOSE=$KIT/g3a-expose
RIGLOG=/tmp/g3a-rig.log
DURATION=2700
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

mkdir -p "$KIT"

echo "== compiling probes =="
swiftc -O research/probes/g3a-rig.swift    -o "$RIG"    || exit 1
swiftc -O research/probes/g3a-canary.swift -o "$CANARY" || exit 1
swiftc -O -lproc research/probes/g3a-expose.swift -o "$EXPOSE" || exit 1
echo "compiled: $RIG, $CANARY, $EXPOSE"

echo "== pre-flight =="
if pgrep -x "LockDown Browser" > /dev/null 2>&1; then
  echo "ABORT: LockDown Browser is already running."
  echo "Quit LDB first — the rig must fetch its screen filter BEFORE LDB launches (F10)."
  exit 1
fi
for app in Electron "Google Chrome" Claude Teams "Microsoft Teams"; do
  if pgrep -x "$app" > /dev/null 2>&1; then
    echo "WARN: '$app' is running — a killable GUI app. Quit it before the quiz"
    echo "      (it contaminates the clean phase; LDB would kill it anyway)."
  fi
done

if [ "$DRY" = 1 ]; then
  echo "[dry-run] skipping sudo steps. Would run:"
  echo "  sudo -v"
  echo "  sudo -E $RIG --arm-check"
  echo "  sudo -E nohup eslogger signal > ~/.screen-reader-util/logs/eslogger-<ts>.jsonl 2>&1 < /dev/null &"
  echo "  sudo -E nohup $RIG --log $RIGLOG --canary $CANARY --duration $DURATION > /tmp/g3a-rig.stdout.log 2>&1 < /dev/null &"
  echo "  $EXPOSE --log $RIGLOG"
  echo "  sudo -E nohup caffeinate -d -t $DURATION > /tmp/g3a-caffeinate.log 2>&1 < /dev/null &"
  echo "[dry-run] done — no processes started."
  exit 0
fi

echo "== sudo pre-heat (you may be asked for your password) =="
sudo -v || exit 1

echo "== arm-check: one root capture now (TCC gate — fails here, not mid-exam) =="
sudo -E "$RIG" --arm-check
case $? in
  0) echo "ARMCHECK PIXELS_OK — capture works as root in this session" ;;
  4) echo "ABORT: PIXELS_BLACK — screen recording permission missing for the"
     echo "sudo-spawn path. System Settings > Privacy & Security > Screen & System"
     echo "Audio Recording: enable Terminal, quit and reopen Terminal, re-run."; exit 1 ;;
  7) echo "ABORT: capture timed out (no frames) — TCC edge; re-run after granting"
     echo "Screen Recording to Terminal (quit+reopen Terminal first)."; exit 1 ;;
  *) echo "ABORT: arm-check failed (no display / capture error). See output above."; exit 1 ;;
esac

echo "== arming eslogger (kill ground truth, detached) =="
mkdir -p "$HOME/.screen-reader-util/logs"
ESLOG="$HOME/.screen-reader-util/logs/eslogger-$(date +%Y%m%d-%H%M%S).jsonl"
sudo -E nohup eslogger signal > "$ESLOG" 2>&1 < /dev/null &
sleep 3

echo "== eslogger self-check: sending a test HUP that MUST appear in the stream =="
sleep 30 &
SPID=$!
sleep 1
kill -HUP "$SPID" 2>/dev/null
sleep 3
if grep -q "\"sig\":1" "$ESLOG" 2>/dev/null && grep "\"sig\":1" "$ESLOG" | grep -q "\"pid\":$SPID"; then
  echo "ES_SELFCHECK_OK — stream live, test event recorded in $ESLOG"
else
  echo "ABORT: eslogger stream recorded nothing for the test signal."
  echo "Grant Full Disk Access to Terminal (System Settings > Privacy & Security >"
  echo "Full Disk Access), QUIT and reopen Terminal, then re-run this script."
  echo "(eslogger pids still running: $(pgrep -x eslogger | tr '\n' ' ')) — kill with:"
  echo "  sudo pkill -x eslogger"
  exit 1
fi

echo "== launching rig (root, detached — survives Terminal close) =="
sudo -E nohup "$RIG" --log "$RIGLOG" --canary "$CANARY" --duration "$DURATION" \
  > /tmp/g3a-rig.stdout.log 2>&1 < /dev/null &
sleep 6
if ! grep -q "G3A_FILTER_READY" "$RIGLOG" 2>/dev/null; then
  echo "ABORT: rig did not reach FILTER_READY. Log:"
  cat "$RIGLOG" 2>/dev/null
  echo "stdout:"; cat /tmp/g3a-rig.stdout.log 2>/dev/null
  exit 1
fi
grep -E "G3A_HOTKEY_(OK|FAIL)" "$RIGLOG" | tail -1
grep "G3A_START" "$RIGLOG"

echo "== exposure probe (as your user — what LDB's checks can see of the rig) =="
"$EXPOSE" --log "$RIGLOG" || echo "WARN: exposure probe failed (non-fatal — see output above)"

echo "== caffeinate (no sleep during the experiment) =="
sudo -E nohup caffeinate -d -t "$DURATION" > /tmp/g3a-caffeinate.log 2>&1 < /dev/null &

echo
echo "================================================================"
echo " G3A ARMED. Rig pid: $(grep -o 'pid=[0-9]*' "$RIGLOG" | head -1 | cut -d= -f2)"
echo " eslogger:    $ESLOG"
echo " rig log:     $RIGLOG"
echo "================================================================"
echo " Automatic timeline (counts from the moment LockDown Browser first appears):"
echo "   +90s   capture 1   (clean phase — no killable GUI target)"
echo "   +300s  capture 2   (clean phase)"
echo "   +480s  canary appears  — EXPECT it to be killed by LDB within ~10-30s"
echo "   +660s  capture 3"
echo "   +720s  decoy root window appears (stays visible — this is deliberate)"
echo "   +2700s rig self-exits"
echo
echo " NOW:"
echo "   1. QUIT this Terminal (everything above is detached and survives)."
echo "   2. Open LockDown Browser and start the PRACTICE quiz promptly"
echo "      (the schedule assumes the quiz starts within a couple of minutes)."
echo "   3. During the quiz: DO NOTHING. Optional: press ⌘⇧Space for extra"
echo "      captures. Write down ANY dialog, warning, or quiz termination."
echo "   4. After the quiz: reopen Terminal and run the collection commands"
echo "      in docs/G3A-RUNBOOK.md, then paste the output in chat."
echo
echo " To abort the experiment early:  sudo pkill -f g3a-rig"
