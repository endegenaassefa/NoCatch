'use strict';
// Behavioral UI tests for the managed onboarding wizard.
//
// These drive the *real* onboarding.js renderer against a minimal simulated
// DOM and a bridge fixture backed by the real SetupService, platform adapter and
// a managed-session double. They cover the primary sign-in → question → answer →
// finish path plus the unconfigured, signed-out, signing-in, cancel, loading,
// error/recovery, screenshot-preview and resume states, exercising simulated DOM
// events (click/change/input/focus) rather than calling renderer internals.
//
// No jsdom is installed and workers must not add dependencies, so the DOM below
// implements only the handful of element behaviours onboarding.js relies on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SetupService } = require('../src/core/setup-service');
const { createPlatformAdapter } = require('../src/platform');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../onboarding.js'), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');
const fail = (code, message) => Object.assign(new Error(message), { code });
const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this._listeners = {};
    this._textContent = '';
    this._value = '';
    this.selectedIndex = -1;
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.src = undefined;
    this.doc = null;
  }
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = v == null ? '' : String(v); }
  get value() {
    if (this.tagName === 'SELECT') { const o = this.children[this.selectedIndex]; return o ? o.value : ''; }
    return this._value;
  }
  set value(v) {
    if (this.tagName === 'SELECT') { this.selectedIndex = this.children.findIndex(o => o.value === String(v)); }
    else this._value = v == null ? '' : String(v);
  }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { const a = this._listeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
  dispatch(type, event = {}) { event.target ||= this; for (const fn of (this._listeners[type] || []).slice()) fn(event); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n]; }
  removeAttribute(n) { delete this.attributes[n]; if (n === 'src') this.src = undefined; }
  focus() { if (this.doc) this.doc.activeElement = this; }
  replaceChildren(...nodes) { this.children = nodes.slice(); if (this.tagName === 'SELECT') this.selectedIndex = this.children.length ? 0 : -1; }
  add(node) { this.children.push(node); if (this.tagName === 'SELECT' && this.selectedIndex === -1) this.selectedIndex = 0; }
  appendChild(node) { this.children.push(node); }
}

function makeOption(text, value) {
  const o = new El('option');
  o.textContent = text == null ? '' : String(text);
  o._value = value == null ? '' : String(value);
  return o;
}

const ELEMENTS = [
  ['wizard', 'main'], ['minimize', 'button'], ['quit', 'button'], ['later', 'button'], ['stepLabel', 'p'], ['heading', 'h1'], ['intro', 'p'], ['status', 'p'],
  ['accountPanel', 'section'], ['accountText', 'p'], ['sessionNote', 'p'], ['signIn', 'button'], ['cancelAuth', 'button'], ['recheck', 'button'],
  ['questionPanel', 'section'], ['identity', 'p'], ['inputMode', 'select'], ['capturePanel', 'div'], ['display', 'select'],
  ['screenStatus', 'p'], ['capture', 'button'], ['refreshDisplays', 'button'], ['screenSettings', 'button'],
  ['previewPanel', 'figure'], ['previewImage', 'img'], ['discard', 'button'], ['recapture', 'button'],
  ['question', 'textarea'], ['sample', 'button'], ['provider', 'select'], ['providerNote', 'p'], ['consent', 'input'], ['consentText', 'span'], ['allowance', 'p'],
  ['submit', 'button'], ['cancelWork', 'button'], ['successPanel', 'section'], ['answerHeading', 'h2'], ['answerText', 'div'], ['readiness', 'p'], ['finish', 'button'], ['settings', 'button'],
];

function buildDom() {
  const byId = new Map();
  for (const [id, tag] of ELEMENTS) { const el = new El(tag); el.id = id; byId.set(id, el); }
  // Static options that live in onboarding.html.
  byId.get('inputMode').replaceChildren(makeOption('Text question', 'text'), makeOption('Screenshot question', 'screenshot'));
  byId.get('display').replaceChildren(makeOption('Choose a display', ''));
  const documentListeners = {};
  const document = {
    activeElement: null,
    getElementById: id => byId.get(id) || null,
    addEventListener: (type, fn) => { (documentListeners[type] ||= []).push(fn); },
    dispatch: (type, event = {}) => { for (const fn of (documentListeners[type] || []).slice()) fn(event); },
  };
  for (const el of byId.values()) el.doc = document;
  const windowListeners = {};
  const window = {
    _listeners: windowListeners,
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { const a = windowListeners[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    dispatch: (type, event = {}) => { for (const fn of (windowListeners[type] || []).slice()) fn(event); },
  };
  return { byId, document, window };
}

// ---------------------------------------------------------------------------
// Backend fixture: bridge -> real SetupService + managed double + controller glue
// ---------------------------------------------------------------------------
function backend(t, opts = {}) {
  const root = opts.root || fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-onboarding-'));
  if (!opts.root) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = {
    mode: 'managed', configured: true, authenticated: false, signingIn: false, subject: 'account-1',
    providers: ['gemini', 'deepseek'], permission: 'granted', now: 1000, bytes: Buffer.from(PNG),
    calls: [], captures: 0, cancels: 0, signInStarted: false, firstRun: true, mainVisible: false,
    settingsShown: false, closed: false, openedSettings: null, operationEpoch: 0,
    signInGate: null, answerGate: null, answerError: null, answerText: 'A helpful answer.', ...opts.state,
  };
  state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, size: { width: 100, height: 100 }, scaleFactor: 1, rotation: 0 }];
  const electron = {
    screen: { getAllDisplays: () => state.displays, getPrimaryDisplay: () => state.displays[0] },
    desktopCapturer: { getSources() {} }, systemPreferences: { getMediaAccessStatus: () => state.permission },
  };
  const adapter = createPlatformAdapter({ electron, platform: 'darwin' });
  const capture = {
    platformAdapter: adapter,
    listDisplays: () => ({ success: true, ...adapter.getDisplayLayout() }),
    captureAndProcess: async () => {
      state.captures++;
      adapter.reportOperation('screen', { success: true });
      return { imageBuffer: state.bytes, mimeType: 'image/png' };
    },
  };
  const managed = {
    status: () => ({ configured: state.configured, authenticated: state.authenticated, signingIn: Boolean(state.signingIn),
      persistence: 'session_only', account: state.authenticated ? { subject: state.subject, providers: state.providers } : null }),
    signIn: async () => { const epoch = state.operationEpoch; state.signingIn = true; if (state.signInGate) await state.signInGate.promise; if (epoch !== state.operationEpoch) throw fail('CANCELLED', 'Sign-in cancelled.'); state.signInStarted = true; state.signingIn = false; state.authenticated = true; return managed.status(); },
    signOut: async () => { state.authenticated = false; state.signingIn = false; return managed.status(); },
    answer: async payload => {
      state.calls.push(payload);
      if (state.answerGate) return state.answerGate.promise;
      if (state.answerError) throw state.answerError;
      return { requestId: 'req-1', text: state.answerText };
    },
    cancelAll: async () => { state.cancels++; },
  };
  const setup = new SetupService({ userDataPath: root, platformAdapter: adapter, captureService: capture, managedSession: managed,
    getAIMode: () => state.mode, now: () => state.now, answer: async payload => { state.direct = payload; return { text: 'Direct answer', requestId: 'direct-req' }; } });

  const invalidateManagedWork = async () => {
    setup.invalidate();
    const cancellation = managed.cancelAll();
    state.operationEpoch++;
    if (managed.status().signingIn) await managed.signOut();
    await cancellation;
  };
  const cancelSetup = async () => {
    state.operationEpoch++;
    const cancellation = setup.cancel();
    if (managed.status().signingIn) await managed.signOut();
    await cancellation;
    return { success: true, ...setup.getStatus() };
  };
  const wrap = fn => async (...a) => {
    try { const r = await fn(...a); return r === undefined ? { success: true } : r; }
    catch (e) { return { success: false, error: { code: e.code || 'REQUEST_FAILED', message: String(e.message || 'The action failed.').slice(0, 512) } }; }
  };
  const bridge = {
    getSetupState: wrap(() => setup.getStatus()),
    getManagedStatus: wrap(() => managed.status()),
    saveSetupProgress: wrap(p => setup.saveProgress(p)),
    captureSetupPreview: wrap(o => setup.capturePreview(o)),
    submitSetupQuestion: wrap(i => setup.submit(i)),
    cancelSetup: wrap(() => cancelSetup()),
    signIn: wrap(async () => {
      const epoch = state.operationEpoch + 1;
      await invalidateManagedWork();
      if (epoch !== state.operationEpoch) throw fail('CANCELLED', 'Sign-in was cancelled.');
      const result = await managed.signIn();
      if (epoch !== state.operationEpoch) throw fail('CANCELLED', 'Sign-in was cancelled.');
      return result;
    }),
    signOut: wrap(async () => { await invalidateManagedWork(); return managed.signOut(); }),
    listDisplays: wrap(() => capture.listDisplays()),
    openPermissionSettings: wrap(kind => { state.openedSettings = kind; return { success: true }; }),
    completeFirstRun: wrap(() => { setup.complete(); state.firstRun = false; state.mainVisible = true; return { success: true }; }),
    closeOnboarding: wrap(async () => { await cancelSetup(); state.closed = true; state.mainVisible = true; return { success: true }; }),
    showSettings: wrap(() => { state.settingsShown = true; return { success: true }; }),
    showOnboarding: wrap(() => ({ success: true })),
    onManagedStatus: cb => { state.managedCb = cb; return () => { state.managedCb = null; }; },
  };
  return { root, state, setup, managed, capture, adapter, bridge };
}

// Load the real renderer against a fresh DOM + a bridge fixture.
function loadRenderer(bridge) {
  const dom = buildDom();
  const windowApi = { send() {} };
  const sandbox = {
    document: dom.document,
    window: Object.assign(dom.window, { electronAPI: bridge, api: windowApi }),
    Option: makeOption,
    console,
    setTimeout, clearTimeout,
  };
  sandbox.window.Option = makeOption;
  vm.runInNewContext(SOURCE, sandbox);
  dom.document.dispatch('DOMContentLoaded');
  return { ...dom, $: id => dom.byId.get(id) };
}

// Interaction helpers that go through simulated DOM events.
const click = el => el.dispatch('click');
const typeInto = (el, value) => { el.value = value; el.dispatch('input'); };
const setChecked = (el, value) => { el.checked = value; el.dispatch('change'); };
const selectValue = (el, value) => { el.value = value; el.dispatch('change'); };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('unconfigured build shows account panel with no sign-in and no service claim', async t => {
  const b = backend(t, { state: { configured: false } });
  const { $ } = loadRenderer(b.bridge);
  await settle();
  assert.equal($('accountPanel').hidden, false);
  assert.equal($('signIn').hidden, true);
  assert.equal($('questionPanel').hidden, true);
  assert.match($('accountText').textContent, /not configured/i);
  assert.equal($('wizard').getAttribute('aria-busy'), 'false');
});

test('primary path: signed-out -> sign in -> ask question -> answer -> finish', async t => {
  const b = backend(t);
  const r = loadRenderer(b.bridge);
  await settle();
  // Signed-out but configured: sign-in offered, question panel hidden.
  assert.equal(r.$('accountPanel').hidden, false);
  assert.equal(r.$('signIn').hidden, false);
  assert.equal(r.$('questionPanel').hidden, true);

  click(r.$('signIn'));
  await settle();
  assert.equal(b.state.authenticated, true);
  assert.equal(r.$('questionPanel').hidden, false);
  assert.equal(r.$('accountPanel').hidden, true);
  assert.equal(r.$('heading').textContent, 'Ask your first question');
  assert.equal(r.$('provider').value, 'gemini');

  typeInto(r.$('question'), 'What is a hash map?');
  setChecked(r.$('consent'), true);
  assert.equal(r.$('submit').disabled, false);

  click(r.$('submit'));
  await settle();
  assert.equal(r.$('successPanel').hidden, false);
  assert.equal(r.$('answerText').textContent, 'A helpful answer.');
  assert.match(r.$('readiness').textContent, /Screen capture and microphone access have not been tested/);
  assert.equal(b.setup.getStatus().capabilities.screen.health, 'untested');
  assert.match(r.$('status').textContent, /finish setup/i);
  assert.equal(r.document.activeElement, r.$('answerHeading'));
  assert.equal(b.state.calls.length, 1);

  click(r.$('finish'));
  await settle();
  assert.equal(b.state.firstRun, false);
  assert.equal(b.state.mainVisible, true);
  assert.equal(b.setup.getStatus().completed, true);
});

test('signing-in state exposes cancel; cancelling before resume never starts a browser sign-in', async t => {
  const gate = deferred();
  const b = backend(t, { state: { signInGate: gate } });
  const r = loadRenderer(b.bridge);
  await settle();
  click(r.$('signIn'));
  await settle();
  // Signing-in: cancel offered, sign-in hidden, browser instruction shown.
  assert.equal(r.$('cancelAuth').hidden, false);
  assert.equal(r.$('signIn').hidden, true);
  assert.match(r.$('accountText').textContent, /browser/i);

  click(r.$('cancelAuth'));
  await settle();
  assert.equal(r.$('accountPanel').hidden, false);
  assert.equal(r.$('signIn').hidden, false);
  assert.match(r.$('status').textContent, /cancelled/i);

  gate.resolve();
  await settle();
  assert.equal(b.state.signInStarted, false);
  assert.equal(b.state.authenticated, false);
  assert.equal(r.$('questionPanel').hidden, true);
});

test('loading state, cancelling a request drops the late answer and warns about allowance', async t => {
  const gate = deferred();
  const b = backend(t, { state: { authenticated: true, answerGate: gate } });
  const r = loadRenderer(b.bridge);
  await settle();
  typeInto(r.$('question'), 'Explain recursion.');
  setChecked(r.$('consent'), true);
  click(r.$('submit'));
  await settle();
  // Loading state.
  assert.equal(r.$('submit').disabled, true);
  assert.equal(r.$('submit').textContent, 'Getting your answer…');
  assert.equal(r.$('cancelWork').hidden, false);
  assert.match(r.$('status').textContent, /Waiting for an answer/i);

  // A duplicate click while busy must not start a second request.
  click(r.$('submit'));
  await settle();
  assert.equal(b.state.calls.length, 1);

  click(r.$('cancelWork'));
  await settle();
  assert.match(r.$('status').textContent, /allowance/i);
  assert.equal(r.$('cancelWork').hidden, true);
  assert.equal(b.state.cancels, 1);

  gate.resolve({ text: 'late answer', requestId: 'late' });
  await settle();
  assert.equal(r.$('successPanel').hidden, true);
  assert.equal(b.setup.getStatus().canComplete, false);
});

test('service failures surface as safe text, disable duplicate sends and allow retry', async t => {
  const b = backend(t, { state: { authenticated: true, answerError: fail('quota_exceeded', 'Your monthly question allowance is used up.') } });
  const r = loadRenderer(b.bridge);
  await settle();
  typeInto(r.$('question'), 'Solve this problem.');
  setChecked(r.$('consent'), true);
  click(r.$('submit'));
  await settle();
  assert.equal(r.$('status').dataset.error, 'true');
  assert.match(r.$('status').textContent, /allowance is used up/i);
  assert.equal(r.$('successPanel').hidden, true);
  // Recovers on retry once the failure clears.
  b.state.answerError = null;
  b.state.answerText = 'Recovered answer.';
  assert.equal(r.$('submit').disabled, false);
  click(r.$('submit'));
  await settle();
  assert.equal(r.$('successPanel').hidden, false);
  assert.equal(r.$('answerText').textContent, 'Recovered answer.');
  assert.equal(b.state.calls.length, 2);
});

test('screenshot flow: capture shows a preview, submit needs consent, discard clears it', async t => {
  const b = backend(t, { state: { authenticated: true } });
  const r = loadRenderer(b.bridge);
  await settle();
  selectValue(r.$('inputMode'), 'screenshot');
  await settle();
  assert.equal(r.$('capturePanel').hidden, false);
  // Display list populated from listDisplays.
  assert.ok(r.$('display').children.some(o => o.value === '1'));
  selectValue(r.$('display'), '1');
  click(r.$('capture'));
  await settle();
  assert.equal(r.$('previewPanel').hidden, false);
  assert.match(r.$('previewImage').src, /^data:image\/png;base64,/);
  assert.equal(b.state.captures, 1);

  typeInto(r.$('question'), 'What does this screen show?');
  // Submit stays disabled until explicit consent.
  assert.equal(r.$('submit').disabled, true);
  setChecked(r.$('consent'), true);
  assert.equal(r.$('submit').disabled, false);

  click(r.$('discard'));
  await settle();
  assert.equal(r.$('previewPanel').hidden, true);
  assert.equal(r.$('consent').checked, false);
  assert.equal(r.$('status').textContent, 'Preview discarded.');
  assert.equal(r.document.activeElement, r.$('capture'));
});

test('resume after reload restores the question and asks for a fresh screenshot, storing no pixels', async t => {
  const b1 = backend(t, { state: { authenticated: true } });
  const r1 = loadRenderer(b1.bridge);
  await settle();
  selectValue(r1.$('inputMode'), 'screenshot');
  await settle();
  typeInto(r1.$('question'), 'Remember this question across restarts.');
  await settle();
  // Simulate a real screenshot preview existing before reload.
  selectValue(r1.$('display'), '1');
  click(r1.$('capture'));
  await settle();
  assert.equal(r1.$('previewPanel').hidden, false);
  r1.window.dispatch('beforeunload');

  const disk = fs.readFileSync(path.join(b1.root, 'setup-state.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(disk)).sort(), ['completed', 'draft', 'inputMode', 'step', 'version']);
  assert.doesNotMatch(disk, /base64|data:image/);

  // Fresh renderer + fresh service over the same on-disk state.
  const b2 = backend(t, { root: b1.root, state: { authenticated: true } });
  const r2 = loadRenderer(b2.bridge);
  await settle();
  assert.equal(r2.$('question').value, 'Remember this question across restarts.');
  assert.equal(r2.$('inputMode').value, 'screenshot');
  assert.equal(r2.$('previewPanel').hidden, true);
  assert.equal(b2.setup.getStatus().hasPreview, false);
  assert.match(r2.$('status').textContent, /not saved|capture a new preview/i);
});

test('direct AI mode is usable without a managed account and labels the mode', async t => {
  const b = backend(t, { state: { mode: 'direct', configured: false, authenticated: false } });
  const r = loadRenderer(b.bridge);
  await settle();
  assert.equal(r.$('questionPanel').hidden, false);
  assert.equal(r.$('accountPanel').hidden, true);
  assert.match(r.$('identity').textContent, /Using your provider settings/i);
  typeInto(r.$('question'), 'A direct-mode question.');
  setChecked(r.$('consent'), true);
  click(r.$('submit'));
  await settle();
  assert.equal(r.$('successPanel').hidden, false);
  assert.equal(r.$('answerText').textContent, 'Direct answer');
  assert.equal(b.state.calls.length, 0);
});

test('recheck on window focus re-reads managed status after an external change', async t => {
  const b = backend(t, { state: { configured: true, authenticated: false } });
  const r = loadRenderer(b.bridge);
  await settle();
  assert.equal(r.$('questionPanel').hidden, true);
  // Account becomes authenticated out of band; focus should surface it.
  b.state.authenticated = true;
  r.window.dispatch('focus');
  await settle();
  assert.equal(r.$('questionPanel').hidden, false);
});
