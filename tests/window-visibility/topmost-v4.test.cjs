'use strict';

// V4: repair externally lost topmost state only for visible Windows root UI.
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

const attempts = (f, window) => f.nativeCalls.filter(call => call.method === 'topmost' && (!window || call.id === window.id));
const disruptive = f => f.nativeCalls.filter(call => ['hide', 'show', 'focus'].includes(call.method));
const repairLogs = f => f.records.filter(record => record.message === 'Root visibility topmost repair');

function resetObservations(f) {
  f.nativeCalls.length = 0;
  f.records.length = 0;
}

function assertRepairLog(record, type, success) {
  assert(record, `${type} repair attempt has a diagnostic record`);
  assert.equal(record.data.type, type);
  assert.equal(record.data.success, success, 'success reflects the observed native topmost flag');
  assert.match(record.data.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert(Number.isFinite(Date.parse(record.data.timestamp)));
}

test('root observer restores externally lost main/chat topmost within one second without hide/show/focus', async t => {
  const f = fixture(t);
  await f.boot();
  resetObservations(f);
  for (const type of ['main', 'chat']) {
    const window = f.manager.getWindow(type);
    assert.equal(window.isVisible(), true);
    window.topmost = false; // Native state changes without an app event.
  }
  await f.advance(1000);
  for (const type of ['main', 'chat']) {
    const window = f.manager.getWindow(type);
    assert.equal(window.isAlwaysOnTop(), true, `${type} recovered automatically`);
    assert.equal(window.isVisible(), true);
    assert.equal(attempts(f, window).length, 1, `${type} requires only one successful repair`);
    assertRepairLog(repairLogs(f).find(record => record.data.type === type), type, true);
  }
  assert.deepEqual(disruptive(f), [], 'repair must not flash or focus the app');
  await f.advance(5000);
  assert.equal(attempts(f).length, 2, 'healthy state stops further reassertions');
});

for (const accelerator of ['CommandOrControl+Shift+V', 'CommandOrControl+Shift+C']) {
  test(`${accelerator} restores topmost when its original toggle shows a hidden root window`, async t => {
    const f = fixture(t);
    await f.boot();
    if (accelerator.includes('Shift+V')) f.manager.hideAllWindowsExcept([]);
    else f.manager.getWindow('chat').hide();
    resetObservations(f);
    f.manager.getWindow('main').topmost = false;
    f.manager.getWindow('chat').topmost = false;
    await f.key(accelerator); // Explicit show action; do not advance observer time.
    for (const type of ['main', 'chat']) {
      const window = f.manager.getWindow(type);
      assert.equal(window.isAlwaysOnTop(), true, `${type} is topmost after explicit show`);
      assert.equal(window.isVisible(), true, `${type} is visible after explicit show`);
      assert.equal(attempts(f, window).length, 1);
    }
    if (accelerator.includes('Shift+C')) {
      assertRepairLog(repairLogs(f).find(record => record.data.type === 'main'), 'main', true);
    }
    const coreIds = new Set(['main', 'chat'].map(type => f.manager.getWindow(type).id));
    const coreChanges = disruptive(f).filter(call => coreIds.has(call.id));
    assert.equal(coreChanges.filter(call => call.method === 'show').length,
      accelerator.includes('Shift+V') ? 2 : 1, 'only the explicitly opened windows are shown');
    assert.equal(coreChanges.filter(call => call.method === 'hide').length, 0,
      'explicit recovery does not hide a core window');
    const expectedFocusId = f.manager.getWindow(accelerator.includes('Shift+V') ? 'main' : 'chat').id;
    assert.deepEqual(coreChanges.filter(call => call.method === 'focus').map(call => call.id),
      [expectedFocusId], 'explicit show focuses only its intended target');
  });
}

test('healthy root windows receive no observer reassertions while idle', async t => {
  const f = fixture(t);
  await f.boot();
  resetObservations(f);
  await f.advance(5000);
  assert.deepEqual(attempts(f), []);
  assert.deepEqual(disruptive(f), []);
  assert.deepEqual(repairLogs(f), []);
});

for (const failure of ['ignore', 'throw']) {
  test(`failed native repair (${failure}) is logged and bounded across observer and forced checks`, async t => {
    const f = fixture(t);
    await f.boot();
    resetObservations(f);
    for (const type of ['main', 'chat']) {
      const window = f.manager.getWindow(type);
      window.topmost = false;
      window.repairFailure = failure;
    }
    await f.advance(750);
    for (let n = 0; n < 200; n++) {
      f.controller.recordRootVisibilitySnapshot('shortcut');
      await f.advance(30);
    }
    for (const type of ['main', 'chat']) {
      const window = f.manager.getWindow(type);
      const calls = attempts(f, window);
      assert(calls.length >= 2, `${type} actually attempts and retries repair`);
      assert(calls.length <= 4, `${type} retry volume is bounded over 6.75 seconds`);
      for (let i = 1; i < calls.length; i++) assert(calls[i].at - calls[i - 1].at >= 2000, `${type} retries respect two-second backoff`);
      const logs = repairLogs(f).filter(record => record.data.type === type);
      assert.equal(logs.length, calls.length, 'each attempted repair is logged once');
      logs.forEach(record => assertRepairLog(record, type, false));
      assert.equal(window.isVisible(), true);
    }
    assert.deepEqual(disruptive(f), []);
  });
}

test('intentional Hide chat remains hidden and receives no automatic topmost repair', async t => {
  const f = fixture(t);
  await f.boot();
  assert.equal((await f.invoke('close-window')).success, true);
  const chat = f.manager.getWindow('chat');
  chat.topmost = false;
  resetObservations(f);
  await f.advance(5000);
  assert.equal(chat.isVisible(), false);
  assert.equal(chat.isAlwaysOnTop(), false);
  assert.deepEqual(attempts(f, chat), []);
  assert.deepEqual(disruptive(f), []);
  await f.key('CommandOrControl+Shift+C');
  assert.equal(chat.isVisible(), true, 'explicit reveal remains available');
  assert.equal(chat.isAlwaysOnTop(), true, 'revealed chat is topmost');
});

for (const mode of [{ rootMode: false, platform: 'win32' }, { rootMode: true, platform: 'darwin' }, { rootMode: false, platform: 'darwin' }]) {
  test(`no automatic repair outside Windows root mode: ${mode.platform} root=${mode.rootMode}`, async t => {
    const f = fixture(t, mode);
    await f.boot();
    resetObservations(f);
    for (const type of ['main', 'chat']) {
      const window = f.manager.getWindow(type);
      window.visible = true;
      window.topmost = false;
    }
    await f.advance(5000);
    assert.deepEqual(attempts(f), []);
    assert.deepEqual(repairLogs(f), []);
    assert.deepEqual(disruptive(f), []);
  });
}
