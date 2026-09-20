#!/usr/bin/env bash
# =============================================================================
#  cluely — one-command root exam mode for OpenCluely
#
#  The ONLY command you need. Run it, then open LockDown Browser.
#  It checks everything, launches Cluely itself as root (kill-immune),
#  waits until the app has really booted, and tells you what to do next.
#
#  Usage:
#    cluely              # doctor + start (idempotent — safe to re-run)
#    cluely start        # same as above
#    cluely stop         # kill root Cluely + restore file ownership
#    cluely status       # is it running? boot-log tail
#    cluely doctor       # prerequisite checks only
#    cluely help
#
#  Install (one time, from this repo):
#    sudo ln -s "$PWD/scripts/cluely.sh" /usr/local/bin/cluely
#
#  Why root: LockDown Browser sweeps and SIGKILLs uid-501 GUI apps during the
#  exam; a root process survives that kill(2) with EPERM. The whole Cluely UI
#  — chat, question-type switching, mic, typing, settings, capture — runs as
#  the root instance, so nothing needs a wrapper.
#
#  Kill design (learned from a real orphan leak on 2026-09-20):
#    * Chromium rewrites the browser main process title to "Terminal" when
#      launched from a terminal, so argv patterns CANNOT find it.
#    * Cluely is therefore launched in its OWN PROCESS GROUP (python3
#      os.setsid before exec), and the PGID is written to a pidfile.
#      `kill -TERM/-9 -PGID` reaches the whole tree — main, wrapper, helpers —
#      regardless of argv or reparenting.
#    * Two anchored argv patterns remain as straggler sweeps only; they are
#      shaped so they cannot match the launcher shell, a `tail -f` on the
#      boot log, or any unrelated process.
#
#  Rules that stay true:
#    * cluely BEFORE LockDown Browser (launch order matters).
#    * Do NOT also run the shield helper (cluely-shield) — both would race
#      for the ⌘⇧Space chord. Root Cluely replaces it entirely.
# =============================================================================

# Not `set -e`: every failure path is handled explicitly so the user always
# gets a clear message instead of a half-dead script.
set -uo pipefail

# ---------------------------------------------------------------------------
# Resolution & identity
# ---------------------------------------------------------------------------

resolve_path() {
  # macOS readlink has no -f; python3 (always present) does realpath.
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null && return 0
  fi
  local p="$1"
  while [ -L "$p" ]; do
    local d
    d="$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
    p="$(readlink "$p")"
    case "$p" in /*) ;; *) p="$d/$p" ;; esac
  done
  (cd -P "$(dirname "$p")" && printf '%s/%s\n' "$PWD" "$(basename "$p")")
}

SCRIPT_PATH="$(resolve_path "$0")" || { echo "cluely: cannot resolve script path" >&2; exit 1; }
REPO="$(cd -P "$(dirname "$SCRIPT_PATH")/.." && pwd -P)"

OPERATOR="$USER"
OPERATOR_HOME="$HOME"
if [ "$(id -u)" -eq 0 ]; then
  if [ -n "${SUDO_USER:-}" ]; then
    OPERATOR="$SUDO_USER"
    OPERATOR_HOME="$(eval echo ~"$SUDO_USER")"
  else
    echo "cluely: run this as your normal user — it elevates Cluely to root itself." >&2
    exit 1
  fi
fi

ROOT_DATA="/var/root/.cluely-root/userdata"
BOOT_LOG="/tmp/cluely-root-boot.log"
PIDFILE="/tmp/cluely-root.pid"        # contains the process-group ID of the app
RUN_LOCK="/tmp/cluely-run.lock"       # atomic start lock (mkdir)
APP_LOG="$OPERATOR_HOME/.screen-reader-util/logs/application-$(date +%F).log"

# Anchored straggler sweeps. The [t] character class keeps each pattern from
# matching its own command line. The shapes below deliberately exclude the
# launcher's `bash -c` argv (it carries `--user-data-dir="$2"` unexpanded) and
# any unrelated process.
SWEEP_HELPERS='--type=.*cluely-roo[t]/userdata'
SWEEP_WRAPPER='\.bin/electron \. --no-sandbox --user-data-dir=/.*cluely-roo[t]/userdata'

C='\033[36m' G='\033[32m' Y='\033[33m' R='\033[31m' B='\033[1m' N='\033[0m'
ok()   { printf "${G}✔${N} %s\n" "$1"; }
warn() { printf "${Y}⚠${N} %s\n" "$1"; }
fail() { printf "${R}✘${N} %s\n" "$1" >&2; }
info() { printf "  %b\n" "$1"; }

# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

sudo_ready() {
  if tty -s 2>/dev/null; then
    # Real terminal: let sudo prompt on the tty and cache credentials for it.
    # One prompt covers every later `sudo -n` in this run (same tty).
    if ! sudo -v; then
      fail "sudo failed — Cluely needs root and macOS needs your password (type it when prompted)."
      exit 1
    fi
  else
    # No controlling terminal (ssh/automation): password must arrive on stdin.
    if ! sudo -S -v; then
      fail "sudo failed — with no terminal, pipe the password in: printf '<password>' | cluely"
      exit 1
    fi
  fi
}

pgid_from_file() {
  [ -r "$PIDFILE" ] || return 1
  local pgid
  pgid="$(cat "$PIDFILE" 2>/dev/null)"
  case "$pgid" in ''|*[!0-9]*) return 1;; esac
  printf '%s\n' "$pgid"
}

app_alive() {
  # Group liveness via ps, NOT `kill -0 -PGID`: a non-root shell gets EPERM
  # when signal-0'ing a root-owned process group, which would read as "dead".
  local pgid
  pgid="$(pgid_from_file)" || return 1
  ps -axo pgid= 2>/dev/null | tr -d ' ' | grep -qx "$pgid"
}

group_members() {
  # ps -axo pgid= lists every process with its group; filter by our PGID.
  local pgid
  pgid="$(pgid_from_file)" || return 1
  ps -axo pid=,pgid=,user=,command= 2>/dev/null | awk -v g="$pgid" '$2 == g'
}

group_looks_like_cluely() {
  # The wrapper and helpers carry the user-data-dir in argv; while the app
  # runs at least one of them is alive, so this validates the group before we
  # ever kill it (protects against PGID reuse by an unrelated process group).
  group_members | grep -q 'cluely-root'
}

stragglers_alive() {
  # `--` matters: the patterns start with dashes, and without it pgrep
  # would parse them as options and fail silently.
  pgrep -f -- "$SWEEP_HELPERS" >/dev/null 2>&1 || pgrep -f -- "$SWEEP_WRAPPER" >/dev/null 2>&1
}

marker_found() {
  grep -q "Application initialized successfully" "$BOOT_LOG" 2>/dev/null && return 0
  # APP_LOG is append-only from our perspective: only accept markers written
  # after launch (captured byte offset), never an earlier boot from today.
  [ -r "$APP_LOG" ] && tail -c +"$((${APP_LOG_OFF:-0} + 1))" "$APP_LOG" 2>/dev/null \
    | grep -q "Application initialized successfully"
}

hotkey_confirmed() {
  grep -q "Capture hotkey registered" "$BOOT_LOG" 2>/dev/null && return 0
  [ -r "$APP_LOG" ] && tail -c +"$((${APP_LOG_OFF:-0} + 1))" "$APP_LOG" 2>/dev/null \
    | grep -q "Capture hotkey registered"
}

# ---------------------------------------------------------------------------
# doctor — everything the root launch depends on, checked before we elevate
# ---------------------------------------------------------------------------

doctor() {
  local problems=0

  if [ ! -x "$REPO/node_modules/.bin/electron" ]; then
    fail "electron not found in $REPO/node_modules — run 'npm install' (or 'pnpm i') in $REPO first."
    problems=$((problems + 1))
  else
    ok "electron binary present"
  fi

  if [ -f "$REPO/.env" ] && grep -q '^DEEPSEEK_API_KEY=.' "$REPO/.env"; then
    ok ".env has DEEPSEEK_API_KEY"
  else
    fail ".env is missing DEEPSEEK_API_KEY — answers will fail. Fix $REPO/.env"
    problems=$((problems + 1))
  fi

  if [ -f "$REPO/.whisper-models/small.pt" ]; then
    ok "local whisper model present (voice → text)"
  else
    warn "whisper model not found — mic capture may need a one-time download on first use."
  fi

  if pgrep -f "cluely-shield" >/dev/null 2>&1; then
    warn "cluely-shield helper is running — root Cluely replaces it and both would race for ⌘⇧Space."
    info "  Stop it with: sudo pkill -9 -f 'cluely-shiel[d]'"
  fi

  # Soft check: has Terminal ever been granted Microphone? Root Cluely cannot
  # show the TCC prompt, so without this one-time grant root-mode voice hangs.
  # The grant lives in the PER-USER TCC db (readable without sudo), not the
  # system one — verified live on 2026-09-20.
  if command -v sqlite3 >/dev/null 2>&1; then
    local micauth
    micauth="$(sqlite3 "$OPERATOR_HOME/Library/Application Support/com.apple.TCC/TCC.db" \
      "SELECT auth_value FROM access WHERE service='kTCCServiceMicrophone' AND client='com.apple.Terminal';" 2>/dev/null)"
    if [ "$micauth" = "2" ]; then
      ok "Terminal has Microphone permission (root-mode mic will work)"
    elif [ -z "$micauth" ]; then
      warn "Terminal has NO Microphone row yet — one-time fix:"
      info "  System Settings → Privacy & Security → Microphone → enable Terminal"
      info "  (voice answers will hang in root mode until this is granted once)"
    else
      warn "Terminal Microphone permission is not granted (auth_value=$micauth) — enable it:"
      info "  System Settings → Privacy & Security → Microphone → enable Terminal"
    fi
  fi

  return "$problems"
}

# ---------------------------------------------------------------------------
# start — elevate, launch in its own process group, verify boot, print plan
# ---------------------------------------------------------------------------

start() {
  # Atomic run lock: two parallel `cluely` runs must not double-launch.
  if ! mkdir "$RUN_LOCK" 2>/dev/null; then
    fail "another cluely run is in progress (lock dir $RUN_LOCK)."
    fail "Wait for it to finish; if it is stuck: rm -rf $RUN_LOCK"
    return 1
  fi
  trap 'rmdir "$RUN_LOCK" 2>/dev/null || true' EXIT

  doctor || return 1

  local pgid
  pgid="$(pgid_from_file 2>/dev/null || true)"

  # Already running: pidfile group alive and validated, OR stragglers found
  # (covers a live app whose pidfile was lost — stop can still clean it).
  if [ -n "$pgid" ] && app_alive && group_looks_like_cluely; then
    ok "Cluely is already running as root (process group $pgid) — nothing to start."
    echo
    print_plan
    return 0
  fi
  if stragglers_alive; then
    ok "Cluely is already running as root (found live processes; pidfile missing)."
    info "If you need to stop it: cluely stop"
    echo
    print_plan
    return 0
  fi
  if [ -n "$pgid" ]; then
    warn "stale pidfile ($pgid) — clearing it before launch."
  fi

  # Capture the current size of today's app log so boot markers from an
  # earlier run today can never satisfy this launch's verification.
  APP_LOG_OFF=0
  [ -r "$APP_LOG" ] && APP_LOG_OFF="$(wc -c < "$APP_LOG" | tr -d ' ')"
  if [ -z "$APP_LOG_OFF" ] || [ "$APP_LOG_OFF" -lt 0 ] 2>/dev/null; then APP_LOG_OFF=0; fi

  echo
  info "Elevating… (type your Mac password if prompted — one prompt covers the whole run)"
  sudo_ready

  sudo -n rm -f "$BOOT_LOG" "$PIDFILE"

  info "Clearing stale singleton locks…"
  sudo -n bash -c '
    mkdir -p "$2"
    rm -f "$2"/Singleton{Lock,Cookie,Socket}
  ' _ "" "$ROOT_DATA"

  info "Launching Cluely as root (own process group)…"
  # python3 calls setsid() before exec: the wrapper, the browser main, and
  # every helper share one process group whose ID lands in the pidfile.
  # argv patterns can never lose track of this group.
  sudo -n bash -c '
    export HOME="$1" CLUELY_ROOT_EXAM=1
    cd "$3" || exit 1
    python3 -c "import os,sys; os.environ.pop(\"ELECTRON_RUN_AS_NODE\",None); os.setsid(); os.execv(\"$3/node_modules/.bin/electron\", [\"$3/node_modules/.bin/electron\", \".\", \"--no-sandbox\", \"--user-data-dir=$2\"])" > "$4" 2>&1 &
    echo $! > "$5"
  ' _ "$OPERATOR_HOME" "$ROOT_DATA" "$REPO" "$BOOT_LOG" "$PIDFILE" || {
    fail "launch command failed — see $BOOT_LOG"
    return 1
  }

  info "Waiting for Cluely to finish booting…"
  pgid="$(pgid_from_file 2>/dev/null || true)"
  local deadline=$((SECONDS + 45))
  while ! marker_found; do
    if [ -z "$pgid" ] || ! app_alive; then
      fail "Cluely exited during startup. Last log lines:"
      tail -n 15 "$BOOT_LOG" 2>/dev/null | sed 's/^/    /' >&2
      return 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "Timed out after 45s — Cluely is alive but the boot marker never appeared. Last log lines:"
      tail -n 15 "$BOOT_LOG" 2>/dev/null | sed 's/^/    /' >&2
      return 1
    fi
    sleep 2
  done

  # Verify the group exists, is non-empty, and every member runs as root.
  local members nonroot
  members="$(group_members)"
  if [ -z "$members" ]; then
    fail "boot marker found but the process group vanished — run 'cluely stop' and retry."
    return 1
  fi
  nonroot="$(printf '%s\n' "$members" | awk '$3 != "root" {print $1, $3}')"
  if [ -n "$nonroot" ]; then
    fail "some Cluely processes are not root: $nonroot — run 'cluely stop' and retry."
    return 1
  fi
  ok "Cluely booted: process group $pgid, $(printf '%s\n' "$members" | wc -l | tr -d ' ') processes, all root"
  if hotkey_confirmed; then
    ok "Capture hotkey ⌘⇧Space armed"
  else
    warn "Hotkey registration not confirmed in the log yet — it re-asserts every 10s; check with 'cluely status' if capture seems dead."
  fi

  echo
  print_plan
  return 0
}

print_plan() {
  printf "${B}You're up. Now:${N}\n"
  info "1. Open LockDown Browser (Cluely is already first — correct order)."
  info "2. On a question, press ⌘⇧Space (or the 📷 button in the chat header)."
  info "3. The answer lands in the Cluely chat. Switch question type from the skill dropdown."
  info "When the exam is over: run ${C}cluely stop${N}"
}

# ---------------------------------------------------------------------------
# stop — kill the process group, sweep stragglers, restore ownership
# ---------------------------------------------------------------------------

stop() {
  local pgid running=1
  pgid="$(pgid_from_file 2>/dev/null || true)"

  if [ -n "$pgid" ] && app_alive && group_looks_like_cluely; then
    running=0
  fi
  if stragglers_alive; then
    running=0
  fi

  if [ "$running" -eq 0 ]; then
    info "Stopping root Cluely…"
    sudo_ready

    # 1. Graceful TERM to the whole group (browser handles it and exits).
    if [ -n "$pgid" ] && app_alive && group_looks_like_cluely; then
      sudo -n kill -TERM "-$pgid" 2>/dev/null || true
    fi

    # 2. Escalate to SIGKILL after a 5s grace period; sweep anchored patterns.
    local i=0
    while app_alive || stragglers_alive; do
      [ "$i" -ge 10 ] && break
      if [ "$i" -ge 5 ]; then
        if [ -n "$pgid" ] && app_alive && group_looks_like_cluely; then
          sudo -n kill -9 "-$pgid" 2>/dev/null || true
        fi
        sudo -n pkill -9 -f -- "$SWEEP_HELPERS" 2>/dev/null || true
        sudo -n pkill -9 -f -- "$SWEEP_WRAPPER" 2>/dev/null || true
      fi
      sleep 1
      i=$((i + 1))
    done

    # 3. Orphaned helpers reparent to the browser main (or launchd). If any
    #    helper survived, kill its root parent — that is the browser main
    #    whose argv says only "Terminal" and no pattern can see it.
    for h in $(pgrep -f -- "$SWEEP_HELPERS" 2>/dev/null); do
      local pp
      pp="$(ps -o ppid= -p "$h" 2>/dev/null | tr -d ' ')"
      if [ -n "$pp" ] && [ "$pp" -gt 1 ] 2>/dev/null \
        && [ "$(ps -o user= -p "$pp" 2>/dev/null | tr -d ' ')" = "root" ]; then
        sudo -n kill -9 "$pp" 2>/dev/null || true
      fi
    done
    sleep 1
    sudo -n pkill -9 -f -- "$SWEEP_HELPERS" 2>/dev/null || true
    sudo -n pkill -9 -f -- "$SWEEP_WRAPPER" 2>/dev/null || true

    if app_alive || stragglers_alive; then
      warn "some Cluely processes survived — inspect with: ps -axo pid,user,command | grep cluely-root"
    else
      ok "root Cluely stopped"
    fi
  else
    ok "root Cluely not running — nothing to kill"
  fi

  # 4. Filesystem cleanup (needs root; skip gracefully when sudo is missing).
  if sudo -n true 2>/dev/null; then
    info "Clearing root-side locks and logs…"
    sudo -n bash -c 'rm -f "$1"/Singleton{Lock,Cookie,Socket}' _ "$ROOT_DATA"
    sudo -n rm -f "$PIDFILE" "$BOOT_LOG"

    info "Restoring ownership of files the root session touched…"
    sudo -n bash -c '
      chown -R "$1" "$2/.screen-reader-util" 2>/dev/null || true
      chown -R "$1" "$2/.cache/whisper" 2>/dev/null || true
      chown "$1" "$3/.env" 2>/dev/null || true
    ' _ "$OPERATOR" "$OPERATOR_HOME" "$REPO"
    ok "cleanup done — a normal (non-exam) launch works again"
  else
    warn "filesystem cleanup skipped (no cached sudo) — rerun 'cluely stop' to restore ownership."
  fi
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

status() {
  local pgid members
  pgid="$(pgid_from_file 2>/dev/null || true)"

  if [ -n "$pgid" ] && app_alive; then
    members="$(group_members)"
    if [ -n "$members" ]; then
      printf '%s\n' "$members" | awk '{print $1, $3, $4}' | sed 's/^/  /'
      ok "root exam mode active (process group $pgid)"
    fi
  fi

  if ! stragglers_alive && { [ -z "$pgid" ] || ! app_alive; }; then
    printf "${Y}Cluely is not running${N} (root exam mode off).\n"
    return 1
  fi

  if hotkey_confirmed 2>/dev/null; then ok "hotkey ⌘⇧Space confirmed armed"; else warn "hotkey not confirmed in log"; fi
  echo
  info "Boot log tail:"
  tail -n 6 "$BOOT_LOG" 2>/dev/null | sed 's/^/    /'
}

usage() {
  cat <<'EOF'
cluely — one-command root exam mode for OpenCluely

  cluely            doctor + start (idempotent — safe to re-run any time)
  cluely start      start root exam mode
  cluely stop       kill root Cluely + restore file ownership
  cluely status     show whether it is running + boot-log tail
  cluely doctor     prerequisite checks only
  cluely help       this message

Exam sequence: run `cluely`, THEN open LockDown Browser, press ⌘⇧Space on a question.
EOF
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

CMD="${1:-start}"
case "$CMD" in
  start)
    if ! app_alive 2>/dev/null && ! stragglers_alive 2>/dev/null; then
      printf "${B}${C}cluely${N} — root exam mode launcher\n"
      echo
    fi
    start
    ;;
  stop)    stop ;;
  status)  status ;;
  doctor)  doctor ;;
  help|-h|--help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
