'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
function fixture(t, blocked = new Set()) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  const registered = new Map(), registrations = [], broadcasts = [], log = [];
  const logger = { info: (...a) => log.push(a), debug() {}, warn: (...a) => log.push(a), error() {} };
  const app = Object.assign(new EventEmitter(), {whenReady: () => new Promise(() => {}), quit() {}});
  const powerMonitor = new EventEmitter();
  const globalShortcut = {
    register(key, fn) { registrations.push(key); if (blocked.has(key) || registered.has(key)) return false; registered.set(key, fn); return true; },
    isRegistered: key => registered.has(key), unregister: key => registered.delete(key), unregisterAll: () => registered.clear()
  };
  const context = { console, process: {platform: 'win32', env: {}}, Date, setTimeout, clearTimeout, setInterval, clearInterval, logger, app, powerMonitor, globalShortcut, speechService: {shutdown() {}}, sessionManager: {getMemoryUsage: () => ({eventCount:0, approximateSize:0})} };
  const managerBox = { ...context, module: {exports: {}}, require: key => key === 'electron' ? {} : key === '../core/logger' ? {createServiceLogger: () => logger} : key === '../core/config' ? {} : require(key) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/managers/window.manager.js'), 'utf8'), managerBox);
  const manager = managerBox.module.exports;
  manager.windows.set('main', {isDestroyed: () => false, setIgnoreMouseEvents() {}, setAlwaysOnTop() {}, webContents: {send: (...args) => broadcasts.push(args)}});
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const Controller = vm.runInNewContext(source.slice(source.indexOf('class ApplicationController {'), source.indexOf('const gotSingleInstanceLock')) + '\nApplicationController', {...context, windowManager: manager});
  const controller = Object.create(Controller.prototype);
  controller.getCaptureHotkey = () => 'CommandOrControl+Shift+Space';
  controller.setupService = {invalidate() {}};
  controller.managedSession = {cancelAll() {}};
  manager.destroyAllWindows = () => manager.windows.clear();
  controller.setupGlobalShortcuts();
  // Registration is deliberately separate from app readiness lifecycle.
  // Calling the real lifecycle hook exercises resume + periodic recovery.
  controller.startShortcutRecovery?.();
  t.after(() => controller.stopShortcutRecovery?.());
  return {controller, manager, registered, blocked, registrations, broadcasts, powerMonitor, app, log,
    advance(ms) { t.mock.timers.tick(ms); },
    key(key) { assert.equal(typeof registered.get(key), 'function'); return registered.get(key)(); }};
}
for (const key of ['Alt+A', 'CommandOrControl+Shift+I']) {
  test(`${key}: one held chord produces one interaction state transition, next press remains usable`, t => {
    const f = fixture(t);
    f.key(key);
    for (let n = 0; n < 20; n++) { f.advance(35); f.key(key); }
    assert.equal(f.broadcasts.filter(x => x[0] === 'interaction-mode-changed').length, 1);
    assert.equal(f.manager.isInteractive, false);
    f.advance(1000); f.key(key);
    assert.equal(f.manager.isInteractive, true);
    assert.equal(f.broadcasts.filter(x => x[0] === 'interaction-mode-changed').length, 2);
  });
}
test('shortcut status reflects a registration lost after startup', t => {
  const f = fixture(t), key = 'Alt+A';
  f.registered.delete(key);
  const state = f.controller.getShortcutStatus().shortcuts.find(row => row.accelerator === key);
  assert.equal(state.registered, false);
  assert(state.reason);
});
test('registration setup is idempotent for already-owned shortcuts', t => {
  const f = fixture(t);
  f.controller.setupGlobalShortcuts();
  const state = f.controller.getShortcutStatus().shortcuts.find(row => row.accelerator === 'Alt+A');
  assert.equal(state.registered, true);
  f.key('Alt+A'); assert.equal(f.manager.isInteractive, false);
});
test('transiently unavailable shortcut recovers without restarting the process', t => {
  const key = 'Alt+A'; const f = fixture(t, new Set([key]));
  assert.equal(f.controller.getShortcutStatus().shortcuts.find(row => row.accelerator === key).registered, false);
  f.blocked.delete(key);
  f.powerMonitor.emit('resume');
  for (let n = 0; n < 12; n++) f.advance(1000);
  assert.equal(f.registered.has(key), true, 'a released registration becomes usable within twelve seconds');
  f.key(key); assert.equal(f.manager.isInteractive, false);
});
test('long initial key-repeat delay and interaction aliases still form a single held action', t => {
  const f = fixture(t);
  f.key('Alt+A'); f.advance(500); f.key('CommandOrControl+Shift+I');
  for (let n=0;n<50;n++) { f.advance(35); f.key(n%2 ? 'Alt+A' : 'CommandOrControl+Shift+I'); }
  assert.equal(f.broadcasts.length,1);
  f.advance(1000); f.key('CommandOrControl+Shift+I');
  assert.equal(f.broadcasts.length,2);
});
test('microphone alternate shares repeat guard while a later press works', t => {
  const f=fixture(t); let toggles=0; f.controller.toggleSpeechRecognition=()=>toggles++;
  f.key('Alt+R'); f.advance(500); f.key('CommandOrControl+Shift+R');
  for(let n=0;n<20;n++){f.advance(35);f.key('Alt+R');}
  assert.equal(toggles,1);
  f.advance(1000);f.key('CommandOrControl+Shift+R');assert.equal(toggles,2);
});
test('healthy periodic polling preserves registrations and failure warnings are not repeated',t=>{
  const f=fixture(t,new Set(['Alt+A']));
  const healthyInitial=f.registrations.filter(x=>x==='CommandOrControl+Shift+I').length;
  const initialWarnings=f.log.filter(x=>x[0]==='Global shortcut unavailable').length;
  for(let n=0;n<12;n++)f.advance(5000);
  assert.equal(f.registrations.filter(x=>x==='CommandOrControl+Shift+I').length,healthyInitial);
  assert.equal(f.log.filter(x=>x[0]==='Global shortcut unavailable').length,initialWarnings);
  f.blocked.clear();f.advance(5000);assert(f.registered.has('Alt+A'));
});
test('application shutdown releases shortcuts and stops resume/periodic recovery',t=>{
  const f=fixture(t);
  f.controller.onWillQuit();
  const count=f.registrations.length;
  f.powerMonitor.emit('resume');f.advance(20000);
  assert.equal(f.registrations.length,count);
  assert.equal(f.registered.size,0);
  assert.equal(f.powerMonitor.listenerCount('resume'),0);
});
