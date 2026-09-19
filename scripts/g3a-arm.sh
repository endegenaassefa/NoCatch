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
if pgrep -x g3a-rig > /dev/null 2>&1; then
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] WARN: a g3a-rig is running — a real run would ABORT here."
  else
    echo "ABORT: a g3a-rig is already running. A second rig would double-schedule"
    echo "captures and truncate the live run's log. If that run is done or stale:"
    echo "  sudo pkill -x g3a-rig   # then re-run this script"
    exit 1
  fi
fi
for app in Electron "Google Chrome" Claude Teams "Microsoft Teams"; do
  if pgrep -x "$app" > /dev/null 2>&1; then
    echo "WARN: '$app' is running — a killable GUI app. Quit it before the quiz"
    echo "      (it contaminates the clean phase; LDB would kill it anyway)."
  fi
done

echo "== Teams launch-agent gate (continuous killable target would ruin P1) =="
CONSOLE_UID=$(stat -f %u /dev/console 2>/dev/null || echo 501)
CONSOLE_USER=$(stat -f %Su /dev/console 2>/dev/null || id -un "$CONSOLE_UID" 2>/dev/null || echo "$USER")
if [ "$DRY" = 1 ]; then
  echo "[dry-run] would run: launchctl bootout gui/$CONSOLE_UID/com.microsoft.teams2.agent"
else
  launchctl bootout "gui/$CONSOLE_UID/com.microsoft.teams2.agent" 2>/dev/null || true
  sleep 2
fi
if pgrep -f "com.microsoft.teams2.agent" > /dev/null 2>&1; then
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] WARN: teams2.agent is running — a real run would ABORT here."
  else
    echo "ABORT: Teams launch agent still running. It respawns and is a continuous"
    echo "killable target — G2 ground truth shows LDB SIGKILLing it every ~10 s."
    echo "Quit Teams, then boot it out manually and re-run:"
    echo "  launchctl bootout gui/$CONSOLE_UID/com.microsoft.teams2.agent"
    echo "  pgrep -f com.microsoft.teams2.agent   # must print nothing"
    exit 1
  fi
else
  echo "teams2.agent: not running"
fi

if [ "$DRY" = 1 ]; then
  echo "[dry-run] skipping sudo steps. Would run:"
  echo "  sudo -v"
  echo "  sudo -E $RIG --arm-check"
  echo "  sudo -E nohup eslogger signal > ~/.screen-reader-util/logs/eslogger-<ts>.jsonl 2>&1 < /dev/null &"
  echo "  sudo -E launchctl asuser <console-uid> /usr/bin/sudo -u <console-user> $CANARY --ttl 5   (canary pre-flight, uid verified)"
  echo "  sudo -E nohup $RIG --log $RIGLOG --canary $CANARY --duration $DURATION > /tmp/g3a-rig.stdout.log 2>&1 < /dev/null &"
  echo "  $EXPOSE --log $RIGLOG"
  echo "  sudo -E nohup caffeinate -d -t $DURATION > /tmp/g3a-caffeinate.log 2>&1 < /dev/null &"
  echo "[dry-run] done — no processes started."
  exit 0
fi

echo "== sudo pre-heat (you may be asked for your password) =="
sudo -v || exit 1

echo "== arm-check: one root capture now (TCC gate — fails here, not mid-exam) =="
sudo -E "$RIG" --arm-check --log /tmp/g3a-armcheck.log
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

echo "== canary pre-flight: real uid-501 GUI spawn via launchctl asuser =="
echo "   (launchctl asuser alone does NOT setuid — sudo -u drops to the console"
echo "    user. A root canary would be unkillable and invert the P2 control.)"
sudo -E launchctl asuser "$CONSOLE_UID" /usr/bin/sudo -u "$CONSOLE_USER" "$CANARY" --ttl 5 > /tmp/g3a-canary-preflight.log 2>&1
sleep 7
if grep -q "CANARY_START" /tmp/g3a-canary-preflight.log 2>/dev/null \
   && grep -q "uid=$CONSOLE_UID" /tmp/g3a-canary-preflight.log 2>/dev/null \
   && grep -q "CANARY_HB" /tmp/g3a-canary-preflight.log 2>/dev/null \
   && grep -q "CANARY_ALIVE_FULL_TTL" /tmp/g3a-canary-preflight.log 2>/dev/null; then
  echo "CANARY_PREFLIGHT_OK — asuser+sudo-u GUI spawn, uid verified, heartbeats, clean exit"
else
  echo "ABORT: canary pre-flight failed — the uid-501 GUI spawn chain is unverified."
  echo "Pre-flight log:"; cat /tmp/g3a-canary-preflight.log 2>/dev/null
  echo "(Expected CANARY_START with uid=$CONSOLE_UID / CANARY_HB / CANARY_ALIVE_FULL_TTL.)"
  exit 1
fi

echo "== launching rig (root, detached — survives Terminal close) =="
sudo -E nohup "$RIG" --log "$RIGLOG" --canary "$CANARY" --duration "$DURATION" \
  > /tmp/g3a-rig.stdout.log 2>&1 < /dev/null &
sleep 10
if ! grep -q "G3A_FILTER_READY" "$RIGLOG" 2>/dev/null; then
  echo "ABORT: rig did not reach FILTER_READY. Log:"
  cat "$RIGLOG" 2>/dev/null
  echo "stdout:"; cat /tmp/g3a-rig.stdout.log 2>/dev/null
  exit 1
fi
if ! grep -q "G3A_HOTKEY_OK" "$RIGLOG" 2>/dev/null; then
  echo "ABORT: rig hotkey registration failed (G3A_HOTKEY_FAIL in log) — the"
  echo "⌘⇧Space quiz-live anchor and manual captures will not work."
  sudo -E pkill -x g3a-rig 2>/dev/null || true
  exit 1
fi
echo "rig: G3A_FILTER_READY + G3A_HOTKEY_OK"
grep "G3A_START" "$RIGLOG"

echo "== exposure probe (as your user — what LDB's checks can see of the rig) =="
"$EXPOSE" --log "$RIGLOG" || echo "WARN: exposure probe failed (non-fatal — see output above)"

echo "== caffeinate (no sleep during the experiment) =="
# covers the rig's worst-case lifetime (late quiz start extends the rig past
# DURATION by up to the phase tail — see rig G3A_END_EXTENDED)
sudo -E nohup caffeinate -d -t $((DURATION + 1200)) > /tmp/g3a-caffeinate.log 2>&1 < /dev/null &
sleep 1
if pgrep -x caffeinate > /dev/null 2>&1; then
  echo "caffeinate: running"
else
  echo "WARN: caffeinate not detected — check /tmp/g3a-caffeinate.log"
  echo "      (a mid-run sleep compromises the experiment; see runbook Limitations)."
fi

echo
echo "================================================================"
echo " G3A ARMED. Rig pid: $(grep -o 'pid=[0-9]*' "$RIGLOG" | head -1 | cut -d= -f2)"
echo " armed at:  $(date)  /  UTC $(date -u '+%Y-%m-%d %H:%M:%S')"
echo " eslogger:    $ESLOG"
echo " rig log:     $RIGLOG"
echo "================================================================"
echo " Automatic timeline (phase offsets count from the moment LockDown Browser"
echo " first appears; the rig self-exits 45 min after ARMING):"
echo "   +90s   capture 1   (clean phase — no killable GUI target)"
echo "   +300s  capture 2   (clean phase)"
echo "   +480s  canary appears  — EXPECT it to be killed by LDB within ~10-30s"
echo "   +540s  capture 3   (canary window)"
echo "   +660s  capture 4   (post-canary, clean condition restored)"
echo "   +720s  decoy root window appears (stays visible — this is deliberate)"
echo "   +780s  capture 5   (decoy window)"
echo "   +2700s rig self-exits (later if the quiz started late — see runbook)"
echo
echo " NOW:"
echo "   1. QUIT this Terminal (everything above is detached and survives)."
echo "   2. Open LockDown Browser and start the PRACTICE quiz promptly"
echo "      (the schedule assumes the quiz starts within a couple of minutes)."
echo "   3. When the FIRST QUESTION appears, press ⌘⇧Space ONCE — this logs a"
echo "      manual=1 capture that anchors quiz-live in the rig log — and note"
echo "      the wall-clock time (eslogger is UTC; your notes are local)."
echo "   4. During the quiz: DO NOTHING else. Write down ANY dialog, warning,"
echo "      or quiz termination, with the exact time."
echo "   5. After the quiz: reopen Terminal and run the collection commands"
echo "      in docs/G3A-RUNBOOK.md, then paste the output in chat."
echo
echo " To abort the experiment early:  sudo pkill -f g3a-rig"
