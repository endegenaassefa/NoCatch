#!/usr/bin/env bash
# =============================================================================
# live-capture.sh — Cluely ↔ LockDown Browser interaction scanner (macOS)
#
# Captures OS-level evidence of how the two apps behave with each other while
# they run concurrently: process census with generation-tracked identity,
# open fds + unix sockets, TCP/UDP peers, per-process byte flows (nettop),
# unified-log events (incl. TCC permission checks and a targeted XPC /
# AppleEvents stream), window focus, SecureEventInput state, filesystem
# activity (fs_usage, sudo), every signal sent between processes (dtrace,
# sudo), resource pressure, app-data growth, shell-history changes, and
# start/end snapshots (plists, codesign entitlements, launch jobs, kexts).
#
# METADATA ONLY. Network capture is IP/port/byte-count level; payloads are
# never captured. The scan only writes into ./capture/<timestamp>/ and reads
# system diagnostics; it never modifies application or system state.
#
# Usage:
#   bash live-capture.sh                 # foreground, stop with Ctrl+C
#   bash live-capture.sh --detach        # background, stop: kill $(cat capture/<ts>/capture.pid)
#   bash live-capture.sh --duration 600  # stop automatically after N seconds
#   bash live-capture.sh --no-sudo       # skip sudo (loses dtrace + fs_usage)
#   bash live-capture.sh --selftest 25   # 25s smoke test (short cadences)
#
# Start it in Terminal BEFORE launching LockDown Browser. It auto-discovers
# both apps whenever they appear, so launch order is free.
# Pre-flight: grant Terminal → System Events automation permission once
# beforehand (the focus sampler uses osascript; a TCC prompt mid-exam would
# itself become an event). sudo -v caches credentials before detaching.
# =============================================================================
set -u
export LC_ALL=C
# Ignore SIGHUP process-tree-wide: closing the Terminal window mid-exam must
# not kill the capture (shutdown happens only via SIGINT/SIGTERM/duration).
trap '' HUP

# ------------------------------------------------------------------ config --
RUN_DIR="$(cd "$(dirname "$0")" && pwd)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$RUN_DIR/capture/$TS"
DURATION=0
TRY_SUDO=1
SELFTEST=0
SELFTEST_SECS=0
DETACH=0

# parse args over a COPY so $@ stays intact for the --detach re-exec below
ARGS=("$@")
for ((_i = 0; _i < ${#ARGS[@]}; _i++)); do
  case "${ARGS[_i]}" in
    --duration) DURATION="${ARGS[_i+1]:-0}"; _i=$((_i + 1)) ;;
    --no-sudo)  TRY_SUDO=0 ;;
    --selftest) SELFTEST=1; SELFTEST_SECS="${ARGS[_i+1]:-0}"; _i=$((_i + 1)) ;;
    --detach)   DETACH=1 ;;
    *) echo "unknown arg: ${ARGS[_i]}" >&2; exit 2 ;;
  esac
done

# numeric guards: a non-numeric --duration/--selftest must not silently
# produce a run that never self-stops
[[ "$DURATION" =~ ^[0-9]+$ ]] || { [[ $SELFTEST -eq 1 ]] && DURATION="$SELFTEST_SECS" || DURATION=0; }
[[ "$SELFTEST_SECS" =~ ^[0-9]+$ ]] || SELFTEST_SECS=30

# re-exec detached: new session, stdio to files, immune to parent Terminal
if [[ $DETACH -eq 1 && -z "${ALREADY_DETACHED:-}" ]]; then
  mkdir -p "$RUN_DIR/capture/.detach-staging" 2>/dev/null
  DET_OUT="$RUN_DIR/capture/.detach-staging/$TS"
  mkdir -p "$DET_OUT"
  _new="$(for _a in "$@"; do [[ "$_a" == "--detach" ]] && continue; printf '%q ' "$_a"; done)"
  eval "set -- $_new"
  nohup bash "$0" "$@" </dev/null >"$DET_OUT/runner.log" 2>&1 &
  sleep 1
  echo "detached run staged — capture dir and stop instructions are printed inside:"
  echo "  logs: $DET_OUT/runner.log"
  echo "  stop: pkill -TERM -f 'live-capture.sh'   (clean shutdown; keeps all data)"
  exit 0
fi
export ALREADY_DETACHED=1

CENSUS_SEC=1
FDS_SEC=5
NET_SEC=5
FOCUS_SEC=2
SECURE_SEC=5
LDB_SEC=5
MEM_SEC=10
CPU_SEC=10
POWER_SEC=30
SHELL_SEC=15
DIAG_SEC=30
LSAPP_SEC=10
TOP_SEC=10
NETTOP_SEC=5
if [[ $SELFTEST -eq 1 ]]; then
  CENSUS_SEC=1; FDS_SEC=2; NET_SEC=2; FOCUS_SEC=1; SECURE_SEC=2
  LDB_SEC=2; MEM_SEC=2; CPU_SEC=2; POWER_SEC=5; SHELL_SEC=3
  DIAG_SEC=5; LSAPP_SEC=3; TOP_SEC=3; NETTOP_SEC=2
  DURATION="$SELFTEST_SECS"
fi

HOME_DIR="$HOME"
WINSTON_DIR="$HOME_DIR/.screen-reader-util/logs"
LDB_DIR="$HOME_DIR/Library/Application Support/Respondus LockDown Browser"
DIAG_DIR="$HOME_DIR/Library/Logs/DiagnosticReports"
ZSH_HIST="$HOME_DIR/.zsh_history"
ZSH_SESS="$HOME_DIR/.zsh_sessions"
SEEN_FILE="$OUT/.seen-state"   # pid<TAB>app<TAB>lstart  (bash 3.2 portable: no assoc arrays)

mkdir -p "$OUT/streams" "$OUT/census" "$OUT/logs" "$OUT/start" "$OUT/end"
touch "$SEEN_FILE"
echo "$$" > "$OUT/capture.pid"
echo "run=$TS started=$(date -u +%Y-%m-%dT%H:%M:%SZ) duration=${DURATION:-until-ctrl-c} detached=$DETACH" > "$OUT/run-info.txt"

JLOG() { # jlog <file> <key=value...>
  local f="$1"; shift
  local parts="\"t\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  local k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    if [[ "$v" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then parts="$parts,\"$k\":$v"
    else parts="$parts,\"$k\":\"$v\""; fi
  done
  printf '{%s}\n' "$parts" >> "$f"
}

HB() { JLOG "$OUT/streams/heartbeats.jsonl" "stream=$1" "tick=$2"; }

# --------------------------------------------------------- capability probe --
cap_probe() {
  local c="$OUT/streams/capabilities.json"
  local tool found
  for tool in ps pgrep lsof nettop vm_stat iostat top pmset ioreg osascript \
              lsappinfo kextstat stat shasum tail awk sed grep sort uniq date \
              log python3 codesign sudo dtrace fs_usage; do
    found="$(command -v "$tool" 2>/dev/null || echo MISSING)"
    JLOG "$c" "tool=$tool" "path=$found"
  done
  JLOG "$c" "tool=lsappinfo-front" "path=$(lsappinfo front >/dev/null 2>&1 && echo WORKING || echo DENIED)"
  JLOG "$c" "tool=secureinput-probe" "path=${SECURE_PROBE:-NOT_BUILT}"
  JLOG "$c" "tool=sudo-elevated" "path=$SUDO_OK"
  JLOG "$c" "tool=dtrace-probe" "path=$(dtrace -ln 'proc:::signal-send' >/dev/null 2>&1 && echo WORKING || echo BLOCKED)"
}

# ------------------------------------------------- identity resolution -----
# A pid is classified by its EXECUTABLE PATH (cannot be disguised):
#   ldb      -> /Applications/LockDown Browser.app/...
#   cluely   -> Electron dev tree / packaged screen-reader-util / keystroke-capture
#   terminal -> the REAL Terminal.app (kept only for signal attribution)
exe_of() { lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }

app_of_exe() {
  local exe="$1"
  [[ -z "$exe" ]] && { echo other; return; }
  case "$exe" in
    "/Applications/LockDown Browser.app"*) echo ldb ;;
    */node_modules/electron/*|*/screen-reader-util.app/*|*/keystroke-capture*) echo cluely ;;
    /System/Applications/Utilities/Terminal.app/*) echo terminal ;;
    *) echo other ;;
  esac
}

app_of() {
  local exe
  exe="$(seen_exe_of "$1" 2>/dev/null)"
  [[ -z "$exe" ]] && exe="$(exe_of "$1")"
  app_of_exe "$exe"
}

CANDIDATE_RE='LockDown Browser|Electron|screen-reader-util|keystroke-capture|node_modules/.bin/electron|Terminal.app/Contents/MacOS/Terminal'

# argv can be disguised (setproctitle), comm can be disguised ("Terminal "),
# but the EXECUTABLE PATH cannot. Collect argv matches AND any pid whose comm
# looks like either app, then classify everything by executable path.
collect_pids() {
  { pgrep -f "$CANDIDATE_RE" 2>/dev/null
    ps -axo pid=,comm= 2>/dev/null | grep -iE 'Terminal|Electron|screen-reader|keystroke|LockDown' | awk '{print $1}'
  } | grep -v -x "$$" | sort -un
}

seen_all_pids() { awk -F'\t' '{print $1}' "$SEEN_FILE" 2>/dev/null; }
seen_app_of()   { awk -F'\t' -v p="$1" '$1==p{last=$2} END{print last}' "$SEEN_FILE" 2>/dev/null; }
seen_st_of()    { awk -F'\t' -v p="$1" '$1==p{last=$3} END{print last}' "$SEEN_FILE" 2>/dev/null; }
seen_exe_of()   { awk -F'\t' -v p="$1" '$1==p{last=$4} END{print last}' "$SEEN_FILE" 2>/dev/null; }
seen_add()      { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$SEEN_FILE"; }
seen_del()      { awk -F'\t' -v p="$1" '$1!=p' "$SEEN_FILE" > "$SEEN_FILE.tmp" 2>/dev/null && mv "$SEEN_FILE.tmp" "$SEEN_FILE"; }

# ------------------------------------------------------------ census tick ---
census_tick() {
  local pid p name ppid app exe cpu rss state st prev_app prev_st
  local ids
  ids="$(collect_pids; seen_all_pids)"
  ids="$(printf '%s\n' $ids | grep -v '^$' | sort -un)"
  # walk parent chains (depth 6): the disguised Electron MAIN process has no
  # matching argv/comm pattern of its own — it is found via its helpers/parents
  for p in $ids; do
    local cur="$p" d=0
    while [[ $d -lt 6 ]]; do
      cur="$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ')"
      [[ "$cur" =~ ^[0-9]+$ ]] || break
      [[ "$cur" == "0" || "$cur" == "1" ]] && break
      ids="$ids"$'\n'"$cur"
      d=$((d + 1))
    done
  done
  ids="$(printf '%s\n' $ids | grep -v '^$' | sort -un)"
  for pid in $ids; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    exe=""          # MUST reset: otherwise the previous pid's exe bleeds over
    # comm LAST so multi-word names ("Electron Helper (Renderer)") don't
    # word-split into the numeric fields
    read -r ppid cpu rss state name < <(ps -o ppid=,%cpu=,rss=,state=,comm= -p "$pid" 2>/dev/null | head -1)
    [[ -z "$name" ]] && continue
    st="$(ps -o lstart= -p "$pid" 2>/dev/null | tail -1)"
    prev_st="$(seen_st_of "$pid")"
    # cache the executable path; re-resolve only when the generation changes
    if [[ -n "$st" && "$st" == "$prev_st" ]]; then
      exe="$(seen_exe_of "$pid")"
    fi
    [[ -z "$exe" ]] && exe="$(exe_of "$pid")"
    app="$(app_of_exe "$exe")"
    JLOG "$OUT/census/census.jsonl" "pid=$pid" "ppid=${ppid:-0}" "app=$app" \
         "name=$name" "exe=$exe" "cpu=${cpu:-0}" "rss=${rss:-0}" "state=${state:--}" "st=$st"
    prev_app="$(seen_app_of "$pid")"
    if [[ -n "$prev_app" ]]; then
      if [[ -n "$st" && -n "$prev_st" && "$prev_st" != "$st" ]]; then
        JLOG "$OUT/census/lifecycle.jsonl" "event=generation-change" "pid=$pid" "app=$app" "st=$st"
        seen_add "$pid" "$app" "${st:-}" "$exe"
      elif [[ "$prev_app" != "$app" ]]; then
        JLOG "$OUT/census/lifecycle.jsonl" "event=reclassify" "pid=$pid" \
             "from=$prev_app" "to=$app"
        seen_add "$pid" "$app" "${st:-}" "$exe"
      fi
    else
      JLOG "$OUT/census/lifecycle.jsonl" "event=birth" "pid=$pid" "app=$app" "name=$name" "st=$st"
      seen_add "$pid" "$app" "${st:-}" "$exe"
    fi
  done
  for p in $(seen_all_pids); do
    if ! ps -p "$p" >/dev/null 2>&1; then
      JLOG "$OUT/census/lifecycle.jsonl" "event=death" "pid=$p" "app=$(seen_app_of "$p")"
      seen_del "$p"
    fi
  done
}

app_pids() { awk -F'\t' -v a="$1" '$2==a{print $1}' "$SEEN_FILE" 2>/dev/null; }

# ------------------------------------------------------------ fd / socket --
fd_tick() {
  local pid app paths
  local pids
  pids="$(app_pids ldb; app_pids cluely)"
  if [[ -z "$pids" ]]; then
    JLOG "$OUT/streams/fds.jsonl" "pid=0" "app=none" "paths="
    return
  fi
  for pid in $pids; do
    app="$(app_of "$pid")"
    paths="$(lsof -a -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -v '^(' | sort -u | head -600 | tr '\n' ';')"
    [[ -n "$paths" ]] && JLOG "$OUT/streams/fds.jsonl" "pid=$pid" "app=$app" "paths=$paths"
    lsof -U -a -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | grep -v '^(' | sort -u | tr '\n' ';' | \
      while read -r unixpaths; do
        [[ -n "$unixpaths" ]] && JLOG "$OUT/streams/unixsocks.jsonl" "pid=$pid" "app=$app" "paths=$unixpaths"
      done
  done
}

net_tick() {
  local pid app line proto raw local remote state
  local pids
  pids="$(app_pids ldb; app_pids cluely)"
  if [[ -z "$pids" ]]; then
    JLOG "$OUT/streams/net.jsonl" "pid=0" "app=none" "proto=TCP" "local=" "remote=" "state=none"
    return
  fi
  for pid in $pids; do
    app="$(app_of "$pid")"
    lsof -nP -a -p "$pid" -iTCP -iUDP 2>/dev/null | tail -n +2 | while read -r line; do
      proto="$(awk '{print $8}' <<<"$line")"
      [[ "$proto" == "TCP" || "$proto" == "UDP" ]] || continue
      raw="$(awk '{print $9}' <<<"$line")"
      local="${raw%%->*}"
      if [[ "$raw" == *'->'* ]]; then
        remote="${raw##*->}"
      else
        remote=""
      fi
      if [[ "$proto" == "TCP" ]]; then
        state="$(awk '{print $10}' <<<"$line" | tr -d '()')"
      else
        state="-"
      fi
      JLOG "$OUT/streams/net.jsonl" "pid=$pid" "app=$app" "proto=$proto" \
           "local=$local" "remote=${remote:-}" "state=${state:--}"
    done
  done
}

nettop_loop() {
  local tick=0
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    nettop -P -l 1 2>/dev/null | grep -iE 'LockDown|Electron|screen-reader|keystroke|Terminal|node' | \
      while read -r line; do
        JLOG "$OUT/streams/nettop.jsonl" "line=$line"
      done
    HB nettop $tick
    sleep "$NETTOP_SEC"
  done
}

# ---------------------------------------------------------------- streams ---
logstream_start() {
  local pred
  pred='process == "LockDown Browser" OR process BEGINSWITH "LockDown Browser Helper" OR process == "Electron" OR process BEGINSWITH "Electron Helper" OR process == "Terminal" OR process == "screen-reader-util" OR process == "keystroke-capture" OR subsystem == "com.apple.TCC"'
  log stream --style ndjson --info --predicate "$pred" \
    > "$OUT/streams/unified.ndjson" 2>"$OUT/logs/logstream.err" &
  local p1=$!
  local pred2
  pred2='(subsystem == "com.apple.xpc" AND (eventMessage CONTAINS[c] "LockDown" OR eventMessage CONTAINS[c] "Electron" OR eventMessage CONTAINS[c] "Terminal" OR eventMessage CONTAINS[c] "screenreader" OR eventMessage CONTAINS[c] "keystroke")) OR process == "appleeventsd"'
  log stream --style ndjson --info --predicate "$pred2" \
    > "$OUT/streams/xpc-appleevents.ndjson" 2>"$OUT/logs/xpc-stream.err" &
  local p2=$!
  echo "$p1 $p2"
}

focus_loop() {
  # lsappinfo front + info: returns pid (registry-mappable) and needs NO
  # Automation TCC — osascript was observed generating kTCCServiceListenEvent
  # requests, polluting the very TCC stream this capture observes.
  local tick=0 asn info name pid
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    asn="$(lsappinfo front 2>/dev/null | awk '{print $NF}')"
    if [[ -n "$asn" ]]; then
      info="$(lsappinfo info -only name -only pid "$asn" 2>/dev/null)"
      name="$(printf '%s\n' "$info" | sed -n 's/^"LSDisplayName"="\(.*\)"$/\1/p')"
      pid="$(printf '%s\n' "$info" | sed -n 's/^"pid"=\([0-9]*\)$/\1/p')"
      JLOG "$OUT/streams/focus.jsonl" "pid=${pid:-0}" "name=$name"
    fi
    HB focus $tick
    sleep "$FOCUS_SEC"
  done
}

secure_loop() {
  local tick=0 s
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    s="unknown"
    [[ -x "$SECURE_PROBE" ]] && s="$("$SECURE_PROBE" 2>/dev/null)"
    JLOG "$OUT/streams/secureinput.jsonl" "enabled=${s:-unknown}"
    HB secureinput $tick
    sleep "$SECURE_SEC"
  done
}

ldb_files_loop() {
  local tick=0 f sz mt
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    for f in "$LDB_DIR"/ldb-hc-log-session-*.dat; do
      [[ -e "$f" ]] || continue
      sz="$(stat -f%z "$f" 2>/dev/null)"
      mt="$(stat -f%m "$f" 2>/dev/null)"
      JLOG "$OUT/streams/ldb-files.jsonl" "path=${f##*/}" "size=${sz:-0}" "mtime=${mt:-0}"
    done
    HB ldb-files $tick
    sleep "$LDB_SEC"
  done
}

winston_follow() {
  # polling follower (NOT `tail -F &`: a backgrounded pipeline writer would
  # hold any enclosing command-substitution pipe open and hang the script).
  # Starts at CURRENT EOF (history is skipped — only exam-time lines matter),
  # and batch-timestamps with awk so there are no per-line fork storms.
  local f off sz
  for f in "$WINSTON_DIR"/*.log; do
    [[ -e "$f" ]] || continue
    (
      off="$(stat -f%z "$f" 2>/dev/null)"; off=$((off + 1))
      while [[ ! -f "$OUT/stop" ]]; do
        sz="$(stat -f%z "$f" 2>/dev/null)"; [[ -z "$sz" ]] && sz=0
        if [[ $sz -lt $off ]]; then off=1; fi   # rotated/truncated
        if [[ $sz -ge $off ]]; then
          tail -c "+$off" "$f" 2>/dev/null | awk -v fn="${f##*/}" \
            '{printf "%s|%s|%s\n", strftime("%Y-%m-%dT%H:%M:%SZ", systime()), fn, $0; fflush()}'
          off=$((sz + 1))
        fi
        sleep 2
      done
    ) >> "$OUT/logs/winston-follow.txt" &
    echo $! >> "$OUT/winston.pids"
  done
}

mem_loop() {
  local tick=0 summary
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    summary="$(vm_stat | awk '/Pages (free|active|inactive|speculative|wired down|purgeable)/ {gsub(/\./,"",$NF); printf "%s=%s ", $1 $2, $NF} /Swapins/ {printf "swapins=%s ", $NF} /Swapouts/ {printf "swapouts=%s", $NF}')"
    JLOG "$OUT/streams/memory.jsonl" "summary=$summary"
    HB memory $tick
    sleep "$MEM_SEC"
  done
}

cpu_loop() {
  local tick=0 s
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    s="$(iostat -c 1 -w 1 2>/dev/null | tail -2 | head -1 | awk '{printf "us=%s sy=%s id=%s", $4, $5, $6}')"
    JLOG "$OUT/streams/cpu.jsonl" "summary=${s:-}"
    HB cpu $tick
    sleep "$CPU_SEC"
  done
}

top_loop() {
  local tick=0
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    # command LAST so multi-word names land in one field
    top -l 1 -stats pid,cpu,mem,state,command 2>/dev/null | \
      grep -iE 'LockDown|Electron|screen-reader|keystroke-capture|Terminal' | \
      awk '{cmd=""; for(i=5;i<=NF;i++) cmd=cmd" "$i; printf "%s|%s|%s|%s|%s\n", $1, $2, $3, $4, substr(cmd,2)}' | \
      while IFS='|' read -r pid cpu mem st cmd; do
        JLOG "$OUT/streams/top.jsonl" "pid=$pid" "cmd=$cmd" "cpu=$cpu" "mem=$mem" "state=$st"
      done
    HB top $tick
    sleep "$TOP_SEC"
  done
}

power_loop() {
  local tick=0 a lp
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    a="$(pmset -g assertions 2>/dev/null | grep -E 'PreventUserIdleSystemSleep|PreventSystemSleep|PreventUserIdleDisplaySleep' | head -6 | tr '\n' ';')"
    lp="$(pmset -g 2>/dev/null | grep lowpowermode | awk '{print $NF}')"
    JLOG "$OUT/streams/power.jsonl" "assertions=$a" "lowpowermode=${lp:-unknown}"
    HB power $tick
    sleep "$POWER_SEC"
  done
}

shell_loop() {
  local tick=0 hz sz mt hs
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    hz="$(shasum -a 256 "$ZSH_HIST" 2>/dev/null | awk '{print $1}')"
    sz="$(stat -f%z "$ZSH_HIST" 2>/dev/null)"
    mt="$(stat -f%m "$ZSH_HIST" 2>/dev/null)"
    hs="$(ls -laT "$ZSH_SESS"/*.session 2>/dev/null | awk '{printf "%s %s %s %s;", $NF, $6, $7, $8}' | head -3)"
    JLOG "$OUT/streams/shellstate.jsonl" "zsh_history_sha=${hz:-}" "zsh_history_size=${sz:-0}" \
         "zsh_history_mtime=${mt:-0}" "sessions=$hs"
    HB shellstate $tick
    sleep "$SHELL_SEC"
  done
}

diag_loop() {
  # emit each diagnostic file ONCE (path+size+mtime key); pre-existing .ips
  # files are recorded at start but never re-emitted every tick
  local tick=0 f key
  touch "$OUT/.diag-seen"
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    for f in "$DIAG_DIR"/*.ips "$DIAG_DIR"/*.diag; do
      [[ -e "$f" ]] || continue
      key="${f##*/} $(stat -f%z "$f" 2>/dev/null) $(stat -f%m "$f" 2>/dev/null)"
      if ! grep -qF "$key" "$OUT/.diag-seen" 2>/dev/null; then
        echo "$key" >> "$OUT/.diag-seen"
        JLOG "$OUT/streams/new-files.jsonl" "kind=diagnostic" "path=${f##*/}" \
             "size=$(stat -f%z "$f" 2>/dev/null)" "mtime=$(stat -f%m "$f" 2>/dev/null)"
      fi
    done
    HB diagnostics $tick
    sleep "$DIAG_SEC"
  done
}

lsapp_loop() {
  local tick=0
  while [[ ! -f "$OUT/stop" ]]; do
    tick=$((tick+1))
    lsappinfo list 2>/dev/null | grep -iE 'LockDown|screen-reader|Electron|Terminal|keystroke-capture' | \
      sed 's/"/\\"/g' | while read -r line; do
        JLOG "$OUT/streams/lsappinfo.jsonl" "entry=$line"
      done
    HB lsappinfo $tick
    sleep "$LSAPP_SEC"
  done
}

# ------------------------------------------------------------- snapshots ----
snapshot() { # snapshot <start|end>
  local dir="$OUT/$1"
  mkdir -p "$dir/plists"
  shasum -a 256 /etc/hosts 2>/dev/null | awk '{print $1}' > "$dir/hosts.sha256"
  shasum -a 256 "$ZSH_HIST" 2>/dev/null | awk '{print $1}' > "$dir/zsh-history.sha256"
  sysctl -n kern.boottime 2>/dev/null > "$dir/boottime.txt"
  stat -f 'mtime=%m size=%z' "$HOME_DIR/Library/Application Support/com.apple.TCC/TCC.db" 2>/dev/null > "$dir/tcc-db.stat"
  for p in "$HOME_DIR/Library/Preferences/com.screenreaderutil.app.plist" \
           "$HOME_DIR/Library/Preferences/com.Respondus.LockDownBrowser.plist" \
           "$HOME_DIR/Library/Preferences/com.Respondus.LockDownBrowser.helper.renderer.plist"; do
    [[ -e "$p" ]] && cp "$p" "$dir/plists/$(basename "$p")" && shasum -a 256 "$p" | awk '{print $1}' > "$dir/plists/$(basename "$p").sha256"
  done
  ls -laT "$DIAG_DIR" 2>/dev/null > "$dir/diagreports.listing"
  ls -laT "$LDB_DIR" 2>/dev/null > "$dir/ldb-dir.listing"
  ls -la "$HOME_DIR/Library/LaunchAgents" /Library/LaunchAgents /Library/LaunchDaemons 2>/dev/null > "$dir/launch-jobs.listing"
  ps axo pid,ppid,user,%cpu,rss,state,lstart,args 2>/dev/null | grep -iE 'LockDown|Electron|screen-reader|keystroke|node|npm|Terminal' > "$dir/procs.listing"
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null > "$dir/listen-tcp.listing"
  kextstat 2>/dev/null | tail -n +2 | awk '{print $6}' | sort > "$dir/kexts.listing"
  # code-signing identity + entitlements of both apps (shows what each is ALLOWED to do cross-process)
  codesign -dv --verbose=2 "/Applications/LockDown Browser.app" > "$dir/codesign-ldb.txt" 2>&1
  codesign -d --entitlements :- "/Applications/LockDown Browser.app/Contents/MacOS/LockDown Browser" 2>/dev/null > "$dir/entitlements-ldb.xml"
  local cb
  cb="$(ls "$RUN_DIR"/../dist/mac-arm64/screen-reader-util.app 2>/dev/null)"
  [[ -n "$cb" ]] && { codesign -dv --verbose=2 "$cb" > "$dir/codesign-cluely.txt" 2>&1; \
                      codesign -d --entitlements :- "$cb/Contents/MacOS/screen-reader-util" 2>/dev/null > "$dir/entitlements-cluely.xml"; }
  local kc
  kc="$(ls "$RUN_DIR"/../resources/bin/keystroke-capture 2>/dev/null)"
  [[ -n "$kc" ]] && { codesign -dv --verbose=2 "$kc" > "$dir/codesign-keystroke.txt" 2>&1; \
                      codesign -d --entitlements :- "$kc" 2>/dev/null > "$dir/entitlements-keystroke.xml"; }
}

# ------------------------------------------------------------ sudo branch --
# dtrace and fs_usage are launched INSIDE one root wrapper that watches the
# stop-file and the main pid. The user cannot kill root-owned children
# (EPERM), so the wrapper must self-terminate: on stop-file, or when the main
# script dies by any means (SIGKILL included).
start_sudo_streams() {
  sudo bash -c '
    OUT="$1"; RUN_DIR="$2"; MAINPID="$3"
    dtrace -q -s "$RUN_DIR/dtrace/signals.d" -o "$OUT/streams/dtrace-signals.log" 2>"$OUT/logs/dtrace.err" &
    echo $! > "$OUT/sudo-pids.txt"
    fs_usage -w -f filesys > "$OUT/streams/fs-usage.txt" 2>"$OUT/logs/fs-usage.err" &
    echo $! >> "$OUT/sudo-pids.txt"
    while [[ ! -f "$OUT/stop" ]] && kill -0 "$MAINPID" 2>/dev/null; do sleep 2; done
    while read -r p; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done < "$OUT/sudo-pids.txt"
  ' _ "$OUT" "$RUN_DIR" "$$" &
  local wrapper=$!
  echo "$wrapper" > "$OUT/sudo-wrapper.pid"
  JLOG "$OUT/streams/capture-state.jsonl" "event=sudo-streams-started" "wrapper_pid=$wrapper"
}

# ------------------------------------------------------------------ main ----
SUDO_OK=0
if [[ $TRY_SUDO -eq 1 ]]; then
  if sudo -n true 2>/dev/null; then
    SUDO_OK=1; echo "sudo: passwordless elevation available" >> "$OUT/logs/sudo.log"
  elif [[ -t 0 ]]; then
    if sudo -v 2>>"$OUT/logs/sudo.log"; then SUDO_OK=1; echo "sudo: elevated" >> "$OUT/logs/sudo.log";
    else echo "sudo: unavailable — dtrace/fs_usage will be skipped" >> "$OUT/logs/sudo.log"; fi
  else
    echo "sudo: no tty — dtrace/fs_usage will be skipped" >> "$OUT/logs/sudo.log"
  fi
else
  echo "sudo: disabled by --no-sudo" > "$OUT/logs/sudo.log"
fi

snapshot start
# build the SecureEventInput probe once at start (needs no TCC, no root)
mkdir -p "$OUT/bin"
SECURE_PROBE="$OUT/bin/secureinput-probe"
if swiftc -O "$RUN_DIR/probe/secureinput.swift" -o "$SECURE_PROBE" 2>>"$OUT/logs/secureinput-compile.log"; then
  JLOG "$OUT/streams/capabilities.json" "tool=secureinput-probe" "path=BUILT"
else
  SECURE_PROBE="/nonexistent"   # probe unusable -> secure_loop records "unknown"
  JLOG "$OUT/streams/capabilities.json" "tool=secureinput-probe" "path=COMPILE_FAILED"
fi
cap_probe
LOGPIDS="$(logstream_start)"
echo "$LOGPIDS" > "$OUT/logstream.pid"
focus_loop &      FOCUS_PID=$!
secure_loop &     SECURE_PID=$!
ldb_files_loop &  LDB_PID=$!
winston_follow
mem_loop &        MEM_PID=$!
cpu_loop &        CPU_PID=$!
top_loop &        TOP_PID=$!
nettop_loop &     NETTOP_PID=$!
power_loop &      POWER_PID=$!
shell_loop &      SHELL_PID=$!
diag_loop &       DIAG_PID=$!
lsapp_loop &      LSAPP_PID=$!
[[ $SUDO_OK -eq 1 ]] && start_sudo_streams

{ echo "focus:$FOCUS_PID"; echo "secure:$SECURE_PID"; echo "ldb:$LDB_PID";
  awk '{print "winston:"$1}' "$OUT/winston.pids" 2>/dev/null;
  echo "mem:$MEM_PID"; echo "cpu:$CPU_PID"; echo "top:$TOP_PID";
  echo "nettop:$NETTOP_PID"; echo "power:$POWER_PID"; echo "shell:$SHELL_PID";
  echo "diag:$DIAG_PID"; echo "lsapp:$LSAPP_PID";
  for p in $LOGPIDS; do echo "logstream:$p"; done; } > "$OUT/bg-map.txt"

ALL_PIDS="$FOCUS_PID $SECURE_PID $LDB_PID $(cat "$OUT/winston.pids" 2>/dev/null) $MEM_PID $CPU_PID $TOP_PID $NETTOP_PID $POWER_PID $SHELL_PID $DIAG_PID $LSAPP_PID $LOGPIDS"

CLEANED=0
cleanup() {
  [[ $CLEANED -eq 1 ]] && return
  CLEANED=1
  touch "$OUT/stop" 2>/dev/null
  local p
  for p in $ALL_PIDS; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  sleep 2
  for p in $ALL_PIDS; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null; done
  # root-owned dtrace/fs_usage are killed by the sudo wrapper itself once it
  # sees the stop-file (user-side kill would be EPERM) — nothing to do here.
  # tree-wide sweep: subshells inherit this script's argv and must not survive.
  # Descendants ONLY (never argv-matched strangers/ancestors).
  _sweep() {
    local _c
    for _c in $(pgrep -P "$1" 2>/dev/null); do
      if ps -o command= -p "$_c" 2>/dev/null | grep -q "$RUN_DIR/live-capture.sh"; then
        kill -9 "$_c" 2>/dev/null
      fi
      _sweep "$_c"
    done
  }
  _sweep "$$"
  snapshot end
  JLOG "$OUT/streams/capture-state.jsonl" "event=capture-end" "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "capture finished -> $OUT"
}
trap cleanup INT TERM EXIT

echo "capturing to $OUT — stop with Ctrl+C (duration=${DURATION:-unlimited})"
START_EPOCH="$(date +%s)"
LAST_FD=0
LAST_NET=0

while :; do
  census_tick
  # elapsed-since-last-fire (NOT wall-clock modulo: a ~1s census tick aliases
  # onto the same parity and starves the %-based checks)
  now="$(date +%s)"
  if (( now - LAST_FD >= FDS_SEC )); then LAST_FD="$now"; fd_tick; fi
  if (( now - LAST_NET >= NET_SEC )); then LAST_NET="$now"; net_tick; fi
  [[ -f "$OUT/stop" ]] && break
  if [[ $DURATION -gt 0 ]] && (( now - START_EPOCH >= DURATION )); then break; fi
  sleep "$CENSUS_SEC"
done

cleanup
trap - INT TERM EXIT
