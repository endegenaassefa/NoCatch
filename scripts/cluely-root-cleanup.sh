#!/bin/bash
# cluely-root-cleanup.sh — restore ownership after a root exam session.
#
# A root Cluely writes logs (~/.screen-reader-util), whisper caches, and may
# touch other user paths. Run this AFTER the exam (with sudo) so the next
# normal (uid-501) launch never hits root-owned EPERM on its own files.
#
#   sudo bash scripts/cluely-root-cleanup.sh

set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash scripts/cluely-root-cleanup.sh" >&2
  exit 1
fi

USER_NAME="${SUDO_USER:-}"
if [ -z "$USER_NAME" ]; then
  echo "SUDO_USER not set — run via: sudo bash scripts/cluely-root-cleanup.sh" >&2
  exit 1
fi

USER_HOME="$(eval echo ~"$USER_NAME")"

chown -R "$USER_NAME" "$USER_HOME/.screen-reader-util" 2>/dev/null || true
chown -R "$USER_NAME" "$USER_HOME/.cache/whisper" 2>/dev/null || true
chown "$USER_NAME" .env 2>/dev/null || true

echo "Root-exam state ownership restored to $USER_NAME"
