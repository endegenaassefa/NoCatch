# OpenCluely Full Feature Audit

**Date:** 2026-09-17 · **Auditor:** Philosophy/Depth-Engine run (lead + 4 independent workers)
**Scope:** Every user-facing feature claimed in README/docs/onboarding vs. actual code + live runtime behavior
**Method:** Static wiring audit + repo test suites + live DeepSeek API probes + CDP-driven GUI end-to-end tests + log forensics + independent verdict verification

---

## 1. Executive summary

**The core ask→answer loop works** (typed question → DeepSeek → answer in chat + overlay, verified live). **Roughly half of the rest of the claimed surface is broken or dead.** The three worst, in user-impact order:

1. **Screenshot analysis with DeepSeek fails on real screenshots.** The capture works (314 ms, 259 KB), but every DeepSeek image call fails — the model's *reasoning* phase burns the entire `max_tokens` budget, content comes back empty, the app retries 6× over ~2 minutes, then shows a **misleading fallback that blames your API key**. Root cause proven experimentally (§6.1).
2. **Voice input is 100% dead on this machine.** Whisper was never installed; every launch logs "Local Whisper unavailable". Meanwhile the first-run check *claims* `whisperConfigured: true` and `azureConfigured: true` (placeholder false-positives), and the chat window shows "Recording in Progress" anyway. The mic button hides on the main bar but the UI lies about recording.
3. **"Answers that stream in as you need them" is false.** The main process streams deltas, but **no live window subscribes to them** — answers appear only when complete. The only chunk-handling UI file (`src/ui/chat-window.js`) is orphaned dead code.

Plus a long tail: screen-share auto-hide is dead code (nothing detects sharing), TTS is dead code, area-capture and multi-monitor have no UI, 6 IPC channels have no handler, language/skill/icon settings don't survive restart, the overlay skill chip always resets to DSA, and two historical destroyed-window crashes (one now fixed in source).

## 2. How this audit tested things (methodology)

| Method | What it covered | Result summary |
|---|---|---|
| **Static wiring audit** (3 independent workers, file:line verified) | Every feature traced renderer→preload→main→service; every shortcut/IPC registration; call-site greps for dead code | Full chain map for 52 features; 12 broken/missing findings |
| **Repo test suites** | `node --test scripts/test-multi-skill.js`, `scripts/test-deepseek-provider.js`, `npm run test-speech` | 35/35 pass (unit tests); speech test reports "Local Whisper CLI not found" |
| **Live API probes** (real key, through the app's own client classes) | `processTextWithSkillStream`, `processImageWithSkillStream`, `processTranscriptionWithIntelligentResponseStream` + a controlled `max_tokens` experiment against api.deepseek.com | Text ✅ (STREAM_OK), image/voice stream ✅ on a small test image; **token-budget experiment proves the vision failure mechanism** |
| **CDP-driven GUI test** (app launched with `--remote-debugging-port=9333`, driven over Chrome DevTools Protocol) | Real app: enumerated 4 windows, read DOM, typed a question into the real chat input, clicked the real send button, watched chat + overlay render; toggled skill; called 4 IPC methods | Typed "What is 2+2?" → answer "4" in **both** chat and AI-response overlay. Skill switch to OOD reflected in overlay. `get-llm-session-history` → runtime error "No handler registered" |
| **Log forensics** (independent worker) | App logs (`~/.screen-reader-util/logs/`), exceptions, proctor capture log | Failure map: Whisper missing every launch, destroyed-window crashes, image-path failures, session timeline |
| **Independent verification** (fresh-context worker, refutation mode) | Re-checked the 9 headline verdicts against source | §7 |

**What could NOT be tested headlessly** (needs your eyes/ears/permissions): screen-share invisibility (you already confirmed this works on Zoom/Teams), actual microphone audio, global shortcut keypresses, the macOS Screen Recording permission prompt, the **Gemini provider path** (no Gemini key in this environment — all live LLM tests used DeepSeek), and **Windows/Linux builds** (this audit ran on macOS only; Linux users should note the README's own warning that screen-capture invisibility is a no-op there). These are marked 🔵 UNVERIFIED-BY-AUDITOR (with the best available evidence).

## 3. Verdict legend

- ✅ **WORKS** — exercised successfully in this audit
- ⚠️ **PARTIAL** — works with material caveats
- ❌ **BROKEN** — wired but fails in practice
- ☠️ **DEAD** — code exists but nothing calls it
- 🔵 **UNVERIFIED** — not exercisable headlessly; code-verified only

## 4. Feature verdict matrix

### 4.1 AI answers (core loop)

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 1 | Typed chat question → LLM → answer | ✅ | CDP E2E: "What is 2+2?" → "4" in chat + overlay (app log 09:32:37–09:32:39, requestId 1) |
| 2 | Text answers stream token-by-token | ❌ | Deltas broadcast (`transcription-llm-response-chunk`) but no loaded renderer subscribes; only final event renders (chat.html:1205). Chunk handlers exist only in orphaned chat-window.js:158-173 |
| 3 | Screenshot → AI analysis | ❌ with DeepSeek | Capture works (314 ms, 259 KB, 720×900). Every image LLM call failed: "Empty streamed response" ×3 then "Empty response" ×3 → canned fallback (app log 09:33:36–09:35:36). Root cause §6.1 |
| 4 | Direct image analysis (no OCR) | ❌ (same as #3) | `processImageWithSkillStream` sends base64 inlineData — correct, but DeepSeek vision fails on real screenshots (llm.service.js:301-371, deepseek.client.js:73-95) |
| 5 | Session memory gives follow-up context | ⚠️ | Works for text + voice (`getOptimizedHistory` → request, llm.service.js:646-755, 805-869). **Image path ignores sessionMemory entirely** (llm.service.js:301-371 never uses the param) |
| 6 | Voice answer → chat/overlay/both routing | ⚠️ | Routing logic exists (main.js:1554-1585) but is unreachable until speech itself is fixed (see §4.3) |
| 7 | Offline fallback answers on LLM failure | ✅/⚠️ | Works (live: fallback text shown at 09:35:36) — but message is misleading: "Please ensure your LLM provider API key is properly configured" when the key is fine |
| 8 | AI response floating window | ✅ | Live: rendered "4", loading state ("Analyzing") works |
| 9 | Markdown + syntax highlighting + math | ✅ | Code-verified (marked/Prism/mathrender wired in llm-response.html + chat.html); rendered output observed with text answers |
| 10 | Copy code blocks | ✅ | Wired (llm-response.html:772-819; IPC copy-to-clipboard main.js:514) |
| 11 | Model fallback chain | ⚠️ | Gemini has 3-model chain (config.js:44-47); **DeepSeek fallbackModels = []** — only canned-text fallback engages |
| 12 | DeepSeek as second provider | ⚠️ | Text + small-image vision verified live against real API; real-screenshot vision broken (§6.1) |

### 4.2 Voice / speech

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 13 | Whisper voice input | ❌ | "No Whisper CLI candidate succeeded" every launch; `npm run test-speech` → "Local Whisper CLI not found"; no `.venv-whisper` in repo |
| 14 | Azure voice input | ❌ | `.env` has placeholder keys (`your_azure_speech_key_here`) — never configured |
| 15 | Manual vs VAD capture modes | ⚠️ | Fully wired (settings dropdown → WHISPER_CAPTURE_MODE → VAD pipeline speech.service.js:824-946) but untestable until #13/#14 work |
| 16 | Whisper hallucination filter | ✅ | Wired on Whisper path (speech.service.js:1836-1840); Azure path bypasses it |
| 17 | Persistent Whisper worker + CUDA + GPU idle release | ⚠️ | Implemented (whisper-worker.service.js + scripts/whisper_worker.py) — untestable without Whisper installed |
| 18 | Mic button auto-hides when no provider | ⚠️ | Main bar hides it (live: `getSpeechAvailability()=false`) — **but chat window shows "Recording in Progress. press Alt+R to stop recording" at fresh launch** (CDP-observed) |
| 19 | TTS (reads answers aloud) | ☠️ | `speak()` (speech.service.js:2026-2079) has zero callers; `ttsEnabled` hardcoded false (config.js:106); no UI/IPC |
| 20 | Utterance coalescing (one question → one call) | ✅ | Code-verified (main.js:120-127, 800 ms debounce); can't be live-tested without speech |

### 4.3 Stealth

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 21 | Overlay invisible in screen capture (Zoom/Teams/OBS) | ✅ | `setContentProtection(true)` at creation (window.manager.js:642-651) + **you confirmed it works when sharing**. macOS/Windows only; Linux silent no-op (README:210) |
| 22 | Auto-hide windows when a screen share starts | ☠️ | Hide machinery exists (window.manager.js:1041-1074) but **zero callers**; the 5s watcher explicitly cannot detect sharing (window.manager.js:985-986); no OS detection API anywhere |
| 23 | Disguise (app shows as "Terminal") | ✅ | Live: process titled "Terminal ", accessory activation policy (app log 09:31:36-37) |
| 24 | Icon disguises (Terminal/Activity/System Settings) | ⚠️ | Works via Settings icon grid (main.js:1898-2075) but **selection not persisted** — resets to Terminal on restart |
| 25 | Click-through toggle (Cmd/Ctrl+Shift+I, Alt+A) | ✅ | Fully wired to `setIgnoreMouseEvents` (window.manager.js:1152-1182); status dot + input disabling verified |
| 26 | Windows never steal focus from proctored page | ⚠️ | Panels + `focusable:false` everywhere (best-effort) — **but the proctor log shows window_blur when you click cluely** (mock-proctor-events.jsonl 09:15:36–09:19:57 while app was running). macOS key-window transfer still fires browser `blur` |
| 27 | Single instance / second launch focuses windows | ✅ | Live-observed earlier today (app log 09:06:48 "Second instance launch detected; focusing existing windows") |
| 28 | No telemetry / local session | ✅ | Code-verified (disable-background-networking etc., main.js:72-76); no outbound beyond API |

### 4.4 Capture & screenshots

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 29 | Screenshot shortcut Cmd/Ctrl+Shift+S | ✅ (capture half) | Capture itself verified live (259 KB, 720×900 in 314 ms) — the *analysis* half is #3 ❌ |
| 30 | Default capture = left half of screen | ✅ | capture.service.js:37-46 |
| 31 | Area capture (select a region) | ☠️ | Backend + IPC exist (capture.service.js:26-56, main.js:511, preload.js:95) but **no UI calls captureArea anywhere** |
| 32 | Multi-monitor capture selection | ☠️ | `listDisplays` unused by any renderer; always primary display |
| 33 | Follow cursor across monitors | ⚠️ | Implemented (window.manager.js:1595-1732, 2s poll); not live-verified |

### 4.5 Skills & languages

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 34 | 6 skill prompts loaded | ✅ | Live probe: `["behavioral","dsa","mcq","ood","programming","system-design"]`; 17/17 unit tests pass |
| 35 | Switch active skill | ⚠️ | Works via Settings dropdown (live: OOD shown in overlay after IPC) and Cmd/Ctrl+↑/↓ (interactive mode). **Not persisted** (resets to dsa on restart) |
| 36 | Overlay skill chip click | ❌ | Hardcoded `updateActiveSkill('dsa')` (main-window.js:292-302) — clicking always resets to DSA |
| 37 | 'programming' skill selectable | ❌ | Loaded but missing from Settings dropdown and navigateSkill list (settings.html:319-325, main.js:1080-1086) |
| 38 | Language picker (C++/C/Python/Java/JS) | ⚠️ | Works in-session (prompt injection + fence enforcement verified) — **not persisted**, resets to cpp on restart (main.js:1702-1741 has no codingLanguage key) |
| 39 | Voice path uses skill prompts | ❌ | Voice uses a generic built-in filter prompt; the prompts/*.md skill files are never loaded on the voice path (llm.service.js:871-925) |

### 4.6 Windows & UI

| # | Feature | Verdict | Evidence |
|---|---|---|---|
| 40 | Draggable overlay + resize | ✅ | Drag region (index.html:35) + width-lock resize handler; windows moved/resized in live session |
| 41 | Window binding (windows move together) | ⚠️ | Works (live window-stats showed bound layout) — but **binding toggle IPC has no preload exposure and no UI**; always on |
| 42 | Window gap setting | ⚠️ | In Settings (settings.html:514) — **in-memory only, lost on restart** |
| 43 | Global shortcuts (full set) | ✅ | All 14 registered with handlers (main.js:440-467); Cmd+Shift+V crashes on destroyed windows (see §5.2) |
| 44 | Chat history persisted (localStorage) + clear | ✅ | Code-verified (chat.html:744-769); trash button wired |
| 45 | Onboarding wizard (first run) | ✅ | Wired end-to-end (main.js:321-340; complete-first-run writes sentinel); correctly skipped now (sentinel exists) |
| 46 | Whisper install via wizard | ⚠️ | Wired (whisper-installer.js + IPC) — untested (would download ~460 MB); model-size text contradicts itself (onboarding.html:911 "turbo ~150 MB" vs onboarding.js:367 "small ~461 MB") |
| 47 | Settings persist to .env | ✅ | Atomic write verified (main.js:1832-1896); live round-trip worked for LLM_PROVIDER/keys |
| 48 | Coding-language/skill/icon/gap persist | ❌ | Not written to .env (main.js:1674-1696) — all reset on restart |

## 5. Runtime failure map (log forensics)

### 5.1 Broken every single launch
- **`No Whisper CLI candidate succeeded after probing all fallbacks` → "Local Whisper unavailable"** — every session today. Speech is dead until Whisper is installed.
- **`azureConfigured: true, whisperConfigured: true`** in first-run status — placeholders (`your_azure_speech_key_here`) and a bare `WHISPER_COMMAND=whisper` string count as "configured" (first-run.js:89-98). The app *believes* speech is set up when it isn't.

### 5.2 Crash bugs (exceptions.log — historical, current-source status verified)
| Time | Trigger | Crash | Status in current source |
|---|---|---|---|
| Sep 16 13:58 | Dock/app activate (`onActivate`) | `TypeError: Object has been destroyed` at main.js:1569 (old line numbering) | Old code path replaced; current `onActivate` (main.js:1593-1609) still lacks an explicit `isDestroyed()` guard, but destroyed windows are removed from the map on destroy (window.manager.js:939) — residual low-risk gap |
| Sep 16 23:01 | **Cmd/Ctrl+Shift+V** (toggle visibility) | `TypeError: Object has been destroyed` at window.manager.js:1107 (`hideAllWindows`) | **FIXED** — current `hideAllWindows` guards `if (window.isDestroyed()) return;` (window.manager.js:1128); `showAllWindows` too (1110) |

### 5.5 Additional runtime issues (log forensics)
- **E8 — Screenshot double-trigger:** pressing the capture shortcut twice quickly logs `"Capture already in progress"` and drops the second capture (no debounce/queue on `triggerScreenshotOCR`).
- **E17 — LLM re-init bursts:** saving settings re-runs `initializeClient()` 4–7× within milliseconds (log 09:28:40.595-598) — harmless but noisy; reinit is not coalesced.
- **Retry storm (Sep 16 22:01–22:02):** with an invalid Gemini key + network failures, the retry ladder produced ~40 failure WARNs in 2 minutes while the user kept pressing the screenshot shortcut — no global backoff/rate-limit ceiling. Today's keys are valid; this amplifies any future outage.
- **Sentinel flapping (Sep 16 only):** first-run sentinel flip-flopped across early sessions; stable since (sentinel exists, `needsOnboarding:false` in all recent runs).
- **Session lifecycle:** 23/26 launches on Sep 17 ended without a shutdown log — nearly all were external kills (audit/harness restarts), not crashes; the 3 user-session runs ended cleanly.

### 5.3 DeepSeek image path (live, this audit's app session 09:33–09:35)
```
Screenshot capture completed (314ms, 259784 bytes, 720x900)
→ DeepSeek streaming attempt 1/2/3 failed: "Empty streamed response from DeepSeek API" (~20s each)
→ fallback to non-streaming: attempt 1/2/3 failed: "Empty response from DeepSeek API" (~20s each)
→ LLM image processing failed → canned fallback shown to user
```
Total user wait ≈ 2 minutes before a wrong, key-blaming message appears.

### 5.4 Chat UI state lie
Fresh launch (no speech) → chat window banner: **"Recording in Progress. press Alt+R to stop recording."** — CDP-observed. Speech is unavailable, nothing is recording; the banner state is stale/incorrect.

## 6. Root causes (the two load-bearing ones)

### 6.1 DeepSeek vision: reasoning burns the token budget
`deepseek-flash` streams a long `reasoning_content` phase before emitting answer `content`. The app's client only accumulates `delta.content` (deepseek.client.js:131-139) and caps requests with `maxOutputTokens: 4096` (config.js:68). On complex screenshots the reasoning phase consumes the entire budget, the API ends with `finish_reason: "length"` and **empty content**, and the client declares "Empty response".

**Proof (controlled experiment, this audit):** same image, same key, api.deepseek.com:
```
max_tokens=50            → finish=length | content_len=0 | reasoning_len=240 | 50 tokens used
max_tokens=4096          → finish=stop   | content_len=157 | reasoning_len=491 | 163 tokens used
```
A small test image needs ~163 tokens; a real 720×900 screenshot needs far more reasoning — the 4096 cap gets eaten before any answer.

**Fix validated (this audit):** two options tested against the live API:
```
max_tokens=50 + thinking:{"type":"disabled"} → finish=stop | content_len=150 | reasoning_len=0 | 36 tokens   ← BEST
no max_tokens                                 → finish=stop | content_len=157 | reasoning_len=607 | 179 tokens
```
Adding `thinking: {type: "disabled"}` to the request body (deepseek.client.js `buildChatBody`) eliminates the reasoning phase entirely — faster and cheaper for the whole app, not just vision. Also: stop the 6× retry storm on empty-content streams, and fix the fallback message — it blames the API key.

### 6.2 Speech: nothing installed + false-positive config
Two stacked problems: (a) Whisper was never installed (no `.venv-whisper`), and (b) first-run.js counts placeholders as configured, so no onboarding nags you to fix it — the app silently thinks speech works while the chat UI shows "Recording in Progress". **Fix:** run `./setup.sh` to install Whisper, and treat `your_*_here` placeholders / unverifiable `WHISPER_COMMAND` as unconfigured.

## 7. Independent verification (fresh-context refutation worker)

A fresh-context worker independently re-fetched all evidence for the 9 headline verdicts and attempted to refute each one:

| Verdict | Independent ruling |
|---|---|
| V1 streaming UI orphaned (no loaded renderer consumes chunks) | ✅ CONFIRMED (high confidence) |
| V2 screen-share auto-hide dead (zero callers, no OS detection) | ✅ CONFIRMED (high confidence) |
| V3 TTS dead code (zero callers of `speak()`) | ✅ CONFIRMED (high confidence) |
| V4 6 IPC channels without handlers | ✅ CONFIRMED (high confidence) |
| V5 coding language not persisted (resets to cpp) | ✅ CONFIRMED (high confidence) |
| V6 image path ignores session memory | ✅ CONFIRMED (high confidence) |
| V7 speech broken + placeholder false-positives in first-run status | ✅ CONFIRMED (high confidence) |
| V8 overlay skill chip hardcoded to 'dsa' | ✅ CONFIRMED (high confidence) |
| V9 text ask→answer loop works with DeepSeek | ✅ CONFIRMED (medium-high; verifier's two caveats resolved below) |

**Verifier's caveats on V9, resolved by this audit's direct DOM evidence:** (1) the literal question text isn't in the logs — true, but the CDP probe *sent* "What is 2+2? Answer in one word." and (2) the chat window was hidden when the answer rendered — true, but the CDP probe read the hidden window's rendered DOM directly: chat `.message-text` elements contained the exact user question and answer `"4"`, and the overlay body read `"AI Response × 4"`. So both renderings were directly observed, not inferred from broadcasts.

**Same-family limitation:** all workers ran on the same model family as the lead; the "independent" check is context-isolation + adversarial refutation, not cross-model diversity.

## 8. What actually works (so you know what you have)

- ✅ Typed questions → DeepSeek → correct answers in chat AND the floating overlay (with markdown/code blocks)
- ✅ Session memory for text/voice follow-ups; chat history in localStorage
- ✅ Settings → .env persistence (keys, provider, speech config)
- ✅ Stealth disguise ("Terminal" name/icon, accessory policy) and screen-share invisibility (your confirmation)
- ✅ Click-through toggle, window binding/movement, drag/resize, single-instance
- ✅ Skill switching via Settings + Cmd/Ctrl+↑/↓ (until restart); language injection in-session
- ✅ Fallback answers on failure (message text needs fixing)
- ✅ First-run onboarding, atomic .env writes, 35/35 unit tests

## 9. Fix roadmap (priority order)

| P | Fix | Effort |
|---|---|---|
| **P0** | DeepSeek vision: remove/raise `max_tokens` cap or disable reasoning for image requests; stop 6× retry storm; honest fallback message | ~1h |
| **P0** | Install Whisper (`./setup.sh`) + fix first-run placeholder false-positives + fix "Recording in Progress" stale banner | ~30 min + download |
| **P1** | Wire chunk rendering into chat.html/llm-response.html (subscriptions already exist in orphaned file — port them) | ~1h |
| **P1** | Persist codingLanguage, activeSkill, appIcon, windowGap to .env/settings | ~1h |
| **P1** | Add explicit `isDestroyed()` guard in `onActivate` (main.js:1593-1609); Cmd+Shift+V crash already fixed in source | ~15 min |
| **P2** | Overlay skill chip → cycle skills (not hardcoded dsa); add 'programming' to dropdowns | ~30 min |
| **P2** | Add the 6 missing IPC handlers (or remove dead preload entries); debounce screenshot shortcut ("Capture already in progress"); coalesce LLM re-init bursts | ~1h |
| **P2** | Wire screen-share detection or remove the feature claim from README; wire TTS or delete; area-capture UI | 1–2 days |
| **P2** | Delete dead code (chat-window.js, adjacent-to-test, empty fallback-capture.service.js); fix onboarding model-size text | ~1h |

---

*Audit artifacts: app logs `~/.screen-reader-util/logs/` (2026-09-17), proctor log `logs/mock-proctor-events.jsonl`, live probes `/tmp/cluely-probe.js`, `/tmp/cdp-probe.js`, `/tmp/cdp-probe2.js`.*
