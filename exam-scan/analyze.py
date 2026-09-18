#!/usr/bin/env python3
# =============================================================================
# analyze.py — merges a live-capture.sh run into one timeline + report.
#
# Usage: python3 analyze.py <capture-dir> [--out report.md]
# The capture dir is exam-scan/capture/<timestamp>/.
#
# Design rules enforced here (reviewer-mandated):
#  - Identity is a GENERATION registry: (pid, start-time, exec path). Bare
#    pids are never trusted; pid reuse produces a new generation, not a
#    misattribution. Events are attributed by generation timeline.
#  - Every stream proves it was alive: heartbeats + gap records. A dimension
#    with no data and no contiguous heartbeat coverage renders as a COVERAGE
#    GAP, never as a negative finding.
#  - Interaction edges require an explicit channel (signal sender/recipient,
#    socket peer, shared path, TCC accessor/subject, fs_usage cross-touch).
#    Timestamp proximity alone is reported separately as coincidence
#    candidates, not as interaction.
# =============================================================================
import json, os, sys, glob, re, hashlib, bisect, time as _time
from collections import defaultdict, Counter

CAP = sys.argv[1] if len(sys.argv) > 1 else None
if not CAP or not os.path.isdir(CAP):
    print("usage: analyze.py <capture-dir> [--out report.md]"); sys.exit(2)
CAP = CAP.rstrip("/")
OUT_MD = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else os.path.join(CAP, "report.md")

def jload(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    return rows

ISO_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?.*$")

def ts(v):
    """Parse either epoch floats or ISO-8601 strings into epoch seconds (UTC)."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v)
    m = ISO_RE.match(s)
    if m:
        try:
            import calendar
            base = calendar.timegm(_time.strptime(m.group(1) + " " + m.group(2), "%Y-%m-%d %H:%M:%S"))
            frac = int(m.group(3)) / (10 ** len(m.group(3))) if m.group(3) else 0.0
            return base + frac
        except Exception:
            return None   # invalid calendar date (e.g. month 13) — skip, never crash
    try:
        return float(s)
    except Exception:
        return None

def parse_log_ts(s):
    """Parse `log stream --style ndjson` timestamps. The real format is
    '2026-09-18 13:46:06.975817-0400' (SPACE separator, local offset) — not
    ISO 'T'. Interpreted as machine-local wall time (matches dtrace/others).
    Also accepts ISO-T for robustness."""
    s = str(s)
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return _time.mktime(_time.strptime(s[:19], fmt))
        except Exception:
            continue
    return None

def iso_of(v):
    return _time.strftime("%Y-%m-%dT%H:%M:%S", _time.localtime(v))

# ---------------------------------------------------------------- identity --
# Generation registry: for each pid, consecutive census records with the same
# lstart string form one generation; a recorded DEATH closes the generation
# permanently, so a same-second restart (pid reuse) can never merge into the
# previous generation's attributions.
gens = defaultdict(list)   # pid -> [[start, end, st, app], ...]
lifecycle = jload(os.path.join(CAP, "census", "lifecycle.jsonl"))
death_t = {}
for r in lifecycle:
    if r.get("event") == "death":
        t = ts(r.get("t"))
        if t is not None:
            death_t[r.get("pid")] = t

for row in sorted(jload(os.path.join(CAP, "census", "census.jsonl")), key=lambda r: ts(r.get("t")) or 0):
    t = ts(row.get("t"))
    if t is None:
        continue
    pid = row.get("pid")
    app = row.get("app")
    if pid is None or app in (None, "other"):
        continue
    st = row.get("st", "") or ""
    seq = gens[pid]
    if seq and seq[-1][2] == st and death_t.get(pid, 1e18) > t:
        seq[-1][1] = t          # extend generation end to latest sighting
        seq[-1][3] = app        # keep latest classification
        continue
    seq.append([t, t, st, app])
# apply death boundaries
for pid, dt in death_t.items():
    seq = gens.get(pid)
    if seq:
        seq[-1][1] = max(seq[-1][1], dt)

def app_at(pid, t):
    seq = gens.get(pid)
    if not seq:
        return None
    i = bisect.bisect_right(seq, [t, 1e18, "", ""]) - 1
    if i < 0:
        return None
    start, end, st, app = seq[i]
    if t <= end + 10:           # 10s attribution slack after last sighting/death
        return app
    return None

DAEMON_FALLBACK = {"runningboardd", "WindowServer", "launchd", "replayd",
                   "ControlCenter", "coreaudiod", "taskgated", "syspolicyd"}

def msg_classify(msg, sub, t, process_name=None):
    """Registry-first classification of a daemon log line's MESSAGE.
    1. explicit accessor/responsible pids in TCC attribution lines -> registry
    2. keyword fallback (LockDown/Electron-family only, never bare 'Terminal')
       restricted to TCC lines or known system-daemon process names.
    Returns (app, path) where path is 'registry' or 'keyword' (or (None, None))."""
    for m in re.finditer(r"(?:accessor|responsible)=([^,]+?)\s+pid\s+(\d+)", msg):
        name, apid = m.group(1), int(m.group(2))
        a = app_at(apid, t)
        if a:
            return a, "registry"
        if "LockDown" in name or "Respondus" in name:
            return "ldb", "registry"
        if any(k in name for k in ("Electron", "screenreader", "keystroke")):
            return "cluely", "registry"
    if sub == "com.apple.TCC" or process_name in DAEMON_FALLBACK:
        if "LockDown" in msg or "Respondus" in msg:
            return "ldb", "keyword"
        if any(k in msg for k in ("screenreader", "keystroke-capture")):
            return "cluely", "keyword"
        if "Electron" in msg:
            return "cluely", "keyword"
    return None, None

# ------------------------------------------------------------ time helpers --
def parse_dt_log(s):
    m = re.match(r"^(\d{4}) (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2})$", s)
    if not m:
        return None
    from datetime import datetime
    try:
        return _time.mktime(datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)} {m.group(4)}",
                                              "%Y %b %d %H:%M:%S").timetuple())
    except Exception:
        return None

# ------------------------------------------------------------------ events --
EVENT_CAP = 300000
events = []   # dicts: t, app, src, text, pid?, channel?, pair?
events_dropped = 0
def add(t, app, src, text, **kw):
    global events_dropped
    if t is None or app is None:
        return
    if len(events) >= EVENT_CAP:
        events_dropped += 1
        return
    events.append(dict(t=t, app=app, src=src, text=text, **kw))

# unified log (ndjson) — timestamps are 'YYYY-MM-DD HH:MM:SS.ffffff±HHMM'
for row in jload(os.path.join(CAP, "streams", "unified.ndjson")):
    tstr, pid = row.get("timestamp"), row.get("processID")
    if tstr is None:
        continue
    msg = row.get("eventMessage", "")
    sub = row.get("subsystem", "")
    pname = row.get("processName", "")
    t = parse_log_ts(tstr)
    if t is None:
        continue
    app = app_at(pid, t)
    cpath = "registry" if app else None
    if app is None:
        app, cpath = msg_classify(msg, sub, t, pname)
    if app is None:
        continue
    kw = dict(pid=pid, subsystem=sub, process=pname, class_path=cpath)
    channel = None
    if sub == "com.apple.TCC":
        channel = "tcc"
    add(t, app, "unified", msg, channel=channel, **kw)

# xpc / appleevents stream
for row in jload(os.path.join(CAP, "streams", "xpc-appleevents.ndjson")):
    tstr, pid = row.get("timestamp"), row.get("processID")
    if tstr is None:
        continue
    msg = row.get("eventMessage", "")
    sub = row.get("subsystem", "")
    pname = row.get("processName", "")
    t = parse_log_ts(tstr)
    if t is None:
        continue
    app = app_at(pid, t)
    cpath = "registry" if app else None
    if app is None:
        app, cpath = msg_classify(msg, sub, t, pname)
    if app is None:
        continue
    add(t, app, "xpc/ae", msg, channel="xpc", pid=pid, process=pname, class_path=cpath)

# dtrace signals — the only source of signal sender/recipient truth
DT = os.path.join(CAP, "streams", "dtrace-signals.log")
for line in open(DT, errors="replace") if os.path.exists(DT) else []:
    line = line.strip()
    if not line or "|" not in line:
        continue
    parts = line.split("|")
    if len(parts) < 7:
        continue
    t = parse_dt_log(parts[0])
    if t is None:
        m = re.match(r"^(\d{2}:\d{2}:\d{2}\.\d{6})", line)
        if not m:
            continue
        base = _time.mktime(_time.strptime(_time.strftime("%Y-%m-%d") + " " + m.group(1), "%Y-%m-%d %H:%M:%S.%f"))
        t = base
    ev, sname, spid, rname, rpid, sig = parts[1:7]
    try:
        spid, rpid = int(spid), int(rpid)
    except Exception:
        continue
    def name_app(pid, name, t):
        a = app_at(pid, t)
        if a:
            return a
        if "LockDown" in name:
            return "ldb"
        if any(k in name for k in ("Electron", "screen-reader", "keystroke")):
            return "cluely"
        if "Terminal" in name:
            return "terminal"
        return None
    sapp, rapp = name_app(spid, sname, t), name_app(rpid, rname, t)
    if sapp or rapp:
        add(t, sapp or rapp, "dtrace",
            f"{ev}: {sname}({spid}) -> {rname}({rpid}) sig {sig}",
            channel="signal", sender=sname, sender_pid=spid, sender_app=sapp,
            recipient=rname, recipient_pid=rpid, recipient_app=rapp,
            signal=sig, event_type=ev)

# fs_usage (sudo). Line: HH:MM:SS.ffffff  PROC  PID  op ...
FS = os.path.join(CAP, "streams", "fs-usage.txt")
fs_path_touch = defaultdict(set)   # path -> set(apps)
fs_times = defaultdict(list)       # app -> [t]
fs_added = set()                   # (app, minute, path) -> emit-at-most-once
FS_EVENT_CAP = 20000
day0 = None
last_t = None
for line in open(FS, errors="replace") if os.path.exists(FS) else []:
    m = re.match(r"^(\d{2}:\d{2}:\d{2})\.(\d{6})\s+(\S+)\s+(\d+)\s+(.*)$", line.rstrip())
    if not m:
        continue
    hms, frac, proc, pid, rest = m.groups()
    if day0 is None:
        day0 = _time.mktime(_time.strptime(_time.strftime("%Y-%m-%d"), "%Y-%m-%d"))
    t = day0 + int(hms[:2]) * 3600 + int(hms[3:5]) * 60 + int(hms[6:8]) + int(frac) / 1e6
    if last_t is not None and t < last_t - 60:
        t += 86400              # midnight wrap: capture crossed into a new day
    last_t = t
    pid = int(pid)
    app = app_at(pid, t)
    if app not in ("ldb", "cluely"):
        continue
    paths = re.findall(r"(/(?:Users|tmp|private|var|Applications|Library|System)/[^\s,]+)", rest)
    for p in paths[:2]:
        fs_path_touch[p].add(app)
    key = (app, int(t // 60), paths[0] if paths else "")
    if key not in fs_added and len(fs_added) < FS_EVENT_CAP:
        fs_added.add(key)
        add(t, app, "fs_usage", f"{proc}: {rest[:180]}", channel="filesystem", pid=pid,
            path=paths[0] if paths else None)
    fs_times[app].append(t)

# fds / shared open paths / unix sockets
path_owners = defaultdict(set)
unix_owners = defaultdict(set)
for row in jload(os.path.join(CAP, "streams", "fds.jsonl")):
    app, t, pid = row.get("app"), ts(row.get("t")), row.get("pid")
    if app not in ("ldb", "cluely"):
        continue
    for p in (row.get("paths") or "").split(";"):
        if p.startswith("/"):
            path_owners[p].add(app)
for row in jload(os.path.join(CAP, "streams", "unixsocks.jsonl")):
    app, t, pid = row.get("app"), ts(row.get("t")), row.get("pid")
    if app not in ("ldb", "cluely"):
        continue
    for p in (row.get("paths") or "").split(";"):
        if p.startswith("/"):
            unix_owners[p].add(app)
    add(t, app, "unix-socket", row.get("paths", "")[:200], channel="ipc", pid=pid)

# net contacts
net_contacts = defaultdict(set)
net_by_app_t = defaultdict(list)
for row in jload(os.path.join(CAP, "streams", "net.jsonl")):
    app, t = row.get("app"), ts(row.get("t"))
    if app not in ("ldb", "cluely"):
        continue
    rem = row.get("remote") or ""
    if rem and rem != "*":
        net_contacts[app].add(f"{row.get('proto')} {rem} ({row.get('state', '-')})")
    add(t, app, "net", f"{row.get('proto')} {row.get('local')} -> {row.get('remote')} {row.get('state','')}",
        channel="network", pid=row.get("pid"))
    net_by_app_t[app].append(t)

# nettop byte flows
for row in jload(os.path.join(CAP, "streams", "nettop.jsonl")):
    line = row.get("line", "")
    t = ts(row.get("t"))
    if t is None:
        continue
    m = re.search(r"([\w .\-]+)\.(\d+)\s+([\d.]+ [KMG]?i?B|0 B)\s+([\d.]+ [KMG]?i?B|0 B)", line)
    app = "ldb" if "LockDown" in line else "cluely" if any(k in line for k in ("Electron", "screen-reader", "keystroke")) else None
    if app is None:
        continue
    add(t, app, "nettop", line, channel="network-bytes")

# focus / secure input
focus_seq = []
for row in jload(os.path.join(CAP, "streams", "focus.jsonl")):
    t = ts(row.get("t"))
    if t is None:
        continue
    name = row.get("name", "")
    pid = row.get("pid")
    # pid-first: map through the generation registry (a real Terminal maps to
    # 'terminal', never to 'cluely')
    a = app_at(pid, t) if isinstance(pid, int) and pid > 0 else None
    if a not in ("ldb", "cluely", "terminal"):
        # name-only fallback: "Terminal" is ambiguous (real vs disguise) —
        # never label it cluely
        if "LockDown" in name:
            a = "ldb"
        elif any(k in name for k in ("screen-reader", "Electron")):
            a = "cluely"
        else:
            a = "other"
    focus_seq.append((t, a, name))
    if a in ("ldb", "cluely"):
        add(t, a, "focus", f"frontmost={name}", channel="focus")
secure_states = []
for row in jload(os.path.join(CAP, "streams", "secureinput.jsonl")):
    t = ts(row.get("t"))
    if t is None:
        continue
    enabled = row.get("enabled", "unknown")
    secure_states.append((t, enabled))
    add(t, "system", "secureinput", f"SecureEventInput={enabled}", channel="secure-input")

# ------------------------------------------------------- coverage / gaps --
caps = {r.get("tool"): r.get("path", "MISSING") for r in jload(os.path.join(CAP, "streams", "capabilities.json"))}
hb = jload(os.path.join(CAP, "streams", "heartbeats.jsonl"))
hb_by_stream = defaultdict(list)
for r in hb:
    t = ts(r.get("t"))
    if t is None:
        continue
    hb_by_stream[r.get("stream")].append(t)

STREAM_SRC = {
    "unified": "streams/unified.ndjson",
    "xpc-appleevents": "streams/xpc-appleevents.ndjson",
    "focus": "streams/focus.jsonl",
    "secureinput": "streams/secureinput.jsonl",
    "ldb-files": "streams/ldb-files.jsonl",
    "memory": "streams/memory.jsonl",
    "cpu": "streams/cpu.jsonl",
    "top": "streams/top.jsonl",
    "nettop": "streams/nettop.jsonl",
    "power": "streams/power.jsonl",
    "shellstate": "streams/shellstate.jsonl",
    "diagnostics": "streams/new-files.jsonl",
    "lsappinfo": "streams/lsappinfo.jsonl",
    "census": "census/census.jsonl",
    "fds": "streams/fds.jsonl",
    "net": "streams/net.jsonl",
    "dtrace": "streams/dtrace-signals.log",
    "fs_usage": "streams/fs-usage.txt",
}

def gap_spans(times, cadence):
    """Return [(start,end)] where inter-sample time > 3*cadence."""
    if len(times) < 2:
        return []
    spans = []
    prev = times[0]
    for t in times[1:]:
        if t - prev > 3 * cadence:
            spans.append((prev, t))
        prev = t
    return spans

CADENCE = {"census": 1, "fds": 5, "net": 5, "focus": 2, "secureinput": 5, "ldb-files": 5,
           "memory": 10, "cpu": 10, "top": 10, "nettop": 5, "power": 30, "shellstate": 15,
           "diagnostics": 30, "lsappinfo": 10, "unified": 1, "xpc-appleevents": 1}

# run window: a dimension is only COVERED if it stayed alive until the end
run_start = None
ri = os.path.join(CAP, "run-info.txt")
if os.path.exists(ri):
    with open(ri, errors="replace") as f:
        m = re.search(r"started=(\S+)", f.read())
        if m:
            run_start = ts(m.group(1))
run_end = None
for r in jload(os.path.join(CAP, "streams", "capture-state.jsonl")):
    if r.get("event") == "capture-end":
        run_end = ts(r.get("t"))
        break
if run_end is None:
    allhb = [t for v in hb_by_stream.values() for t in v]
    run_end = max(allhb) if allhb else None

def hb_coverage(times, cadence):
    """COVERED iff: >=1 sample, no inter-sample gap, first sample near run
    start, last sample near run end. Anything else is DEGRADED (a stream that
    died mid-exam is never certified as evidence of nothing)."""
    if not times:
        return "MISSING", 0, []
    times = sorted(times)
    spans = gap_spans(times, cadence)
    problems = list(spans)
    if run_start and times[0] > run_start + 3 * cadence:
        problems.append(("late-start", run_start, times[0]))
    if run_end and times[-1] < run_end - 3 * cadence:
        problems.append(("died-early", times[-1], run_end))
    if problems:
        return "DEGRADED", len(times), problems
    return "COVERED", len(times), []

def stream_cov(path, optional):
    """File-backed streams: aliveness = non-empty AND mtime within staleness
    tolerance of run end."""
    fpath = os.path.join(CAP, path)
    if not os.path.exists(fpath) or os.path.getsize(fpath) == 0:
        return ("MISSING" if optional else "DEGRADED")
    mtime = os.path.getmtime(fpath)
    if run_end and mtime < run_end - 120:
        return "DEGRADED"   # stream died mid-run
    return "COVERED"

coverage = {}
for stream, path in STREAM_SRC.items():
    fpath = os.path.join(CAP, path)
    if stream in ("unified", "xpc-appleevents"):
        coverage[stream] = {"status": stream_cov(path, optional=False), "records": None, "gaps": []}
    elif stream in ("dtrace", "fs_usage"):
        coverage[stream] = {"status": stream_cov(path, optional=True), "records": None, "gaps": []}
    elif stream in ("census", "fds", "net"):
        # data-driven: coverage from the records' own timestamps
        rows = jload(fpath)
        times = sorted(t for t in (ts(r.get("t")) for r in rows) if t is not None)
        st, n, probs = hb_coverage(times, CADENCE.get(stream, 5))
        coverage[stream] = {"status": st, "records": n, "gaps": probs}
    else:
        times = hb_by_stream.get(stream, [])
        st, n, probs = hb_coverage(times, CADENCE.get(stream, 10))
        coverage[stream] = {"status": st, "records": n, "gaps": probs}

# ------------------------------------------------------------------ report --
R = []
R.append("# Cluely ↔ LockDown Browser interaction report")
R.append("")
R.append(f"Capture dir: `{os.path.basename(CAP)}`")
info = None
p = os.path.join(CAP, "run-info.txt")
if os.path.exists(p):
    with open(p) as f:
        info = f.read().strip()
R.append(f"```\n{info or 'n/a'}\n```")

# --- 0. coverage
R.append("\n## 0. Coverage manifest (absence is a gap, never a negative finding)\n")
R.append("| dimension | status | samples | problems |")
R.append("|---|---|---|---|")
for stream in sorted(STREAM_SRC):
    c = coverage[stream]
    prob_txt = []
    for g in c["gaps"][:4]:
        if isinstance(g, tuple) and len(g) == 3 and isinstance(g[0], str):
            kind, a, b = g
            prob_txt.append(f"{kind} {iso_of(a)}→{iso_of(b)}" if isinstance(a, (int, float)) and isinstance(b, (int, float)) else f"{kind}")
        else:
            prob_txt.append(f"{iso_of(g[0])}–{iso_of(g[1])}")
    gaps = "; ".join(prob_txt) or "—"
    rec = str(c["records"]) if c["records"] is not None else "stream"
    R.append(f"| {stream} | {c['status']} | {rec} | {gaps} |")
sudo_state = caps.get("sudo-elevated", "MISSING")
dtrace_probe = caps.get("dtrace-probe", "MISSING")
R.append(f"\nsudo elevated: `{sudo_state}` — dtrace probe: `{dtrace_probe}`")
if coverage["dtrace"]["status"] == "MISSING":
    err = os.path.join(CAP, "logs", "dtrace.err")
    if os.path.exists(err) and os.path.getsize(err) > 0:
        with open(err, errors="replace") as f:
            R.append(f"dtrace stderr: `{f.read().strip()[:200]}`")
if coverage["fs_usage"]["status"] == "MISSING":
    err = os.path.join(CAP, "logs", "fs-usage.err")
    if os.path.exists(err) and os.path.getsize(err) > 0:
        with open(err, errors="replace") as f:
            R.append(f"fs_usage stderr: `{f.read().strip()[:200]}`")
if events_dropped:
    R.append(f"events capped: {events_dropped} records beyond {EVENT_CAP} were dropped from the merged timeline (raw streams intact).")
R.append("")

# --- 1. lifecycle
lc = Counter(r.get("event") for r in lifecycle)
R.append("\n## 1. Process lifecycle & generations\n")
R.append(f"- births: {lc.get('birth',0)} — deaths: {lc.get('death',0)} — generation changes: {lc.get('generation-change',0)} — reclassifications: {lc.get('reclassify',0)}")
if any(r.get("event") == "death" for r in lifecycle):
    R.append("- observed deaths:")
    for d in [r for r in lifecycle if r.get("event") == "death"][:15]:
        R.append(f"  - pid {d.get('pid')} ({d.get('app')})")
R.append("")

# --- 2. signals (verified channel)
sig_events = [e for e in events if e["src"] == "dtrace"]
R.append("## 2. Signals (verified channel: sender→recipient pids)\n")
if sig_events:
    R.append("| time | sender | → | recipient | sig |")
    R.append("|---|---|---|---|---|")
    for e in sig_events:
        R.append(f"| {iso_of(e['t'])} | {e.get('sender','')} ({e.get('sender_app','')}) | → | {e.get('recipient','')} ({e.get('recipient_app','')}) | {e.get('signal','')} |")
else:
    if coverage["dtrace"]["status"] == "MISSING":
        R.append("- **No dtrace stream.** The run had no sudo elevation, or dtrace was blocked by SIP. Cross-tree signals (the 09-18 unanswered question) were NOT captured this run. Re-run with sudo.")
    else:
        R.append("- dtrace ran and recorded zero signals involving either tree during the capture.")
R.append("")

# --- 3. verified channels: shared resources
shared_files = {p: s for p, s in path_owners.items() if len(s) > 1}
shared_unix = {p: s for p, s in unix_owners.items() if len(s) > 1}
cross_touch = {p: s for p, s in fs_path_touch.items() if len(s) > 1}
R.append("## 3. Verified channels: shared resources\n")
R.append("### 3.1 Files held open by both trees (lsof samples)")
R.append("\n".join(f"- `{p}` ← {', '.join(sorted(s))}" for p, s in sorted(shared_files.items())) or "- none observed (sampled; short-lived opens can be missed)")
R.append("\n### 3.2 Unix sockets / IPC endpoints held by both trees")
R.append("\n".join(f"- `{p}` ← {', '.join(sorted(s))}" for p, s in sorted(unix_owners.items())) or "- none observed")
R.append("\n### 3.3 Filesystem paths touched by both trees (fs_usage)")
R.append("\n".join(f"- `{p}` ← {', '.join(sorted(s))}" for p, s in sorted(cross_touch.items())) or ("- none observed" if coverage["fs_usage"]["status"] != "MISSING" else "- fs_usage not captured (needs sudo)"))
R.append("")

# --- 4. TCC pairs
tcc_events = [e for e in events if e.get("channel") == "tcc"]
R.append("## 4. TCC permission activity (verified channel: accessor/subject attribution)\n")
kw_tcc = sum(1 for e in tcc_events if e.get("class_path") == "keyword")
if kw_tcc:
    R.append(f"- {kw_tcc} of {len(tcc_events)} TCC events were keyword-classified (registry miss) — lower confidence than pid-attributed ones.")
if tcc_events:
    seen = set()
    for e in tcc_events[:60]:
        key = (iso_of(e["t"]), e["app"], e["text"][:80])
        if key in seen:
            continue
        seen.add(key)
        R.append(f"- `{iso_of(e['t'])}` [{e['app']}] {e['text'][:200]}")
else:
    R.append("- no TCC events attributed to either tree during the capture (stream status: %s)" % coverage["unified"]["status"])
R.append("")

# --- 5. xpc / appleevents
xpc_events = [e for e in events if e.get("channel") == "xpc"]
R.append("## 5. XPC / AppleEvents traffic\n")
if xpc_events:
    for e in xpc_events[:40]:
        R.append(f"- `{iso_of(e['t'])}` [{e['app']}] {e['text'][:180]}")
else:
    R.append("- none captured (stream status: %s)" % coverage["xpc-appleevents"]["status"])
R.append("")

# --- 6. focus + secure input timeline
R.append("## 6. Focus & SecureEventInput timeline\n")
if focus_seq:
    R.append("frontmost-app transitions:")
    prev = None
    for t, a, name in focus_seq:
        if name != prev:
            R.append(f"- `{iso_of(t)}` frontmost → {name} ({a})")
            prev = name
else:
    R.append("- no focus samples (lsappinfo unavailable — see capabilities; stream status: %s)" % coverage["focus"]["status"])
if secure_states:
    flips = [f"`{iso_of(t)}` enabled={h}" for t, h in secure_states if h != (secure_states[0][1] if secure_states else None)]
    R.append("\nSecureEventInput (IsSecureEventInputEnabled probe):")
    R.append("\n".join(flips[:20]) or "- constant across capture")
R.append("")

# --- 6b. resource peaks (top samples)
top_rows = jload(os.path.join(CAP, "streams", "top.jsonl"))
if top_rows:
    peaks = defaultdict(lambda: {"max_cpu": 0.0, "max_mem": 0.0, "samples": 0})
    for r in top_rows:
        cmd = r.get("cmd", "")
        app = "ldb" if "LockDown" in cmd else "cluely" if any(k in cmd for k in ("Electron", "screen-reader", "keystroke")) else None
        if app is None:
            continue
        try:
            cpu = float(r.get("cpu") or 0)
            mem = float(r.get("mem") or 0)
        except Exception:
            continue
        peaks[app]["max_cpu"] = max(peaks[app]["max_cpu"], cpu)
        peaks[app]["max_mem"] = max(peaks[app]["max_mem"], mem)
        peaks[app]["samples"] += 1
    if peaks:
        R.append("## 6b. Per-app CPU/memory peaks (top samples)\n")
        for app in ("cluely", "ldb"):
            if app in peaks:
                p = peaks[app]
                R.append(f"- {app}: peak CPU {p['max_cpu']:.1f}%, peak RSS {p['max_mem']:.0f} MB, {p['samples']} samples")
        R.append("")

# --- 7. coincidence candidates
WINDOW = 2.0
windows = []
if events:
    cur, wstart, apps, cnt = [], None, set(), Counter()
    for e in sorted(events, key=lambda e: e["t"]):
        if wstart is None:
            wstart = e["t"]
        if e["t"] - wstart > WINDOW:
            if "ldb" in apps and "cluely" in apps:
                windows.append((wstart, dict(cnt), sum(cnt.values()), list(cur[:60])))
            cur, wstart, apps, cnt = [], e["t"], set(), Counter()
        if e["app"] in ("ldb", "cluely"):
            cur.append(e); apps.add(e["app"]); cnt[e["app"]] += 1
    if "ldb" in apps and "cluely" in apps:
        windows.append((wstart, dict(cnt), sum(cnt.values()), list(cur[:60])))

R.append("## 7. Temporal coincidence candidates (NOT proof of interaction)\n")
R.append("Same 2-second window, both trees active — flagged for manual inspection only.")
if windows:
    for t, cnt, total, evs in windows[:30]:
        R.append(f"\n### {iso_of(t)} (cluely {cnt.get('cluely',0)} / ldb {cnt.get('ldb',0)})")
        for e in evs[:10]:
            R.append(f"- {e['src']:11s} [{e['app']:6s}] {e['text'][:140]}")
else:
    R.append("- none — the two trees produced no temporally-overlapping events in the capture window")
R.append("")

# --- 8. network
R.append("## 8. Network contacts (metadata only)\n")
for app, label in (("cluely", "Cluely"), ("ldb", "LockDown Browser")):
    R.append(f"### {label}")
    if net_contacts[app]:
        for c in sorted(net_contacts[app]):
            R.append(f"- {c}")
    else:
        R.append("- none observed")
    R.append("")

# --- 9. start/end diffs
R.append("## 9. Start/end system diffs\n")
def snap_read(side, name):
    pth = os.path.join(CAP, side, name)
    if not os.path.exists(pth):
        return None
    with open(pth, errors="replace") as f:
        return f.read()

def pair(name, kind):
    a, b = snap_read("start", name), snap_read("end", name)
    if a is None or b is None:
        return []
    diffs = []
    if kind == "sha":
        if a.strip() != b.strip():
            diffs.append(f"- {name}: `{a.strip()}` → `{b.strip()}`")
    else:
        sa = {l.strip() for l in a.splitlines() if l.strip() and not l.strip().startswith("total ")}
        sb = {l.strip() for l in b.splitlines() if l.strip() and not l.strip().startswith("total ")}
        hdr = {l.strip() for l in b.splitlines()[:1]}
        for x in sorted(sb - sa):
            if x not in hdr:
                diffs.append(f"- NEW: `{x[:160]}`")
        for x in sorted(sa - sb):
            diffs.append(f"- GONE: `{x[:160]}`")
    return diffs

found = False
for name, kind in [("hosts.sha256", "sha"), ("zsh-history.sha256", "sha"), ("tcc-db.stat", "listing"),
                   ("diagreports.listing", "listing"), ("ldb-dir.listing", "listing"),
                   ("launch-jobs.listing", "listing"), ("kexts.listing", "listing"),
                   ("listen-tcp.listing", "listing")]:
    d = pair(name, kind)
    if d:
        found = True
        R.append(f"**{name}**")
        R.extend(d)
        R.append("")
for pl in glob.glob(os.path.join(CAP, "start", "plists", "*.sha256")):
    base = os.path.basename(pl)
    endpl = os.path.join(CAP, "end", "plists", base)
    if os.path.exists(endpl):
        a = open(pl).read().strip()
        b = open(endpl).read().strip()
        if a != b:
            found = True
            R.append(f"- plist {base[:-7]}: `{a}` → `{b}`")
if not found:
    R.append("- no changes detected between start and end snapshots")

# --- 10. LDB session log growth
R.append("\n## 10. LDB encrypted session-log growth\n")
ldb_rows = jload(os.path.join(CAP, "streams", "ldb-files.jsonl"))
if ldb_rows:
    by = defaultdict(list)
    for row in ldb_rows:
        by[row.get("path")].append((ts(row.get("t")), int(row.get("size") or 0)))
    for pth, seq in sorted(by.items()):
        sizes = [s for _, s in seq if s]
        if sizes:
            R.append(f"- `{pth}`: {min(sizes)} → {max(sizes)} bytes ({len(seq)} samples)")
else:
    R.append("- no LDB session-log samples (LDB may not have run during this capture)")
R.append("")

# --- 11. limits
R.append("## 11. What this capture CANNOT prove\n")
R.append("- Signal sender identity without the dtrace stream (sudo; SIP may still block it — see coverage).")
R.append("- LDB's `ldb-hc-log-session-*.dat` contents (encrypted, per-session key); only size/mtime growth is observed.")
R.append("- Network payloads: intentionally never captured (metadata only).")
R.append("- Sub-second file opens between lsof/fs_usage samples are missed (sampling, not an event log).")
R.append("- SecureEventInput is read via the official IsSecureEventInputEnabled probe (compiled at capture start); if the probe failed to compile, the stream records `unknown` and Cluely's own tap-status logs (winston-follow.txt) are the fallback source.")
R.append("- Ordering claims across detected gaps in the coverage table must be treated as suspect.")
R.append("")

# ------------------------------------------------------------- write out ----
events.sort(key=lambda e: e["t"])
if events:
    with open(os.path.join(CAP, "merged-events.jsonl"), "w") as f:
        for e in events:
            e2 = dict(e)
            e2["t_iso"] = iso_of(e["t"])
            f.write(json.dumps(e2, default=str) + "\n")
    for app in ("ldb", "cluely"):
        with open(os.path.join(CAP, f"per-app-{app}-events.jsonl"), "w") as f:
            for e in events:
                if e["app"] == app:
                    f.write(json.dumps(dict(e, t_iso=iso_of(e["t"])), default=str) + "\n")

with open(OUT_MD, "w") as f:
    f.write("\n".join(R))
print(f"report -> {OUT_MD}")
print(f"events merged: {len(events)} — coincidence windows: {len(windows)}")
print(f"coverage: " + ", ".join(f"{s}={coverage[s]['status']}" for s in sorted(STREAM_SRC)))
