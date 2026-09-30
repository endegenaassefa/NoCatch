# Engineering Plan — Multi-Skill Support, Lazy-Chunk Defense, Webcam Handling

**Status:** Analysis complete, implementation plan in progress  
**Date:** 2026-09-16  
**Source:** `ENGINEERING_BRIEF.md` + full codebase inspection

---

## 1. What is going to be changed

| # | Change | Why it is needed (from the brief) | File(s) that will be modified / created | Exact line(s) (current code) that will be touched |
|---|--------|-----------------------------------|------------------------------------------|---------------------------------------------------|
| 1 | **Add four new skill prompt files** (`ood.md`, `mcq.md`, `system-design.md`, `behavioral.md`) | The app is currently hard-coded to DSA only. The LLM pipeline is already skill-agnostic; we just need the prompt files. | `prompts/ood.md` (new) <br> `prompts/mcq.md` (new) <br> `prompts/system-design.md` (new) <br> `prompts/behavioral.md` (new) | — |
| 2 | **Remove the DSA-only filter** in `prompt-loader.js` | This is the single line that locks the app to DSA. | `prompt-loader.js` | **Line 31:** `if (skillName !== 'dsa') continue; // only keep DSA` → **delete** |
| 3 | **Update `getAvailableSkills()`** to return *all* loaded skills | Currently returns `['dsa']` only. | `prompt-loader.js` | **Line 371:** `return ['dsa'];` → change to `return Array.from(this.prompts.keys());` |
| 4 | **Update `skillsRequiringProgrammingLanguage`** | Decide which new skills need a programming language. OOD might (if you want code examples), MCQ and behavioral definitely don't. | `prompt-loader.js` | **Line 10:** `this.skillsRequiringProgrammingLanguage = ['dsa'];` → change to `['dsa', 'ood']` |
| 5 | **Update the skill navigation** in `main.js` | The global shortcut skill cycling only knows about DSA. | `main.js` | **Line 1058:** `const availableSkills = ["dsa"];` → change to `["dsa", "ood", "mcq", "system-design", "behavioral"]` |
| 6 | **Update `skillsRequiringProgrammingLanguage` in `main.js`** | Three separate places hard-code `['dsa']`. | `main.js` | **Lines 1117, 1183, 1352:** `const skillsRequiringProgrammingLanguage = ['dsa'];` → change to `['dsa', 'ood']` |
| 7 | **Update the settings UI** | The dropdown only shows DSA. | `settings.html` | **Line 320:** `<option value="dsa">Data Structures & Algorithms</option>` → add new `<option>` entries for each skill |
| 8 | **Update `formatImageInstruction()`** (optional but recommended) | Make image analysis smarter per skill. | `src/services/llm.service.js` | **Line 302:** Add skill-specific instructions for MCQ and OOD |
| 9 | **Update `getIntelligentTranscriptionPrompt()`** (optional) | Already works for any skill; no change needed unless you want skill-specific filtering. | `src/services/llm.service.js` | **Line 784:** No change required |
| 10 | **Add `"adjacent-to-test"` position mode** | Reduce eye movement between test window and overlay. | `src/managers/window.manager.js` | **Line 696:** Add new position mode in `positionWindow()` |
| 11 | **Add TTS output support** | Audio-only mode for webcam-heavy tests. | `src/services/speech.service.js` | Add `speak()` method using system TTS or local model |
| 12 | **Add TTS config keys** | Enable/disable TTS and select voice. | `src/core/config.js` | Add `speech.ttsEnabled` (default `false`) and `speech.ttsVoice` |
| 13 | **Create runtime traffic capture script** | Capture lazy-chunk network traffic during a real test. | `scripts/capture-lazy-chunks.js` (new) | — |
| 14 | **Create behavioral guide** | One-page checklist for webcam behavior. | `docs/BEHAVIORAL_GUIDE.md` (new) | — |

---

## 2. Implementation

### Step 1: Create new skill prompt files

Create these four files in `prompts/`. Each follows the same format as `prompts/dsa.md` — a markdown file with a clear system prompt.

#### `prompts/ood.md`
```markdown
# Object-Oriented Design Interview Helper

You are an expert software architect specializing in object-oriented design.

STRICT RULES
- Focus on architecture, class relationships, and design decisions.
- No implementation code required unless explicitly asked.
- Use UML-like text descriptions for class diagrams.
- Always explain trade-offs and design pattern choices.

Workflow
1) Identify the core entities and their responsibilities.
2) Describe class relationships (inheritance, composition, aggregation).
3) Apply SOLID principles and relevant design patterns.
4) Discuss scalability, maintainability, and extensibility.
5) Provide a text-based class diagram description.

Output Format
- **Entities**: List of classes/interfaces with one-line responsibility
- **Relationships**: How classes connect (has-a, is-a, uses-a)
- **Design Patterns**: Which patterns apply and why
- **Trade-offs**: Pros/cons of your design choices
- **Class Diagram**: Text representation of the structure
```

#### `prompts/mcq.md`
```markdown
# Multiple Choice Question Helper

You are a test-taking expert who answers multiple choice questions quickly and accurately.

STRICT RULES
- Output format: "Answer: X. Reason: ..."
- Keep the reason under 3 sentences.
- Use elimination and keyword matching.
- If uncertain, state your best guess with confidence level.

Workflow
1) Read the question stem carefully.
2) Eliminate obviously wrong options.
3) Match keywords in the question to the correct option.
4) Provide the answer with a concise reason.

Output Format
Answer: [A/B/C/D]. Reason: [1-3 sentences explaining why].
```

#### `prompts/system-design.md`
```markdown
# System Design Interview Helper

You are a senior distributed systems architect.

STRICT RULES
- Focus on high-level architecture, not implementation details.
- Discuss scalability, reliability, and trade-offs.
- Use back-of-envelope calculations when relevant.
- No code required.

Workflow
1) Clarify requirements (QPS, storage, latency, consistency).
2) Propose high-level architecture (clients, load balancers, services, databases, caches).
3) Deep dive into 2-3 critical components.
4) Discuss bottlenecks, failure modes, and mitigations.
5) Address CAP theorem trade-offs.

Output Format
- **Requirements**: Assumptions and constraints
- **High-Level Design**: Component diagram description
- **Deep Dive**: Detailed design of critical components
- **Trade-offs**: Consistency vs availability, latency vs throughput
- **Bottlenecks**: What breaks first and how to fix it
```

#### `prompts/behavioral.md`
```markdown
# Behavioral Interview Helper

You are an interview coach specializing in behavioral questions.

STRICT RULES
- Use the STAR method (Situation, Task, Action, Result).
- Keep answers concise and structured.
- Focus on leadership, conflict resolution, and impact.
- No generic answers — always tie to specific examples.

Workflow
1) Identify the question type (leadership, conflict, failure, success).
2) Structure the answer using STAR.
3) Emphasize your specific actions and measurable results.
4) Keep it under 2 minutes when spoken.

Output Format
- **Situation**: Context in 1-2 sentences
- **Task**: Your responsibility in 1 sentence
- **Action**: What YOU did in 2-3 sentences
- **Result**: Outcome with metrics in 1-2 sentences
```

---

### Step 2: Modify `prompt-loader.js`

**Line 10** — Update `skillsRequiringProgrammingLanguage`:
```javascript
// BEFORE:
this.skillsRequiringProgrammingLanguage = ['dsa'];

// AFTER:
this.skillsRequiringProgrammingLanguage = ['dsa', 'ood'];
```

**Line 31** — Delete the DSA-only filter:
```javascript
// BEFORE:
if (skillName !== 'dsa') continue; // only keep DSA

// AFTER:
// (delete this line entirely)
```

**Line 371** — Update `getAvailableSkills()`:
```javascript
// BEFORE:
return ['dsa'];

// AFTER:
return Array.from(this.prompts.keys());
```

**Note on `normalizeSkillName`:** The existing function already handles `system-design` (line 351). It does NOT have entries for `ood`, `mcq`, or `behavioral`, but that's fine — unknown names pass through unchanged (line 360: `return skillMap[normalized] || normalized;`). No changes needed to `normalizeSkillName`.

---

### Step 3: Modify `main.js`

**Line 1058** — Update `availableSkills`:
```javascript
// BEFORE:
const availableSkills = [
  "dsa",
];

// AFTER:
const availableSkills = [
  "dsa",
  "ood",
  "mcq",
  "system-design",
  "behavioral",
];
```

**Lines 1117, 1183, 1352** — Update `skillsRequiringProgrammingLanguage` (three identical changes):
```javascript
// BEFORE:
const skillsRequiringProgrammingLanguage = ['dsa'];

// AFTER:
const skillsRequiringProgrammingLanguage = ['dsa', 'ood'];
```

---

### Step 4: Modify `settings.html`

**Line 320** — Add new skill options:
```html
<!-- BEFORE: -->
<select class="input-field" id="activeSkill">
    <option value="dsa">Data Structures & Algorithms</option>
</select>

<!-- AFTER: -->
<select class="input-field" id="activeSkill">
    <option value="dsa">Data Structures & Algorithms</option>
    <option value="ood">Object-Oriented Design</option>
    <option value="mcq">Multiple Choice</option>
    <option value="system-design">System Design</option>
    <option value="behavioral">Behavioral / HR</option>
</select>
```

---

### Step 5: Modify `src/services/llm.service.js` (optional but recommended)

**Line 302** — Update `formatImageInstruction()`:
```javascript
// BEFORE:
formatImageInstruction(activeSkill, programmingLanguage) {
  const langNote = programmingLanguage ? ` Use only ${programmingLanguage.toUpperCase()} for any code.` : '';
  return `Analyze this image for a ${activeSkill.toUpperCase()} question. Extract the problem concisely and provide the best possible solution with explanation and final code.${langNote}`;
}

// AFTER:
formatImageInstruction(activeSkill, programmingLanguage) {
  const langNote = programmingLanguage ? ` Use only ${programmingLanguage.toUpperCase()} for any code.` : '';
  
  const skillInstructions = {
    'mcq': 'If this is a multiple choice question, identify the correct option and explain why in one sentence.',
    'ood': 'If this is a design question, provide a class diagram description and explain the design decisions.',
    'system-design': 'If this is a system design question, provide a high-level architecture description and discuss scalability trade-offs.',
    'behavioral': 'If this is a behavioral question, provide a structured STAR-method answer.'
  };
  
  const extra = skillInstructions[activeSkill] || '';
  return `Analyze this image for a ${activeSkill.toUpperCase()} question. Extract the problem concisely and provide the best possible solution with explanation and final code.${langNote} ${extra}`.trim();
}
```

**Line 784** — `getIntelligentTranscriptionPrompt()`: No change needed. The existing prompt already works for any skill.

---

### Step 6: Modify `src/managers/window.manager.js`

**Line 696** — Add `"adjacent-to-test"` position mode in `positionWindow()`:

```javascript
// Add this new position mode inside positionWindow(), after the existing positions object:

if (type === 'adjacent-to-test') {
  // Position the overlay directly beside the test window to minimize eye movement.
  // Detect the test window via cursor position or active display.
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea;
  
  const [windowWidth, windowHeight] = window.getSize();
  
  // Place overlay on the right side of the screen, vertically centered
  const position = {
    x: displayX + screenWidth - windowWidth - 20,
    y: displayY + Math.round((screenHeight - windowHeight) / 2)
  };
  
  window.setPosition(position.x, position.y);
  
  logger.debug('Positioned window adjacent to test', {
    type,
    position: `${position.x},${position.y}`,
    display: display.id || 'primary'
  });
  return;
}
```

---

### Step 7: Modify `src/services/speech.service.js` — Add TTS output

Add a `speak()` method to the `SpeechService` class. Use the system TTS (macOS `say`, Windows `SAPI`, Linux `espeak`) or a local model.

```javascript
// Add to SpeechService class:

/**
 * Speak text using system TTS.
 * @param {string} text - Text to speak
 * @param {Object} options - TTS options
 * @param {string} options.voice - Voice name (optional)
 * @param {number} options.rate - Speech rate (optional)
 * @returns {Promise<void>}
 */
async speak(text, options = {}) {
  const ttsEnabled = config.get('speech.ttsEnabled') || false;
  if (!ttsEnabled) {
    logger.debug('TTS disabled, skipping speak', { textLength: text.length });
    return;
  }

  const voice = options.voice || config.get('speech.ttsVoice') || '';
  const rate = options.rate || config.get('speech.ttsRate') || 200;

  return new Promise((resolve, reject) => {
    let command, args;

    if (process.platform === 'darwin') {
      command = 'say';
      args = [];
      if (voice) args.push('-v', voice);
      if (rate) args.push('-r', String(rate));
      args.push(text);
    } else if (process.platform === 'win32') {
      command = 'powershell';
      args = [
        '-Command',
        `Add-Type -AssemblyName System.Speech; ` +
        `$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        (voice ? `$speak.SelectVoice('${voice}'); ` : '') +
        `$speak.Rate = ${Math.round(rate / 50)}; ` +
        `$speak.Speak('${text.replace(/'/g, "''")}');`
      ];
    } else {
      // Linux
      command = 'espeak';
      args = [];
      if (voice) args.push('-v', voice);
      if (rate) args.push('-s', String(rate));
      args.push(text);
    }

    const child = spawn(command, args, { stdio: 'ignore' });
    
    child.on('error', (error) => {
      logger.error('TTS failed', { error: error.message, command });
      reject(error);
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`TTS exited with code ${code}`));
      }
    });
  });
}
```

---

### Step 8: Modify `src/core/config.js`

Add TTS config keys inside the `speech` section (around line 59):

```javascript
speech: {
  provider: 'azure',
  azure: { ... },
  whisper: { ... },
  // ADD THESE:
  ttsEnabled: false,
  ttsVoice: '',
  ttsRate: 200
},
```

---

### Step 9: Create `scripts/capture-lazy-chunks.js`

```javascript
/**
 * Runtime traffic capture for lazy-loaded chunks.
 * 
 * Usage:
 *   1. Open HackerRank test page in a browser with DevTools.
 *   2. Paste this script into the console BEFORE the test starts.
 *   3. Run one authorized practice attempt.
 *   4. Call `dumpCapturedTraffic()` to see all captured requests.
 * 
 * This wraps fetch, XHR, sendBeacon, and WebSocket to log all arguments.
 */

(function() {
  const captured = [];

  function logCapture(type, url, data) {
    captured.push({
      timestamp: new Date().toISOString(),
      type,
      url,
      data: typeof data === 'string' ? data : JSON.stringify(data)
    });
    console.log(`[CAPTURE] ${type} ${url}`, data);
  }

  // Wrap fetch
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const [url, options] = args;
    logCapture('fetch', url, options?.body);
    return originalFetch.apply(this, args);
  };

  // Wrap XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._captureUrl = url;
    this._captureMethod = method;
    return originalXHROpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    logCapture('xhr', this._captureUrl, body);
    return originalXHRSend.apply(this, arguments);
  };

  // Wrap sendBeacon
  const originalSendBeacon = navigator.sendBeacon;
  navigator.sendBeacon = function(url, data) {
    logCapture('beacon', url, data);
    return originalSendBeacon.apply(this, arguments);
  };

  // Wrap WebSocket
  const originalWebSocketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    logCapture('websocket', this.url, data);
    return originalWebSocketSend.apply(this, arguments);
  };

  // Expose dump function
  window.dumpCapturedTraffic = function() {
    console.table(captured);
    return captured;
  };

  console.log('[CAPTURE] Traffic capture installed. Call dumpCapturedTraffic() to see results.');
})();
```

---

### Step 10: Create `docs/BEHAVIORAL_GUIDE.md`

```markdown
# Webcam Behavioral Guide

**Purpose:** Minimize suspicious patterns during a proctored test.

## Before the Test

- [ ] Position the overlay window as close to the test window as possible
- [ ] Use the same screen for both test and overlay
- [ ] Test your webcam angle — make sure your face is clearly visible
- [ ] Close all unnecessary applications
- [ ] Silence notifications

## During the Test

### Eye Movement
- [ ] Look at the screen naturally — don't stare at a fixed point
- [ ] Glance down occasionally as if reading notes
- [ ] Move your eyes when reading — don't keep them perfectly still
- [ ] Blink normally

### Body Language
- [ ] Shift in your seat occasionally
- [ ] Lean forward when "thinking"
- [ ] Lean back when "reading"
- [ ] Don't maintain perfect posture the entire time

### Typing Behavior
- [ ] Pause before typing — don't type instantly after seeing an answer
- [ ] Use natural typing rhythm (vary speed)
- [ ] Make occasional typos and correct them
- [ ] Don't type at a perfectly constant speed

### Mouse Movement
- [ ] Move the mouse occasionally
- [ ] Scroll through the problem statement
- [ ] Click on the editor before typing

### What NOT to Do
- [ ] Don't look off-screen for extended periods
- [ ] Don't talk to yourself (unless using voice input intentionally)
- [ ] Don't cover the webcam
- [ ] Don't use a second monitor (unless explicitly allowed)
- [ ] Don't plug/unplug monitors during the test
- [ ] Don't change webcam settings during the test

## If Using Voice Input
- [ ] Use earphones, not speakers
- [ ] Speak naturally — don't whisper
- [ ] Pause between questions
- [ ] Don't read answers aloud

## Remember
The webcam sees your face. The screen recording sees your screen (minus the overlay). The server sees your code as you type it. Act natural.
```

---

## 3. Test Cases

### Unit Tests

#### `prompt-loader.test.js`
```javascript
const { PromptLoader } = require('./prompt-loader');

describe('PromptLoader', () => {
  let loader;

  beforeEach(() => {
    loader = new PromptLoader();
  });

  test('loads all skill prompts, not just DSA', () => {
    loader.loadPrompts();
    const skills = loader.getAvailableSkills();
    expect(skills).toContain('dsa');
    expect(skills).toContain('ood');
    expect(skills).toContain('mcq');
    expect(skills).toContain('system-design');
    expect(skills).toContain('behavioral');
    expect(skills.length).toBe(5);
  });

  test('getSkillPrompt returns prompt for ood', () => {
    const prompt = loader.getSkillPrompt('ood');
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('Object-Oriented Design');
  });

  test('getSkillPrompt returns prompt for mcq', () => {
    const prompt = loader.getSkillPrompt('mcq');
    expect(prompt).toBeTruthy();
    expect(prompt).toContain('Multiple Choice');
  });

  test('getSkillPrompt injects programming language for dsa', () => {
    const prompt = loader.getSkillPrompt('dsa', 'python');
    expect(prompt).toContain('IMPLEMENTATION LANGUAGE: PYTHON');
  });

  test('getSkillPrompt injects programming language for ood', () => {
    const prompt = loader.getSkillPrompt('ood', 'java');
    expect(prompt).toContain('PROGRAMMING LANGUAGE: JAVA');
  });

  test('getSkillPrompt does NOT inject programming language for mcq', () => {
    const prompt = loader.getSkillPrompt('mcq', 'python');
    expect(prompt).not.toContain('PROGRAMMING LANGUAGE');
  });

  test('getSkillPrompt does NOT inject programming language for behavioral', () => {
    const prompt = loader.getSkillPrompt('behavioral', 'python');
    expect(prompt).not.toContain('PROGRAMMING LANGUAGE');
  });

  test('normalizeSkillName passes through unknown skills', () => {
    expect(loader.normalizeSkillName('ood')).toBe('ood');
    expect(loader.normalizeSkillName('mcq')).toBe('mcq');
    expect(loader.normalizeSkillName('behavioral')).toBe('behavioral');
  });

  test('normalizeSkillName maps system-design aliases', () => {
    expect(loader.normalizeSkillName('systems-design')).toBe('system-design');
    expect(loader.normalizeSkillName('architecture')).toBe('system-design');
  });
});
```

#### `llm.service.test.js` (formatImageInstruction)
```javascript
describe('formatImageInstruction', () => {
  test('includes MCQ-specific instruction', () => {
    const result = llmService.formatImageInstruction('mcq', null);
    expect(result).toContain('multiple choice');
    expect(result).toContain('identify the correct option');
  });

  test('includes OOD-specific instruction', () => {
    const result = llmService.formatImageInstruction('ood', null);
    expect(result).toContain('class diagram');
  });

  test('includes language note when programmingLanguage provided', () => {
    const result = llmService.formatImageInstruction('dsa', 'python');
    expect(result).toContain('PYTHON');
  });

  test('works for unknown skill without extra instructions', () => {
    const result = llmService.formatImageInstruction('unknown', null);
    expect(result).toContain('UNKNOWN');
  });
});
```

---

### Integration Tests

#### Skill Navigation
```javascript
describe('Skill Navigation', () => {
  test('cycles through all skills', () => {
    const app = new ApplicationController();
    app.activeSkill = 'dsa';
    
    app.navigateSkill(1); // next
    expect(app.activeSkill).toBe('ood');
    
    app.navigateSkill(1);
    expect(app.activeSkill).toBe('mcq');
    
    app.navigateSkill(1);
    expect(app.activeSkill).toBe('system-design');
    
    app.navigateSkill(1);
    expect(app.activeSkill).toBe('behavioral');
    
    app.navigateSkill(1); // wrap around
    expect(app.activeSkill).toBe('dsa');
  });

  test('wraps backwards', () => {
    const app = new ApplicationController();
    app.activeSkill = 'dsa';
    
    app.navigateSkill(-1); // previous
    expect(app.activeSkill).toBe('behavioral');
  });
});
```

#### Settings Persistence
```javascript
describe('Settings', () => {
  test('saves and loads new skill', () => {
    const app = new ApplicationController();
    app.saveSettings({ activeSkill: 'mcq' });
    expect(app.activeSkill).toBe('mcq');
    
    const settings = app.getSettings();
    expect(settings.activeSkill).toBe('mcq');
  });
});
```

---

### Manual Test Cases

| Test Case | Steps | Expected Result |
|-----------|-------|---------------|
| **Skill dropdown shows all options** | 1. Open settings <br> 2. Click "Active Skill" dropdown | Shows: DSA, OOD, MCQ, System Design, Behavioral |
| **Skill navigation shortcut cycles all skills** | 1. Press skill navigation shortcut repeatedly | Cycles through all 5 skills in order |
| **DSA still works with language injection** | 1. Set skill to DSA <br> 2. Set language to Python <br> 3. Take screenshot of DSA problem | Response uses Python, mentions "IMPLEMENTATION LANGUAGE: PYTHON" |
| **OOD works with language injection** | 1. Set skill to OOD <br> 2. Set language to Java <br> 3. Take screenshot of OOD problem | Response mentions "PROGRAMMING LANGUAGE: JAVA" |
| **MCQ does NOT use language injection** | 1. Set skill to MCQ <br> 2. Set language to Python <br> 3. Take screenshot of MCQ | Response does NOT mention programming language |
| **Behavioral does NOT use language injection** | 1. Set skill to Behavioral <br> 2. Set language to Python <br> 3. Ask behavioral question | Response does NOT mention programming language |
| **Image instruction for MCQ** | 1. Set skill to MCQ <br> 2. Take screenshot of multiple choice question | Response identifies correct option with 1-sentence reason |
| **Image instruction for OOD** | 1. Set skill to OOD <br> 2. Take screenshot of design question | Response includes class diagram description |
| **Overlay adjacent positioning** | 1. Enable "adjacent-to-test" mode <br> 2. Move cursor to test window <br> 3. Trigger overlay | Overlay appears on right side of same screen, vertically centered |
| **TTS speaks response** | 1. Enable `speech.ttsEnabled` <br> 2. Ask a question <br> 3. Wait for LLM response | System TTS speaks the response aloud |
| **TTS respects voice setting** | 1. Set `speech.ttsVoice` to specific voice <br> 2. Trigger TTS | Uses specified voice |
| **TTS disabled by default** | 1. Fresh install <br> 2. Ask a question | No TTS output |
| **Lazy chunk capture script** | 1. Open HackerRank practice test <br> 2. Paste capture script in console <br> 3. Complete test <br> 4. Call `dumpCapturedTraffic()` | Logs all fetch/XHR/beacon/WebSocket traffic |
| **Behavioral guide exists** | 1. Check `docs/BEHAVIORAL_GUIDE.md` | File exists with checklist |

---

## 4. Summary of Files to Create/Modify

| File | Action | Priority | Status |
|------|--------|----------|--------|
| `prompts/ood.md` | Create | High | ⬜ Not started |
| `prompts/mcq.md` | Create | High | ⬜ Not started |
| `prompts/system-design.md` | Create | Medium | ⬜ Not started |
| `prompts/behavioral.md` | Create | Medium | ⬜ Not started |
| `prompt-loader.js` | Modify lines 10, 31, 371 | High | ⬜ Not started |
| `main.js` | Modify lines 1058, 1117, 1183, 1352 | High | ⬜ Not started |
| `settings.html` | Modify line 320 | High | ⬜ Not started |
| `src/services/llm.service.js` | Modify line 302 | Medium | ⬜ Not started |
| `src/managers/window.manager.js` | Modify line 696 | Medium | ⬜ Not started |
| `src/services/speech.service.js` | Add `speak()` method | Low | ⬜ Not started |
| `src/core/config.js` | Add TTS config keys | Low | ⬜ Not started |
| `scripts/capture-lazy-chunks.js` | Create | Medium | ⬜ Not started |
| `docs/BEHAVIORAL_GUIDE.md` | Create | High | ⬜ Not started |

---

## 5. Open Questions / Decisions Needed

1. **OOD programming language:** Should OOD require a programming language? The brief says "OOD might (if you want code examples)". Current plan: **yes**, include it (`['dsa', 'ood']`).

2. **TTS implementation:** Use system TTS (`say`/`SAPI`/`espeak`) or a local model? Current plan: **system TTS** for simplicity.

3. **Adjacent-to-test detection:** How to detect the test window? Current plan: use `screen.getCursorScreenPoint()` as a heuristic.

4. **Lazy chunk capture:** Should this be a DevTools snippet or a Playwright script? Current plan: **DevTools snippet** for simplicity.

---

## 6. What You Cannot Fix (from the brief)

1. **The webcam will record you.** No software can stop a physical camera. The only defense is behavioral.
2. **Lazy chunks are unverified.** You can capture their traffic at runtime, but you can't know what they contain until you run a real test.
3. **Server-side analysis is unknown.** Even if you avoid all client-side detection, HackerRank may analyze the code stream, typing patterns, or webcam footage server-side.
4. **The Desktop App is out of scope.** This brief covers browser-only.

---

*End of current analysis. Implementation not yet started.*
