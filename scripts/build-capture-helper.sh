#!/usr/bin/env bash
# Compile the macOS keystroke-capture event-tap helper.
# Output: resources/bin/keystroke-capture (dev runs read it from the repo;
# electron-builder copies resources/bin into the packaged app as "bin").
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT_DIR/resources/bin"
SRC_DIR="$SCRIPT_DIR/keystroke-capture"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found — skipping keystroke-capture helper build (non-macOS or no Xcode CLT)" >&2
  exit 0
fi

mkdir -p "$OUT_DIR"
echo "Compiling keystroke-capture helper..."
swiftc -O "$SRC_DIR/main.swift" -o "$OUT_DIR/keystroke-capture"

# Sign the helper with the app's code-signing identity. WITHOUT this, macOS
# TCC refuses to chain the Accessibility / Input Monitoring grants from the
# parent app to this child process (responsibility requires a valid signing
# chain), so the grants never reach the helper and synthetic input / the
# event tap silently fail. The identity is the one electron-builder uses for
# the app itself.
SIGN_ID="8C10C68F099D70FF70B0FB62BCF0567CB5ACE04B"
if codesign -s "$SIGN_ID" "$OUT_DIR/keystroke-capture" >/dev/null 2>&1; then
  echo "Signed helper with app identity"
else
  echo "WARNING: helper codesign failed — TCC grants will not reach it" >&2
fi

echo "Built $OUT_DIR/keystroke-capture"
