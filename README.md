# OpenCluely

**The invisible AI exam copilot** — AI answers on a floating overlay that
screen-share cannot see, plus the forensic scanner that records what happens
between it and proctoring software (Respondus LockDown Browser).

---

## Documentation index

| Doc | What it covers |
|---|---|
| [`docs/TIMELINE.md`](docs/TIMELINE.md) | Master chronological record of the whole project, every entry sourced to evidence on disk |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Both systems: Cluely's process tree/stealth/TCC mechanics, and the scanner's 10 dimensions + structural rules |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Operating procedures: armored launch, scanner lifecycle, stop/analyze, after-action checks |
| [`docs/EXAM-CAPTURE-2026-09-18.md`](docs/EXAM-CAPTURE-2026-09-18.md) | The real exam recording: verdicts on every Cluely↔LDB interaction question |
| [`docs/INCIDENT-2026-09-18-144138.md`](docs/INCIDENT-2026-09-18-144138.md) | Incident: Cluely died at question-1 load (14:41:38.8) — full evidence chain; original "self-exit" verdict corrected to LDB SIGKILL |
| [`docs/INCIDENT-2026-09-18-160938-LDB-SIGKILL.md`](docs/INCIDENT-2026-09-18-160938-LDB-SIGKILL.md) | The smoking gun: retest caught LockDown Browser's SIGKILL kill-loop on tape; all three incidents unified |
| [`docs/INCIDENT-2026-09-18-1105-FORENSICS.md`](docs/INCIDENT-2026-09-18-1105-FORENSICS.md) | Incident: morning shutdown forensics (10:04–11:45) |
| [`docs/INCIDENT-2026-09-19-135148-LDB-SIGKILL.md`](docs/INCIDENT-2026-09-19-135148-LDB-SIGKILL.md) | **Sender-attributed kill**: EndpointSecurity named LDB→Electron byte-for-byte; capture proven as the trigger; G1 content gate passed |
| [`docs/SOLUTION-DESIGN.md`](docs/SOLUTION-DESIGN.md) | "Cluely Shield": engineering design for surviving LDB's kill loop (threat model, Brain/root-helper split, verification plan) |
| [`shield/README.md`](shield/README.md) | The "Cluely Shield" root helper itself: what it is, build/run, Day-1 contract, and validation status |
| [`research/`](research/) | Adversary recon + platform research: LDB static analysis, capture-visibility probes, design review |
| [`docs/history/`](docs/history/) | Historical engineering briefs, plans, and audit trails (Sep 16–17) |
| [`exam-scan/README.md`](exam-scan/README.md) | Scanner usage, dimensions, and limitations |
| `exam-scan/capture/20260918T183018Z/report.md` | Machine-generated interaction report for the exam run (12 sections, 0–11) |

---

## What the app does

- **Invisible on camera.** Windows are excluded from screen capture. Zoom, Teams, Meet, OBS — nobody sees them.
- **Focusless typing (macOS).** Press `Cmd/Ctrl + Shift + Space` and type into chat **without ever clicking away** from your test page. Enter sends, Esc cancels. (Typing capture is macOS-only; other platforms type into the chat window normally.)
- **Screenshot → answer.** Press `Cmd/Ctrl + Shift + S`. The AI reads your screen and answers. **No OCR. Direct vision.**
- **Streams live.** Answers type themselves out, token by token, in chat and the floating overlay.
- **Remembers context.** Follow-ups like "what's the time complexity?" just work.
- **6 skills.** DSA, OOD, MCQ, System Design, Behavioral, Programming. One click cycles them.
- **Your key, your data.** DeepSeek or Gemini. The only thing that leaves your machine is your question.
- **Voice (optional).** Local Whisper transcription. Off by default.

## Quick start

```bash
npm install

# add your key to .env  (pick one)
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-your-key

# normal run:
npm start

# armored run (console + exit-status captured for forensics):
bash cluely-safe-start.sh
```

macOS: on first use, allow **Screen Recording** (screenshots) and **Input Monitoring** (focusless typing).
They show up as one-time system prompts.

## Shortcuts

| Keys | What happens |
|---|---|
| `Cmd/Ctrl + Shift + S` | Screenshot → AI answer |
| `Cmd/Ctrl + Shift + Space` | Focusless typing ON/OFF |
| `Cmd/Ctrl + Shift + C` | Open chat |
| `Cmd/Ctrl + Shift + V` | Hide / show all windows |
| `Cmd/Ctrl + ,` | Settings |
| `Alt + R` | Voice (only if configured) |

## The exam scanner

`exam-scan/` records, at machine level, everything that happens between Cluely
and LockDown Browser during a proctored exam — identity registry, TCC
attribution, focus/SecureEventInput, IPC, network metadata, filesystem,
resources, and coverage telemetry. See `docs/RUNBOOK.md` for the full
procedure and `docs/ARCHITECTURE.md` for the design.

## Reliability history (condensed)

The app went through three audit rounds (Sep 17) and a Depth Engine hardening
run (Sep 18) — 35/35 unit tests, zero proctor-event leaks, one-network-socket
verification, 18-crash window-destroy bug fixed. Three real incidents were
forensically investigated on Sep 18 and unified: **LockDown Browser SIGKILLs
Cluely during exams** (a ~10 s kill loop plus a detection-triggered kill after
capture/window activity) — documented under `docs/`, with death-visibility
instrumentation installed so any future silent death names itself. The fix
design lives in [`docs/SOLUTION-DESIGN.md`](docs/SOLUTION-DESIGN.md).

Deep dive (every symptom, root cause, and test result): [`docs/history/FEATURE_AUDIT_R3.md`](docs/history/FEATURE_AUDIT_R3.md)

---

## License

MIT — see [LICENSE](./LICENSE).

*Use responsibly. Follow the rules of any exam you take.*
