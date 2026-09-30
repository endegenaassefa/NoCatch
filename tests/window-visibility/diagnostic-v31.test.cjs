'use strict';

// V3.1 diagnostic regressions for the independent review findings.
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
      this.focusCalls = 0;
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
    focus() { this.focusCalls += 1; }
    isMinimized() { return this.minimized; }
    getNativeWindowHandle() { const handle = Buffer.alloc(8); handle.writeBigUInt64LE(BigInt(1000 + this.id)); return handle; }
    getTitle() { forbiddenReads.push('getTitle'); throw Error('Titles forbidden'); }
    capturePage() { forbiddenReads.push('capturePage'); throw Error('Pixels forbidden'); }
    isAlwaysOnTop() { return this.topmost; }
    show() { this.showInactive(); }
    showInactive() { if (!this.visible) this.transitions.push('show'); this.visible = true; this.emit('show'); }
    hide() { if (this.visible) this.transitions.push('hide'); this.visible = false; this.emit('hide'); }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    getBounds() { return { ...this.bounds }; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    getSize() { return [this.bounds.width, this.bounds.height]; }
    getContentSize() { return this.getSize(); }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
    setSize(width, height) { Object.assign(this.bounds, { width, height }); }
    setContentSize(width, height) { this.setSize(width, height); }
    setAlwaysOnTop(value) { this.topmost = value; }
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
  return { manager, controller, errors, records, advance, app, forbiddenReads,
    async boot() {
      const pending = controller.onAppReady();
      await advance(2000);
      await pending;
      assert.deepEqual(errors, [], 'startup reaches application readiness without fixture errors');
      assert.equal(controller.isReady, true);
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

const snapshots = f => f.records.filter(record => record.message === 'Root visibility snapshot');
const receipts = f => f.records.filter(record => record.message === 'Root visibility shortcut');
const warnings = f => f.records.filter(record => record.level === 'warn');

for (const accelerator of ['CommandOrControl+Shift+V', 'CommandOrControl+Shift+C']) {
  test(`${accelerator} repeat burst preserves receipts without duplicate full snapshots`, async t => {
    const f = fixture(t);
    await f.boot();
    assert(snapshots(f).length, 'real recorder started');
    f.manager.showWindow('chat'); // Exercise a visible chat, not the hidden startup state.
    await f.advance(500); // Let the recorder accept that explicit show as its baseline.
    f.records.length = 0;
    await f.key(accelerator);
    await f.advance(500); // A held Windows chord starts repeating after a delay.
    for (let n = 1; n < 30; n++) {
      await f.key(accelerator);
      await f.advance(30);
    }
    assert.equal(receipts(f).length, 30, 'all delivered callbacks remain attributable');
    assert(receipts(f).every(record => record.data.accelerator === accelerator));
    assert.equal(snapshots(f).length, 1, 'one physical hold changes visibility and emits one full snapshot');
    assert.equal(f.manager.getWindow('chat').isVisible(), false, 'held chord hides chat once');
    // Suppression must not hide a real recovery on the same callback path.
    await f.advance(750);
    assert.equal(snapshots(f).at(-1).data.windows.chat.visible, false);
    await f.key(accelerator);
    await f.advance(750);
    assert.equal(snapshots(f).at(-1).data.windows.chat.visible, true, 'real recovered state is still recorded');
  });
}

test('unavailable optional HWND preserves live window state and warns once until recovery', async t => {
  const f = fixture(t);
  await f.boot();
  const toolbar = f.manager.getWindow('main');
  const readHandle = toolbar.getNativeWindowHandle.bind(toolbar);
  toolbar.getNativeWindowHandle = () => { throw new Error('QA: native handle unavailable'); };
  f.records.length = 0;
  await f.advance(3000);
  const state = snapshots(f).at(-1)?.data.windows.main;
  assert(state, 'HWND outage is sampled');
  assert.equal(state.destroyed, false, 'optional HWND failure must not claim the window died');
  assert.equal(state.visible, true);
  assert.equal(state.alwaysOnTop, true);
  assert.equal(state.minimized, false);
  assert.equal(state.webContentsDestroyed, false);
  assert.equal(state.hwnd, null);
  assert(Number.isFinite(state.bounds.x) && Number.isFinite(state.bounds.width));
  assert.equal(warnings(f).length, 1, 'repeated sampling warns once for a continuing HWND outage');
  assert.equal(snapshots(f).length, 1, 'unchanged outage does not generate sample-rate snapshots');
  assert.deepEqual(f.errors, []);

  // Recovery must clear suppression so a new outage gets its own warning.
  toolbar.getNativeWindowHandle = readHandle;
  await f.advance(750);
  assert.equal(snapshots(f).at(-1).data.windows.main.hwnd, '3e9');
  toolbar.getNativeWindowHandle = () => { throw new Error('QA: second native handle outage'); };
  await f.advance(1500);
  assert.equal(warnings(f).length, 2, 'separate outage emits a fresh warning after recovery');
  assert.equal(snapshots(f).at(-1).data.windows.main.destroyed, false);
});
