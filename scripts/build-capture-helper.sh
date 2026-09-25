#!/usr/bin/env bash
# Compatibility entry point for existing developer instructions.
set -euo pipefail
exec node "$(dirname "$0")/build-capture-helper.js" "$@"
