'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { SetupService } = require('../src/core/setup-service');
const { createDirectSetupAnswer } = require('../src/core/setup-direct-answer');
const { assertTrustedRenderer } = require('../src/core/trusted-renderer');
const { createPlatformAdapter } = require('../src/platform');
const { CaptureService } = require('../src/services/capture.service');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');
const question = { text: 'Explain this example.', provider: 'gemini', consent: true };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, root) {
  root ||= fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-setup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { mode: 'managed', authenticated: true, subject: 'account-1', now: 1000,
    calls: [], captures: 0, cancels: 0, permission: 'granted', bytes: Buffer.from(png),
    providers: ['gemini', 'deepseek'], configured: true };
  state.displays = [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1, rotation: 0 }];
  const electron = { screen: { getAllDisplays: () => state.displays, getPrimaryDisplay: () => state.displays[0] },
    desktopCapturer: { getSources() {} }, systemPreferences: { getMediaAccessStatus: () => state.permission } };
  const adapter = createPlatformAdapter({ electron, platform: 'darwin' });
  const capture = { platformAdapter: adapter,
    listDisplays: () => ({ success: true, ...adapter.getDisplayLayout() }),
    captureAndProcess: async options => {
      state.captures++; state.options = options;
      if (state.captureGate) await state.captureGate.promise;
      if (state.captureError) { adapter.reportOperation('screen', { success: false }); throw state.captureError; }
      adapter.reportOperation('screen', { success: true });
      return { imageBuffer: state.bytes, mimeType: 'image/png' };
    } };
  const manager = { status: () => ({ configured: state.configured, authenticated: state.authenticated,
    signingIn: Boolean(state.signingIn), persistence: 'session_only', account: state.authenticated ? { subject: state.subject, providers: state.providers } : null }),
    answer: async payload => { state.calls.push(payload); if (state.answerGate) return state.answerGate.promise; if (state.answerError) throw state.answerError;
      return { requestId: 'fixture-request', text: state.answerText ?? 'A useful answer.' }; },
    cancelAll: () => { state.cancels++; },
    signOut: async () => { state.authenticated = false; state.signingIn = false; } };
  const options = { userDataPath: root, platformAdapter: adapter, captureService: capture, managedSession: manager,
    getAIMode: () => state.mode, now: () => state.now, answer: async payload => { state.direct = payload; return { text: 'Direct answer', requestId: 'direct-request' }; } };
  return { root, state, adapter, capture, manager, options, setup: new SetupService(options) };
}

test('permission and text success never claim screen health; only an answer allows completion', async t => {
  const f = fixture(t);
  assert.equal(f.setup.getStatus().capabilities.screen.health, 'untested');
  assert.throws(() => f.setup.complete(), { code: 'ANSWER_REQUIRED' });
  f.setup.saveProgress({ completed: true, step: 'complete', draft: 'draft', inputMode: 'text', answer: 'forged' });
  assert.equal(f.setup.getStatus().completed, false);
  await f.setup.submit(question);
  assert.equal(f.setup.getStatus().capabilities.screen.health, 'untested');
  assert.equal(f.setup.complete().completed, true);
  assert.equal(f.setup.getStatus().draft, '');
});

test('bounded versioned progress survives restart without images, tokens, answers or health', async t => {
  const f = fixture(t);
  f.setup.saveProgress({ step: 'question', draft: 'remember this question', inputMode: 'screenshot', token: 'SECRET', image: png, completed: true });
  await f.setup.capturePreview();
  const disk = fs.readFileSync(path.join(f.root, 'setup-state.json'), 'utf8');
  assert.doesNotMatch(disk, /SECRET|base64|healthy|preview|answer|token/);
  assert.equal(Object.keys(JSON.parse(disk)).length, 5);
  assert.equal(fs.readdirSync(f.root).length, 1);
  const restored = fixture(t, f.root).setup;
  assert.equal(restored.getStatus().draft, 'remember this question');
  assert.equal(restored.getStatus().step, 'question');
  assert.equal(restored.getStatus().inputMode, 'screenshot');
  assert.equal(restored.getStatus().capabilities.screen.health, 'untested');
  assert.equal(restored.getStatus().hasPreview, false);
  assert.throws(() => restored.saveProgress({ draft: 'x'.repeat(16001) }), { code: 'INPUT_LIMIT' });
  await f.setup.submit(question);
  f.setup.complete();
  assert.equal(new SetupService(f.options).getStatus().completed, true);
  assert.doesNotMatch(fs.readFileSync(f.setup.filename, 'utf8'), /A useful answer|fixture-request/);
});

test('corrupt, oversized and unknown-version state reset safely; legacy sentinel imports only absent state', t => {
  const f = fixture(t);
  for (const contents of ['{', 'null', JSON.stringify({ version: 99, completed: true }), JSON.stringify({ version: 1, completed: true, step: 'question', draft: {}, inputMode: 'text' }), 'x'.repeat(100000)]) {
    fs.writeFileSync(f.setup.filename, contents);
    assert.equal(new SetupService({ ...f.options, legacyCompleted: true }).getStatus().completed, false);
  }
  fs.rmSync(f.setup.filename);
  assert.equal(new SetupService({ ...f.options, legacyCompleted: true }).getStatus().completed, true);
  assert.equal(new SetupService(f.options).getStatus().completed, false);
});

test('atomic write failure leaves prior progress intact and removes staging files', t => {
  const f = fixture(t);
  f.setup.saveProgress({ draft: 'old question', step: 'question' });
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk rename failed'); });
  assert.throws(() => f.setup.saveProgress({ draft: 'new question' }), /disk rename failed/);
  assert.equal(f.setup.getStatus().draft, 'old question');
  assert.equal(JSON.parse(fs.readFileSync(f.setup.filename)).draft, 'old question');
  assert.deepEqual(fs.readdirSync(f.root), ['setup-state.json']);
});

test('preview is local; only exact retained bytes upload after explicit consent', async t => {
  const f = fixture(t);
  const preview = await f.setup.capturePreview();
  assert.equal(preview.width, 1); assert.equal(preview.height, 1);
  assert.match(preview.id, /^[a-f0-9]{64}$/);
  assert.equal(f.state.calls.length, 0);
  const expected = Buffer.from(preview.dataUrl.split(',')[1], 'base64');
  // A capture provider cannot mutate the retained preview after returning it.
  f.state.bytes.fill(0);
  for (const consent of [false, undefined, 'true', 1]) {
    await assert.rejects(f.setup.submit({ ...question, previewId: preview.id, consent }), { code: 'CONSENT_REQUIRED' });
  }
  await assert.rejects(f.setup.submit({ ...question, previewId: preview.id, provider: 'deepseek' }), { code: 'image_not_supported' });
  await assert.rejects(f.setup.submit({ ...question, image: { data: 'injected' } }), { code: 'INVALID_REQUEST' });
  assert.equal(f.state.calls.length, 0);
  await f.setup.submit({ ...question, previewId: preview.id });
  assert.deepEqual(f.state.calls[0].image, { mimeType: 'image/png', data: expected.toString('base64') });
  assert.equal(f.state.captures, 1);
});

test('preview limits, expiry, recapture and display changes require a new preview', async t => {
  const f = fixture(t);
  const first = await f.setup.capturePreview();
  const second = await f.setup.capturePreview();
  await assert.rejects(f.setup.submit({ ...question, previewId: first.id }), { code: 'STALE_PREVIEW' });
  f.state.now += 300001;
  await assert.rejects(f.setup.submit({ ...question, previewId: second.id }), { code: 'STALE_PREVIEW' });
  const third = await f.setup.capturePreview();
  f.state.displays[0].scaleFactor = 2;
  await assert.rejects(f.setup.submit({ ...question, previewId: third.id }), { code: 'STALE_DISPLAY_LAYOUT' });
  f.state.bytes = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
  await assert.rejects(f.setup.capturePreview(), { code: 'IMAGE_LIMIT' });
  assert.equal(f.state.calls.length, 0);
});

test('permission denial and revocation prevent capture/upload; recovery really captures', async t => {
  const f = fixture(t);
  f.state.permission = 'denied';
  await assert.rejects(f.setup.capturePreview(), { code: 'SCREEN_PERMISSION_DENIED' });
  assert.equal(f.state.captures, 0);
  assert.equal(f.setup.getStatus().capabilities.screen.health, 'untested');
  f.state.permission = 'granted';
  assert.equal(f.setup.getStatus().capabilities.screen.health, 'untested');
  const preview = await f.setup.capturePreview();
  assert.equal(f.setup.getStatus().capabilities.screen.health, 'healthy');
  f.state.permission = 'restricted';
  assert.equal(f.setup.getStatus().capabilities.screen.health, 'untested');
  await assert.rejects(f.setup.submit({ ...question, previewId: preview.id }), { code: 'SCREEN_PERMISSION_DENIED' });
  assert.equal(f.state.calls.length, 0);
  f.state.permission = 'granted';
  assert.equal(f.setup.getStatus().capabilities.screen.health, 'untested');
  await f.setup.capturePreview();
  assert.equal(f.setup.getStatus().capabilities.screen.health, 'healthy');
});

test('capture failures and invalid selections never reuse the previous image', async t => {
  const f = fixture(t);
  const preview = await f.setup.capturePreview();
  f.state.captureError = new Error('capture unavailable');
  await assert.rejects(f.setup.capturePreview(), /capture unavailable/);
  await assert.rejects(f.setup.submit({ ...question, previewId: preview.id }), { code: 'STALE_PREVIEW' });
  for (const options of [null, [], { displayId: {} }, { displayId: 99 }, { layoutRevision: 'old' }, { area: null }, { areaCoordinateSpace: 'invalid' }, { imageBuffer: png }]) {
    await assert.rejects(f.setup.capturePreview(options));
  }
  f.state.captureError = null;
  assert.ok((await f.setup.capturePreview()).id);
});

test('cancel rejects pending capture immediately and drops its late result', async t => {
  const f = fixture(t);
  f.state.captureGate = deferred();
  const pending = f.setup.capturePreview();
  const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await f.setup.cancel();
  await rejected;
  f.state.captureGate.resolve(); await tick();
  assert.equal(f.setup.getStatus().hasPreview, false);
  assert.equal(f.setup.getStatus().canComplete, false);
});

test('concurrent requests block; cancel rejects immediately and late answers cannot win', async t => {
  const f = fixture(t);
  f.state.answerGate = deferred();
  const pending = f.setup.submit(question);
  const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await assert.rejects(f.setup.submit(question), { code: 'SETUP_BUSY' });
  await assert.rejects(f.setup.capturePreview(), { code: 'SETUP_BUSY' });
  await f.setup.cancel(); await rejected;
  const late = f.state.answerGate; f.state.answerGate = null;
  await f.setup.submit({ ...question, text: 'new question' });
  late.resolve({ text: 'stale answer', requestId: 'stale' }); await tick();
  assert.equal(f.setup.getStatus().requestId, 'fixture-request');
  assert.equal(f.setup.getStatus().draft, 'new question');
  assert.equal(f.state.calls.length, 2);
  assert.equal(f.state.cancels, 1);
});

test('signout, account replacement, AI mode and input mode discard in-flight results', async t => {
  for (const change of [f => { f.state.authenticated = false; }, f => { f.state.subject = 'other'; }, f => { f.state.mode = 'direct'; }, f => f.setup.saveProgress({ inputMode: 'screenshot' })]) {
    const f = fixture(t);
    f.state.answerGate = deferred();
    const pending = f.setup.submit(question); const rejected = assert.rejects(pending, { code: 'CANCELLED' });
    change(f);
    f.state.answerGate.resolve({ text: 'stale', requestId: 'stale' });
    await rejected;
    assert.equal(f.setup.getStatus().canComplete, false);
    assert.throws(() => f.setup.complete(), { code: 'ANSWER_REQUIRED' });
  }
});

test('empty answers, service failures, provider and text validation never mark completion or retry', async t => {
  const f = fixture(t);
  for (const input of [null, {}, { ...question, text: '' }, { ...question, text: 'x'.repeat(16001) }, { ...question, provider: 'other' }]) await assert.rejects(f.setup.submit(input));
  f.state.providers = ['deepseek'];
  await assert.rejects(f.setup.submit(question), { code: 'INVALID_PROVIDER' });
  f.state.providers = ['gemini']; f.state.configured = false;
  await assert.rejects(f.setup.submit(question), { code: 'not_configured' });
  f.state.configured = true; f.state.authenticated = false;
  await assert.rejects(f.setup.submit(question), { code: 'signed_out' });
  assert.equal(f.state.calls.length, 0);
  f.state.authenticated = true; f.state.answerText = '  ';
  await assert.rejects(f.setup.submit(question), { code: 'EMPTY_ANSWER' });
  f.state.answerError = Object.assign(new Error('quota reached'), { code: 'quota_exceeded' });
  await assert.rejects(f.setup.submit(question), { code: 'quota_exceeded' });
  assert.equal(f.state.calls.length, 2);
  assert.equal(f.setup.getStatus().draft, question.text);
  assert.throws(() => f.setup.complete(), { code: 'ANSWER_REQUIRED' });
  f.state.answerError = null; f.state.answerText = 'recovered';
  assert.equal((await f.setup.submit(question)).text, 'recovered');
});

test('direct mode uses injected answer without managed authentication', async t => {
  const f = fixture(t); f.state.mode = 'direct'; f.state.authenticated = false; f.state.configured = false;
  assert.equal((await f.setup.submit(question)).text, 'Direct answer');
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.direct.text, question.text);
  assert.equal(f.setup.complete().completed, true);
});

test('direct Gemini forwards question and exact bytes once with retries disabled and abort signal', async () => {
  const calls = [];
  const llmService = { isInitialized: true, provider: 'gemini', model: 'configured-model', client: { models: { generateContent: async payload => { calls.push(payload); return { text: 'answer' }; } } }, extractTextFromCandidates: result => result };
  const answer = createDirectSetupAnswer({ llmService });
  const image = { mimeType: 'image/png', data: png.toString('base64') };
  assert.equal((await answer({ ...question, image })).text, 'answer');
  assert.deepEqual(calls[0].contents[0].parts, [{ text: question.text }, { inlineData: image }]);
  assert.equal(calls[0].config.httpOptions.retryOptions.attempts, 1);
  assert.ok(calls[0].config.abortSignal);
  llmService.client.models.generateContent = async () => { calls.push('failed'); throw new Error('network https://provider.invalid?key=SECRET'); };
  await assert.rejects(answer(question), error => { assert.equal(error.code, 'DIRECT_REQUEST_FAILED'); assert.doesNotMatch(error.message, /SECRET|provider.invalid/); return true; });
  assert.equal(calls.length, 2);
});

test('direct DeepSeek uses configured credentials once without managed sign-in or retries', async () => {
  let calls = 0;
  const answer = createDirectSetupAnswer({ llmService: { isInitialized: true, provider: 'deepseek', deepseekClient: {
    baseUrl: 'https://provider.invalid', apiKey: 'existing-key', buildChatBody: request => ({ model: 'configured-model', request }) } },
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'https://provider.invalid/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer existing-key'); assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'direct response' } }] }), { headers: { 'Content-Type': 'application/json' } });
    } });
  assert.equal((await answer({ ...question, provider: 'deepseek' })).text, 'direct response');
  assert.equal(calls, 1);
});

// Exercise the real controller methods without starting Electron or native helpers.
function ipcFixture(t) {
  const f = fixture(t);
  const root = path.resolve(__dirname, '..');
  const handlers = new Map(); const listeners = new Map();
  const window = new EventEmitter(); window.webContents = {}; window.isDestroyed = () => false;
  const wm = { windows: new Map([['onboarding', window]]), getWindow: name => name === 'onboarding' ? window : null,
    showOnboarding: async () => window, showMainWindow: async () => { f.state.mainVisible = true; },
    closeOnboarding: () => { window.emit('closed'); }, broadcastToAllWindows() {}, hideLLMResponse() {} };
  const electron = { BrowserWindow: { getAllWindows: () => [] } };
  const context = { console, Buffer, setTimeout, clearTimeout, path, fs, fileURLToPath, process: { env: {} },
    app: { getAppPath: () => root }, ipcMain: { handle: (name, fn) => { assert.ok(!handlers.has(name), name); handlers.set(name, fn); }, on: (name, fn) => listeners.set(name, fn) },
    windowManager: wm, captureService: f.capture, assertTrustedRenderer,
    speechService: { initializeClient() {}, isAvailable: () => false, stopRecording() {}, cancelRecording() { f.state.voiceCancelled = true; } }, sessionManager: { clear() {} },
    logger: { warn() {}, info() {}, error() {} }, require: name => { assert.equal(name, 'electron'); return electron; } };
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const code = source.slice(source.indexOf('class ApplicationController {'), source.indexOf('const gotSingleInstanceLock'));
  const Controller = vm.runInNewContext(`${code}\nApplicationController`, context);
  const controller = Object.create(Controller.prototype);
  Object.assign(controller, { operationEpoch: 0, setupService: f.setup, managedSession: f.manager, platformAdapter: f.adapter,
    firstRunManager: { getStatus: () => ({ sentinelExists: Boolean(f.state.legacy), needsOnboarding: true }) } });
  controller.setupIPCHandlers();
  const frame = { url: pathToFileURL(path.join(root, 'onboarding.html')).href };
  const trusted = { senderFrame: frame, sender: { mainFrame: frame } };
  return { ...f, controller, handlers, listeners, context, window, trusted, invoke: (channel, input) => handlers.get(channel)(trusted, input) };
}

test('all setup IPC and legacy completion aliases reject untrusted pages and subframes', async t => {
  const f = ipcFixture(t);
  const channels = ['take-screenshot', 'open-external', 'managed-status', 'get-setup-state', 'save-setup-progress', 'capture-setup-preview', 'submit-setup-question', 'cancel-setup', 'show-onboarding', 'setup-test-answer', 'complete-first-run', 'close-onboarding', 'get-first-run-status', 'setup-capabilities', 'setup-permission', 'setup-permission-settings', 'managed-sign-in', 'managed-sign-out', 'list-displays', 'capture-area'];
  for (const channel of channels) {
    const remote = { url: 'https://attacker.invalid/onboarding.html' };
    for (const event of [{}, { senderFrame: remote, sender: { mainFrame: remote } }, { senderFrame: f.trusted.senderFrame, sender: { mainFrame: {} } }]) {
      await assert.rejects(f.handlers.get(channel)(event, question), /Untrusted/);
    }
  }
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.captures, 0); assert.equal(f.state.cancels, 0);
});

test('IPC no longer grants first-run completion after sign-in or a greeting-only test', async t => {
  const f = ipcFixture(t);
  assert.equal((await f.invoke('complete-first-run')).success, false);
  assert.equal((await f.invoke('setup-test-answer')).success, false);
  assert.equal(f.state.calls.length, 0);
  const reply = await f.invoke('submit-setup-question', question);
  assert.equal(reply.text, 'A useful answer.');
  assert.equal((await f.invoke('complete-first-run')).success, true);
  assert.equal(f.state.mainVisible, true);
});

test('close and native close show main; idle cancellation does not reveal another window', async t => {
  const f = ipcFixture(t);
  await f.invoke('show-onboarding');
  f.state.signingIn = true;
  f.controller._setupSignInEpoch = f.controller.operationEpoch;
  await f.invoke('cancel-setup');
  assert.equal(f.state.signingIn, false);
  assert.equal(f.state.mainVisible, undefined);
  f.state.mainVisible = false;
  await f.invoke('close-onboarding');
  assert.equal(f.state.mainVisible, true);
  f.state.mainVisible = false;
  f.window.emit('closed'); await tick();
  assert.equal(f.state.mainVisible, true);
});

test('cancel before the sign-in handler resumes cannot start a delayed browser sign-in', async t => {
  const f = ipcFixture(t);
  let started = false;
  f.manager.signIn = async () => { started = true; return f.manager.status(); };
  const pending = f.invoke('managed-sign-in');
  await f.invoke('cancel-setup');
  assert.equal((await pending).success, false);
  assert.equal(started, false);
});

test('mode/account invalidation stops authentication as well as answer work', async t => {
  const f = ipcFixture(t);
  f.state.signingIn = true;
  await f.controller.invalidateManagedWork();
  assert.equal(f.state.voiceCancelled, true);
  assert.equal(f.state.signingIn, false);
  assert.equal(f.state.authenticated, false);
  assert.equal(f.state.cancels, 1);
});

test('signout IPC invalidates pending preview/answer; mode changes invalidate before settings persist', async t => {
  const f = ipcFixture(t);
  f.state.answerGate = deferred();
  const pending = f.invoke('submit-setup-question', question);
  await f.invoke('managed-sign-out');
  f.state.answerGate.resolve({ text: 'stale' });
  assert.equal((await pending).success, false);
  assert.equal(f.setup.getStatus().canComplete, false);
  f.controller.invalidateManagedWork = async () => { f.state.invalidated = true; await f.setup.cancel(); };
  f.controller.persistEnvUpdates = () => { assert.equal(f.state.invalidated, true); return true; };
  // Mode selection is tested through the actual saveSettings path; later unrelated
  // speech/client initialization may be unavailable in this isolated controller.
  f.controller.saveSettings({ aiMode: 'direct' });
  assert.equal(f.state.invalidated, true);
});

test('legacy sentinel preserves direct mode and completion without requiring another key', t => {
  const f = ipcFixture(t);
  f.state.legacy = true;
  assert.equal(f.controller.getAIMode(), 'direct');
  f.context.process.env.AI_MODE = 'managed';
  assert.equal(f.controller.getAIMode(), 'managed');
  f.state.authenticated = false;
  assert.equal(new SetupService({ ...f.options, legacyCompleted: true }).getStatus().completed, true);
});

test('preload invokes the narrow setup channels without exposing IPC', () => {
  let api; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../preload.js'), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'electronAPI') api = value; } },
    ipcRenderer: { invoke: (...args) => calls.push(args), on() {} }
  }), console });
  for (const [method, channel] of Object.entries({ getSetupState: 'get-setup-state', saveSetupProgress: 'save-setup-progress', captureSetupPreview: 'capture-setup-preview', submitSetupQuestion: 'submit-setup-question', cancelSetup: 'cancel-setup', showOnboarding: 'show-onboarding' })) {
    api[method](question); assert.equal(calls.at(-1)[0], channel);
  }
  assert.equal(api.ipcRenderer, undefined);
});

test('setup and real capture share operation health on the same platform adapter', async t => {
  const f = fixture(t);
  const image = { getSize: () => ({ width: 1, height: 1 }), isEmpty: () => false, crop() { return this; }, toPNG: () => png };
  f.adapter.electron.desktopCapturer.getSources = async () => [{ display_id: '1', thumbnail: image }];
  const capture = new CaptureService({ electron: f.adapter.electron, platformAdapter: f.adapter, logger: { logPerformance() {} } });
  const setup = new SetupService({ ...f.options, captureService: capture });
  await capture.captureAndProcess({ area: { x: 0, y: 0, width: 1, height: 1 } });
  assert.equal(setup.getStatus().capabilities.screen.health, 'healthy');
  f.state.permission = 'denied';
  await assert.rejects(setup.capturePreview(), { code: 'SCREEN_PERMISSION_DENIED' });
  assert.equal(capture.platformAdapter.checkCapability('screen').health, 'untested');
});


test('setup validation does not fabricate a capture failure or operation timestamp', async t => {
  const f = fixture(t);
  await f.setup.capturePreview();
  const before = f.adapter.checkCapability('screen');
  await assert.rejects(f.setup.capturePreview({ area: { x: 0, y: 0, width: 1, height: 1 } }), { code: 'STALE_DISPLAY_LAYOUT' });
  assert.equal(f.state.captures, 1);
  assert.equal(f.adapter.checkCapability('screen').lastOperationAt, before.lastOperationAt);
  assert.equal(f.adapter.checkCapability('screen').health, 'healthy');
  f.state.permission = 'denied';
  assert.equal(f.setup.getStatus().capabilities.screen.health, 'untested');
  assert.equal(f.adapter.checkCapability('screen').lastOperationAt, before.lastOperationAt);
});

test('idle setup cancellation leaves unrelated managed work running', async t => {
  const f = fixture(t);
  await f.setup.cancel();
  assert.equal(f.state.cancels, 0);
});

test('settings secrets only reach the trusted settings page', async t => {
  const f = ipcFixture(t);
  f.controller.getSettings = () => ({ geminiKey: 'SECRET1', deepseekKey: 'SECRET2', azureKey: 'SECRET3', aiMode: 'direct' });
  assert.deepEqual(Object.keys(await f.invoke('get-settings')), ['aiMode']);
  const frame = { url: pathToFileURL(path.resolve(__dirname, '../settings.html')).href };
  assert.equal((await f.handlers.get('get-settings')({ senderFrame: frame, sender: { mainFrame: frame } })).geminiKey, 'SECRET1');
  assert.throws(() => f.handlers.get('get-settings')({}), /Untrusted/);
});

test('completed managed setup prompts for an expired session on restart', t => {
  const f = ipcFixture(t);
  f.controller.setupService = { getStatus: () => ({ completed: true, aiMode: 'managed', managed: { authenticated: false } }) };
  assert.equal(f.controller.getSetupStatus().needsOnboarding, true);
});


test('idle setup close preserves a sign-in started in Settings and the shared operation epoch', async t => {
  const f = ipcFixture(t);
  const gate = deferred(); let started = false;
  f.manager.signIn = async () => { started = true; f.state.signingIn = true; await gate.promise; f.state.signingIn = false; return f.manager.status(); };
  const frame = { url: pathToFileURL(path.resolve(__dirname, '../settings.html')).href };
  const pending = f.handlers.get('managed-sign-in')({ senderFrame: frame, sender: { mainFrame: frame } });
  await tick(); assert.equal(started, true);
  const before = f.controller.operationEpoch;
  await f.invoke('close-onboarding');
  assert.equal(f.state.signingIn, true);
  assert.equal(f.controller.operationEpoch, before);
  gate.resolve();
  assert.notEqual((await pending).success, false);
});
