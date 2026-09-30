'use strict';

// V4.1: successful repair must not throttle a fresh external topmost loss.
// Real controller entry points + real WindowManager, with Electron/OS outputs
// replaced at the process boundary. No installed application or browser starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, { rootMode = true, completed = true, platform = 'win32' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-09-26T20:00:00Z') });
  const advance = async ms => {
    for (let elapsed = 0; elapsed < ms; elapsed += 25) {
      for (let n = 0; n < 20; n++) await Promise.resolve();
      t.mock.timers.tick(Math.min(25, ms - elapsed));
    }
    for (let n = 0; n < 20; n++) await Promise.resolve();
  };
  const timers = new Set();
  const intervals = new Set();
  const shortcuts = new Map();
  const handlers = new Map();
  const errors = [];
  const windows = [];
  const records = [];
  const nativeCalls = [];
  const forbiddenReads = [];
  const logger = { info: (message, data) => records.push({ message, data: structuredClone(data), at: Date.now() }),
    debug() {}, warn: (message, data) => records.push({ level: 'warn', message, data: structuredClone(data), at: Date.now() }),
    error: (...args) => errors.push(args) };
  const timed = (fn, ms, ...args) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms);
    timers.add(timer);
    return timer;
  };
  const repeating = (fn, ms) => { const timer = setInterval(fn, ms); intervals.add(timer); return timer; };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.id = windows.length + 1;
      this.visible = Boolean(options.show);
      this.destroyed = false;
      this.minimized = false;
      this.webContentsDestroyed = false;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.transitions = [];
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { send() {}, setWindowOpenHandler() {}, getURL: () => `file:///${this.file}` });
      this.webContents.isDestroyed = () => this.webContentsDestroyed;
      this.webContents.isCrashed = () => false;
      this.webContents.executeJavaScript = () => { forbiddenReads.push('executeJavaScript'); throw Error('Content reads forbidden'); };
      windows.push(this);
    }
    static getAllWindows() { return windows.filter(win => !win.destroyed); }
    async loadFile(file) { this.file = file; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    isFocused() { return false; }
    isMinimized() { return this.minimized; }
    getNativeWindowHandle() { const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(1000 + this.id)); return handle; }
    getTitle() { forbiddenReads.push('getTitle'); throw Error('Titles forbidden'); }
    capturePage() { forbiddenReads.push('capturePage'); throw Error('Pixels forbidden'); }
    isAlwaysOnTop() { return this.topmost; }
    show() { this.showInactive(); }
    showInactive() { nativeCalls.push({ id: this.id, method: 'show', at: Date.now() }); if (!this.visible) this.transitions.push('show'); this.visible = true; this.emit('show'); }
    hide() { nativeCalls.push({ id: this.id, method: 'hide', at: Date.now() }); if (this.visible) this.transitions.push('hide'); this.visible = false; this.emit('hide'); }
    focus() { nativeCalls.push({ id: this.id, method: 'focus', at: Date.now() }); }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    getBounds() { return { ...this.bounds }; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    getSize() { return [this.bounds.width, this.bounds.height]; }
    getContentSize() { return this.getSize(); }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
    setSize(width, height) { Object.assign(this.bounds, { width, height }); }
    setContentSize(width, height) { this.setSize(width, height); }
    setAlwaysOnTop(value) {
      nativeCalls.push({ id: this.id, method: 'topmost', value, at: Date.now() });
      if (this.repairFailure === 'throw') throw new Error('QA: native topmost request rejected');
      if (this.repairFailure !== 'ignore') this.topmost = value;
    }
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    setSkipTaskbar() {}
    setContentProtection() {}
    setMinimumSize() {}
    setTitle() {}
  }
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ x: 800, y: 500 })
  });
  const app = Object.assign(new EventEmitter(), { setName() {}, getPath: () => __dirname, getAppPath: () => root,
    whenReady: () => new Promise(() => {}),
    quit() { errors.push('unexpected app.quit'); } });
  const electron = { BrowserWindow, screen, app, powerMonitor: new EventEmitter(),
    ipcMain: Object.assign(new EventEmitter(), { handle: (name, fn) => handlers.set(name, fn) }),
    globalShortcut: { register: (name, fn) => { shortcuts.set(name, fn); return true; },
      isRegistered: name => shortcuts.has(name), unregister: name => shortcuts.delete(name), unregisterAll: () => shortcuts.clear() } };
  const config = { get: key => key === 'window.webPreferences' ? {} : undefined };
  const base = { console, Buffer, setTimeout: timed, clearTimeout, setInterval: repeating, clearInterval,
    process: { platform, env: {}, title: '' }, Date, performance, path, logger, config };
  const managerFile = path.join(root, 'src/managers/window.manager.js');
  const nativeRequire = createRequire(managerFile);
  const managerContext = { ...base, module: { exports: {} }, __dirname: path.dirname(managerFile),
    require: name => name === 'electron' ? electron : name === '../core/logger' ? { createServiceLogger: () => logger }
      : name === '../core/config' ? config : nativeRequire(name) };
  vm.runInNewContext(fs.readFileSync(managerFile, 'utf8'), managerContext, { filename: managerFile });
  const manager = managerContext.module.exports;
  class FirstRunManager { ensureEnv() {} getStatus() { return { sentinelExists: completed }; } }
  class SetupService {
    getStatus() { return { completed, aiMode: 'direct' }; }
    complete() { completed = true; }
    invalidate() {}
  }
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const start = source.indexOf('class ApplicationController {');
  const end = source.indexOf('const gotSingleInstanceLock');
  assert(start >= 0 && end > start, 'controller load boundary is available');
  const context = { ...base, ...electron, windowManager: manager, FirstRunManager, SetupService,
    PRIVILEGE: { isRoot: rootMode, detail: 'QA fixture' }, ENV_PATH: path.join(__dirname, '.unused-env'),
    captureService: { platformAdapter: {} }, speechService: { initializeClient() {}, isAvailable: () => false, shutdown() {} },
    llmService: {}, sessionManager: { addEvent() {}, getMemoryUsage: () => ({ eventCount: 0, approximateSize: 0 }) },
    createManagedManager: () => ({ restore: async () => {}, status: () => ({ authenticated: false }), cancelAll() {} }),
    createDirectSetupAnswer: () => () => {}, attachManagedSession() {}, assertTrustedRenderer() {},
    require: name => name === 'electron' ? electron : createRequire(path.join(root, 'main.js'))(name) };
  const Controller = vm.runInNewContext(source.slice(start, end) + '\nApplicationController', context, { filename: 'main.js' });
  // Irrelevant boot services are disconnected. Startup visibility, shortcuts,
  // onboarding status/completion, IPC registration and every manager method run unchanged.
  for (const name of ['setupStealth', 'setupMicrophoneCapture', 'setupServiceEventHandlers', 'setupWhisperModelPreparation',
    'setupPermissions', 'setupNetworkConfiguration', 'updateAppIcon']) Controller.prototype[name] = function () {};
  const controller = new Controller();
  t.after(() => {
    manager.destroyAllWindows();
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
  });
  return { manager, controller, errors, records, nativeCalls, advance, app, forbiddenReads,
    async boot() {
      const pending = controller.onAppReady();
      await advance(2000);
      await pending;
      assert.deepEqual(errors, [], 'startup reaches application readiness without fixture errors');
      assert.equal(controller.isReady, true);
      manager.showWindow('chat'); // Explicitly enter the visible-chat state under test.
      await advance(600); // Flush the native show's delayed topmost follow-up.
    },
    async key(name) {
      assert.equal(typeof shortcuts.get(name), 'function', `${name} registered with Electron`);
      await shortcuts.get(name)();
    },
    async invoke(name, type = 'chat') {
      assert.equal(typeof handlers.get(name), 'function', `${name} IPC registered`);
      return handlers.get(name)({ sender: manager.getWindow(type)?.webContents,
        senderFrame: { url: `file:///${type}.html` } });
    }
  };
}

const attempts = (f, window) => f.nativeCalls.filter(call => call.method === 'topmost' && call.id === window.id);
const disruptive = f => f.nativeCalls.filter(call => ['hide', 'show', 'focus'].includes(call.method));

test('fresh topmost loss 100 ms after success is repaired by a forced visibility check without stale cooldown', async t => {
    const f = fixture(t);
    await f.boot();
    f.nativeCalls.length = 0;
    const windows = ['main', 'chat'].map(type => f.manager.getWindow(type));
    windows.forEach(window => { window.topmost = false; });
    f.controller.recordRootVisibilitySnapshot('shortcut');
    for (const window of windows) {
      assert.equal(window.isAlwaysOnTop(), true, 'first native repair succeeded');
      assert.equal(attempts(f, window).length, 1);
    }
    await f.advance(100);
    windows.forEach(window => { window.topmost = false; });
    f.controller.recordRootVisibilitySnapshot('shortcut');
    for (const window of windows) {
      assert.equal(window.isAlwaysOnTop(), true, 'forced repair must not be delayed by the previous success');
      assert.equal(attempts(f, window).length, 2, 'each separate loss gets one successful repair');
      assert.equal(window.isVisible(), true);
    }
    assert.deepEqual(disruptive(f), [], 'fresh recovery does not hide/show/focus windows');
});

test('observer backs off during a recurring demotion instead of fighting every strip', async t => {
  const f = fixture(t);
  await f.boot();
  f.nativeCalls.length = 0;
  const windows = ['main', 'chat'].map(type => f.manager.getWindow(type));
  windows.forEach(window => { window.topmost = false; });
  f.controller.recordRootVisibilitySnapshot('shortcut');
  for (const window of windows) {
    assert.equal(window.isAlwaysOnTop(), true, 'first native repair succeeded');
    assert.equal(attempts(f, window).length, 1);
  }
  // The exam app strips topmost again shortly after: the observer must NOT
  // immediately re-fight, or the chat flickers at the exam's ~1 Hz cadence.
  await f.advance(100);
  windows.forEach(window => { window.topmost = false; });
  await f.advance(1000);
  for (const window of windows) {
    assert.equal(window.isAlwaysOnTop(), false, 'observer backs off while the war backoff is active');
    assert.equal(attempts(f, window).length, 1, 'no re-assert inside the backoff window');
  }
  // Once the backoff elapses the observer re-asserts exactly once.
  await f.advance(5000);
  for (const window of windows) {
    assert.equal(window.isAlwaysOnTop(), true, 'observer re-asserts after the backoff elapses');
    assert.equal(attempts(f, window).length, 2);
    assert.equal(window.isVisible(), true);
  }
  assert.deepEqual(disruptive(f), [], 'observer repair does not hide/show/focus windows');
});

for (const failure of ['ignore', 'throw']) {
  test(`unsuccessful native repair (${failure}) shares two-second backoff across forced checks and observer`, async t => {
    const f = fixture(t);
    await f.boot();
    f.nativeCalls.length = 0;
    const windows = ['main', 'chat'].map(type => f.manager.getWindow(type));
    for (const window of windows) {
      window.topmost = false;
      window.repairFailure = failure;
    }
    f.controller.recordRootVisibilitySnapshot('shortcut');
    for (const window of windows) assert.equal(attempts(f, window).length, 1);
    for (let n = 0; n < 70; n++) {
      await f.advance(30);
      f.controller.recordRootVisibilitySnapshot('shortcut');
    }
    for (const window of windows) {
      const calls = attempts(f, window);
      assert.equal(calls.length, 2, 'one initial failure plus one bounded retry in 2.1 seconds');
      assert(calls[1].at - calls[0].at >= 2000, 'native failures retain their retry cooldown');
      assert.equal(window.isAlwaysOnTop(), false);
      assert.equal(window.isVisible(), true);
    }
    assert.deepEqual(disruptive(f), []);
  });
}
