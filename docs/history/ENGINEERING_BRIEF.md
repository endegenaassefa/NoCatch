# Engineering Brief — Multi-Skill Support, Lazy-Chunk Defense, Webcam Handling

**Date:** 2026-09-16
**Audience:** Coding agents implementing tonight
**Scope:** Browser-only HackerRank (no Desktop App)

---

## 1. Can it handle different question types? (Yes, but you have to build it)

**Current state:** The app is **hard-coded to DSA only**. The prompt system is a plugin architecture, but someone deliberately locked it to one skill.

**The good news:** The LLM pipeline is **already skill-agnostic**. `processImageWithSkillStream`, `processTextWithSkillStream`, and `processTranscriptionWithIntelligentResponseStream` all take `activeSkill` as a parameter and call `promptLoader.getSkillPrompt(activeSkill, programmingLanguage)`. If you add a new skill file and remove the filter, it works automatically.

**What needs to change:**

### A. Add new skill prompt files

Create these files in `prompts/`:

| File | Purpose | System prompt focus |
|------|---------|---------------------|
| `prompts/ood.md` | Object-Oriented Design | Class diagrams, SOLID principles, design patterns, trade-off analysis. No code required — focus on architecture and reasoning. |
| `prompts/mcq.md` | Multiple Choice | Fast elimination, keyword matching, conceptual clarity. Output format: "Answer: X. Reason: ..." Keep it under 3 sentences. |
| `prompts/system-design.md` | System Design | Scalability, load balancing, caching, database sharding, CAP theorem. High-level architecture, not implementation. |
| `prompts/behavioral.md` | Behavioral / HR | STAR method, leadership principles, conflict resolution. Concise, structured answers. |

**Direction:** Each file should follow the same format as `prompts/dsa.md` — a markdown file with a clear system prompt. The `prompt-loader.js` will load them automatically once you remove the filter.

### B. Remove the DSA-only filter

**File:** `prompt-loader.js`

- **Line 31:** `if (skillName !== 'dsa') continue; // only keep DSA` — **delete this line**. This is the single line that locks the app to DSA.
- **Line 371:** `return ['dsa'];` — change to `return Array.from(this.prompts.keys());` so it returns all loaded skills.
- **Line 10:** `this.skillsRequiringProgrammingLanguage = ['dsa'];` — decide which new skills need a programming language. OOD might (if you want code examples), MCQ and behavioral definitely don't. Update this array accordingly.

### C. Update the skill navigation

**File:** `main.js`

- **Line 1058:** `const availableSkills = ["dsa"];` — change to include all new skills: `["dsa", "ood", "mcq", "system-design", "behavioral"]`.
- **Lines 1117, 1183, 1352:** `const skillsRequiringProgrammingLanguage = ['dsa'];` — update to match the array in `prompt-loader.js`. If OOD needs language context, add it here.

### D. Update the settings UI

**File:** `settings.html`

- **Line 320:** `<option value="dsa">Data Structures & Algorithms</option>` — add new `<option>` entries for each skill. The `value` must match the filename (without `.md`).

### E. Update the image instruction (optional but recommended)

**File:** `src/services/llm.service.js`

- **Line 302:** `formatImageInstruction()` currently says `"Analyze this image for a ${activeSkill.toUpperCase()} question."` — this works for any skill, but you can make it smarter. For MCQ, add: `"If this is a multiple choice question, identify the correct option and explain why in one sentence."` For OOD: `"If this is a design question, provide a class diagram description and explain the design decisions."`

### F. Update the intelligent transcription prompt (optional)

**File:** `src/services/llm.service.js`

- **Line 784:** `getIntelligentTranscriptionPrompt()` says `"Assume you are asked a question in ${activeSkill.toUpperCase()} mode."` — this works for any skill. No change needed unless you want skill-specific filtering.

---

## 2. What else can we prevent against lazy-loaded chunks?

**What we know:** The research (`browser_level_capture.md` §9) says the post-login attempt page loads **lazy chunks** that are only served to an authenticated session. These chunks contain:
- Tab-switch enforcement UI
- Proctor upload loop
- `J.yR` default proctor interval constant
- `v.UD` paste truncation length constant

**What we don't know:** The exact contents of these chunks. They could contain additional event types, new endpoints, or anti-debugging traps.

**What we CAN do defensively:**

### A. Runtime traffic capture (the only way to see what's actually sent)

**Direction:** The research already proves that the public bundles send events to `/candidate/api/v1/events` and `/candidate/api/v1/keystrokes`. The lazy chunks will use the **same endpoints** (they're part of the same app). So if you intercept the actual network traffic during a real test, you'll see whatever new fields or event types the lazy chunks introduce.

**How to do it:** Use the API-boundary wrapper method described in `browser_level_capture.md` §8 method 2. Before the test page loads, wrap `window.fetch`, `XMLHttpRequest.prototype.send`, `navigator.sendBeacon`, and `WebSocket.prototype.send` to log all arguments. Run one authorized practice attempt and dump every request/response body. Compare against the known event enum to discover new event types.

**File to create:** `scripts/capture-lazy-chunks.js` — a DevTools snippet or Playwright script that automates this.

### B. Assume the worst-case event set

**Direction:** Even without seeing the lazy chunks, you can defend against the **known** event types plus reasonable extrapolations:

| Known event | Likely lazy-chunk addition | Defense |
|-------------|---------------------------|---------|
| `BLUR`/`FOCUS` | More granular focus tracking (e.g., `WINDOW_MINIMIZE`, `TAB_SWITCH_TO_DEVTOOLS`) | Keep overlay `focusable: false`; never let it steal focus |
| `PASTE` | Paste detection with longer truncation, or paste from external apps | Never paste into the test page; use synthetic typing only |
| `EXIT_FULLSCREEN` | Full-screen exit with reason codes | Keep test tab in full-screen; overlay must not trigger exit |
| `MULTIPLE_MONITOR_DETECTION` | Monitor hot-plug detection during test | Don't plug/unplug monitors during test |
| `WEBCAM_SWITCH` | Webcam resolution change detection | Don't change webcam settings during test |
| `FIRST_TYPE`/`MULTI_LINE_DELETE` | Typing speed analysis, keystroke dynamics | Use human-like typing delays (50-150ms random) |

### C. Anti-debugging traps

**Direction:** The research verified **no anti-debugging traps** in the public bundles. But the lazy chunks might add them. Common traps:
- `debugger;` statements that pause execution when DevTools is open
- `Function.prototype.toString` checks to detect wrapped functions
- Timing checks to detect breakpoints

**Defense:** If you use the API-boundary wrapper, use `Runtime.evaluateOnNewDocument` (Playwright) or a `document_start` content script (extension) to install wrappers **before** any page script runs. This bypasses most `toString` checks because the wrapper is installed before the page's own code.

---

## 3. What can we do about the webcam?

**The reality:** You will be recorded. The webcam is pointed at your face. No software can stop the physical camera feed without breaking HackerRank's own permission prompt (which would likely disqualify you or flag an error).

**What you CAN do:**

### A. Behavioral mimicry (the only real defense)

**Direction:** Act like a human taking a test. The webcam captures video, but the **analysis** is done by AI (Amazon Rekognition, Google Gemini) looking for suspicious patterns. Avoid these patterns:

| Suspicious pattern | What to do instead |
|-------------------|-------------------|
| Staring at a fixed point (the overlay) | Look at the screen naturally; glance down occasionally as if reading notes |
| No eye movement | Move your eyes naturally; blink; look at the keyboard occasionally |
| Perfect posture | Shift in your seat; lean forward when thinking; lean back when reading |
| Instant typing after seeing answer | Pause; look at the screen as if thinking; type with natural rhythm |
| No mouse movement | Move the mouse occasionally; scroll; click on the editor |

**File to create:** `docs/BEHAVIORAL_GUIDE.md` — a one-page checklist for the user to review before the test.

### B. Overlay positioning (reduce eye movement)

**Direction:** Position the overlay **as close to the test window as possible** so eye movement between the test and the overlay is minimal. If the overlay is on the same screen and near the test window, the webcam sees natural eye movement, not suspicious side-to-side glances.

**File:** `src/managers/window.manager.js`

- **Line 696:** `positionWindow()` — add a new position mode `"adjacent-to-test"` that places the overlay window directly beside the test window (detected via `screen.getCursorScreenPoint()` or `screen.getDisplayNearestPoint()`).

### C. Audio-only mode (no visual overlay)

**Direction:** If the test has a webcam, consider using **voice input + audio output** instead of a visual overlay. The user speaks the question, the AI responds with text-to-speech through earphones. No visual overlay means no suspicious eye movement.

**File:** `src/services/speech.service.js`

- The service already supports audio input (Whisper). Add **text-to-speech output** using the system TTS or a local model. Add a config option `speech.ttsEnabled` (default `false`).

**File:** `src/core/config.js`

- Add `speech.ttsEnabled` and `speech.ttsVoice` config keys.

### D. Screen recording vs. webcam

**Direction:** The research shows HackerRank captures **screenshots** (screen recording) and **webcam images** separately. The overlay is already protected from screen recording via `setContentProtection(true)`. The webcam is a separate physical device — you can't hide from it, but you can make sure the overlay doesn't appear in the **screen recording** (already done) and that your **behavior** on webcam looks natural.

---

## 4. Summary of files to create/modify

| File | Action | Priority |
|------|--------|----------|
| `prompts/ood.md` | Create | High |
| `prompts/mcq.md` | Create | High |
| `prompts/system-design.md` | Create | Medium |
| `prompts/behavioral.md` | Create | Medium |
| `prompt-loader.js` | Remove DSA-only filter (line 31); update `getAvailableSkills()` (line 371); update `skillsRequiringProgrammingLanguage` (line 10) | High |
| `main.js` | Update `availableSkills` (line 1058); update `skillsRequiringProgrammingLanguage` (lines 1117, 1183, 1352) | High |
| `settings.html` | Add new skill options (line 320) | High |
| `src/services/llm.service.js` | Update `formatImageInstruction()` (line 302) for skill-specific instructions | Medium |
| `src/managers/window.manager.js` | Add `"adjacent-to-test"` position mode (line 696) | Medium |
| `src/services/speech.service.js` | Add TTS output support | Low |
| `src/core/config.js` | Add `speech.ttsEnabled`, `speech.ttsVoice` | Low |
| `scripts/capture-lazy-chunks.js` | Create runtime traffic capture script | Medium |
| `docs/BEHAVIORAL_GUIDE.md` | Create webcam behavior checklist | High |

---

## 5. What you cannot fix

1. **The webcam will record you.** No software can stop a physical camera. The only defense is behavioral.
2. **Lazy chunks are unverified.** You can capture their traffic at runtime, but you can't know what they contain until you run a real test.
3. **Server-side analysis is unknown.** Even if you avoid all client-side detection, HackerRank may analyze the code stream, typing patterns, or webcam footage server-side.
4. **The Desktop App is out of scope.** This brief covers browser-only. The Desktop App has additional OS-level capabilities that are not fully documented.

---

## 6. Final warning

This refactor will make OpenCluely significantly more versatile (multiple question types) and slightly safer (better overlay positioning, behavioral guidance). It will **not** make you invisible. The webcam sees your face. The screen recording sees your screen (minus the overlay). The server sees your code as you type it. The only question is whether HackerRank's AI analysis flags your behavior as suspicious. Act natural, and you reduce that risk. There is no zero-risk option.
