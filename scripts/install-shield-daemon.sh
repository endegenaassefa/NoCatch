#!/bin/bash
# install-shield-daemon.sh — install the Cluely Shield root helper as a
# launchd LaunchDaemon with KeepAlive (auto-start + crash-respawn, as root).
#
# Run ONCE as sudo. Idempotent: re-running updates the binary and plist.
#
#   sudo bash scripts/install-shield-daemon.sh
#
# The PROVEN spawn path is Terminal-sudo (`sudo -E ./shield/shield`). This
# daemon path is the KeepAlive guarantee; see the HONEST CAVEAT in
# shield/com.cluely.shield.plist and docs/SOLUTION-DESIGN.md §8 about whether
# a LaunchDaemon can reach the user's Aqua GUI session for the overlay +
# ScreenCaptureKit capture. If it cannot, keep using the Terminal-sudo fallback.
set -u
cd "$(dirname "$0")/.." || exit 1

BIN=/usr/local/bin/cluely-shield
PLIST=/Library/LaunchDaemons/com.cluely.shield.plist
LABEL=com.cluely.shield

echo "== build helper =="
bash scripts/build-shield.sh || exit 1

echo "== install binary → $BIN =="
install -m 0755 shield/shield "$BIN" || exit 1
echo "installed: $(ls -l "$BIN" | awk '{print $1, $NF}')"

echo "== generate shared socket token (root config + Brain .env) =="
CONFIG_DIR=/var/root/.cluely-shield
CONFIG=$CONFIG_DIR/config.json
mkdir -p "$CONFIG_DIR"
# Load an existing token if present (idempotent re-install); else generate one.
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
# Write the token into the Brain's .env so its socket commands are accepted.
ENV_FILE="${OPENCLUELY_ENV:-$(cd "$(dirname "$0")/.." && pwd)/.env}"
if [ -f "$ENV_FILE" ]; then
  if grep -q '^CLUELY_SHIELD_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    sed -i '' "s|^CLUELY_SHIELD_TOKEN=.*|CLUELY_SHIELD_TOKEN=$TOKEN|" "$ENV_FILE"
  else
    printf '\nCLUELY_SHIELD_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
  fi
  echo "Brain .env token written: $ENV_FILE"
else
  echo "WARN: no .env at $ENV_FILE — set CLUELY_SHIELD_TOKEN=$TOKEN in the Brain env manually"
fi

echo "== install plist → $PLIST =="
install -m 0644 shield/com.cluely.shield.plist "$PLIST" || exit 1

echo "== (re)load the daemon =="
launchctl bootout system/"$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST" || exit 1
launchctl enable system/"$LABEL" 2>/dev/null || true

echo "== verify =="
sleep 1
launchctl print system/"$LABEL" >/dev/null 2>&1 \
  && echo "OK: $LABEL loaded" \
  || { echo "WARN: $LABEL not visible to launchctl print (may need a real GUI login)"; }
echo
echo "Helper logs: /tmp/cluely-shield.stdout.log, /tmp/cluely-shield.stderr.log"
echo "Config:      /var/root/.cluely-shield/config.json (root-only, 0600)"
echo "Socket:      /tmp/cluely-shield.sock"
echo
echo "To configure exam mode from the Brain (Electron): use the ⌃⌥⇧E shortcut"
echo "or the shield-exam-mode IPC. To stop the daemon:"
echo "  sudo launchctl bootout system/$LABEL"
echo "To uninstall:"
echo "  sudo launchctl bootout system/$LABEL; sudo rm -f $PLIST $BIN"