#!/bin/bash
# cluely-safe-start-root.sh — EXPERIMENTAL: launch Cluely AS ROOT.
#
# Purpose: crude pre-Shield kill-proofing. LockDown Browser's kill loop runs
# as your user (uid 501); kill(2) against a root-owned process fails with
# EPERM, so a root-launched Cluely should survive LDB's SIGKILLs.
#
# WARNINGS:
#  - NOT validated by the smoke test unless you ran scripts/cluely-shield-smoke.sh
#    and saw CAPTURE_OK + KILL_PROOF_OK first.
#  - Chromium requires --no-sandbox as root (added below).
#  - Screen Recording TCC resolves to your Terminal (already granted), so
#    capture should work — the smoke test confirms.
#  - Files Cluely creates under ~/.screen-reader-util may become root-owned.
#    After the exam run:  sudo chown -R "$USER" "$HOME/.screen-reader-util"
#
# Usage:  bash scripts/cluely-safe-start-root.sh
set -u
cd "$(dirname "$0")/.."

LOGDIR="$HOME/.screen-reader-util/logs"
mkdir -p "$LOGDIR"
TS="$(date +%Y%m%d-%H%M%S)"
CONSOLE_LOG="$LOGDIR/console-root-$TS.log"
STATUS_FILE="$LOGDIR/exit-status-root.txt"

echo "Cluely (ROOT) console log: $CONSOLE_LOG"
echo "(password prompt next; leave this terminal alone during the exam)"

sudo -E env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . --no-sandbox --disable-gpu 2>&1 | tee -a "$CONSOLE_LOG"

CODE=${PIPESTATUS[0]:-1}
echo "exit_code=$CODE" > "$STATUS_FILE"
echo "Cluely(root) exited with code $CODE (see $STATUS_FILE)"
echo "Cleanup hint: sudo chown -R \"$USER\" \"$HOME/.screen-reader-util\""
exit "$CODE"
