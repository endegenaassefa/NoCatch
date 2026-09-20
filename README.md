# OpenCluely

**The invisible AI exam copilot** — an Electron app that answers questions
from screenshots through the DeepSeek/Gemini vision APIs, on a floating
overlay that screen-share cannot see, plus the forensic scanner that records
what happens between it and proctoring software.

> **Current state (2026-09-20):** root exam mode is the supported way to run
> Cluely. The entire app relaunches as **root**, which makes it immune to
> LockDown Browser's uid-501 SIGKILL sweep (kill(2) returns EPERM) — chat,
> question-type switching, mic, settings, capture, all in the one
> kill-immune process. One command: **`cluely`**. Details and the honest
> unknowns live in [`docs/ROOT-EXAM-MODE.md`](docs/ROOT-EXAM-MODE.md).

---

## Exam mode (recommended)

```bash
npm install
cp env.example .env            # then put your DeepSeek key in .env

# one-time: put `cluely` on your PATH
sudo ln -s "$PWD/scripts/cluely.sh" /usr/local/bin/cluely

cluely                         # checks, launches Cluely as root, verifies boot
```

Then open LockDown Browser, and on a question press **⌘⇧Space**. The answer
streams into the chat. When you're done:

```bash
cluely stop                    # kills the whole root Cluely + restores file ownership
```

Also available: `cluely status`, `cluely doctor`. The launcher is
idempotent, cleans stale singleton locks, kills by process group (not argv —
Chromium renames itself to "Terminal" when launched from a terminal), and
verifies real boot before telling you to proceed.

**Order matters:** Cluely first, LockDown Browser second. Do not run the
optional shield helper at the same time — one process owns the hotkey chord.

## Normal mode (non-exam)

```bash
npm start                                    # plain launch
bash scripts/cluely-safe-start.sh            # armored: console tee'd for forensics
```

macOS first-run permissions: **Screen Recording** (screenshots), **Microphone**
(voice), **Input Monitoring** (focusless typing).

## Shortcuts

| Keys | What happens |
|---|---|
| `Cmd/Ctrl + Shift + Space` | Capture → AI answer (the exam hotkey) |
| `Cmd/Ctrl + Shift + S` / `+ Q` | Screenshot → OCR answer |
| `Cmd/Ctrl + Shift + V` | Hide / show all windows |
| `Cmd/Ctrl + Shift + I` | Toggle click-through interaction |
| `Cmd/Ctrl + Shift + C` | Open chat |
| `Cmd/Ctrl + Shift + \` | Clear session memory |
| `Cmd/Ctrl + ,` | Settings |

## Structure

```
main.js                 Electron main (windows, capture, hotkeys, exam mode)
chat.html / settings.html / onboarding.html / llm-response.html / index.html
src/                    services + managers (window, llm, shield client, …)
scripts/                ALL scripts: cluely.sh (exam launcher), cluely-safe-start.sh,
                        shield build/install, capture tests, whisper worker
shield/                 Swift root helper "Cluely Shield" (optional fallback only)
exam-scan/              forensic scanner: records Cluely ↔ LockDown Browser
prompts/                skill prompts (DSA, MCQ, OOD, behavioral, system design, programming)
lib/                    shared browser libraries (HTML sanitizer)
assets/                 icons + vendored FontAwesome
docs/                   everything documented — see docs/INDEX.md
docs/research/          adversary recon + platform research (probe code: research/probes/)
docs/history/           pre-shield engineering briefs + audit rounds
webapp/                 legacy web scaffold
```

The full, categorized documentation index is **[`docs/INDEX.md`](docs/INDEX.md)**.

## Requirements

- **Node.js 18+** (Electron 29)
- macOS 13+ for the full stealth/capture surface (windows can run without it)
- Voice: Python 3.10+ and ffmpeg for local Whisper (`./setup.sh` handles it)

## License

MIT — see [LICENSE](./LICENSE).

*Use responsibly. Follow the rules of any exam you take.*
