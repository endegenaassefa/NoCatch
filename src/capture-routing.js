/**
 * capture-routing.js — pure mid-capture key routing (Depth Engine run de-0002, E9).
 *
 * Implements the converged design contract (Ledger L-0052..L-0067):
 * gate order  (i) family → (ii) exit-equality → (iii) drop → (iv) editing →
 *             (v) palette → (vi) normal.
 *
 * This module is PURE: no Electron, no I/O. main.js feeds it events from the
 * Swift helper and executes the returned actions; scripts/test-capture-routing.js
 * exercises it directly (17-chord trace + Q079/Q080 negative controls).
 *
 * macOS CGEventFlags values used in `flags` (raw, from main.swift):
 *   control 0x40000 · option 0x80000 · command 0x100000 · shift 0x20000
 *   capsLock (alphaShift) 0x10000 — EXCLUDED from the 4-modifier set (L-0052 i).
 */

const FLAG_CONTROL = 0x40000;
const FLAG_OPTION = 0x80000;
const FLAG_COMMAND = 0x100000;
const FLAG_SHIFT = 0x20000;

// kVK codes (macOS Events.h).
const KVK_SPACE = 49;
const KVK_RETURN = 36;
const KVK_TAB = 48;
const KVK_ESCAPE = 53;
const KVK_BACKSPACE = 51;
const KVK_HOME = 115;
const KVK_PAGEUP = 116;
const KVK_FWDDELETE = 117;
const KVK_END = 119;
const KVK_PAGEDOWN = 121;
const KVK_LEFT = 123;
const KVK_RIGHT = 124;
const KVK_DOWN = 125;
const KVK_UP = 126;

// Chord family: ⌃⌥⌘+{Space,1-6} with the L-0042-verified kVK map {18:1,19:2,20:3,21:4,23:5,22:6}.
const FAMILY_DIGITS = { 18: '1', 19: '2', 20: '3', 21: '4', 23: '5', 22: '6' };

// Editing class (Q077(3)/Q078): {51,115,116,117,119,121} + nav 123-126.
const EDITING_CODES = new Set([
  KVK_BACKSPACE, KVK_HOME, KVK_PAGEUP, KVK_FWDDELETE, KVK_END, KVK_PAGEDOWN,
]);
const NAV_CODES = new Set([KVK_LEFT, KVK_RIGHT, KVK_DOWN, KVK_UP]);

// Q078(6): the explicit 12-code F-key set (NOT the contiguous 96-123 span).
const F_KEYS = new Set([96, 97, 98, 99, 100, 101, 103, 109, 111, 118, 120, 122]);

// Q078(9a): keypad codes incl. keypad Enter 76.
const KEYPAD_CODES = new Set([65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92]);

/**
 * Parse raw CGEventFlags into the 4-modifier set + caps (L-0052 i).
 * Returns { ctrl, opt, cmd, shift, caps, family, any, ctrlMod }
 *   family  = ctrl∧opt∧cmd all held (⊇{ctrl,opt,cmd}).
 *   any     = any of the 4-modifier set held.
 *   ctrlMod = any of {ctrl,opt,cmd} held.
 */
function parseFlags(flags) {
  const f = Number(flags) || 0;
  const ctrl = (f & FLAG_CONTROL) !== 0;
  const opt = (f & FLAG_OPTION) !== 0;
  const cmd = (f & FLAG_COMMAND) !== 0;
  const shift = (f & FLAG_SHIFT) !== 0;
  const caps = (f & 0x10000) !== 0;
  return {
    ctrl, opt, cmd, shift, caps,
    family: ctrl && opt && cmd,
    any: ctrl || opt || cmd || shift,
    ctrlMod: ctrl || opt || cmd,
  };
}

/**
 * Route one captured keyDown.
 *
 * @param {{code:number, char:string, flags:number, repeat:boolean}} event
 *   code  — virtual keycode; char — helper-folded unicode (may be ''); repeat — autorepeat.
 * @param {{paletteOpen:boolean}} state
 * @returns {{action:string, [code]:number, [modifiers]:boolean, [digit]:string, [char]:string, [paletteClosed]:boolean}}
 *   actions: palette-toggle | skill-set | exit-capture | drop | editing |
 *            palette-nav | palette-commit | palette-tab | send-exit |
 *            type | consume-silent
 */
function routeCapturedKey(event, state) {
  const code = Number(event.code);
  const char = String(event.char || '');
  const repeat = Boolean(event.repeat);
  const paletteOpen = Boolean(state && state.paletteOpen);
  const m = parseFlags(event.flags);

  // (i) FAMILY GATE — ⌃⌥⌘+{Space,1-6}. Repeat-guarded (Q065/Q077(2)).
  if (m.family) {
    if (code === KVK_SPACE) {
      return repeat
        ? { action: 'consume-silent' }
        : { action: 'palette-toggle' };
    }
    if (FAMILY_DIGITS[code]) {
      return repeat
        ? { action: 'consume-silent' }
        : { action: 'skill-set', digit: FAMILY_DIGITS[code] };
    }
  }

  // (ii) EXIT GATE — EXACT set equality {cmd,shift}+49, repeat:false (Q076).
  if (code === KVK_SPACE && m.cmd && m.shift && !m.ctrl && !m.opt) {
    return repeat ? { action: 'drop' } : { action: 'exit-capture' };
  }

  // (iii) DROP GATE — ∩{ctrl,opt,cmd}≠∅ ∧ (char=="" ∨ code==49) ∧ ∉editing∪nav.
  //       The "OR code == 49" closes the modified-Space class (Q079(3)):
  //       any modified Space is consumed regardless of folded char
  //       (family/exit gates above already took the full/exit chords).
  const editingOrNav = EDITING_CODES.has(code) || NAV_CODES.has(code);
  if (m.ctrlMod && (char === '' || code === KVK_SPACE) && !editingOrNav) {
    return { action: 'drop' };
  }

  // (iv) EDITING GATE — editing-class codes; bare arrows with paletteOpen
  //       belong to the PALETTE (Q062/Q079(2)), modified arrows to the textarea.
  if (EDITING_CODES.has(code)) {
    return { action: 'editing', code, modifiers: m.any };
  }
  if (NAV_CODES.has(code)) {
    if (m.any) return { action: 'editing', code, modifiers: true };
    if (paletteOpen) return { action: 'palette-nav', code };
    return { action: 'editing', code, modifiers: false };
  }

  // (v) PALETTE GATE — bare Enter commits (keep capture ON, refocus), bare Tab
  //       cycles (Q077(1)/Q078(9b)). Letters are GATED from the draft while the
  //       palette is open: delivered on the palette-key channel instead (Q050/Q052).
  //       Modified Enter falls through (Q077(1): never commit/send).
  if (paletteOpen && !m.any) {
    if (code === KVK_RETURN) {
      return repeat ? { action: 'consume-silent' } : { action: 'palette-commit' };
    }
    if (code === KVK_TAB) return { action: 'palette-tab' };
    if (char !== '') return { action: 'palette-key', char };
  }

  // Bare Esc exits (close palette + capture); modified Esc is dropped — never exits (trace 10).
  // CapsLock+Esc is bare (caps excluded from the 4-modifier set).
  if (code === KVK_ESCAPE) {
    if (m.any) return { action: 'drop' };
    return { action: 'exit-capture', paletteClosed: paletteOpen };
  }

  // Bare Enter, palette closed — forward-and-stop send gesture (main.js:362-368 today; Q077(1)).
  if (code === KVK_RETURN && !m.any) {
    return repeat ? { action: 'consume-silent' } : { action: 'send-exit' };
  }

  // Bare Tab palette-closed → textarea (specialKeyMap); modified Tab → drop (Q068/Q078(9b)).
  if (code === KVK_TAB) {
    return m.any
      ? { action: 'drop' }
      : { action: 'editing', code: KVK_TAB, modifiers: false };
  }

  // F-keys and keypad → else-drop (Q078(6)/(9a)).
  if (F_KEYS.has(code) || KEYPAD_CODES.has(code)) {
    return { action: 'drop' };
  }

  // (vi) NORMAL — modifier-folded chars (Shift/Option) are typed (the helper
  //       folds them into `char`); Cmd/Ctrl-modified zero-char chords were
  //       already dropped by (iii).
  if (char !== '') {
    return { action: 'type', char };
  }

  // Anything else (unknown keys, modifier-only) is swallowed.
  return { action: 'drop' };
}

// ── Settings-time refusal validation (Q079(1), Q076 D2, Q077(3)) ──────────────
// Config-time parse of an Electron accelerator string; NOT used mid-capture
// (the Q060 no-parser commitment applies to the mid-capture path only).

const BARE_REFUSED_KEYS = {
  esc: true, escape: true, enter: true, return: true, tab: true,
  left: true, right: true, up: true, down: true,
};
const EDITING_REFUSED_KEYS = {
  backspace: true, delete: true, home: true, end: true,
  pageup: true, pagedown: true, left: true, right: true, up: true, down: true,
};

/**
 * @param {string} accelerator e.g. "CommandOrControl+Shift+Space"
 * @returns {{refused:boolean, reason?:string, normalized?:string}}
 */
function validateCaptureHotkey(accelerator) {
  if (!accelerator || typeof accelerator !== 'string') {
    return { refused: true, reason: 'empty' };
  }
  const parts = accelerator
    .trim()
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return { refused: true, reason: 'empty' };

  const mods = new Set();
  let key = '';
  for (const p of parts) {
    if (p === 'commandorcontrol' || p === 'cmdorctrl') mods.add('command');
    else if (p === 'command' || p === 'cmd') mods.add('command');
    else if (p === 'control' || p === 'ctrl') mods.add('control');
    else if (p === 'option' || p === 'alt') mods.add('option');
    else if (p === 'shift') mods.add('shift');
    else key = p;
  }
  if (!key) return { refused: true, reason: 'no key' };

  const has = (m) => mods.has(m);
  const bare = mods.size === 0;

  // Family members ⌃⌥⌘+{Space,1-6} — refused (Q074/Q076/Q079(1)).
  if (has('command') && has('control') && has('option')) {
    if (key === 'space' || /^[1-6]$/.test(key)) {
      return { refused: true, reason: 'family-member' };
    }
  }

  // Default exit chord {cmd,shift}+Space — LEGAL (dual role by design, Q076 D2).
  const exactDefault =
    key === 'space' &&
    mods.size === 2 &&
    has('command') && has('shift');

  // Editing-class chords ({51,115,116,117,119,121} or nav 123-126) WITH modifiers — refused.
  if (!bare && EDITING_REFUSED_KEYS[key]) {
    return { refused: true, reason: 'editing-class' };
  }

  // Bare Esc/Enter/Tab/arrows — refused (Q079(1)).
  if (bare && BARE_REFUSED_KEYS[key]) {
    return { refused: true, reason: 'bare-pinned-role' };
  }

  return { refused: false, normalized: parts.join('+'), isDefaultChord: exactDefault };
}

module.exports = {
  routeCapturedKey,
  parseFlags,
  validateCaptureHotkey,
  KVK_SPACE,
  KVK_RETURN,
  KVK_TAB,
  KVK_ESCAPE,
  KVK_BACKSPACE,
  KVK_HOME,
  KVK_PAGEUP,
  KVK_FWDDELETE,
  KVK_END,
  KVK_PAGEDOWN,
  KVK_LEFT,
  KVK_RIGHT,
  KVK_DOWN,
  KVK_UP,
  FAMILY_DIGITS,
  EDITING_CODES,
  NAV_CODES,
  F_KEYS,
  KEYPAD_CODES,
  FLAG_CONTROL,
  FLAG_OPTION,
  FLAG_COMMAND,
  FLAG_SHIFT,
};
