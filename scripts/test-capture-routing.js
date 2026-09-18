#!/usr/bin/env node
/**
 * test-capture-routing.js — E9 build-probe harness for de-0002.
 * Runs the L-0062 17-chord trace + the Q079 negative controls + the settings
 * refusal validation against the pure routing module (src/capture-routing.js).
 *
 * A failing case here is an E9 surprise (E9 Step 4) — the negative controls are
 * the executable form of the Q079 kill pass (operator ruling L-0065).
 *
 * Run: node scripts/test-capture-routing.js
 */
const assert = require('assert');
const R = require('../src/capture-routing');

const F = R;
const S = { paletteOpen: false };
const SO = { paletteOpen: true };

function route(code, char, flags, repeat, state) {
  return R.routeCapturedKey({ code, char, flags, repeat: Boolean(repeat) }, state || S);
}

let pass = 0;
let fail = 0;
function check(name, actual, expectedAction, expectedExtra) {
  const parts = [String(name)];
  const ok =
    actual.action === expectedAction &&
    (expectedExtra === undefined ||
      Object.entries(expectedExtra).every(([k, v]) => actual[k] === v));
  if (ok) {
    pass++;
    parts.push('PASS');
  } else {
    fail++;
    parts.push(`FAIL expected action=${expectedAction} got=${JSON.stringify(actual)}`);
  }
  console.log(parts.join(' — '));
}

console.log('=== 17-chord concrete trace (L-0062) ===');
// 1 ⌃⌥⌘Space → palette toggle; repeat → consumed silently
check('t1a family space', route(49, ' ', R.FLAG_CONTROL | R.FLAG_OPTION | R.FLAG_COMMAND), 'palette-toggle');
check('t1b family space repeat', route(49, ' ', R.FLAG_CONTROL | R.FLAG_OPTION | R.FLAG_COMMAND, true), 'consume-silent');
// 2 ⇧⌘Space (default) exact → exit; repeat → drop
check('t2a default exit', route(49, ' ', R.FLAG_COMMAND | R.FLAG_SHIFT), 'exit-capture');
check('t2b default exit repeat', route(49, ' ', R.FLAG_COMMAND | R.FLAG_SHIFT, true), 'drop');
// 3 ⌃⌥⌘⇧Space → family (superset) → palette toggle, exit gate fails exact-equality
check('t3 superset space', route(49, ' ', R.FLAG_CONTROL | R.FLAG_OPTION | R.FLAG_COMMAND | R.FLAG_SHIFT), 'palette-toggle');
// 4 ⌥⌘⇧Space / ⌃⌘⇧Space → drop gate (modified Space, char non-empty — Q079(3) class)
check('t4a opt-cmd-shift space', route(49, ' ', R.FLAG_OPTION | R.FLAG_COMMAND | R.FLAG_SHIFT), 'drop');
check('t4b ctrl-cmd-shift space', route(49, ' ', R.FLAG_CONTROL | R.FLAG_COMMAND | R.FLAG_SHIFT), 'drop');
// 5 ⌃⌥⌘1..6 → skill-set; repeat consumed silently; bare digit → type
check('t5a family digit', route(18, '1', R.FLAG_CONTROL | R.FLAG_OPTION | R.FLAG_COMMAND), 'skill-set', { digit: '1' });
check('t5b family digit repeat', route(23, '5', R.FLAG_CONTROL | R.FLAG_OPTION | R.FLAG_COMMAND, true), 'consume-silent');
check('t5c bare digit', route(18, '1', 0), 'type', { char: '1' });
// 6 ⌘+arrows / ⌥+arrows → editing with modifiers
check('t6a cmd-left', route(123, '', R.FLAG_COMMAND), 'editing', { code: 123, modifiers: true });
check('t6b opt-up', route(126, '', R.FLAG_OPTION), 'editing', { code: 126, modifiers: true });
// 7 ⌘Backspace / ⌥Delete → editing
check('t7a cmd-backspace', route(51, '', R.FLAG_COMMAND), 'editing', { code: 51, modifiers: true });
check('t7b opt-fwddelete', route(117, '', R.FLAG_OPTION), 'editing', { code: 117, modifiers: true });
// 8 bare arrows: paletteOpen → palette-nav; palette closed → textarea (Q079(2))
check('t8a bare arrow palette', route(125, '', 0, false, SO), 'palette-nav', { code: 125 });
check('t8b bare arrow textarea', route(125, '', 0, false, S), 'editing', { code: 125, modifiers: false });
// 9 Tab: bare paletteOpen → palette-tab; bare closed → textarea; Shift+Tab → drop
check('t9a bare tab palette', route(48, '', 0, false, SO), 'palette-tab');
check('t9b bare tab closed', route(48, '', 0, false, S), 'editing', { code: 48, modifiers: false });
check('t9c shift-tab', route(48, '', R.FLAG_SHIFT), 'drop');
// 9b letters gated to the palette channel while open (Q050/Q052)
check('t9d letter palette-key', route(14, 'e', 0, false, SO), 'palette-key', { char: 'e' });
check('t9e letter closed types', route(14, 'e', 0, false, S), 'type', { char: 'e' });
// 10 Esc: bare → exit; modified → drop; CapsLock+Esc → bare exit (caps excluded)
check('t10a bare esc', route(53, '', 0), 'exit-capture');
check('t10b modified esc', route(53, '', R.FLAG_SHIFT), 'drop');
check('t10c capslock esc', route(53, '', 0x10000), 'exit-capture');
// 11 Enter: paletteOpen → commit (keep ON); closed → send-exit; repeat dropped; Shift+Enter → newline char path; Cmd+Enter → drop
check('t11a enter palette', route(36, '\r', 0, false, SO), 'palette-commit');
check('t11b enter closed', route(36, '\r', 0, false, S), 'send-exit');
check('t11c enter repeat', route(36, '\r', 0, true, S), 'consume-silent');
check('t11d shift-enter newline', route(36, '\r', R.FLAG_SHIFT), 'type', { char: '\r' });
check('t11e cmd-enter drop', route(36, '', R.FLAG_COMMAND), 'drop');
// 12 plain + folded chars → type (Option-folded: the helper folds modifiers into char)
check('t12a plain char', route(14, 'e', 0), 'type', { char: 'e' });
check('t12b option-folded', route(14, 'é', R.FLAG_OPTION), 'type', { char: 'é' });
check('t12c alt-r ring', route(15, '®', R.FLAG_OPTION), 'type', { char: '®' });
// 13 Cmd/Ctrl-modified zero-char chords → drop (15/15 inventory class)
check('t13a cmd-c', route(8, '', R.FLAG_COMMAND), 'drop');
check('t13b cmd-shift-v', route(9, '', R.FLAG_COMMAND | R.FLAG_SHIFT), 'drop');
// 14 F-keys (12-code set) → drop; keypad → drop
check('t14a f5', route(96, '', 0), 'drop');
check('t14b f13 (not in set, char empty)', route(105, '', 0), 'drop');
check('t14c keypad enter', route(76, '', 0), 'drop');
// 15 Home/PageUp/FwdDelete/End/PageDown: bare → editing textarea; modified → editing with modifiers
check('t15a bare home', route(115, '', 0), 'editing', { code: 115, modifiers: false });
check('t15b cmd-home', route(115, '', R.FLAG_COMMAND), 'editing', { code: 115, modifiers: true });
// 16 remap classes — covered by the refusal tests below (config-time) + bound text
// 17 IME/marked-text — documented limitation (no router arm; noted, not tested)

console.log('=== Q079 negative controls (the executable kill pass) ===');
// NC-1 modified-Space class closed: ⌥Space (NBSP char) consumed, NOT typed
check('nc1a opt-space consumed', route(49, '\u00a0', R.FLAG_OPTION), 'drop');
check('nc1b opt-shift-space consumed', route(49, ' ', R.FLAG_OPTION | R.FLAG_SHIFT), 'drop');
// NC-2 family gate precedes drop: ⌃⌥⌘Space with char ' ' toggles, never typed (L-0042 C1 class)
check('nc2 family space never typed', route(49, ' ', R.FLAG_CONTROL | R.FLAG_OPTION | R.FLAG_COMMAND), 'palette-toggle');
// NC-3 exact-equality: ⌘⇧⌥Space is NOT the exit chord (superset with opt) → drop, no exit
check('nc3 cmd-shift-opt space not exit', route(49, ' ', R.FLAG_COMMAND | R.FLAG_SHIFT | R.FLAG_OPTION), 'drop');
// NC-4 repeat guards: exit chord repeat → drop (no exit), family digit repeat → silent
check('nc4a exit repeat no exit', route(49, ' ', R.FLAG_COMMAND | R.FLAG_SHIFT, true), 'drop');
check('nc4b family digit repeat silent', route(19, '2', R.FLAG_CONTROL | R.FLAG_OPTION | R.FLAG_COMMAND, true), 'consume-silent');
// NC-5 bare Esc exits with paletteOpen too (close+exit)
check('nc5 esc palette close-exit', route(53, '', 0, false, SO), 'exit-capture', { paletteClosed: true });
// NC-6 modified Enter never commits/sends: ⌘⇧Enter char '' → drop
check('nc6 cmd-shift-enter drop', route(36, '', R.FLAG_COMMAND | R.FLAG_SHIFT), 'drop');

console.log('=== Settings refusal validation (Q079(1), Q076 D2) ===');
function vcheck(name, acc, expectedRefused, expectedReason) {
  const r = R.validateCaptureHotkey(acc);
  const ok = r.refused === expectedRefused && (expectedReason === undefined || r.reason === expectedReason);
  if (ok) { pass++; console.log(`${name} — PASS`); }
  else { fail++; console.log(`${name} — FAIL expected refused=${expectedRefused}${expectedReason ? ' reason=' + expectedReason : ''} got=${JSON.stringify(r)}`); }
}
vcheck('v1 family space refused', 'Command+Control+Option+Space', true, 'family-member');
vcheck('v2 family digit refused', 'CommandOrControl+Control+Option+3', true, 'family-member');
vcheck('v3 editing-class refused', 'Command+Backspace', true, 'editing-class');
vcheck('v4 bare esc refused', 'Esc', true, 'bare-pinned-role');
vcheck('v5 bare arrow refused', 'Down', true, 'bare-pinned-role');
vcheck('v6 default chord legal', 'CommandOrControl+Shift+Space', false);
vcheck('v7 ctrl-opt-space legal', 'Control+Option+Space', false);
vcheck('v8 cmd-f5 legal', 'Command+F5', false);
vcheck('v9 empty refused', '', true);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
