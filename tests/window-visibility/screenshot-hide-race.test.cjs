'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const project = path.resolve(__dirname, '../..');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { chatInitiallyVisible = true } = {}) {
  const timers = new Set();
  const handlers = new Map();
  const events = [];
  const capture = deferred();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const later = (fn, delay, ...args) => {
    const id = setTimeout(() => { timers.delete(id); fn(...args); }, delay);
    timers.add(id);
    return id;
  };

  class FakeWindow {
    constructor(type, visible) {
      this.type = type;
      this.id = type === 'main' ? 1 : 2;
      this.visible = visible;
      this.topmost = true;
      this.destroyed = false;
      this.focusCalls = 0;
      this.webContents = { send: (channel, data) => events.push({ type, channel, data }) };
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isAlwaysOnTop() { return this.topmost; }
    focus() { this.focusCalls += 1; }
    hide() { this.visible = false; }
    showInactive() { this.visible = true; }
    setAlwaysOnTop(value) { this.topmost = value; }
    setVisibleOnAllWorkspaces() {}
  }

  const managerFile = path.join(project, 'src/managers/window.manager.js');
  const managerContext = {
    module: { exports: {} }, console, process: { platform: 'win32' },
    setTimeout: later, clearTimeout, setInterval, clearInterval,
    require: name => name === 'electron'
      ? { BrowserWindow: FakeWindow, screen: {}, desktopCapturer: {}, shell: {} }
      : name === '../core/logger' ? { createServiceLogger: () => logger }
      : name === '../core/config' ? { get() {} }
      : createRequire(managerFile)(name)
  };
  vm.runInNewContext(fs.readFileSync(managerFile, 'utf8'), managerContext, { filename: managerFile });
  const manager = managerContext.module.exports;
  const main = new FakeWindow('main', true);
  const chat = new FakeWindow('chat', chatInitiallyVisible);
  manager.windows.set('main', main);
  manager.windows.set('chat', chat);
  manager.isVisible = true;

  const ipcMain = Object.assign(new EventEmitter(), {
    handle: (channel, handler) => handlers.set(channel, handler)
  });
  const app = { getAppPath: () => project };
  const controllerFile = path.join(project, 'main.js');
  const source = fs.readFileSync(controllerFile, 'utf8');
  const start = source.indexOf('class ApplicationController {');
  const end = source.indexOf('const gotSingleInstanceLock');
  assert(start >= 0 && end > start, 'load the current production controller class');
  const controllerContext = {
    console, Buffer, Date, path, setTimeout: later, clearTimeout,
    process: { platform: 'win32', env: {} }, logger,
    app, ipcMain, windowManager: manager,
    config: { get: key => key === 'ui.answerSurface' ? 'chat' : undefined },
    assertTrustedRenderer() {},
    captureService: { captureAndProcess: () => capture.promise },
    llmService: { processImageWithSkillStream: async () => ({
      response: 'answer', metadata: { processingTime: 1, usedFallback: false }
    }) },
    sessionManager: {
      getOptimizedHistory: () => ({ recent: [] }), addModelResponse() {}, addConversationEvent() {}
    },
    require: name => name === 'electron' ? { app } : createRequire(controllerFile)(name)
  };
  const Controller = vm.runInNewContext(
    source.slice(start, end) + '\nApplicationController', controllerContext, { filename: controllerFile }
  );
  const controller = Object.create(Controller.prototype);
  Object.assign(controller, {
    isReady: true, isRootMode: true, operationEpoch: 0, activeSkill: 'dsa', codingLanguage: 'cpp',
    broadcastTranscriptionLLMResponse() {}, broadcastOCRError() {}
  });
  controller.setupIPCHandlers();

  t.after(() => { for (const id of timers) clearTimeout(id); });
  return {
    manager, main, chat, capture,
    startCapture: () => controller.triggerScreenshotOCR('qa-capture'),
    closeChat: () => {
      const handler = handlers.get('close-window');
      assert.equal(typeof handler, 'function', 'production close-window IPC is registered');
      return handler({ sender: chat.webContents });
    }
  };
}

test('a normal screenshot opens the chat after capture completes', async t => {
  const f = fixture(t, { chatInitiallyVisible: false });
  const pending = f.startCapture();
  assert.equal(f.chat.isVisible(), false, 'capture runs before showing the chat');
  f.capture.resolve({ imageBuffer: Buffer.from('image'), mimeType: 'image/png' });
  await pending;
  assert.equal(f.chat.isVisible(), true, 'ordinary capture still opens the answer surface');
  assert.equal(f.chat.focusCalls, 0, 'automatic answer display leaves exam focus alone');
  assert.equal(f.main.focusCalls, 0, 'capture does not focus the toolbar');
});

test('hiding chat through its close control during capture prevents a late reopen', async t => {
  const f = fixture(t);
  const pending = f.startCapture();
  assert.equal(f.chat.isVisible(), true);
  assert.equal(f.closeChat().success, true);
  assert.equal(f.chat.isVisible(), false, 'user hide takes effect while capture is pending');
  f.capture.resolve({ imageBuffer: Buffer.from('image'), mimeType: 'image/png' });
  await pending;
  assert.equal(f.chat.isVisible(), false, 'capture completion respects the later user hide');
});

test('hiding the whole UI during capture prevents a late chat reopen', async t => {
  const f = fixture(t);
  const pending = f.startCapture();
  f.manager.hideAllWindowsExcept([]);
  assert.equal(f.main.isVisible(), false);
  assert.equal(f.chat.isVisible(), false);
  f.capture.resolve({ imageBuffer: Buffer.from('image'), mimeType: 'image/png' });
  await pending;
  assert.equal(f.main.isVisible(), false);
  assert.equal(f.chat.isVisible(), false, 'capture completion respects the later visibility hide');
});
