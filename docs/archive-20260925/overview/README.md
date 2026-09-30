# OpenCluely

**The invisible AI exam copilot** — an Electron app that answers questions
from screenshots through the DeepSeek/Gemini vision APIs, on a floating
overlay that screen-share cannot see, plus the forensic scanner that records
what happens between it and proctoring software.

## Windows and Mac setup

The local setup implementation now defaults to managed AI: open the app, sign in in your browser, then ask a text or screenshot question. It saves your question and setup step, previews screenshots before upload, requires your approval to send, and finishes after a successful answer. Screen permission is requested only when you capture; text success does not claim screen or microphone readiness.

The managed service is **not deployed yet**. An unsigned local build without deployment configuration explains that sign-in is unavailable. Local automated tests use fixture identity/capture/AI services; they do not establish live service availability. Release operators supply public configuration before packaging; ordinary users do not enter service URLs, provider keys or environment variables. See [building and configuration](docs/BUILDING.md).

Settings contains account sign-in/sign-out and **Resume setup**. **Advanced Settings** retains direct provider keys and existing voice/helper controls, with a persisted AI connection selector. Existing direct-mode installations retain their configuration. Voice remains optional during setup. Windows x64 builds include a private CPU speech runtime and explicit model preparation in Settings; managed voice and the packaged Mac speech runtime remain future release work.

Develop locally with Node 22 and the lockfile:

```bash
npm ci
npm start
npm run test:packaging
node --test scripts/test-setup-service.js scripts/test-onboarding.js scripts/test-managed-client.js scripts/test-managed-server.js scripts/test-platform.js
```

Windows x64 and Intel/Apple Silicon Mac package targets share the setup flow and adapt permissions through platform adapters. Clean Windows installation, physical microphone testing, native Mac qualification, signed installers, deployed authentication/AI, managed voice, packaged Mac speech, updates/migration and full P01–P21 native parity remain release gates. A local passing test is not a claim of production readiness. The [cross-platform blueprint](docs/cross-platform-blueprint/README.md) records the complete product contract and sequence.

## Optional voice capture

Windows and macOS now use one owned microphone session in the main overlay renderer for both existing **Azure direct** and **local Whisper** voice settings. Capture uses AudioWorklet and continuously converts the actual device/context sample rate to mono 16 kHz PCM. It needs no sox, rec or arecord on these platforms. Linux retains its native ALSA/sox recorder.

Use the existing microphone control to start and stop. Startup and general recording notifications do not request microphone access. Stop releases the microphone and drains pending transcription and the final audio tail. If the final audio cannot be recovered, the app processes only audio already received and says so; cancel, renderer loss, suspend, account transitions and settings changes discard late results. Manual/VAD segmentation and configured answer destinations remain in use. Denied or lost microphone access reports a retry/settings action.

Windows x64 packages include the CPU Whisper runtime. In Settings, select Local Whisper and Auto or CPU, leave the command at `whisper`, then click **Prepare model**. The app verifies the selected model and loads it before enabling recording; the default `small` model needs about 461 MiB once. Cancel, Retry and reopening Settings preserve operation ownership. This included runtime does not require external Python, pip or ffmpeg. Explicit custom runtimes and other platforms retain their existing setup requirements. See [Windows speech runtime](docs/WINDOWS-SPEECH-RUNTIME.md).

Azure still requires the existing explicit direct-provider choice and credentials and sends audio to Azure. Managed voice, signing, physical microphone/provider qualification and full speech parity remain separate release work. The local [Windows test guide](docs/WINDOWS-TESTING.md) explains how to test the current candidate.

Local regression checks (no microphone, credentials or provider calls):

```bash
node --test scripts/test-portable-voice.cjs
```

The coordinator owns package builds, rendered browser review, independent acceptance and native/provider qualification. These local fixtures do not establish recognition quality, hardware compatibility or live service readiness.

## Advanced macOS exam mode

The existing specialized Mac root launcher is retained separately from normal setup. Its behavior and limitations are documented in [ROOT-EXAM-MODE.md](docs/ROOT-EXAM-MODE.md). It is not a Windows setup path.



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

## Additional development launch commands

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

- **Node.js 22+** for development (candidate runtime: Electron 44.4.4). Build and signing instructions: [`docs/BUILDING.md`](docs/BUILDING.md).
- macOS 13+ for the full stealth/capture surface (windows can run without it)
- Packaged Windows x64 voice: included CPU runtime plus a one-time model preparation in Settings.
- Custom/local development and other-platform Whisper: compatible Python/Whisper and ffmpeg (`./setup.sh` covers the legacy setup).

## License

MIT — see [LICENSE](./LICENSE).

*Use responsibly. Follow the rules of any exam you take.*
