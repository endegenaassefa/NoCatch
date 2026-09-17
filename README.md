# OpenCluely

**The invisible AI interview copilot.**

AI answers on a floating overlay that screen-share **cannot see**.
Ask by typing, or screenshot — get the answer instantly.

---

## What it does

- **Invisible on camera.** Windows are excluded from screen capture. Zoom, Teams, Meet, OBS — nobody sees them.
- **Focusless typing (macOS).** Press `Cmd/Ctrl + Shift + Space` and type into chat **without ever clicking away** from your test page. Enter sends, Esc cancels. (Typing capture is macOS-only; other platforms type into the chat window normally.)
- **Screenshot → answer.** Press `Cmd/Ctrl + Shift + S`. The AI reads your screen and answers. **No OCR. Direct vision.**
- **Streams live.** Answers type themselves out, token by token, in chat and the floating overlay.
- **Remembers context.** Follow-ups like "what's the time complexity?" just work.
- **Speaks your language.** C++, C, Python, Java, JavaScript.
- **6 skills.** DSA, OOD, MCQ, System Design, Behavioral, Programming. One click cycles them.
- **Your key, your data.** DeepSeek or Gemini. The only thing that leaves your machine is your question.
- **Voice (optional).** Local Whisper transcription. Off by default — see below.

---

## Quick start

```bash
# 1. Install
npm install

# 2. Add your key to .env  (pick one)
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-your-key

# 3. Run
npm start
```

macOS: on first use, allow **Screen Recording** (screenshots) and **Input Monitoring** (focusless typing).
They show up as one-time system prompts.

---

## Shortcuts

| Keys | What happens |
|---|---|
| `Cmd/Ctrl + Shift + S` | Screenshot → AI answer |
| `Cmd/Ctrl + Shift + Space` | Focusless typing ON/OFF |
| `Cmd/Ctrl + Shift + C` | Open chat |
| `Cmd/Ctrl + Shift + V` | Hide / show all windows |
| `Cmd/Ctrl + ,` | Settings |
| `Alt + R` | Voice (only if configured) |

---

## What was broken → what we fixed

**1. Screenshot analysis failed 100% of the time.** 💀
DeepSeek was spending its whole answer budget on *hidden reasoning* before writing any text.
The app retried 6 times for 2 minutes, then blamed your API key. All lies.
**Fix:** tell DeepSeek to skip reasoning (`thinking: disabled`). **Now: real answer in under 1 second.**

**2. Clicking chat to type blurred your test page.** 🚨
That's the tell proctors watch for. Any window that takes keyboard focus makes the page fire `blur`.
**Fix:** chat/settings can now *never* take focus. Typing goes through a global hotkey that
captures keystrokes and routes them into chat. Clicks now produce **zero** proctor events.

**3. Settings forgot everything on restart.** 🔁
Skill, language, icon, window gap — all reset every launch.
**Fix:** they now save to `.env` and survive restarts. Verified with a full restart test.

**4. Answers appeared all at once, not streaming.** 🐌
The main process streamed the tokens, but no window was listening.
**Fix:** wired chat and the overlay to the stream. Tokens now appear live (~200ms ticks).

**5. The app lied about voice.** 🎤
No Whisper installed, but the UI said "Recording in Progress" and showed a mic button.
**Fix:** placeholder keys no longer count as configured. No setup → mic hidden, no fake banner.
Voice stays off until you run `./setup.sh`.

**6. Copy buttons leaked code to the clipboard.** 📋
Proctor clipboard watchers can see pasted code snippets.
**Fix:** buttons and the clipboard code removed entirely.

**7. 18 crashes in 24 minutes.** 💥
A destroyed-window bug in `onActivate`. **Fix:** `isDestroyed()` guards everywhere.

**8. Six dead IPC channels.** 🕸️
The UI called channels that had no handler. **Fix:** all six now handled.

**9. Gemini TLS verification was disabled.** 🔓
The app blindly trusted Gemini's certificates. **Fix:** normal verification everywhere.

**10. The mock proctor couldn't tell noise from tells.** 📊
Heartbeats and real events shared one file, so the log always looked "caught".
**Fix:** heartbeats split into their own file, plus `/marker` endpoints for clean test runs.

---

## How we proved it

- A **mock proctor** (test page + local server) records `blur` / `visibilitychange` events — the exact signals real proctors watch.
- Tests ran against the **packaged app**, driven by a real browser and real OS-level mouse/keyboard input.
- The full matrix passed: clicking every window, dragging, showing/hiding, and typing through keystroke-capture — **zero proctor events**, and **zero keystrokes leaked to the test page**.
- The network table was inspected live during LLM calls: **one socket, `api.deepseek.com`, nothing else.**
- 35/35 unit tests pass.

Deep dive (every symptom, root cause, and test result):
**[FEATURE_AUDIT_R3.md](./FEATURE_AUDIT_R3.md)**

---

## License

MIT — see [LICENSE](./LICENSE).

*Use responsibly. Follow the rules of any exam you take.*
