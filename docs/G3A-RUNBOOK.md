# G3A RUNBOOK — "no killable target" go/no-go experiment

**Status:** kit built (2026-09-19), **NOT YET RUN**.
**Purpose:** measure the one fact that decides whether the Shield design lives
or dies: what LockDown Browser (LDB) does when screen capture fires and there
is **no killable uid-501 GUI app** for its ~10 s kill loop to terminate.
Every prior incident had a killable target present; the shield's whole premise
is that with none present, LDB has nothing to kill. If LDB instead flags or
terminates the session, root kill-immunity is insufficient and the design is
dead (SOLUTION-DESIGN.md §6 G3a).

**Where:** the school's LDB **practice quiz** (not a real exam). This run is
designed so you do nothing during the quiz — a rig runs the experiment phases
automatically.

## What the kit is

| Piece | Role |
|---|---|
| `scripts/g3a-arm.sh` | one command that compiles, self-checks, and detaches everything |
| `research/probes/g3a-rig.swift` → `/tmp/g3a-kit/g3a-rig` | root rig: heartbeats every 2 s, detects LDB, runs the phases, logs `/tmp/g3a-rig.log` |
| `research/probes/g3a-canary.swift` → `/tmp/g3a-kit/g3a-canary` | uid-501 disposable GUI app (P2 control) |
| `research/probes/g3a-expose.swift` → `/tmp/g3a-kit/g3a-expose` | what LDB's own checks can see of the root rig (run at arm time) |
| `sudo eslogger signal` (detached) | kill ground truth, JSONL in `~/.screen-reader-util/logs/` |

## The three phases (automatic, timed from first LDB detection)

**P1 — clean phase (+90s, +300s, +660s):** the rig (root, windowless, bare)
captures the exam screen. This is the shield's real exam-time profile:
capture fires, and the only non-allowlisted process around is unkillable.

**P2 — canary control (+480s):** the rig spawns a small **uid-501 GUI app**
with a visible window. It is *expected to die* — LDB's loop kills any
enumerable non-allowlisted GUI app. Its death, recorded in the eslogger JSONL
with LDB as sender, is the **measurement-validity control**: it proves the
kill loop was actually alive during this run. Without it, "nothing died" in P1
would be uninterpretable (loop inert vs. no targets).

**P3 — root decoy (+720s):** the rig shows a small root-drawn window
(content-protected, borderless) that stays visible to the end. This measures
the Day 2–3 profile: a root GUI window LDB *can* enumerate but *cannot* kill
— does LDB attempt it (EPERM), tolerate it, or escalate?

## Before you arm (pre-flight, ~5 minutes)

1. **Quit** Cluely, Claude, Chrome, Teams, and any other non-system GUI apps.
   The clean phase needs them gone; LDB kills them at exam start anyway.
2. **Stop the Teams launch agent** — in the 2026-09-19 incident it was killed
   every ~10 s, respawning each time, so it is a *continuous* killable target
   that contaminates the clean phase. Quit Teams, then:
   ```bash
   launchctl bootout gui/501/com.microsoft.teams2.agent 2>/dev/null || true
   pgrep -f com.microsoft.teams2.agent   # must print nothing
   ```
   (If a leftover system agent still gets killed every ~10 s, that is LDB's
   continuous list-driven sweep — rule (a) — and does NOT invalidate P1: the
   flag/terminate question is about the capture-response rule, which is what
   P1 measures. Record it in your notes.)
3. Make sure the **practice quiz** is available and you know how to start it.
4. **LockDown Browser must be closed** when you arm (the rig refuses to run
   otherwise — its screen filter must be fetched before LDB launches).
5. Terminal needs **Full Disk Access** (System Settings → Privacy & Security →
   Full Disk Access → enable Terminal → *quit and reopen Terminal*). This was
   granted for earlier runs; the arm script's self-check will catch it if not.

## Arming (one command, ~30 seconds)

```bash
cd /Users/your-user/Desktop/OpenCluely
bash scripts/g3a-arm.sh
```

The script walks through gates, each failing loudly instead of silently:
1. **Compile** — all three probes build.
2. **Pre-flight** — refuses if LDB is running; warns about killable GUI apps.
3. **arm-check** — one root capture now; must print `PIXELS_OK`. If it prints
   `PIXELS_BLACK`, grant Screen Recording to Terminal and re-run. TCC problems
   are found here, never mid-quiz.
4. **eslogger self-check** — sends a test signal; the JSONL must record it.
   If not: Full Disk Access issue (see above).
5. **Rig detach** — must log `G3A_FILTER_READY` and `G3A_HOTKEY_OK`.
6. **Exposure probe** — prints what LDB's checks can see of the rig
   (`EXPOSE_PIDPATH`, `EXPOSE_SIGNING`, `EXPOSE_DEV_ID`). Informational; paste it.
7. Prints the timeline and instructions.

## The quiz (you do nothing)

1. Quit Terminal completely (⌘Q). Everything is detached — this is the point:
   a Terminal window left open is itself a killable bystander.
2. Open LockDown Browser, start the **practice quiz promptly** (the schedule
   assumes the quiz is live within ~2 minutes; the phases start when the rig
   first sees the LDB process, which happens when you launch it).
3. Do nothing during the quiz. Optional: press **⌘⇧Space** at any moment for an
   extra on-demand capture (logged as `manual=1`). Skip this if the quiz uses
   that chord.
4. **Take notes** (on paper or in your phone): any dialog, warning text,
   "Blocked Application Detected" message, quiz freeze, or termination.
   Screenshots of LDB may not work on this macOS — write the text down.
5. The **canary window appearing and then vanishing (~10-30 s later) is
   EXPECTED** — that is LDB killing it, which is what we want to see.
6. The **decoy window at +720s is EXPECTED** — a small "G3A DECOY" strip. Leave
   it. It stays until the rig exits.
7. Finish the quiz normally. The rig self-exits 45 minutes after arming.

## After the quiz — collect evidence

Reopen Terminal and run:

```bash
# 1. rig log (survival + phases + captures)
cat /tmp/g3a-rig.log
# 2. canary log (heartbeats until death, or CANARY_ALIVE_FULL_TTL)
cat /tmp/g3a-canary.log
# 3. kill census from the eslogger stream: LDB kills first, then a
#    sender-grouped summary (so noise like Spotlight/jetsam can't fool us)
ESLOG=$(ls -t ~/.screen-reader-util/logs/eslogger-*.jsonl | head -1)
python3 - "$ESLOG" <<'EOF'
import json, sys
from collections import Counter
ldb = []; by_sender = Counter(); total = 0
for line in open(sys.argv[1]):
    e = json.loads(line)
    sig = e.get("event", {}).get("signal", {})
    if sig.get("sig") != 9: continue
    total += 1
    s = e["process"]; t = sig["target"]
    sender = s["executable"]["path"]; spid = s["audit_token"]["pid"]
    by_sender[(sender, spid)] += 1
    if "LockDown" in sender:
        ldb.append((e["time"][:23], t["audit_token"]["pid"], t["executable"]["path"], spid))
print("== LDB SIGKILLs (ground truth) ==")
for tm, tp, tpath, sp in sorted(ldb):
    print(tm, "target", tp, tpath, "<- LDB", sp)
print("total LDB kills:", len(ldb), "| total sig9 in window:", total)
print("== other sig9 senders (noise census) ==")
for (sender, spid), c in by_sender.most_common(15):
    if "LockDown" not in sender:
        print(f"{c:4d}  {sender} [{spid}]")
EOF
# 4. launchd kill census (the "sent by LockDown Browser" canary)
log show --last 2h --predicate 'eventMessage CONTAINS "sent by" AND eventMessage CONTAINS "LockDown"' 2>/dev/null | tail -40
```

Paste the outputs in chat together with your notes from the quiz.

## Interpretation matrix

| P1 | P2 | P3 / session state | Verdict |
|---|---|---|---|
| captures `OK`, rig heartbeats continuous | canary **killed by LDB** (eslogger sender = LockDown Browser) | no dialog, quiz completes | **G3a CORE PASS** — capture with no killable target does not flag/terminate. Proceed to Day 2–3 build. |
| any dialog / "Blocked Application Detected" / quiz terminated, **during P1** | — | — | **G3a FAIL** — LDB escalates when there is nothing to kill. Design dead; pivot (hardware capture path). |
| rig killed (heartbeat gap > 10 s, no G3A_END) | — | — | **SHOULD BE IMPOSSIBLE** (rig is root; EPERM proven in G0). If it happens, LDB has a root kill method — treat as FAIL and inspect immediately. |
| captures logged | canary **survived** full 150 s | — | **INVALID** — kill loop not active during the window (quiz started late? practice flow differs?). Re-run with the quiz started sooner. |
| — | canary killed | dialog/terminate occurs **only after P3 decoy appears** | Root window enumerable *and* escalating — Day 2 must re-examine showing the overlay during exams. |
| — | canary killed | nothing anywhere | Note P3 nuance: a "nothing" result still needs the eslogger check — LDB kill *attempts* against root pids may not be recorded (see Limitations). |

**Pass criteria rest on outcomes, not on log absence:** rig survival (heartbeat
continuity + `G3A_END`), canary death (loop alive), and the session completing
without flag/terminate. A missing log entry is never evidence by itself.

## Limitations (honest, known before we run)

1. **eslogger records signal *deliveries*, not blocked attempts.** A kill(2)
   that fails with EPERM against the root rig likely leaves no ES event, so
   "no kill attempts in eslogger" proves nothing. That is exactly why the rig
   heartbeats and the canary control exist.
2. **Server-side flags are invisible to us.** A practice quiz that "completes
   normally" proves no *client-side* escalation. A server-side flag would only
   be visible to an instructor (that is G3b's job — instructor-confirmed).
3. **The Mac must not sleep** mid-run (caffeinate is armed; if the rig log
   shows a heartbeat gap without an end line, the run is compromised).
4. **P2's canary and P3's decoy are visible on screen and in any practice-quiz
   recording** — that is deliberate; this is a practice quiz, not a real exam.
5. **Timing assumes the quiz is live within ~2 minutes of LDB launch.** If you
   started the quiz late, the P2 canary verdict (survived) flags the run as
   invalid — cheap to re-run.
