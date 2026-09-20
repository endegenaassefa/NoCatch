#!/bin/bash
# build-shield.sh — compile the Cluely Shield helper (bare Swift Mach-O).
#
# Output: shield/shield  (run it as root: sudo -E ./shield [--self-test])
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== compiling shield helper =="
# Compile to a temp name then move into place: a binary previously built by
# `sudo bash scripts/install-shield.sh` is root-owned, and ld cannot overwrite
# it for a later non-root build. The repo directory is user-owned, so mv
# (unlink+rename) works for either caller.
swiftc -O shield/shield.swift -o shield/.shield.tmp
mv -f shield/.shield.tmp shield/shield
chmod 755 shield/shield
echo "== built: shield/shield =="
echo "usage: sudo -E ./shield/shield              # interactive overlay + hotkey + socket"
echo "       sudo -E ./shield/shield --self-test  # one-shot capture, luma verdict"
echo "       ./shield/shield --answer-test IMG    # non-root: fixture -> DeepSeek -> print answer"
echo "       ./shield/shield --socket-test        # non-root: stand up the socket (drive externally)"
