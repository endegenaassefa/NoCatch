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
echo "Built $OUT_DIR/keystroke-capture"
