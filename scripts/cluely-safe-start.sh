#!/bin/bash
# cluely-safe-start.sh — launch Cluely with its console (stdout+stderr) tee'd
# to a timestamped log, and record the final exit status to a status file.
#
# Why this exists: on 2026-09-18 14:41:38.8 Cluely's Electron main process
# exited with code 1 leaving no trace anywhere (no crash report, no app log
# line, no signal record). Chromium/Electron print their fatal reasons to
# stderr — this wrapper captures that, so the next incident names its own
# cause. The exit code is also written to exit-status.txt (137=SIGKILL,
# 143=SIGTERM, 1=native self-exit, etc).
#
# Usage:  bash cluely-safe-start.sh
# Logs:   ~/.screen-reader-util/logs/console-YYYYMMDD-HHMMSS.log
# Status: ~/.screen-reader-util/logs/exit-status.txt

set -u
cd "$(dirname "$0")"

LOGDIR="$HOME/.screen-reader-util/logs"
mkdir -p "$LOGDIR"

TS="$(date +%Y%m%d-%H%M%S)"
CONSOLE_LOG="$LOGDIR/console-$TS.log"
STATUS_FILE="$LOGDIR/exit-status.txt"

echo "Cluely console log: $CONSOLE_LOG"

# Same env as package.json "start", but stderr+stdout tee'd to disk.
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . 2>&1 | tee -a "$CONSOLE_LOG"

CODE=${PIPESTATUS[0]:-1}
echo "exit_code=$CODE" > "$STATUS_FILE"
echo "Cluely exited with code $CODE (see $STATUS_FILE)"
exit "$CODE"
