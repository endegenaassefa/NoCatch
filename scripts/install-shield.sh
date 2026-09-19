#!/bin/bash
# install-shield.sh — install the Cluely Shield root helper.
#
# One-time setup: builds the helper, installs it to /usr/local/bin, and seeds
# the shared socket token (root config + the Brain's .env) so the Brain can
# authenticate to the helper's socket.
#
#   sudo bash scripts/install-shield.sh
#
# The helper is a GUI process (overlay + ScreenCaptureKit), so it must run in
# the user's Aqua session. There is deliberately NO launchd daemon: a
# LaunchDaemon boots into the system session, which cannot draw the overlay or
# capture the screen (proven 2026-09-19 — `bootstrap system` rejects the plist
# with "Service cannot load in requested session", and even a bootstrapped
# daemon would be headless). Start the helper in a terminal before the exam:
#
#   sudo -E /usr/local/bin/cluely-shield
#
# Idempotent: re-running updates the binary and reuses the existing token.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

BIN=/usr/local/bin/cluely-shield

echo "== build helper =="
bash scripts/build-shield.sh

echo "== install binary → $BIN =="
install -m 0755 shield/shield "$BIN"
echo "installed: $(ls -l "$BIN" | awk '{print $1, $NF}')"

echo "== generate shared socket token (root config + Brain .env) =="
CONFIG_DIR=/var/root/.cluely-shield
CONFIG=$CONFIG_DIR/config.json
mkdir -p "$CONFIG_DIR"
# Load an existing token if present (idempotent re-install); else generate one.
TOKEN=""
if [ -f "$CONFIG" ] && command -v python3 >/dev/null 2>&1; then
  TOKEN=$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("token",""))
except Exception:
    print("")' "$CONFIG")
fi
if [ -z "${TOKEN:-}" ]; then
  TOKEN=$(openssl rand -hex 24)
fi
# Merge the token into the root config, preserving any existing fields.
python3 - "$CONFIG" "$TOKEN" <<'EOF'
import json, os, sys
path, token = sys.argv[1], sys.argv[2]
cfg = {}
if os.path.exists(path):
    try:
        cfg = json.load(open(path))
    except Exception:
        cfg = {}
cfg["token"] = token
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(cfg, open(path, "w"), indent=2)
os.chmod(path, 0o600)
print("root config token written:", path)
EOF
# Write the token into every .env the Brain may read. The Brain's
# resolveEnvPath() (main.js) prefers Electron's userData .env over the repo
# .env once the userData one exists — so we write BOTH, or a dev who has run
# the app once would read a token-less .env and get "unauthorized" forever.
write_token_to_env() {
  local envfile="$1"
  if [ -f "$envfile" ]; then
    if grep -q '^CLUELY_SHIELD_TOKEN=' "$envfile" 2>/dev/null; then
      sed -i '' "s|^CLUELY_SHIELD_TOKEN=.*|CLUELY_SHIELD_TOKEN=$TOKEN|" "$envfile"
    else
      printf '\nCLUELY_SHIELD_TOKEN=%s\n' "$TOKEN" >> "$envfile"
    fi
    echo "Brain .env token written: $envfile"
  else
    echo "WARN: no .env at $envfile — set CLUELY_SHIELD_TOKEN=$TOKEN there manually"
  fi
}
write_token_to_env "${OPENCLUELY_ENV:-$(cd "$(dirname "$0")/.." && pwd)/.env}"
write_token_to_env "$HOME/Library/Application Support/screen-reader-util/.env"

echo
echo "Done. Config: $CONFIG (root-only, 0600)"
echo "Socket:  /tmp/cluely-shield.sock"
echo
echo "Start the helper in a terminal before the exam (it needs your GUI session):"
echo "  sudo -E $BIN"
echo
echo "To enter exam mode from the Brain (Electron): use the ⌃⌥⇧E shortcut or the"
echo "Settings → 'Cluely Shield (Exam Mode)' button."
