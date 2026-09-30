'use strict';

// V3 diagnostic contract, independently authored before implementation.
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
    debug() {}, warn() {}, error: (...args) => errors.push(args) };
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
const plain = value => JSON.parse(JSON.stringify(value));

function assertTimestamp(value) {
  assert.equal(typeof value, 'string', 'diagnostic timestamp is an ISO string');
  assert(Number.isFinite(Date.parse(value)), 'diagnostic timestamp can be parsed');
  assert.match(value, /^\d{4}-\d{2}-\d{2}T/);
}

function assertSnapshot(record, expected = {}) {
  assert(record, 'root visibility diagnostic snapshot exists');
  assertTimestamp(record.data.timestamp);
  assert(['initial', 'change', 'heartbeat', 'shortcut'].includes(record.data.reason));
  for (const type of ['main', 'chat']) {
    const state = record.data.windows?.[type];
    assert(state, `${type} state present`);
    assert.equal(typeof state.destroyed, 'boolean', `${type} destroyed state`);
    for (const key of ['visible', 'alwaysOnTop', 'minimized', 'webContentsDestroyed']) {
      assert(typeof state[key] === 'boolean' || (state.destroyed && state[key] === null), `${type}.${key} is sampled or explicitly unavailable`);
    }
    if (!state.destroyed) {
      for (const key of ['x', 'y', 'width', 'height']) assert(Number.isFinite(state.bounds?.[key]), `${type} bounds.${key} sampled`);
    }
    assert(state.hwnd === null || typeof state.hwnd === 'string', `${type} HWND serialized safely`);
    for (const [key, value] of Object.entries(expected[type] || {})) {
      assert.deepEqual(plain(state[key]), value, `${type}.${key} reflects observed window state`);
    }
  }
  const serialized = JSON.stringify(record.data);
  assert(!/"(?:title|content|text|pixels|image|screenshot|url)"\s*:/i.test(serialized), 'diagnostic excludes content, titles and pixels');
}

function assertBoundedHeartbeat(records) {
  assert(records.length >= 5, 'at least five heartbeats across 60 seconds confirm recorder remains alive');
  assert(records.length <= 8, 'unchanged state does not log at the 500 ms sample rate');
  assert(records.every(record => record.data.reason === 'heartbeat'), 'unchanged state emits only heartbeats');
  for (let i = 1; i < records.length; i++) {
    const gap = Date.parse(records[i].data.timestamp) - Date.parse(records[i - 1].data.timestamp);
    assert(gap >= 9000 && gap <= 11000, `heartbeat gap is approximately ten seconds, got ${gap}`);
  }
}

test('diagnostic oracle accepts known-good and rejects absent, stale, noisy and content-bearing controls', () => {
  const state = { visible: true, alwaysOnTop: true, minimized: false, destroyed: false,
    webContentsDestroyed: false, bounds: { x: 10, y: 20, width: 500, height: 700 }, hwnd: '1001' };
  const good = { message: 'Root visibility snapshot', data: { timestamp: '2026-09-26T20:00:00.000Z', reason: 'initial',
    windows: { main: structuredClone(state), chat: structuredClone(state) } } };
  assert.doesNotThrow(() => assertSnapshot(good, { main: { visible: true } }));
  assert.throws(() => assertSnapshot(undefined));
  assert.throws(() => assertSnapshot(good, { main: { visible: false } }), /reflects observed window state/);
  for (const key of ['title', 'content', 'pixels']) {
    const bad = structuredClone(good);
    bad.data.windows.chat[key] = 'private-fixture';
    assert.throws(() => assertSnapshot(bad), /excludes content/);
  }
  const heartbeat = Array.from({ length: 6 }, (_, i) => ({ data: { reason: 'heartbeat', timestamp: new Date(Date.parse(good.data.timestamp) + 10000 * (i + 1)).toISOString() } }));
  assert.doesNotThrow(() => assertBoundedHeartbeat(heartbeat));
  assert.throws(() => assertBoundedHeartbeat([]), /remains alive/);
  assert.throws(() => assertBoundedHeartbeat(Array(120).fill(heartbeat[0])), /does not log/);
});

test('root Windows startup records initial main/chat state without title, page or pixel reads', async t => {
  const f = fixture(t);
  await f.boot();
  const initial = snapshots(f).find(record => record.data.reason === 'initial');
  assertSnapshot(initial, {
    main: { visible: true, alwaysOnTop: true, minimized: false, destroyed: false, webContentsDestroyed: false },
    chat: { visible: false, alwaysOnTop: true, minimized: false, destroyed: false, webContentsDestroyed: false }
  });
  for (const type of ['main', 'chat']) assert.match(initial.data.windows[type].hwnd, /^(?:0x)?[0-9a-f]+$/i, 'available native handle is logged');
  assert.deepEqual(f.forbiddenReads, []);
});

test('observer samples externally changed BrowserWindow state within 750 ms and records destroyed window health', async t => {
  const f = fixture(t);
  await f.boot();
  assert(snapshots(f).length, 'observer started');
  const toolbar = f.manager.getWindow('main');
  // Change the Electron boundary without emitting hide/show/focus events.
  toolbar.visible = false;
  toolbar.topmost = false;
  toolbar.minimized = true;
  toolbar.bounds = { x: 77, y: 88, width: 600, height: 40 };
  const before = snapshots(f).length;
  await f.advance(750);
  const changed = snapshots(f).slice(before);
  assert.equal(changed.length, 1, 'one changed sample, not event-only or per-tick logging');
  assert.equal(changed[0].data.reason, 'change');
  assertSnapshot(changed[0], { main: { visible: false, alwaysOnTop: false, minimized: true,
    bounds: { x: 77, y: 88, width: 600, height: 40 } } });
  f.manager.showWindow('chat'); // The original startup keeps chat hidden until requested.
  const chat = f.manager.getWindow('chat');
  chat.webContentsDestroyed = true;
  await f.advance(750);
  assertSnapshot(snapshots(f).at(-1), { chat: { webContentsDestroyed: true } });
  const beforeDestruction = snapshots(f).length;
  chat.destroyed = true;
  await f.advance(750);
  const afterDestruction = snapshots(f).slice(beforeDestruction);
  const destroyedAt = afterDestruction.findIndex(record => record.data.windows.chat.destroyed === true);
  assert(destroyedAt >= 0, 'observer records the destroyed chat before rebuilding it');
  assertSnapshot(afterDestruction[destroyedAt], { chat: { destroyed: true } });
  const recovered = afterDestruction.slice(destroyedAt + 1).find(record =>
    record.data.windows.chat.destroyed === false && record.data.windows.chat.visible === true);
  assert(recovered, 'observer records the live replacement after the destroyed sample');
  assert.notEqual(f.manager.getWindow('chat'), chat, 'the dead chat has a new window instance');
  assert.deepEqual(f.errors, [], 'destroyed windows cannot break main-process recorder');
  assert.deepEqual(f.forbiddenReads, []);
});

test('unchanged root windows log only occasional heartbeat over a minute', async t => {
  const f = fixture(t);
  await f.boot();
  assert(snapshots(f).length, 'observer started');
  const before = snapshots(f).length;
  await f.advance(60000);
  assertBoundedHeartbeat(snapshots(f).slice(before));
});

test('root V/C callbacks each log timestamped delivery even when reveal changes no state', async t => {
  const f = fixture(t);
  await f.boot();
  for (const accelerator of ['CommandOrControl+Shift+V', 'CommandOrControl+Shift+C']) await f.key(accelerator);
  const delivered = receipts(f);
  assert.equal(delivered.length, 2, 'each delivered shortcut has a receipt independent of state change');
  assert.deepEqual(delivered.map(record => record.data.accelerator), ['CommandOrControl+Shift+V', 'CommandOrControl+Shift+C']);
  for (const record of delivered) assertTimestamp(record.data.timestamp);
});

for (const mode of [{ rootMode: false, platform: 'win32' }, { rootMode: true, platform: 'darwin' }, { rootMode: false, platform: 'darwin' }]) {
  test(`observer is inactive for ${mode.platform} root=${mode.rootMode}`, async t => {
    const f = fixture(t, mode);
    await f.boot();
    await f.advance(12000);
    await f.key('CommandOrControl+Shift+V');
    await f.key('CommandOrControl+Shift+C');
    assert.deepEqual(snapshots(f), []);
    assert.deepEqual(receipts(f), []);
  });
}

test('real will-quit event stops diagnostic recording before window disposal', async t => {
  const f = fixture(t);
  await f.boot();
  assert(snapshots(f).length, 'observer started');
  f.app.emit('will-quit');
  const before = snapshots(f).length;
  await f.advance(12000);
  assert.equal(snapshots(f).length, before, 'no samples or heartbeat after shutdown');
  assert.deepEqual(f.errors, []);
});
