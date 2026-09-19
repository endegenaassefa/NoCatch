#!/bin/bash
# cluely-shield-smoke.sh — run ONCE from a Terminal (asks your password once).
#
# Verifies the five platform assumptions of the Shield architecture:
#   A) a root helper can capture the screen via ScreenCaptureKit in your GUI session
#   B) a root helper can draw a window on your desktop
#   C) that helper cannot be SIGKILLed by your own user account (kill-proof)
#   D) RegisterEventHotKey (Carbon) — the PRIMARY hotkey path — registers with no TCC
#   E) the overlay joins a fullscreen space (.canJoinAllSpaces + .fullScreenAuxiliary)
#
# Expected result: CAPTURE_OK, WINDOW_SHOWN, KILL_BLOCKED, KILL_PROOF_OK,
# REGISTER_EVENT_HOTKEY_OK, FULLSCREEN_OVERLAY_OK, and a final "G0 PASS".
# Exits non-zero if any of the five checks fails.
# (EVENT_TAP_* is informational only: CGEventTap is the demoted fallback, so a
# tap failure does not fail the gate — the Carbon hotkey is the primary path.)
# If the first run shows a Screen Recording prompt, approve it for Terminal
# (or the helper binary) and run again.
# Close Cluely first: the probe registers ⌘⇧Space (the same chord as Cluely's
# global shortcut), and a duplicate registration fails the hotkey check.
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
# NOTE: `kill -0` cannot be used to test liveness of a ROOT process from a
# non-root shell — the null-signal permission check also fails with EPERM,
# which reads as "process gone" even when the helper is alive (verified:
# `kill -0 1` from uid 501 → "Operation not permitted" while `ps -p 1` shows
# launchd alive). Use ps, which needs no signal permission.
if ps -p "$PID" > /dev/null 2>&1; then
  echo "KILL_PROOF_OK: helper survived your SIGKILL attempt"
  KILL_PROOF_PASS=1
else
  echo "KILL_PROOF_FAIL: helper died"
fi

echo "== waiting for helper to finish =="
wait "$SUDO_PID" 2>/dev/null
echo "== helper output =="
cat /tmp/shield-smoke.out

echo "== asserting gate signals =="
OUT=/tmp/shield-smoke.out
FAILED=""
grep -q 'CAPTURE_OK' "$OUT" || FAILED="$FAILED CAPTURE_OK"
grep -q 'WINDOW_SHOWN' "$OUT" || FAILED="$FAILED WINDOW_SHOWN"
grep -q 'REGISTER_EVENT_HOTKEY_OK' "$OUT" || FAILED="$FAILED REGISTER_EVENT_HOTKEY_OK"
grep -q 'FULLSCREEN_OVERLAY_OK' "$OUT" || FAILED="$FAILED FULLSCREEN_OVERLAY_OK"
[ -n "${KILL_PROOF_PASS:-}" ] || FAILED="$FAILED KILL_PROOF_OK"

if [ -n "$FAILED" ]; then
  echo "G0 FAIL — missing signals:$FAILED"
  exit 1
fi
echo "G0 PASS — all five platform assumptions verified"
