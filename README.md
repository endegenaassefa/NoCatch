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
| [`docs/INCIDENT-2026-09-18-144138.md`](docs/INCIDENT-2026-09-18-144138.md) | Incident: Cluely self-exited (code 1) at question-1 load — full evidence chain, LDB exonerated |
| [`docs/INCIDENT-2026-09-18-1105-FORENSICS.md`](docs/INCIDENT-2026-09-18-1105-FORENSICS.md) | Incident: morning shutdown forensics (10:04–11:45) |
| [`docs/history/`](docs/history/) | Historical engineering briefs, plans, and audit trails (Sep 16–17) |
| [`exam-scan/README.md`](exam-scan/README.md) | Scanner usage, dimensions, and limitations |
| `exam-scan/capture/20260918T183018Z/report.md` | Machine-generated interaction report for the exam run (11 sections) |

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
verification, 18-crash window-destroy bug fixed. Two real incidents were
forensically investigated on Sep 18: a morning kill (external signal) and an
exam-time self-exit (Electron native exit(1)) — both fully documented under
`docs/`, with death-visibility instrumentation now installed so any future
silent death names itself.

Deep dive (every symptom, root cause, and test result): [`docs/history/FEATURE_AUDIT_R3.md`](docs/history/FEATURE_AUDIT_R3.md)

---

## License

MIT — see [LICENSE](./LICENSE).

*Use responsibly. Follow the rules of any exam you take.*
