#!/bin/bash
# cluely-root-exam.sh — launch the FULL Cluely app as root for proctored exams.
#
# This is the rebuild the operator asked for: Cluely ITSELF runs at the root
# level (the shield's privilege level), so the entire UI — chat history,
# question-type switching, mic recording, typing, settings, capture — is the
# kill-immune process. LockDown Browser's uid-501 kill loop gets EPERM exactly
# as it did against the shield helper in the real 2026-09-19 test.
#
# Usage:
#   sudo bash scripts/cluely-root-exam.sh
#
# Rules:
#   * Do NOT run the shield helper (/usr/local/bin/cluely-shield) at the same
#     time — both register ⌘⇧Space and would race for the chord.
#   * Launch Cluely BEFORE LockDown Browser.
#   * Normal (non-exam) use stays exactly as before: bash scripts/cluely-safe-start.sh
#
# See docs/ROOT-EXAM-MODE.md for the design and its honest unknowns.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash scripts/cluely-root-exam.sh" >&2
  exit 1
fi

# Keep HOME pointed at the operator's home so logs land in the operator's
# log dir (~/.screen-reader-util/logs). Chromium state is isolated to a
# root-owned dir via --user-data-dir so the normal instance's singleton
# lock and cache are never touched by root.
if [ -n "${SUDO_USER:-}" ]; then
  USER_HOME="$(eval echo ~"$SUDO_USER")"
  export HOME="$USER_HOME"
fi
export CLUELY_ROOT_EXAM=1

ROOT_DATA="/var/root/.cluely-root/userdata"
mkdir -p "$ROOT_DATA"

echo "Launching Cluely as root (root exam mode) — logs: $HOME/.screen-reader-util/logs"

# Chromium refuses to run as root without --no-sandbox; --user-data-dir keeps
# root-owned state out of the operator's Application Support directory.
exec env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron . \
  --no-sandbox \
  --user-data-dir="$ROOT_DATA"
