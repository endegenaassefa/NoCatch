'use strict';

// Regression tests for the Windows SYSTEM-band exam fix:
//  - main.js: SYSTEM-integrity launch forces --no-sandbox + CPU rendering
//    (Chromium refuses to run as SYSTEM otherwise; GPU is unreliable there).
//  - window.manager.js: win32 showOnCurrentDesktop re-fronts the window in the
//    shared topmost band via moveTop() (SetWindowPos HWND_TOPMOST, no
//    activation) so summon hotkeys work when the window is covered, not just
//    hidden; showWindow no longer short-circuits a visible window on win32.
//  - window.manager.js: external WM_CLOSE is refused unless the quit path has
//    flipped setClosable(true).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const wmSource = fs.readFileSync(path.join(root, 'src/managers/window.manager.js'), 'utf8');
const quietLogger = { info() {}, debug() {}, warn() {}, error() {} };

// ── main.js startup slice: up to and including the Chromium switch blocks ──
function startupFixture({ platform = 'win32', integrity = 'high', isRoot = true, failRootProfile = false } = {}) {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const endMarker = 'app.commandLine.appendSwitch("no-pings");';
  const end = main.indexOf(endMarker);
  assert.notEqual(end, -1, 'main startup must reach the Chromium switch block');
  const startup = main.slice(0, end + endMarker.length);

  const events = [];
  const switches = [];
  const normalData = 'C:\\Users\\Jane\\AppData\\Roaming\\screen-reader-util';
  let userData = normalData;
  const app = {
    isPackaged: true,
    getName: () => 'screen-reader-util',
    getPath(name) {
      if (name === 'appData') return path.win32.dirname(normalData);
      if (name === 'userData') return userData;
      throw new Error(`unexpected path: ${name}`);
    },
    setPath(name, value) {
      assert.equal(name, 'userData');
      userData = value;
      events.push(['setPath', value]);
    },
    commandLine: {
      appendSwitch(name) { switches.push(name); },
    },
    disableHardwareAcceleration() { events.push(['disableHardwareAcceleration']); },
  };
  const files = new Map();
  const fakeFs = {
    mkdirSync(value) {
      events.push(['mkdir', value]);
      if (failRootProfile) throw new Error('profile cannot be created');
    },
    existsSync(value) { return files.has(value); },
    statSync(value) {
      if (files.has(value)) return { size: Buffer.byteLength(files.get(value)) };
      throw Object.assign(new Error(`missing file: ${value}`), { code: 'ENOENT' });
    },
    readFileSync(value) {
      if (files.has(value)) return files.get(value);
      throw Object.assign(new Error(`missing file: ${value}`), { code: 'ENOENT' });
    },
    writeFileSync(value, contents) { events.push(['write', value, contents]); files.set(value, contents); },
    copyFileSync(from, to) { events.push(['copy', from, to]); files.set(to, files.get(from)); },
  };
  const privilege = {
    detect() {
      return { platform, isRoot, integrity, method: 'fixture', detail: `${platform} test (integrity ${integrity})` };
    },
    rootDataDir: () => 'C:\\ProgramData\\CluelyRoot',
  };
  const context = vm.createContext({
    process: { platform, cwd: () => 'C:\\repo' },
    require(id) {
      if (id === 'path') return path.win32;
      if (id === 'fs') return fakeFs;
      if (id === 'url') return { fileURLToPath() {} };
      if (id === 'electron') return { app };
      if (id === './src/capture-routing') return {};
      if (id === './src/platform/privilege') return privilege;
      if (id === './src/platform/windows-instance') return { currentSessionId: () => 7 };
      if (id === 'dotenv') return { config({ path: envPath }) { events.push(['dotenv', envPath]); } };
      throw new Error(`unexpected startup dependency: ${id}`);
    },
  });
  if (failRootProfile) {
    assert.throws(() => vm.runInContext(startup, context, { filename: 'main.js' }), /profile cannot be created/);
  } else {
    vm.runInContext(startup, context, { filename: 'main.js' });
  }
  return { events, switches };
}

test('SYSTEM-integrity Windows startup forces no-sandbox and CPU rendering', () => {
  const { switches, events } = startupFixture({ platform: 'win32', integrity: 'system', isRoot: true });
  for (const name of ['no-sandbox', 'disable-gpu', 'disable-gpu-compositing', 'disable-software-rasterizer', 'disable-gpu-sandbox', 'in-process-gpu']) {
    assert.ok(switches.includes(name), `SYSTEM mode must append --${name}, got: ${switches.join(', ')}`);
  }
  assert.ok(events.some(e => Array.isArray(e) && e[0] === 'disableHardwareAcceleration'), 'SYSTEM mode must disable hardware acceleration');
});

test('elevated (High) Windows startup does NOT disable the sandbox', () => {
  const { switches } = startupFixture({ platform: 'win32', integrity: 'high', isRoot: true });
  assert.ok(!switches.includes('no-sandbox'), `High-integrity launch must keep the Chromium sandbox, got: ${switches.join(', ')}`);
  assert.ok(!switches.includes('disable-gpu'), 'High-integrity launch must keep GPU rendering');
});

// ── window.manager.js fixtures ─────────────────────────────────────────────
function wmContext(platform = 'win32') {
  const sandbox = {
    module: { exports: {} },
    process: { platform, env: {} },
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    require: name => {
      if (name === 'electron') return { screen: new EventEmitter() };
      if (name === '../core/logger') return { createServiceLogger: () => quietLogger };
      if (name === '../core/config') return {};
      return require(name);
    },
  };
  vm.runInNewContext(
    wmSource.replace('module.exports = new WindowManager();', 'module.exports = WindowManager;'),
    sandbox,
    { filename: 'window.manager.js' }
  );
  return { manager: Object.create(sandbox.module.exports.prototype), sandbox };
}

test('win32 showOnCurrentDesktop re-fronts the topmost band via moveTop after showInactive', () => {
  const { manager } = wmContext('win32');
  const calls = [];
  const fakeWin = {
    id: 'chat',
    isDestroyed: () => false,
    setVisibleOnAllWorkspaces: (v, o) => calls.push(['setVisibleOnAllWorkspaces', v, o]),
    showInactive: () => calls.push(['showInactive']),
    moveTop: () => calls.push(['moveTop']),
  };
  manager.windows = new Map();
  manager.setWindowAlwaysOnTop = w => calls.push(['setWindowAlwaysOnTop', w.id]);
  manager.showOnCurrentDesktop(fakeWin);
  const order = calls.map(c => c[0]);
  assert.ok(order.indexOf('showInactive') < order.indexOf('moveTop'),
    `showInactive must precede moveTop for a flicker-free re-front, got: ${order.join(', ')}`);
  assert.ok(order.includes('moveTop'), 'covered windows must be re-fronted with moveTop');
});

test('darwin showOnCurrentDesktop keeps the no-moveTop path', () => {
  const { manager } = wmContext('darwin');
  const calls = [];
  const fakeWin = {
    id: 'chat',
    isDestroyed: () => false,
    hide: () => calls.push(['hide']),
    setVisibleOnAllWorkspaces: (v, o) => calls.push(['setVisibleOnAllWorkspaces', v]),
    showInactive: () => calls.push(['showInactive']),
    moveTop: () => calls.push(['moveTop']),
    setAlwaysOnTop: () => calls.push(['setAlwaysOnTop']),
  };
  manager.windows = new Map();
  manager.setWindowAlwaysOnTop = w => calls.push(['setWindowAlwaysOnTop']);
  manager.showOnCurrentDesktop(fakeWin);
  assert.ok(!calls.some(c => c[0] === 'moveTop'), 'macOS uses window levels, not moveTop');
});

test('win32 showWindow re-fronts an already-visible window instead of no-oping', () => {
  const { manager } = wmContext('win32');
  const shown = [];
  const fakeWin = { isDestroyed: () => false, isVisible: () => true };
  manager.windows = new Map([['main', fakeWin]]);
  manager.showOnCurrentDesktop = w => shown.push(w);
  manager.showWindow('main');
  assert.equal(shown.length, 1, 'visible-but-covered win32 window must still be re-fronted');
});

test('macOS showWindow keeps the visible no-op (no flash mid-share)', () => {
  const { manager } = wmContext('darwin');
  const shown = [];
  const fakeWin = { isDestroyed: () => false, isVisible: () => true };
  manager.windows = new Map([['main', fakeWin]]);
  manager.showOnCurrentDesktop = w => shown.push(w);
  manager.showWindow('main');
  assert.equal(shown.length, 0, 'macOS visible window must not run the hide/show dance');
});

test('external close requests are refused until the quit path flips closable', () => {
  const { manager } = wmContext('win32');
  const handlers = new Map();
  let closable = false;
  const fakeWin = {
    on(event, cb) { handlers.set(event, cb); },
    isClosable: () => closable,
  };
  manager.windows = new Map([['chat', fakeWin]]);
  manager.setupWindowEventHandlers();
  const closeHandler = handlers.get('close');
  assert.ok(closeHandler, 'close handler must be registered');

  const prevented = [];
  const event = { preventDefault: () => prevented.push(true) };
  closeHandler(event);
  assert.equal(prevented.length, 1, 'non-closable overlays must refuse external close (WM_CLOSE is UIPI-benign)');

  closable = true;
  prevented.length = 0;
  closeHandler(event);
  assert.equal(prevented.length, 0, 'the quit path (setClosable(true)) must allow the real close');
});
