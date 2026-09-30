'use strict';

// The app's recording-start event calls WindowManager.handleRecordingStarted.
// Observe its real behavior at the Electron window API boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const file = path.resolve(__dirname, '../../src/managers/window.manager.js');

function fixture(visible) {
  const nativeCalls = [];
  const rendererEvents = [];
  const pending = [];
  const chat = {
    id: 1,
    visible,
    webContents: { send: event => rendererEvents.push(event) },
    isDestroyed: () => false,
    isVisible() { return this.visible; },
    setVisibleOnAllWorkspaces(value) { nativeCalls.push(['workspace', value]); },
    setAlwaysOnTop(value) { nativeCalls.push(['topmost', value]); },
    showInactive() { nativeCalls.push(['showInactive']); this.visible = true; }
  };
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  const electron = { BrowserWindow: class {}, screen: {}, desktopCapturer: {}, shell: {} };
  const context = {
    module: { exports: {} }, __dirname: path.dirname(file),
    process: { platform: 'win32' },
    setTimeout: fn => { pending.push(fn); return pending.length; },
    require: name => name === 'electron' ? electron
      : name === '../core/logger' ? { createServiceLogger: () => logger }
      : name === '../core/config' ? { get: () => undefined }
      : createRequire(file)(name)
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const manager = context.module.exports;
  manager.windows.set('chat', chat);
  return { manager, chat, nativeCalls, rendererEvents, pending };
}

test('recording start leaves an already-visible Windows chat undisturbed', () => {
  const f = fixture(true);
  f.manager.handleRecordingStarted();
  assert.equal(f.chat.isVisible(), true);
  assert.deepEqual(f.rendererEvents, ['recording-started']);
  assert.deepEqual(f.nativeCalls, [], 'recording state must not re-show or reassert a visible chat');
  assert.equal(f.pending.length, 0, 'no delayed workspace or topmost change is queued');
});

test('recording start reveals a hidden Windows chat once', () => {
  const f = fixture(false);
  f.manager.handleRecordingStarted();
  assert.equal(f.chat.isVisible(), true);
  assert.equal(f.nativeCalls.filter(([name]) => name === 'showInactive').length, 1);
  assert.deepEqual(f.rendererEvents, ['recording-started']);
});
