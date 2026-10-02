'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/managers/window.manager.js'), 'utf8');
const quietLogger = { info() {}, debug() {}, warn() {}, error() {} };

function fixture(initialDisplay, { chatVisible = false } = {}) {
  const screen = new EventEmitter();
  let cursorDisplay = initialDisplay;
  screen.getCursorScreenPoint = () => ({ x: 30, y: 30 });
  screen.getDisplayNearestPoint = () => cursorDisplay;
  screen.getPrimaryDisplay = () => cursorDisplay;
  const pendingTimeouts = [];
  let nextTimerId = 1;
  const sandbox = {
    module: { exports: {} },
    process: { platform: 'win32', env: {} },
    console,
    setTimeout: (callback, delay) => {
      const id = nextTimerId++;
      pendingTimeouts.push({ id, callback, delay, cancelled: false });
      return id;
    },
    clearTimeout: id => {
      const timer = pendingTimeouts.find(item => item.id === id);
      if (timer) timer.cancelled = true;
    },
    setInterval: () => 1,
    require: name => {
      if (name === 'electron') return { screen };
      if (name === '../core/logger') return { createServiceLogger: () => quietLogger };
      if (name === '../core/config') return {};
      return require(name);
    }
  };
  vm.runInNewContext(
    source.replace('module.exports = new WindowManager();', 'module.exports = WindowManager;'),
    sandbox,
    { filename: 'window.manager.js' }
  );
  const manager = Object.create(sandbox.module.exports.prototype);
  const positions = [];
  const showCalls = [];
  const chat = {
    isDestroyed: () => false,
    isVisible: () => chatVisible,
    getSize: () => [500, 700],
    setPosition: (x, y) => positions.push({ x, y })
  };
  Object.assign(manager, {
    windows: new Map([['chat', chat]]),
    bindWindows: false,
    isScreenBeingShared: false,
    setWindowAlwaysOnTop() {},
    showOnCurrentDesktop: window => showCalls.push(window),
    setupDesktopTracking() {}
  });
  manager.setupScreenTracking();
  return {
    manager, screen, positions, showCalls,
    setCursorDisplay(display) { cursorDisplay = display; },
    runDisplayChange() {
      let timer;
      while (pendingTimeouts.length && !timer) {
        const next = pendingTimeouts.shift();
        if (!next.cancelled) timer = next;
      }
      assert(timer, 'display event schedules reposition work');
      timer.callback();
    },
    runPendingDisplayChanges() {
      for (let i = 0; pendingTimeouts.length && i < 10; i++) {
        const timer = pendingTimeouts.shift();
        if (!timer.cancelled) timer.callback();
      }
      assert.equal(pendingTimeouts.length, 0);
    }
  };
}

test('Windows display removal moves chat into the surviving display at the event deadline', () => {
  const removed = { id: 1, workArea: { x: 0, y: 0, width: 1600, height: 900 } };
  const surviving = { id: 2, workArea: { x: 1600, y: 0, width: 1600, height: 900 } };
  const f = fixture(removed);
  f.setCursorDisplay(surviving);
  f.screen.emit('display-removed');
  f.runDisplayChange();
  assert.equal(f.manager.currentDisplay.id, 2, 'removed display must not remain the positioning target');
  assert.deepEqual(f.positions.at(-1), { x: 2650, y: 20 });
});

test('Windows work-area change on the same display ID refreshes cached bounds', () => {
  const before = { id: 7, workArea: { x: 0, y: 0, width: 1600, height: 900 } };
  const after = { id: 7, workArea: { x: 0, y: 0, width: 1200, height: 800 } };
  const f = fixture(before);
  f.setCursorDisplay(after);
  f.screen.emit('display-metrics-changed');
  f.runDisplayChange();
  f.manager.trackActiveScreen();
  assert.equal(f.manager.currentDisplay.workArea.width, 1200, 'new metrics must replace the cached work area');
  assert.deepEqual(f.positions.at(-1), { x: 650, y: 20 });
});

test('control: cursor moving to a different display updates the target without an event', () => {
  const first = { id: 1, workArea: { x: 0, y: 0, width: 1600, height: 900 } };
  const second = { id: 2, workArea: { x: 1600, y: 0, width: 1600, height: 900 } };
  const f = fixture(first);
  f.setCursorDisplay(second);
  f.manager.trackActiveScreen();
  assert.equal(f.manager.currentDisplay.id, 2);
  assert.deepEqual(f.positions.at(-1), { x: 2650, y: 20 });
});

test('burst Windows display metric events perform one reposition for the final layout', () => {
  const before = { id: 7, workArea: { x: 0, y: 0, width: 1600, height: 900 } };
  const after = { id: 7, workArea: { x: 0, y: 0, width: 1200, height: 800 } };
  const f = fixture(before);
  f.setCursorDisplay(after);
  f.screen.emit('display-metrics-changed');
  f.screen.emit('display-metrics-changed');
  f.screen.emit('display-metrics-changed');
  f.runPendingDisplayChanges();
  assert.deepEqual(f.positions, [{ x: 650, y: 20 }]);
});

test('unchanged Windows display metrics do not re-show an already visible chat', () => {
  const display = { id: 7, workArea: { x: 0, y: 0, width: 1600, height: 900 } };
  const f = fixture(display, { chatVisible: true });
  f.screen.emit('display-metrics-changed');
  f.runDisplayChange();
  assert.equal(f.showCalls.length, 0, 'unchanged layout must not churn visible-window z-order');
});

test('Ctrl+Shift+V hides a chat reopened with C after the overlays were hidden', () => {
  const display = { id: 7, workArea: { x: 0, y: 0, width: 1600, height: 900 } };
  const f = fixture(display);
  let visible = true;
  const chat = {
    id: 42,
    isDestroyed: () => false,
    isVisible: () => visible,
    hide: () => { visible = false; },
    showInactive: () => { visible = true; },
    setVisibleOnAllWorkspaces() {}
  };
  f.manager.windows = new Map([['chat', chat]]);
  f.manager.windowConfigs = { chat: {} };
  f.manager.isVisible = true;
  delete f.manager.showOnCurrentDesktop;
  f.manager.toggleVisibility();
  assert.equal(visible, false);
  f.manager.switchToWindow('chat');
  assert.equal(visible, true);
  f.manager.toggleVisibility();
  assert.equal(visible, false, 'visibility toggle follows what is actually on screen');
});

function answerFixture({ captureService, captureAndProcess, processImageWithSkillStream, processTextWithSkillStream, includeChat = false } = {}) {
  const display = { id: 7, workArea: { x: 0, y: 0, width: 1600, height: 900 } };
  const f = fixture(display);
  let visible = false;
  const messages = [];
  const panel = {
    id: 99,
    isDestroyed: () => false,
    isVisible: () => visible,
    hide: () => { visible = false; },
    showInactive: () => { visible = true; },
    setVisibleOnAllWorkspaces() {},
    webContents: { send: (channel, payload) => messages.push({ windowType: 'llmResponse', channel, payload }) }
  };
  let settingsVisible = false;
  const settings = {
    id: 100,
    isDestroyed: () => false,
    isVisible: () => settingsVisible,
    hide: () => { settingsVisible = false; },
    showInactive: () => { settingsVisible = true; },
    setVisibleOnAllWorkspaces() {},
    webContents: { send: (channel, payload) => messages.push({ windowType: 'settings', channel, payload }) }
  };
  f.manager.windows = new Map([['llmResponse', panel], ['settings', settings]]);
  if (includeChat) {
    f.manager.windows.set('chat', {
      isDestroyed: () => false,
      isVisible: () => false,
      webContents: { send: (channel, payload) => messages.push({ windowType: 'chat', channel, payload }) }
    });
  }
  f.manager.bindWindows = false;
  f.manager.isVisible = true;
  delete f.manager.showOnCurrentDesktop;
  f.manager.centerWindow = () => {};

  let finishAnswer, rejectAnswer;
  const answer = new Promise((resolve, reject) => { finishAnswer = resolve; rejectAnswer = reject; });
  const sessionManager = {
    getOptimizedHistory: () => ({ recent: [] }),
    addUserInput() {},
    addModelResponse() {},
    addConversationEvent() {}
  };
  const ipcListeners = new Map();
  let answerSurface = 'panel';
  let voiceDelta;
  const voiceEnv = { WHISPER_RESPONSE_TARGET: 'overlay' };
  const context = {
    Buffer, console,
    process: { env: voiceEnv },
    config: { get: key => key === 'ui.answerSurface' ? answerSurface : undefined },
    logger: quietLogger,
    windowManager: f.manager,
    ipcMain: { handle() {}, on: (channel, listener) => ipcListeners.set(channel, listener) },
    sessionManager,
    captureService: captureService || { captureAndProcess: captureAndProcess || (async () => ({ imageBuffer: Buffer.from('image'), mimeType: 'image/png' })) },
    llmService: {
      processImageWithSkillStream: processImageWithSkillStream || (() => answer),
      processTextWithSkillStream: processTextWithSkillStream || (() => answer),
      processTranscriptionWithIntelligentResponseStream: (...args) => { voiceDelta = args.at(-1); return answer; },
      generateIntelligentFallbackResponse: () => ({ response: 'fixture fallback', metadata: { processingTime: 1, usedFallback: true } })
    }
  };
  const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const controllerSource = mainSource.slice(
    mainSource.indexOf('class ApplicationController {'),
    mainSource.indexOf('const gotSingleInstanceLock')
  );
  const Controller = vm.runInNewContext(controllerSource + '\nApplicationController', context);
  const controller = Object.create(Controller.prototype);
  Object.assign(controller, { isReady: true, operationEpoch: 0, activeSkill: 'dsa', codingLanguage: 'JavaScript', isRootMode: false });
  controller.setupIPCHandlers();

  return {
    manager: f.manager, controller, messages, finishAnswer, rejectAnswer,
    isVisible: () => visible, isSettingsVisible: () => settingsVisible,
    setAnswerSurface(value) { answerSurface = value; },
    setVoiceResponseTarget(value) { voiceEnv.WHISPER_RESPONSE_TARGET = value; },
    emitVoiceDelta(delta) { assert.equal(typeof voiceDelta, 'function'); voiceDelta(delta); },
    emitIPC(channel) {
      const listener = ipcListeners.get(channel);
      assert(listener, `${channel} IPC handler registered`);
      listener({});
    }
  };
}

for (const surface of ['screenshot', 'text']) test(
  `${surface} answer arriving after Ctrl+Shift+V stays hidden`, async () => {
  const f = answerFixture();
  const pending = surface === 'screenshot'
    ? f.controller.triggerScreenshotOCR()
    : f.controller.processWithLLM('question', { recent: [] });
  await new Promise(setImmediate);
  assert.equal(f.isVisible(), true, 'the in-flight request shows its loading panel');
  f.manager.toggleVisibility();
  assert.equal(f.isVisible(), false, 'V hides the loading panel');
  f.finishAnswer({ response: 'fixture answer', metadata: { processingTime: 1, usedFallback: false } });
  await pending;
  assert(f.messages.some(message => message.channel === 'display-llm-response'), 'the answer reached the real window manager');
  assert.equal(f.isVisible(), false, 'late answer may update content without reversing the user hide');
});

test('S answer after V-hide stays hidden when unrelated Settings is opened', async () => {
  const f = answerFixture();
  const pending = f.controller.triggerScreenshotOCR();
  await new Promise(setImmediate);
  assert.equal(f.isVisible(), true);
  f.manager.toggleVisibility();
  assert.equal(f.isVisible(), false);
  f.manager.showSettings();
  assert.equal(f.isSettingsVisible(), true, 'Settings is independently visible');
  f.finishAnswer({ response: 'fixture answer', metadata: { processingTime: 1, usedFallback: false } });
  await pending;
  assert(f.messages.some(message => message.channel === 'display-llm-response'));
  assert.equal(f.isVisible(), false, 'Settings must not cancel the explicit V hide of the answer panel');
});

test('S answer after an explicit V show may reveal its panel', async () => {
  const f = answerFixture();
  const pending = f.controller.triggerScreenshotOCR();
  await new Promise(setImmediate);
  f.manager.toggleVisibility();
  assert.equal(f.isVisible(), false);
  f.manager.toggleVisibility();
  assert.equal(f.isSettingsVisible(), true, 'V restored the normal windows');
  f.finishAnswer({ response: 'fixture answer', metadata: { processingTime: 1, usedFallback: false } });
  await pending;
  assert.equal(f.isVisible(), true, 'the later explicit V show permits answer reveal');
});

for (const outcome of ['provider answer', 'fallback answer']) test(
  `voice ${outcome} arriving after Ctrl+Shift+V stays hidden`, async () => {
  const f = answerFixture();
  const pending = f.controller.processTranscriptionWithLLM('spoken question', { recent: [] });
  await new Promise(setImmediate);
  assert.equal(f.isVisible(), true, 'voice request shows its loading panel');
  f.manager.toggleVisibility();
  assert.equal(f.isVisible(), false);
  if (outcome === 'provider answer') {
    f.finishAnswer({ response: 'fixture answer', metadata: { processingTime: 1, usedFallback: false } });
  } else {
    f.rejectAnswer(new Error('fixture provider failure'));
  }
  await pending;
  assert(f.messages.some(message => message.channel === 'display-llm-response'), 'voice result reached the real window manager');
  assert.equal(f.isVisible(), false, 'late voice result must not reverse the user hide');
});

for (const target of ['overlay', 'both']) test(
  `chat-only answer surface still delivers ${target} voice events to a hidden, unowned panel`, async () => {
  const f = answerFixture({ includeChat: true });
  f.setAnswerSurface('chat');
  f.setVoiceResponseTarget(target);
  const pending = f.controller.processTranscriptionWithLLM('spoken question', { recent: [] });
  await new Promise(setImmediate);
  f.emitVoiceDelta('voice token');
  f.finishAnswer({ response: 'voice answer', metadata: { processingTime: 1, usedFallback: false } });
  await pending;
  const channels = ['transcription-llm-response-start', 'transcription-llm-response-chunk', 'transcription-llm-response'];
  const panelEvents = f.messages.filter(message => message.windowType === 'llmResponse' && channels.includes(message.channel)).map(message => message.channel);
  const chatEvents = f.messages.filter(message => message.windowType === 'chat' && channels.includes(message.channel)).map(message => message.channel);
  assert.deepEqual(panelEvents, channels, 'configured voice overlay keeps receiving its stream events');
  assert.deepEqual(chatEvents, target === 'both' ? channels : []);
  assert.equal(f.isVisible(), false, 'chat-only answer surface does not auto-show the panel');
});

for (const target of ['overlay', 'both']) test(
  `chat-only ${target} voice events do not touch a visible panel owned by S`, async () => {
  let finishScreenshot;
  const f = answerFixture({
    includeChat: true,
    processImageWithSkillStream: () => new Promise(resolve => { finishScreenshot = resolve; })
  });
  const screenshot = f.controller.triggerScreenshotOCR('panel-owner');
  await new Promise(setImmediate);
  assert.equal(f.isVisible(), true);
  f.setAnswerSurface('chat');
  f.setVoiceResponseTarget(target);
  const voice = f.controller.processTranscriptionWithLLM('spoken question', { recent: [] });
  await new Promise(setImmediate);
  f.emitVoiceDelta('voice token');
  f.finishAnswer({ response: 'voice answer', metadata: { processingTime: 1, usedFallback: false } });
  await voice;
  const voicePanelEvents = f.messages.filter(message =>
    message.windowType === 'llmResponse' &&
    message.channel.startsWith('transcription-llm-response') &&
    String(message.payload?.messageId || '').startsWith('tr-'));
  f.setAnswerSurface('panel');
  finishScreenshot({ response: 'screenshot answer', metadata: { processingTime: 1, usedFallback: false } });
  await screenshot;
  assert.deepEqual(voicePanelEvents, [], 'voice stream does not overwrite the active screenshot panel');
  assert.equal(f.messages.filter(message => message.channel === 'display-llm-response').at(-1).payload.content, 'screenshot answer');
});

test('panel close IPC keeps an in-flight S answer hidden while receiving its content', async () => {
  const f = answerFixture();
  const pending = f.controller.triggerScreenshotOCR('closed-panel');
  await new Promise(setImmediate);
  assert.equal(f.isVisible(), true);
  f.emitIPC('hide-llm-response');
  assert.equal(f.isVisible(), false);
  f.finishAnswer({ response: 'closed panel answer', metadata: { processingTime: 1, usedFallback: false } });
  await pending;
  assert(f.messages.some(message => message.channel === 'display-llm-response' && message.payload.content === 'closed panel answer'));
  assert.equal(f.isVisible(), false, 'a direct panel close must remain in force after the answer arrives');
});

function overlappingScreenshotFixture() {
  const answers = [];
  const f = answerFixture({
    includeChat: true,
    processImageWithSkillStream: (...args) => new Promise((resolve, reject) => answers.push({ resolve, reject, delta: args.at(-1) }))
  });
  return { ...f, answers };
}

test('an older S failure cannot hide a newer S loading panel', async () => {
  const f = overlappingScreenshotFixture();
  const older = f.controller.triggerScreenshotOCR('older');
  await new Promise(setImmediate);
  const newer = f.controller.triggerScreenshotOCR('newer');
  await new Promise(setImmediate);
  assert.equal(f.answers.length, 2, 'both captures have reached the provider');
  f.answers[0].reject(new Error('older provider failure'));
  await older;
  const visibleAfterOlderFailure = f.isVisible();
  f.answers[1].resolve({ response: 'newer answer', metadata: { processingTime: 1, usedFallback: false } });
  await newer;
  assert.equal(visibleAfterOlderFailure, true, 'newer request still owns the loading panel');
  assert.equal(f.isVisible(), true);
});

test('a busy second S cannot hide the first S loading panel during capture', async () => {
  let finishCapture;
  const captureService = {
    isProcessing: false,
    captureAndProcess() {
      if (this.isProcessing) return Promise.reject(Object.assign(new Error('Capture already in progress'), { code: 'CAPTURE_BUSY' }));
      this.isProcessing = true;
      return new Promise(resolve => {
        finishCapture = value => { this.isProcessing = false; resolve(value); };
      });
    }
  };
  const f = answerFixture({
    captureService
  });
  const first = f.controller.triggerScreenshotOCR('first-capture');
  await new Promise(setImmediate);
  assert.equal(f.isVisible(), true);
  const busy = f.controller.triggerScreenshotOCR('busy-second-capture');
  await busy;
  const visibleAfterBusy = f.isVisible();
  finishCapture({ imageBuffer: Buffer.from('first image'), mimeType: 'image/png' });
  await new Promise(setImmediate);
  f.finishAnswer({ response: 'first answer', metadata: { processingTime: 1, usedFallback: false } });
  await first;
  assert.equal(visibleAfterBusy, true, 'busy refusal must leave the first request loading');
  assert.equal(f.isVisible(), true);
  assert.equal(f.messages.filter(message => message.channel === 'display-llm-response').at(-1).payload.content, 'first answer');
});

test('an older S success cannot replace a newer S result', async () => {
  const f = overlappingScreenshotFixture();
  const older = f.controller.triggerScreenshotOCR('older');
  await new Promise(setImmediate);
  const newer = f.controller.triggerScreenshotOCR('newer');
  await new Promise(setImmediate);
  assert.equal(f.answers.length, 2);
  f.answers[1].resolve({ response: 'newer answer', metadata: { processingTime: 1, usedFallback: false } });
  await newer;
  f.answers[0].resolve({ response: 'older answer', metadata: { processingTime: 1, usedFallback: false } });
  await older;
  const displayed = f.messages.filter(message => message.channel === 'display-llm-response').map(message => message.payload.content);
  assert.equal(displayed.at(-1), 'newer answer', 'the latest request retains ownership of the visible result');
});

test('an older S success cannot replace a newer S loading panel', async () => {
  const f = overlappingScreenshotFixture();
  const older = f.controller.triggerScreenshotOCR('older');
  await new Promise(setImmediate);
  const newer = f.controller.triggerScreenshotOCR('newer');
  await new Promise(setImmediate);
  assert.equal(f.answers.length, 2);
  f.answers[0].resolve({ response: 'older answer', metadata: { processingTime: 1, usedFallback: false } });
  await older;
  const displayedWhileNewerWaited = f.messages.filter(message => message.channel === 'display-llm-response').map(message => message.payload.content);
  f.answers[1].resolve({ response: 'newer answer', metadata: { processingTime: 1, usedFallback: false } });
  await newer;
  assert.deepEqual(displayedWhileNewerWaited, [], 'newer loading state must remain visible until its answer arrives');
  assert.equal(f.messages.filter(message => message.channel === 'display-llm-response').at(-1).payload.content, 'newer answer');
});

test('older S stream chunks reach chat but not the newer answer panel', async () => {
  const f = overlappingScreenshotFixture();
  const older = f.controller.triggerScreenshotOCR('older');
  await new Promise(setImmediate);
  const newer = f.controller.triggerScreenshotOCR('newer');
  await new Promise(setImmediate);
  assert.equal(f.answers.length, 2);
  f.answers[0].delta('old token');
  f.answers[1].delta('new token');
  const chunks = f.messages.filter(message => message.channel === 'transcription-llm-response-chunk');
  const chatTokens = chunks.filter(message => message.windowType === 'chat').map(message => message.payload.delta);
  const panelTokens = chunks.filter(message => message.windowType === 'llmResponse').map(message => message.payload.delta);
  f.answers[0].resolve({ response: 'older answer', metadata: { processingTime: 1, usedFallback: false } });
  f.answers[1].resolve({ response: 'newer answer', metadata: { processingTime: 1, usedFallback: false } });
  await Promise.all([older, newer]);
  assert.deepEqual(chatTokens, ['old token', 'new token'], 'chat retains both request streams');
  assert.deepEqual(panelTokens, ['new token'], 'the shared panel receives only its current owner stream');
});

test('S capture completing after a typed request claims the panel starts only in chat', async () => {
  let finishCapture, finishScreenshot, finishText;
  const f = answerFixture({
    includeChat: true,
    captureService: { isProcessing: false, captureAndProcess: () => new Promise(resolve => { finishCapture = resolve; }) },
    processImageWithSkillStream: () => new Promise(resolve => { finishScreenshot = resolve; }),
    processTextWithSkillStream: () => new Promise(resolve => { finishText = resolve; })
  });
  const screenshot = f.controller.triggerScreenshotOCR('s1');
  await new Promise(setImmediate);
  const typed = f.controller.processWithLLM('typed question', { recent: [] }, 't2');
  await new Promise(setImmediate);
  finishCapture({ imageBuffer: Buffer.from('s1 image'), mimeType: 'image/png' });
  await new Promise(setImmediate);
  const starts = f.messages.filter(message =>
    message.channel === 'transcription-llm-response-start' && message.payload.requestId === 's1');
  const chatStarts = starts.filter(message => message.windowType === 'chat').length;
  const panelStarts = starts.filter(message => message.windowType === 'llmResponse').length;
  assert.equal(typeof finishScreenshot, 'function', 'S1 reached its provider after delayed capture');
  finishScreenshot({ response: 's1 answer', metadata: { processingTime: 1, usedFallback: false } });
  finishText({ response: 't2 answer', metadata: { processingTime: 1, usedFallback: false } });
  await Promise.all([screenshot, typed]);
  assert.equal(chatStarts, 1, 'chat receives S1 start for its own request bubble');
  assert.equal(panelStarts, 0, 'S1 must not reset the panel owned by T2');
});

test('a chat-only text error cannot hide another request\'s answer panel', async () => {
  const f = answerFixture({ processTextWithSkillStream: async () => { throw new Error('chat-only provider failure'); } });
  const screenshot = f.controller.triggerScreenshotOCR('panel-request');
  await new Promise(setImmediate);
  assert.equal(f.isVisible(), true);
  f.setAnswerSurface('chat');
  await f.controller.processWithLLM('typed question', { recent: [] }, 'chat-only-request');
  const visibleAfterChatError = f.isVisible();
  f.setAnswerSurface('panel');
  f.finishAnswer({ response: 'panel answer', metadata: { processingTime: 1, usedFallback: false } });
  await screenshot;
  assert.equal(visibleAfterChatError, true, 'chat-only cleanup cannot hide a panel it never owned');
  assert.equal(f.isVisible(), true);
});
