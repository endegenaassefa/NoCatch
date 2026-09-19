#!/bin/bash
# build-shield.sh — compile the Cluely Shield helper (bare Swift Mach-O).
#
# Output: shield/shield  (run it as root: sudo -E ./shield [--self-test])
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== compiling shield helper =="
swiftc -O shield/shield.swift -o shield/shield
echo "== built: shield/shield =="
echo "usage: sudo -E ./shield/shield             # interactive overlay + hotkey"
echo "       sudo -E ./shield/shield --self-test # one-shot capture, luma verdict"
