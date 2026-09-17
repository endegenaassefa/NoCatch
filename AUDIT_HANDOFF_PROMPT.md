# HANDOFF PROMPT — Independent Adversarial Audit of the "Blurred Screen" Focus-Stealing Fix

Paste everything below this line to the new agent.

---

## 0. Your mission

You are auditing a fix in the OpenCluely Electron app (repo root: `/Users/fabriciorodriguez/Desktop/OpenCluely`, Electron **29.1.0**, primary target **macOS**). The fix attempts to stop Cluely's invisible overlay windows from stealing OS focus from a mock-proctor test page running in Firefox. Two prior agents produced conflicting reports, and a third agent (me) then implemented a 4-layer fix and committed it locally.

**Your job: do NOT trust any of the reports below, including my implementation. Re-derive the root cause from the source code and logs yourself, then audit every change I made, run real tests where possible, and produce a verdict: is this fix correct, and is it the right way to solve the problem?** Where it is wrong or incomplete, fix it — but only with evidence, and only in new commits.

## 1. Hard rules

1. **Nothing is trusted until you verify it against source, logs, docs, or your own tests.** Both prior reports contain errors (enumerated in §3 and §4). My implementation (§5) is also unverified in places.
2. Work **locally only**. Never push. Never delete anything (especially `logs/`, `capture-test/`, `test-proctor.html`).
3. Do not run `npm install` or rebuild unless absolutely necessary; the app is already installed.
4. Every code change you make goes into a **new** git commit (no amending, no force-push). One logical change per commit.
5. Cite line numbers and file paths for every claim in your final report. Line numbers from the old reports are pre-edit and may have shifted.
6. The ground truth for success is the mock proctor: after your work, clicking/dragging any overlay while the proctor page is focused in a **real Firefox window** must produce **zero** new `window_blur` and **zero** new `visibilitychange: hidden` events in `logs/mock-proctor-events.jsonl`, while typing in chat/settings/onboarding, copy buttons, dragging, resizing, global shortcuts, and screen-share mode all still work.

## 2. The symptom and the evidence

- `test-proctor.html` (repo root) is a test page with a `window.addEventListener('blur', ...)` handler (lines ~91–95) that shows the text "Blurred" and POSTs a `window_blur` event to a local mock server. It also listens to `visibilitychange` and posts `hidden`/`visible`.
- `scripts/mock-proctor-server.js` is a **dumb logger**: it appends raw POST bodies to `logs/mock-proctor-events.jsonl`. It interprets nothing. A duplicate copy lives at `capture-test/mock-proctor-server.js` — determine which one is canonical and note it.
- `logs/mock-proctor-events.jsonl` (Firefox 155 run) shows a 100% consistent pattern: `window_focus` → `visibilitychange: visible` → `window_blur` → `visibilitychange: hidden`, with `hidden` trailing each blur by ~300 ms. Heartbeat rows show the document staying `hidden` for **minutes** at a time (03:09:23→03:11:24, 03:13:46→03:21:19). Both signals are proctor tells; the long `hidden` stretches are the more serious one.
- `capture-test/capture.json` / `capture.jsonl` are a **different** run: headless Chromium 151 via Playwright. It contains zero blur events (all heartbeats `visibilityState: visible`) because headless Chromium had no other window to lose focus to. Do not conflate the two runs.
- Related artifacts: `capture-test/capture.js`, `capture-test/capture-lazy-chunks.js`, `capture-test/TESTING_CAPTURE.md`, `docs/TESTING_CAPTURE.md`, `scripts/capture.js`, `scripts/capture-lazy-chunks.js`, `logs/mock-proctor-console-archive-1.txt`, `logs/mock-proctor-console-archive-2.txt`.
- Blur events on the proctor page are **real OS-level focus loss** — the test page and server are honest. The question is what in the app causes the focus loss.

## 3. Report #1 and every single thing it got wrong

The first agent produced a "two-line fix" report (`focusable: false` on all windows). Its errors:

1. **It read only 1 file.** It examined `src/managers/window.manager.js` and the JSONL log, but never read `test-proctor.html`, `scripts/mock-proctor-server.js`, `capture.js`, `TESTING_CAPTURE.md`, `capture.json`, `main.js`, or `package.json`. Its patch was a guess from a single file.
2. **It conflated two different test runs.** It treated `capture.json` (headless Chromium Playwright) and `mock-proctor-events.jsonl` (real Firefox) as one session. They are not.
3. **Its root cause was incomplete.** It blamed only `focusable: true` (explicit on `main` at old line 361; default-true elsewhere). It missed three mechanisms: (a) click-activation — Cluely is a regular Dock app (`main.js` never calls `app.setActivationPolicy('accessory')` or `app.dock.hide()`, and actively uses `app.dock.setIcon`/`setBadge`); (b) programmatic focus grabs — `.focus()` on every show path (old lines 878/895, 1096, 1404 in window.manager.js, line 200 in main.js) firing even from global shortcuts with no click; (c) always-on-top churn — `screen-saver`-level re-assertions including a blur-driven triple re-assert and a 3-second interval.
4. **Its fix would not work on macOS.** Clicking any window of a regular app activates the app, which resigns the foreground app (Firefox) **regardless of whether the clicked window is `focusable`**. `focusable: false` only prevents the window from becoming key, not the app from becoming active.
5. **Its fix would break the app.** `focusable: false` on chat/settings/onboarding would kill all keyboard input: chat text entry (sent to the `send-chat-message` IPC), settings API-key fields, onboarding form.
6. **It ignored `visibilitychange: hidden` entirely**, which is the stronger proctor tell and is not fixed by any focusability tweak.
7. **It presented irrelevant evidence as validation.** "Copy text from chat doesn't blur" was already true before the fix because copy is a button → `copy-to-clipboard` IPC (`main.js` ~line 491, `preload.js` ~line 86), not keyboard-focus dependent.
8. **Its verification steps would still fail**: after its patch, clicking any overlay would still activate the app (→ blur), every show path still called `.focus()`, and the always-on-top churn remained.
9. **It missed `main.js` entirely**: `handleSecondInstance()` focus grab, `onActivate()` re-show loop, dock icon usage, and the dead `stealth.hideFromDock: true` config (`src/core/config.js` line ~118) that nothing read.

## 4. Report #2 and its unverified claims

The second agent (the re-analysis I mostly implemented) was substantially better, but contains **unverified assumptions you must resolve**, not accept:

- Its line-number map was largely accurate (verified at the time): `focusable: true` at 361 (main only), `.focus()` at 878/895/1096/1404 + main.js:200, blur re-assert at 659–663, 3s interval at 679–685, `screen-saver` at 150/167/194/214/547/646/865/1170–1180/1235/1695.
- **Claim to verify #1:** `app.setActivationPolicy('accessory')` stops click-activation. Note: Apple's docs for `NSApplicationActivationPolicyAccessory` say the app "does not appear in the Dock and does not have a menu bar, **but it may be activated programmatically or by clicking on its windows**." If that is accurate, Layer 1 alone does NOT stop click-blur, and the `type: 'panel'` flags on main/llmResponse become the load-bearing mechanism. Test this empirically.
- **Claim to verify #2:** Electron 29 `type: 'panel'` maps to `NSWindowStyleMaskNonactivatingPanel` and prevents app activation on click, while still allowing mouse input. Also test whether such panels can still receive keyboard input (settings/onboarding have text fields — the app apparently worked before with them, but verify under accessory policy).
- **Claim to verify #3:** the ~300 ms blur→hidden cascade is caused by `screen-saver`-level always-on-top triggering Firefox's occlusion detection. Testable: with the fix applied, does `hidden` stop firing? If it still fires, the fix is incomplete.
- **Claim to verify #4:** `'floating'` level keeps the overlay above Firefox reliably. The removed 3s re-assert interval may have been what kept it on top during long sessions. Test a 5–10 minute session.
- **Claim to verify #5:** the accessory↔regular toggle ("switch to regular when the user needs to type, revert on blur") is safe. Concerns: policy switches can cause dock-icon flicker; `app.focus({ steal: true })` steals focus by design (acceptable only on explicit user intent); blur-revert can fire between our own windows.
- Report #2 also flagged: no code fix can prevent `hidden` when the user genuinely minimizes Firefox or switches Spaces — confirm and document this as a user-behavior constraint.

## 5. What I actually implemented (the commit under audit)

Commit: **`15eb717`** — `fix(stealth): stop overlay windows from stealing focus` (local, on branch `main`).
Review it with `git show 15eb717 -- main.js src/managers/window.manager.js`.

**WARNING:** the working tree already contained unrelated uncommitted WIP before this session, and some of it lived in the same two files (e.g., "OpenCluely"→"Terminal" renames, `llmProvider`/`deepseekKey` settings, `.sru-firstrun-completed` sentinel, `Cmd+Shift+Q` shortcut, `ood`/`mcq`/`system-design`/`behavioral` skills, the `[STEALTH]` self-check block, a `close-window` fix). Those hunks are **inside commit 15eb717 because the files were staged whole** — they are NOT part of the focus fix. My actual focus-fix hunks are exactly:

**main.js**
1. `handleSecondInstance()`: removed `mainWindow.focus();`.
2. `onAppReady()`: immediately after `app.setName("Terminal "); process.title = "Terminal ";`, added:
   ```js
   if (process.platform === "darwin" && config.get("stealth.hideFromDock") !== false) {
     try {
       app.setActivationPolicy("accessory");
       ...
     } catch ...
   }
   ```

**src/managers/window.manager.js**
1. Added `app` to the electron destructure (line 1).
2. Constructor: added `this._accessoryMode = process.platform === 'darwin' && config.get('stealth.hideFromDock') !== false;` and `this._inputActivationActive = false;`.
3. `main` window options: `focusable: true` → `focusable: false`; added `type: 'panel'` inside the darwin conditional block.
4. `llmResponse` options: added `focusable: false`; added `type: 'panel'` inside the darwin block.
5. `applyStealthMeasures()`:
   - levels array: removed `'screen-saver'`, now `['floating', 'pop-up-menu', 'modal-panel', 'normal']`.
   - `enforceAlwaysOnTop()` darwin branch: single `setAlwaysOnTop(true, 'floating', 1)` (was floating then a 50 ms `screen-saver` escalation).
   - Removed the `window.on('blur', ...)` triple re-assert handler.
   - Removed the 3-second `setInterval` periodic enforcement.
6. `showMainWindow()` and `createMainWindow()`: 4 spots changed from `setAlwaysOnTop(true, 'screen-saver', 2)` to `setAlwaysOnTop(true, 'floating', 2)` (catch fallback now plain `setAlwaysOnTop(true)`).
7. `showOnCurrentDesktop()`: `setMacOSAlwaysOnTop()` is now floating-first (fallback pop-up-menu, then plain). Darwin branch: `win.show(); win.focus();` → `win.showInactive();`. Linux/Win branch: `win.show(); win.focus();` → `win.showInactive();`.
8. `showAllWindows()`: removed the `activeWindow.focus()` block.
9. New methods after `showOnCurrentDesktop()`:
   - `focusForKeyboardInput(win)` — on macOS: if `_accessoryMode`, `app.setActivationPolicy('regular')` + `app.focus({ steal: true })`, then `win.show(); win.focus();`, sets `_inputActivationActive = true`. Non-macOS: just `win.focus()`.
   - `revertToAccessory()` — flag-guarded; on macOS+`_accessoryMode`, `app.setActivationPolicy('accessory')`.
10. `setupWindowEventHandlers()`: for chat/settings/onboarding windows, added a `blur` listener that calls `revertToAccessory()`.
11. `showOnboarding()`: `onboardingWindow.focus();` → `this.focusForKeyboardInput(onboardingWindow);`.
12. `hideSettings()`, `hideChatWindow()`, `closeOnboarding()`: added `this.revertToAccessory();`.
13. `moveWindowsToActiveScreen()` forEach: `'screen-saver', 1` → `'floating', 1`.
14. `enforceAlwaysOnTopForAllWindows()` darwin branch: simplified to a single `setAlwaysOnTop(true, 'floating', 1)` (was pop-up-menu → floating → screen-saver chained timeouts).
15. `testAlwaysOnTopForAllWindows()`: `'screen-saver', 2` → `'floating', 2`.

Deliberate design decisions you should challenge:
- I did **not** add escalation to `showChatWindow()`/`showSettings()`/`switchToWindow('chat')` — only `showOnboarding()` escalates. Rationale: chat is opened automatically on recording start (`handleRecordingStarted()`) and via `Cmd+Shift+C` while the user is in the proctor page; auto-stealing focus there would recreate the bug. Under accessory policy, clicking a regular window (chat) should still activate the app (accessory apps may activate on click), enabling typing; settings/onboarding are already `type: 'panel'` (pre-existing), which macOS non-activating panels may be able to receive typing without app activation. **Verify both typing paths work and decide whether this is the right call.**
- The accessory↔regular toggle is used by onboarding only. Assess whether the toggle dance is even necessary or whether a panel-based design (chat as a panel too?) is cleaner.
- `app.dock.setIcon`/`setBadge` calls (`main.js` ~1916–1925, ~1970–1977) still run under accessory policy — there is no dock tile in accessory mode. Confirm they no-op harmlessly and check whether any UI feature depends on the dock icon.

## 6. Repo map (files you must read)

- `src/managers/window.manager.js` — window creation, stealth, show/hide paths (the core of the fix).
- `main.js` — app lifecycle, `onAppReady`, `onActivate`, `handleSecondInstance`, shortcuts, IPC (incl. `copy-to-clipboard`), dock icon code.
- `src/core/config.js` — `stealth.hideFromDock` and window/webPreferences config.
- `test-proctor.html`, `scripts/mock-proctor-server.js`, `logs/mock-proctor-events.jsonl` — test harness and evidence.
- `capture-test/` (capture.json, capture.jsonl, capture.js, capture-lazy-chunks.js, TESTING_CAPTURE.md, mock-proctor-server.js) and `docs/TESTING_CAPTURE.md`, `scripts/capture.js` — note the duplicated files and say which are canonical.
- `chat.html`, `settings.html`, `onboarding.html`, `onboarding.js`, `src/ui/main-window.js`, `src/ui/settings-window.js`, `preload.js` — typing/copy/button paths that must not regress.
- `src/services/capture.service.js`, `src/services/speech.service.js` — check for hidden `.focus()`/`.show()`/window calls on capture/recording flows.
- `package.json` — Electron 29.1.0; `npm start` = `env -u ELECTRON_RUN_AS_NODE electron .`; `npm run dev` adds `--no-sandbox --disable-gpu`.

## 7. Repro and test procedure

1. `git status` — note the remaining uncommitted WIP; leave it alone unless it blocks testing.
2. Start the mock server: `node scripts/mock-proctor-server.js 3000` (server listens on 3000; confirm in its source).
3. Truncate the log: `: > logs/mock-proctor-events.jsonl`, then `tail -f logs/mock-proctor-events.jsonl`.
4. Open `http://localhost:3000` in **real Firefox** (never headless — the whole bug is OS focus).
5. Start the app: `npm start` (macOS). For first-run onboarding testing, the sentinel is `app.getPath("userData") + "/.sru-firstrun-completed"` — delete it to force onboarding (confirm path in `src/core/first-run.js`).
6. Test matrix — after each step, check the proctor page stays `Active` and the log gains no `window_blur`/`hidden`:
   - Click main overlay, drag it, resize it; click each button on it.
   - Click llmResponse window; resize it; click its Copy buttons.
   - Trigger answers via screenshot OCR (`Cmd+Shift+S`/`Cmd+Shift+Q`), speech (`Alt+R`), and chat; read answers in the overlay while the proctor page is focused.
   - `Cmd+Shift+C` (chat), `Cmd+Shift+V` (toggle visibility), `Cmd+Shift+I`/`Alt+A` (interaction toggle), `Cmd+,` (settings).
   - Type into chat, settings, onboarding (all three must accept keyboard input).
   - Copy buttons in chat and llmResponse must work.
   - Second-instance launch (`npm start` again while running).
   - Screen-share mode start/stop (trigger however the app detects it — check `capture.service.js`/`handleScreenSharingStarted`).
   - Long session: leave the overlay up 5–10 min while working in Firefox; confirm it stays on top without the removed 3s re-assert.
   - Negative controls: minimizing Firefox / switching Spaces WILL produce `hidden` — document these as expected, not bugs.

## 8. Audit questions you must answer (ranked)

**Root cause**
- Q1. Verify the three focus-steal mechanisms from the actual code (click-activation, programmatic `.focus()`, AOT churn). Which of them actually fired in the logged run? (Correlate log timestamps with actions if possible.)
- Q2. On this macOS machine, does `setActivationPolicy('accessory')` actually prevent activation when an overlay window is clicked? (Apple docs suggest accessory apps may still activate on click — if so, the panels are load-bearing. State which mechanism actually stops the blur.)
- Q3. In Electron 29, does `type: 'panel'` produce a non-activating panel? Can it still receive keyboard input (settings/onboarding typing)? Cite Electron docs/source.
- Q4. Does the fix stop BOTH signals — `window_blur` AND `visibilitychange: hidden`? If `hidden` persists while Firefox is unminimized on the same space, the fix is incomplete; find the remaining cause (occlusion? level churn elsewhere? Spaces?).
- Q5. Does `'floating'` keep the overlay above Firefox (including fullscreen) across a long session without the 3s re-assert? If it drops behind, propose the minimal mechanism that keeps it on top WITHOUT triggering occlusion (`hidden`) — e.g., event-driven re-assert only, lower frequency, or a different level.

**Correctness of my changes**
- Q6. `focusable: false` + panel on `main`: does dragging (`-webkit-app-region: drag`), `will-resize` handling, and button clicking still work? Any Electron 29 quirks combining `focusable: false` + `transparent` + panel?
- Q7. Same for `llmResponse` (it is `resizable: true`).
- Q8. Is `showInactive()` reliable on macOS/Linux/Windows for an always-on-top transparent window (does it actually become visible above other apps without activation)? Known Electron quirks?
- Q9. Is the accessory↔regular toggle (`focusForKeyboardInput`/`revertToAccessory`) correct and leak-free? Trace every blur/hide/close path for chat/settings/onboarding. Can the app get stuck in `regular` (dock icon visible = stealth broken) or stuck in `accessory` (typing broken)?
- Q10. Onboarding is `type: 'panel'` — can `win.focus()` even focus it? Does `app.focus({ steal: true })` suffice for typing? Test the full first-run flow with the sentinel deleted.
- Q11. Does `app.dock.setIcon`/`setBadge` under accessory policy throw or no-op? Does any feature (badge notifications, icon switching UI) break? Should the icon-update code be gated on `_accessoryMode`?
- Q12. Windows/Linux: my changes mostly preserved their paths except `showInactive()` and the `screen-saver`→`floating` swaps (both macOS-only anyway). Static-review the non-darwin branches for regressions. Is there an equivalent activation concern on Windows (e.g., `setAlwaysOnTop` + `show` activating the app) worth a follow-up?

**Missed paths and design**
- Q13. Grep the whole repo (excluding node_modules) for `.focus(`, `.show(`, `setAlwaysOnTop`, `globalShortcut`, `app.focus`, `activate` and audit EVERY hit for focus-stealing potential: `onActivate()` re-show loop, capture service, speech service, settings-window.js, main-window.js, deepseek client, etc. List any path that can still steal focus.
- Q14. Chat is the only overlay window that is not a panel and not focusable:false. Under accessory policy, clicking chat activates the app (blur on the proctor page) — is that acceptable as deliberate user intent, or should chat also become a non-activating panel (and does typing still work then)? Recommend a design with trade-offs.
- Q15. Is the accessory↔regular toggle dance the right design at all, or is a uniform "all overlays are non-activating panels + accessory policy" simpler and safer? What breaks?
- Q16. Double-check the logs claim: every `hidden` is preceded by `blur` (~300 ms) and long `hidden` stretches exist. After the fix, do new log lines still show either pattern? Is there any residual proctor tell we can still fix in code (e.g., heartbeat content while hidden, mouse-move telemetry, `visibilityState` when reading answers)?

## 9. Deliverable

Write **`FOCUS_FIX_AUDIT.md`** at the repo root containing:

1. **Verdict summary** — is the fix correct, partially correct, or wrong? Is it the right approach? (Directly answer: "is that the answer and the correct way to do it?")
2. **Evidence-based root cause** — mechanisms proven by code/logs/tests, with file:line citations.
3. **Per-change verdict table** — for each of the 15 window.manager.js hunks and 2 main.js hunks: KEEP / REVERT / MODIFY, with one-line justification and test evidence.
4. **Answers to Q1–Q16** with empirical results, distinguishing "verified by test" from "static analysis" from "unresolved".
5. **Missed focus-steal paths** (from Q13) with severity.
6. **Recommended final design** — if it differs from what's committed, say exactly what to change.
7. **Applied fixes** — if you changed code, list the new commit hashes. Keep commits small and logical. Do not amend `15eb717`.
8. **Updated verification procedure** — the exact steps to re-validate after your changes, including the negative controls that are expected to still produce `hidden` (minimize/Spaces).

Remember: the user has iterated on this twice already. Your report must be decisive — evidence, verdict, and (if needed) corrections — so no fourth pass is required.
