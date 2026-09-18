#!/bin/bash
# cluely-shield-smoke.sh — run ONCE from a Terminal (asks your password once).
#
# Verifies the three platform assumptions of the Shield architecture:
#   A) a root helper can capture the screen via ScreenCaptureKit in your GUI session
#   B) a root helper can draw a window on your desktop
#   C) that helper cannot be SIGKILLed by your own user account (kill-proof)
#
# Expected result: CAPTURE_OK, WINDOW_SHOWN, KILL_BLOCKED, KILL_PROOF_OK.
# If the first run shows a Screen Recording prompt, approve it for Terminal
# (or the helper binary) and run again.
set -u
cd "$(dirname "$0")/.." || exit 1

echo "== compiling helper =="
swiftc -O research/probes/shield-smoke.swift -o research/probes/shield-smoke || exit 1

echo "== launching helper as root (password prompt next) =="
rm -f /tmp/shield-smoke.out
sudo -E ./research/probes/shield-smoke > /tmp/shield-smoke.out 2>&1 &
SUDO_PID=$!

PID=""
for _ in $(seq 1 60); do
  PID=$(grep -o 'SMOKE_PID [0-9]*' /tmp/shield-smoke.out 2>/dev/null | awk '{print $2}' | head -1)
  [ -n "$PID" ] && break
  sleep 0.3
done
if [ -z "$PID" ]; then
  echo "FAIL: helper did not start — /tmp/shield-smoke.out:"
  cat /tmp/shield-smoke.out
  wait "$SUDO_PID" 2>/dev/null
  exit 1
fi
echo "helper pid=$PID (you should see the smoke window on screen)"

sleep 4
echo "== testing kill(2) from your user account (expect 'operation not permitted') =="
if kill -9 "$PID" 2>/tmp/shield-kill.err; then
  echo "UNEXPECTED: kill succeeded — helper is not root-owned"
  cat /tmp/shield-kill.err
else
  echo "KILL_BLOCKED (expected): $(cat /tmp/shield-kill.err)"
fi
sleep 1
if kill -0 "$PID" 2>/dev/null; then
  echo "KILL_PROOF_OK: helper survived your SIGKILL attempt"
else
  echo "KILL_PROOF_FAIL: helper died"
fi

echo "== waiting for helper to finish =="
wait "$SUDO_PID" 2>/dev/null
echo "== helper output =="
cat /tmp/shield-smoke.out
