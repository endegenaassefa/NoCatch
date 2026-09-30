'use strict';

// OpenCluely shortcut contract: V toggles the overlay; C toggles chat.
// Physical key holds still must not flash the menu through auto-repeat.
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

function fixture(t, { rootMode = true, completed = true } = {}) {
  const timers = new Set();
  const intervals = new Set();
  const shortcuts = new Map();
  const handlers = new Map();
  const errors = [];
  const windows = [];
  const logger = { info() {}, debug() {}, warn() {}, error: (...args) => errors.push(args) };
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
      this.options = options;
      this.visible = Boolean(options.show);
      this.destroyed = false;
      this.focusCalls = 0;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.transitions = [];
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { send() {}, setWindowOpenHandler() {}, getURL: () => `file:///${this.file}` });
      windows.push(this);
    }
    static getAllWindows() { return windows.filter(win => !win.destroyed); }
    async loadFile(file) { this.file = file; }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    isFocused() { return false; }
    focus() { this.focusCalls += 1; }
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
  const app = { setName() {}, getPath: () => __dirname, getAppPath: () => root,
    quit() { errors.push('unexpected app.quit'); } };
  const electron = { BrowserWindow, screen, app, powerMonitor: new EventEmitter(),
    ipcMain: Object.assign(new EventEmitter(), { handle: (name, fn) => handlers.set(name, fn) }),
    globalShortcut: { register: (name, fn) => { shortcuts.set(name, fn); return true; },
      isRegistered: name => shortcuts.has(name), unregister: name => shortcuts.delete(name) } };
  const config = { get: key => key === 'window.webPreferences' ? {} : undefined };
  const base = { console, Buffer, setTimeout: timed, clearTimeout, setInterval: repeating, clearInterval,
    process: { platform: 'win32', env: {}, title: '' }, Date, performance, path, logger, config };
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
  }
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const start = source.indexOf('class ApplicationController {');
  const end = source.indexOf('const gotSingleInstanceLock');
  assert(start >= 0 && end > start, 'controller load boundary is available');
  const context = { ...base, ...electron, windowManager: manager, FirstRunManager, SetupService,
    PRIVILEGE: { isRoot: rootMode, detail: 'QA fixture' }, ENV_PATH: path.join(__dirname, '.unused-env'),
    captureService: { platformAdapter: {} }, speechService: { initializeClient() {}, isAvailable: () => false },
    llmService: {}, sessionManager: { addEvent() {} },
    createManagedManager: () => ({ restore: async () => {}, status: () => ({ authenticated: false }) }),
    createDirectSetupAnswer: () => () => {}, attachManagedSession() {}, assertTrustedRenderer() {},
    require: name => name === 'electron' ? electron : createRequire(path.join(root, 'main.js'))(name) };
  const Controller = vm.runInNewContext(source.slice(start, end) + '\nApplicationController', context, { filename: 'main.js' });
  // Irrelevant boot services are disconnected. Startup visibility, shortcuts,
  // onboarding status/completion, IPC registration and every manager method run unchanged.
  for (const name of ['setupStealth', 'setupEventHandlers', 'setupWhisperModelPreparation',
    'setupPermissions', 'setupNetworkConfiguration', 'updateAppIcon']) Controller.prototype[name] = function () {};
  const controller = new Controller();
  controller.setupIPCHandlers();
  t.after(() => {
    manager.destroyAllWindows();
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
  });
  return { manager, controller, errors, screen,
    async boot() {
      await controller.onAppReady();
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

test('Windows root startup shows the original toolbar-only surface after completed onboarding', async t => {
  const f = fixture(t);
  await f.boot();
  assert.equal(f.manager.getWindow('main').isVisible(), true, 'toolbar is visible automatically');
  assert.equal(f.manager.getWindow('chat').isVisible(), false, 'chat waits for an explicit action');
});

test('Windows root onboarding defers both surfaces, then completion shows only toolbar', async t => {
  const f = fixture(t, { completed: false });
  await f.boot();
  assert.equal(f.manager.getWindow('main').isVisible(), false);
  assert.equal(f.manager.getWindow('chat').isVisible(), false);
  const result = await f.invoke('complete-first-run');
  assert.equal(result.success, true);
  assert.equal(f.manager.getWindow('main').isVisible(), true);
  assert.equal(f.manager.getWindow('chat').isVisible(), false, 'completed onboarding keeps chat closed');
});

test('one held chat shortcut opens chat once without repeat flicker', async t => {
  const f = fixture(t);
  await f.boot();
  const chat = f.manager.getWindow('chat');
  chat.hide();
  await f.key('CommandOrControl+Shift+C');
  assert.equal(chat.isVisible(), true, 'first callback opens chat');
  chat.transitions.length = 0;
  for (let n = 0; n < 40; n++) {
    await pause(30);
    await f.key('CommandOrControl+Shift+C');
  }
  assert.deepEqual(chat.transitions, [], 'held chat shortcut must not hide/show the window');
  assert.equal(chat.isVisible(), true);
});

test('Windows root visibility shortcut reveals hidden UI and later separate press hides it', async t => {
  const f = fixture(t);
  await f.boot();
  f.manager.hideAllWindowsExcept([]);
  const toolbar = f.manager.getWindow('main');
  toolbar.transitions.length = 0;
  await f.key('CommandOrControl+Shift+V');
  assert.equal(toolbar.isVisible(), true, 'first callback opens toolbar');
  for (let n = 0; n < 41; n++) {
    await pause(30);
    await f.key('CommandOrControl+Shift+V');
  }
  assert.deepEqual(toolbar.transitions, ['show'], 'held visibility shortcut must produce one show and no hides');
  assert.equal(toolbar.isVisible(), true, 'repeat burst must not end hidden');
  await pause(1200);
  await f.key('CommandOrControl+Shift+V');
  assert.equal(toolbar.isVisible(), false, 'later separate press toggles the overlay off');
  assert.equal(f.manager.getWindow('chat').isVisible(), false, 'chat follows the overlay toggle');
  assert.deepEqual(toolbar.transitions, ['show', 'hide'], 'separate root callbacks toggle once each');
});

for (const shortcut of ['CommandOrControl+Shift+V', 'CommandOrControl+Shift+C']) {
  test(`Windows root ${shortcut} toggles its original surfaces on separate presses`, async t => {
    const f = fixture(t);
    await f.boot();
    f.manager.showWindow('chat'); // Explicitly enter the visible-chat state under test.
    const toolbar = f.manager.getWindow('main');
    const chat = f.manager.getWindow('chat');
    assert.equal(toolbar.isVisible(), true);
    assert.equal(chat.isVisible(), true);
    toolbar.transitions.length = 0;
    chat.transitions.length = 0;
    await f.key(shortcut);
    assert.equal(chat.isVisible(), false, 'first press hides visible chat');
    assert.equal(toolbar.isVisible(), shortcut.includes('Shift+C'), 'C leaves toolbar visible; V hides it');
    await pause(1200);
    await f.key(shortcut);
    await pause(100); // Still bounded when the repeat classifier delays an ambiguous tap.
    assert.equal(chat.isVisible(), true, 'second press restores chat');
    assert.equal(toolbar.isVisible(), true, 'toolbar is visible after the second press');
    assert.deepEqual(chat.transitions, ['hide', 'show'], 'each separate press changes chat once');
    assert.deepEqual(toolbar.transitions, shortcut.includes('Shift+C') ? [] : ['hide', 'show'],
      'C leaves toolbar alone; V toggles toolbar once per press');
  });

  test(`Windows root Hide chat stays closed until ${shortcut} completes its original toggle`, async t => {
    const f = fixture(t);
    await f.boot();
    f.manager.showWindow('chat');
    const chat = f.manager.getWindow('chat');
    const toolbar = f.manager.getWindow('main');
    assert.equal(chat.isVisible(), true);
    const result = await f.invoke('close-window');
    assert.equal(result.success, true);
    assert.equal(chat.isVisible(), false, 'Hide chat is a deliberate dismissal');
    assert.equal(toolbar.isVisible(), true, 'Hide chat only dismisses its own window');
    await pause(1200);
    assert.equal(chat.isVisible(), false, 'deliberate dismissal remains effective while idle');
    await f.key(shortcut);
    if (shortcut.includes('Shift+V')) {
      assert.equal(chat.isVisible(), false, 'V first hides the still-visible toolbar');
      assert.equal(toolbar.isVisible(), false);
      await pause(300);
      await f.key(shortcut);
      await pause(100); // Ambiguous second tap may wait briefly for a repeat callback.
    }
    assert.equal(chat.isVisible(), true, 'explicit shortcut eventually opens chat');
    assert.equal(toolbar.isVisible(), true, 'toolbar is visible after reopening');
  });
}

test('deliberate close-window IPC keeps chat closed until explicitly reopened', async t => {
  const f = fixture(t);
  await f.boot();
  f.manager.showWindow('chat');
  const result = await f.invoke('close-window');
  assert.equal(result.success, true);
  assert.equal(f.manager.getWindow('chat').isVisible(), false);
  await pause(1200);
  assert.equal(f.manager.getWindow('chat').isVisible(), false, 'deliberate close survives delayed startup work');
  await f.key('CommandOrControl+Shift+C');
  assert.equal(f.manager.getWindow('chat').isVisible(), true, 'explicit chat shortcut can reopen');
});

test('ordinary Windows startup preserves toolbar-only behavior', async t => {
  const f = fixture(t, { rootMode: false });
  await f.boot();
  assert.equal(f.manager.getWindow('main').isVisible(), true);
  assert.equal(f.manager.getWindow('chat').isVisible(), false);
});

test('ordinary Windows visibility shortcut retains explicit hide and reveal', async t => {
  const f = fixture(t, { rootMode: false });
  await f.boot();
  await f.key('CommandOrControl+Shift+V');
  assert.equal(f.manager.getWindow('main').isVisible(), false);
  await pause(1200);
  await f.key('CommandOrControl+Shift+V');
  await pause(100);
  assert.equal(f.manager.getWindow('main').isVisible(), true);
});

test('original visibility toggle leaves a visible answer panel alone', async t => {
  const f = fixture(t);
  await f.boot();
  f.manager.showWindow('llmResponse');
  const panel = f.manager.getWindow('llmResponse');
  assert.equal(panel.isVisible(), true, 'answer panel is already showing');
  await f.key('CommandOrControl+Shift+V');
  assert.equal(f.manager.getWindow('main').isVisible(), false, 'V hides the toolbar');
  assert.equal(panel.isVisible(), true, 'V preserves the existing answer panel');
});

test('startup main-window show cannot override a hide during its final delay', async t => {
  const f = fixture(t);
  let signalShowStarted;
  const showStarted = new Promise(resolve => { signalShowStarted = resolve; });
  const realShowMainWindow = f.manager.showMainWindow.bind(f.manager);
  f.manager.showMainWindow = (...args) => {
    const pending = realShowMainWindow(...args);
    signalShowStarted();
    return pending;
  };
  const startup = f.controller.onAppReady();
  await showStarted;
  await pause(150); // After the first 100 ms show, before the final 200 ms write.
  const main = f.manager.getWindow('main');
  assert.equal(main.isVisible(), true, 'startup has opened the toolbar');
  f.manager.hideAllWindowsExcept(['llmResponse']);
  assert.equal(main.isVisible(), false, 'the user hide takes effect immediately');
  await startup;
  await pause(600); // Include delayed topmost follow-up from showOnCurrentDesktop.
  assert.equal(main.isVisible(), false, 'startup does not reopen the toolbar');
  assert.equal(f.manager.isVisible, false, 'startup does not replace the newer hide intent');
  assert.equal(f.controller.isReady, true);
});

// OpenCluely 0a9da751 routes V to toggleVisibility and C to switchToWindow.
// These tests record the original user actions across the delayed verifier
// and destroyed-window races introduced by exam-mode recovery.
test('original visibility shortcut toggles both windows on separate root-mode presses', async t => {
  const f = fixture(t);
  await f.boot();
  f.manager.showWindow('chat');
  const main = f.manager.getWindow('main');
  const chat = f.manager.getWindow('chat');
  assert.equal(main.isVisible(), true);
  assert.equal(chat.isVisible(), true);

  await f.key('CommandOrControl+Shift+V');
  assert.equal(main.isVisible(), false);
  assert.equal(chat.isVisible(), false);
  await pause(700); // Includes the root-mode delayed visibility check.
  assert.equal(main.isVisible(), false, 'a deliberate hide must persist');
  assert.equal(chat.isVisible(), false, 'a deliberate hide must persist');

  await f.key('CommandOrControl+Shift+V');
  await pause(100);
  assert.equal(main.isVisible(), true);
  assert.equal(chat.isVisible(), true);
});

test('original chat shortcut hides visible chat and the next press reopens it', async t => {
  const f = fixture(t);
  await f.boot();
  f.manager.showWindow('chat');
  const chat = f.manager.getWindow('chat');
  assert.equal(chat.isVisible(), true);
  await f.key('CommandOrControl+Shift+C');
  assert.equal(chat.isVisible(), false, 'first press hides visible chat as in OpenCluely');
  await pause(300);
  await f.key('CommandOrControl+Shift+C');
  await pause(100);
  assert.equal(chat.isVisible(), true, 'second press reopens chat');
});

test('explicit V show focuses the active toolbar; automatic restore does not focus', async t => {
  const f = fixture(t);
  await f.boot();
  const main = f.manager.getWindow('main');
  const chat = f.manager.getWindow('chat');
  assert.equal(main.options.focusable, true, 'Windows toolbar accepts explicit focus');
  main.focusCalls = 0;
  chat.focusCalls = 0;

  f.manager.startScreenSharingMode();
  f.manager.stopScreenSharingMode();
  assert.equal(main.focusCalls, 0, 'automatic restore leaves prior app focus alone');
  assert.equal(chat.focusCalls, 0, 'automatic restore does not focus chat');

  await f.key('CommandOrControl+Shift+V'); // Explicit hide.
  assert.equal(main.focusCalls, 0, 'hiding does not take focus');
  await pause(1300);
  await f.key('CommandOrControl+Shift+V'); // Explicit show.
  await pause(100);
  assert.equal(main.focusCalls, 1, 'V show focuses the active toolbar exactly once');
  assert.equal(chat.focusCalls, 0, 'V show does not focus a different window');
});

test('explicit C show focuses chat and leaves toolbar focus alone', async t => {
  const f = fixture(t);
  await f.boot();
  const main = f.manager.getWindow('main');
  const chat = f.manager.getWindow('chat');
  assert.equal(chat.isVisible(), false, 'original startup leaves chat hidden');
  main.focusCalls = 0;
  chat.focusCalls = 0;
  await f.key('CommandOrControl+Shift+C');
  assert.equal(chat.isVisible(), true);
  assert.equal(chat.focusCalls, 1, 'C show focuses chat exactly once');
  assert.equal(main.focusCalls, 0, 'C show does not focus toolbar');
});

test('one held visibility chord causes one transition; a later press toggles back', async t => {
  const f = fixture(t);
  await f.boot();
  f.manager.showWindow('chat');
  const main = f.manager.getWindow('main');
  const chat = f.manager.getWindow('chat');
  main.transitions.length = 0;
  chat.transitions.length = 0;
  await f.key('CommandOrControl+Shift+V');
  await pause(500); // Typical first Windows key repeat starts after a hold delay.
  for (let n = 0; n < 40; n++) {
    await f.key('CommandOrControl+Shift+V');
    await pause(30); // Subsequent Windows key-repeat cadence.
  }
  assert.deepEqual(main.transitions, ['hide'], 'held chord must not flash toolbar');
  assert.deepEqual(chat.transitions, ['hide'], 'held chord must not flash chat');
  await pause(300);
  await f.key('CommandOrControl+Shift+V');
  await pause(100);
  assert.deepEqual(main.transitions, ['hide', 'show']);
  assert.deepEqual(chat.transitions, ['hide', 'show']);
});

test('late recreation cannot reopen chat after an intentional hide', async t => {
  const f = fixture(t);
  await f.boot();
  f.manager.showWindow('chat');
  const oldChat = f.manager.getWindow('chat');
  oldChat.destroyed = true; // External HWND loss without an Electron close event.
  oldChat.visible = false;
  let releaseCreation;
  const creationGate = new Promise(resolve => { releaseCreation = resolve; });
  const createChatWindow = f.manager.createChatWindow.bind(f.manager);
  f.manager.createChatWindow = async () => {
    await creationGate;
    return createChatWindow();
  };

  f.manager.ensureWindow('chat');
  f.manager.hideAllWindowsExcept([]);
  releaseCreation();
  await pause(30);
  const newChat = f.manager.getWindow('chat');
  assert(newChat && newChat !== oldChat, 'dead chat gets rebuilt');
  assert.equal(newChat.isVisible(), false, 'the late rebuild must respect the newer hide');
});

test('duplicate unchanged display metrics leave visible toolbar and chat untouched', async t => {
  const f = fixture(t);
  await f.boot();
  f.manager.showWindow('chat');
  assert(f.screen.listenerCount('display-metrics-changed') > 0, 'real display listener is installed');
  const unchanged = f.screen.getPrimaryDisplay();
  f.screen.emit('display-metrics-changed', unchanged, 'workArea');
  await pause(1100); // First notification and its delayed native writes settle.
  const operations = [];
  for (const type of ['main', 'chat']) {
    const window = f.manager.getWindow(type);
    assert.equal(window.isVisible(), true, `${type} starts visible`);
    for (const method of ['showInactive', 'hide', 'setPosition', 'setAlwaysOnTop']) {
      const original = window[method].bind(window);
      window[method] = (...args) => {
        operations.push({ type, method });
        return original(...args);
      };
    }
  }

  await pause(1100);
  assert.deepEqual(operations, [], 'healthy idle windows produce no native writes in this fixture');

  f.screen.emit('display-metrics-changed', unchanged, 'workArea');
  f.screen.emit('display-metrics-changed', unchanged, 'workArea');
  await pause(1100); // Includes any 500 ms follow-up topmost writes.
  assert.deepEqual(operations, [], 'duplicate metrics must not flash, move or reassert healthy windows');
  assert.equal(f.manager.getWindow('main').isVisible(), true);
  assert.equal(f.manager.getWindow('chat').isVisible(), true);
});
