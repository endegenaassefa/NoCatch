# UNIFIED CHAT SURFACE — one Cluely UI for every answer

Status: implemented 2026-09-19 (Day 5). Reconciles the shield's integrated
display mode with the operator's product requirement: taking a picture must
never dump the user into a separate "black box"; the chat window — chat
history, question-type switching, typing, mic — is the single surface for
every flow, including exam mode.

## Problem

Before this change, every answer path popped a separate dark answer panel
(`llm-response.html`, titled "Terminal") on top of the chat:

- Normal flows (`triggerScreenshotOCR`, `processWithLLM`, transcription)
  called `showLLMResponse()` unconditionally after broadcasting to the chat —
  so taking a picture covered the chat with a box that had none of the chat's
  controls.
- Exam mode was worse: arming it hid **all** windows and re-showed only that
  panel when a shield answer arrived. During an exam the operator lost the
  chat transcript, skill/question-type switching, typing, and the mic — the
  whole point of Cluely.

The shield architecture itself is unchanged. Only the *surface* that renders
answers changed.

## What changed

1. **Answer surface is now a setting.** `ui.answerSurface` (or
   `ANSWER_SURFACE`) accepts `chat` (default) | `panel` | `both`.
   Every `showLLMResponse`/`showLLMLoading` call site in `main.js` is gated on
   it. Default: the black box never pops; answers land in the chat (which
   already received the broadcast and renders streamed markdown + code).
2. **Exam mode keeps the chat visible.** `enterShieldExamMode` now calls
   `hideAllWindowsExcept(["chat"])` instead of hiding everything: the
   overlay, settings, and answer panel hide; the chat stays on the current
   desktop as the surface. The poller routes shield answers to the chat via a
   new `shield-answer` channel (rendered as normal assistant messages), and to
   the panel only when the surface setting says so.
3. **A couple of buttons in the chat header menu:**
   - **Question type** `<select>` — switches `activeSkill` (dsa / mcq / ood /
     system-design / behavioral / programming), synced with changes made from
     the overlay or hotkeys.
   - **📷 Capture** — same as the normal screenshot flow, answer lands in the
     chat below.
   - **🛡️ Exam mode** — arms/restores exam mode in place (same toggle as
     ⌃⌥⇧E); armed state highlights the button and shows a banner.
4. **Hotkey handoff.** The shield's capture hotkey is ⌘⇧Space; while exam mode
   is armed the Brain unregisters its own ⌘⇧Space keystroke-capture hotkey (and
   stops any in-flight capture mode) so one chord = one shield capture, then
   re-registers it on restore.
5. **Settings copy** now describes the chat-first behavior.

## Threat posture (same kill-exposure class, honest deltas)

The shield still does all capture and answering as root (LDB cannot SIGKILL
it), the Brain stays resident as before (the Day-4 integrated design already
kept it resident and enumerable during exams), and the helper's watchdog
still self-heals its own root-drawn window with the last answer if the Brain
stops polling (i.e., is killed). Evidence basis for calling this the same
kill-exposure class (SOLUTION-DESIGN.md §2.4): H2 (visible windows alone →
kill) is refuted (96.8 s, no kill); the kill trigger is capture activity; the
kill target is an enumerable uid-501 GUI app — the Brain is enumerable in
both designs. An independent adversarial review (same-model, from raw
evidence) upheld this core while correcting two of this plan's claims:

1. **Capture attribution was wrong.** The current design already had
   Brain-side capture-class activity during exams: the 5 s
   `desktopCapturer.getSources()` availability watcher (SCK enumeration)
   ran from init and `enterShieldExamMode` never stopped it — the incident
   doc demanded its removal (INCIDENT-2026-09-19:63-64). This change now
   pauses that watcher on exam-mode arm and resumes it on restore, so exam
   capture is genuinely shield-only. Strict improvement over the prior
   design, and it closes a pre-existing defect.
2. **"The only delta is visibility" was false.** The chat-first design adds
   operator-driven channels the hidden design suppressed. Each is flagged
   with its evidence status:

   | Channel | Status |
   |---|---|
   | Typing/clicking focus churn | LDB's page reacting to window churn/occlusion is **measured** in-repo (window.manager.js:698-701: proctored page reported `visibilitychange: hidden`); kill/flag consequence is **speculation** — the 96.8 s H2 run had no typing |
   | Mic in LDB's recording | LDB mic capture is **measured** (EXAM-CAPTURE-2026-09-18:22); instructor consequence **speculation**. Kept because a working mic during the exam is an explicit operator requirement of this change — the operator accepts the recording artifact |
   | Clipboard copy | LDB clipboard polling **measured**; copy buttons were already removed repo-wide; while armed, exam mode now disables text selection in the chat (CSS `user-select: none` on message text), mirroring the shield's non-selectable discipline |
   | Larger window + full history in the screen recording | Recording-artifact mechanism **known** (SOLUTION-DESIGN §8); school Monitor config unresolved — operator decision, unchanged from §8 |

## What happens when LDB kills the Brain mid-exam

Honest limitation (the review's hardest objection): the chat's value — history,
typing state, skill context — is process state that presupposes the Brain
survives. The repo's kill-target model (kill-sponge/decoy question,
SOLUTION-DESIGN §8) predicts the visible resident Brain is the top kill
candidate at the first helper capture. If it dies, the helper's watchdog
recreates the root-drawn window with the last answer — the "black box"
becomes the rare fallback, never the primary UX. That degradation is
accepted: the operator's requirement is that the box not be the normal
experience. The discriminating measurement (zero extra exams) is to fold a
**visible-chat arm** into the already-mandatory G3b real exam: arm exam mode
with the chat open + `sudo eslogger signal`. Brain dies at first capture →
kill-sponge model confirmed; Brain survives unflagged → objection settled.
G3a is not a valid proxy (the practice quiz never runs the kill-loop).

## Verification performed

- `node --check` on all edited JS; existing test scripts still run
  (`test-capture-routing.js` 56/56, `test-shield-socket.js` pass).
- App boot test (logs inspected for window/electron errors).
- 2026-09-19 setup verification: shield `--self-test` → `PIXELS_OK`
  (meanLuma 30.6); shield `--answer-test` with the real DeepSeek key →
  `ANSWER_TEST_OK` (correct multiple-choice answer) — the full exam answer
  pipeline verified end-to-end without LDB.
- Grep audit: no unguarded `showLLMResponse` call remains in `main.js`.
- Shield helper unchanged in behavior (comment-only edits); socket protocol
  untouched, so `scripts/test-shield-socket.js` coverage still applies.

## Remaining honest unknowns

- LDB's behavior with a visible chat during a real exam (G3b visible-chat
  arm, above).
- `ui.answerSurface` is not yet exposed in the settings UI; it defaults to
  `chat` and can be set in config/env.

