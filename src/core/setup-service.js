'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const MAX_TEXT = 16000;
const MAX_IMAGE = 2 * 1024 * 1024;
const PREVIEW_TTL = 5 * 60 * 1000;
const STEPS = new Set(['welcome', 'account', 'permissions', 'capture', 'preview', 'question', 'answer', 'success', 'complete']);
const MODES = new Set(['text', 'screenshot']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const defaults = () => ({ version: VERSION, completed: false, step: 'welcome', draft: '', inputMode: 'text' });

/** Main-process setup state. Only progress is durable; previews and answers are not. */
class SetupService {
  #state;
  #preview = null;
  #operation = null;
  #epoch = 0;
  #context;
  #answered = false;
  #lastRequestId = null;

  constructor({ userDataPath, platformAdapter, captureService, managedSession,
    getAIMode = () => 'managed', answer, materialsManager, now = Date.now, legacyCompleted = false } = {}) {
    if (!userDataPath || !platformAdapter || !captureService || !managedSession) throw new TypeError('Setup dependencies are required');
    this.filename = path.join(userDataPath, 'setup-state.json');
    this.platformAdapter = platformAdapter;
    this.captureService = captureService;
    this.managedSession = managedSession;
    this.getAIMode = getAIMode;
    this.answer = answer;
    this.materialsManager = materialsManager;
    this.materialDraft = null;
    this.now = now;
    this.#context = this._context();
    this.#state = this._read(legacyCompleted);
  }

  _read(legacyCompleted) {
    try {
      if (fs.statSync(this.filename).size > MAX_TEXT * 6 + 1024) throw new Error('State too large');
      const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (!object(saved) || saved.version !== VERSION || typeof saved.completed !== 'boolean' ||
          !STEPS.has(saved.step) || !MODES.has(saved.inputMode) || typeof saved.draft !== 'string' || saved.draft.length > MAX_TEXT) {
        throw new Error('Invalid state');
      }
      // Copy only the versioned progress fields, never renderer assets or credentials.
      return { version: VERSION, completed: saved.completed, step: saved.step, draft: saved.draft, inputMode: saved.inputMode };
    } catch (error) {
      // A legacy sentinel is an existing user's completion, not a new success test.
      // Never use it to override corrupt or unsupported new state.
      return { ...defaults(), completed: error.code === 'ENOENT' && legacyCompleted === true };
    }
  }

  _write(next) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const staging = `${this.filename}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(staging, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(this._materialScope() ? {...next,draft:''} : next), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(staging, this.filename);
      this.#state = next;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(staging); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  _materialScope() { return ['draft','active'].includes(this.materialsManager?.status().state); }

  _context() {
    const status = this.managedSession.status();
    return JSON.stringify([this.getAIMode(), status.configured, status.authenticated, status.account?.subject]);
  }

  _syncContext() {
    const current = this._context();
    if (current !== this.#context) {
      this.invalidate();
      this.#context = current;
    }
  }

  // Synchronous invalidation is also used before account/mode changes in main.
  invalidate() {
    this.#epoch++;
    if(this.materialDraft!==null){this.#state.draft='';this.materialDraft=null;this._write({...this.#state,draft:''});}
    this.#preview = null;
    this.#answered = false;
    this.#lastRequestId = null;
    this.#operation?.controller.abort();
    this.#operation = null;
  }

  getStatus() {
    this._syncContext();
    if (this.#preview && this.now() >= this.#preview.expiresAt) this.#preview = null;
    const capabilities = this.platformAdapter.checkCapabilities();
    return { ...this.#state, capabilities, managed: this.managedSession.status(), aiMode: this.getAIMode(),
      busy: Boolean(this.#operation), operation: this.#operation?.kind || null,
      canComplete: this.#answered, requestId: this.#lastRequestId,
      hasPreview: Boolean(this.#preview), needsOnboarding: !this.#state.completed,
      maxTextLength: MAX_TEXT, maxImageBytes: MAX_IMAGE };
  }

  saveProgress(progress) {
    this._syncContext();
    if (!object(progress)) throw fail('INVALID_PROGRESS', 'Setup progress must be an object.');
    const next = { ...this.#state };
    if (progress.step !== undefined) {
      if (!STEPS.has(progress.step)) throw fail('INVALID_PROGRESS', 'Unknown setup step.');
      next.step = progress.step;
    }
    if (progress.draft !== undefined) {
      if (typeof progress.draft !== 'string' || progress.draft.length > MAX_TEXT) throw fail('INPUT_LIMIT', `Use at most ${MAX_TEXT} characters.`);
      next.draft = progress.draft;
    }
    if (progress.inputMode !== undefined) {
      if (!MODES.has(progress.inputMode)) throw fail('INVALID_PROGRESS', 'Choose text or screenshot input.');
      next.inputMode = progress.inputMode;
    }
    const inputChanged = next.inputMode !== this.#state.inputMode;
    if(this._materialScope())this.materialDraft=next.draft;
    this._write(next);
    // Includes changing to text while capture is still pending.
    if (inputChanged) this.cancel().catch(() => {});
    return this.getStatus();
  }

  _begin(kind) {
    this._syncContext();
    if (this.#operation) throw fail('SETUP_BUSY', 'Wait for the current operation or cancel it.');
    const operation = { kind, epoch: this.#epoch, controller: new AbortController(), materialSnapshot:this.materialsManager?.snapshot() };
    this.#operation = operation;
    return operation;
  }

  _check(operation) {
    this._syncContext();
    if (operation.epoch !== this.#epoch || operation.controller.signal.aborted || (operation.materialSnapshot && !this.materialsManager.isCurrent(operation.materialSnapshot))) throw fail('CANCELLED', 'Setup operation was cancelled.');
  }

  async _wait(promise, operation) {
    const signal = operation.controller.signal;
    let abort;
    try {
      const result = await Promise.race([promise, new Promise((_, reject) => {
        abort = () => reject(fail('CANCELLED', 'Setup operation was cancelled.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      })]);
      this._check(operation);
      return result;
    } catch (error) {
      this._check(operation);
      throw error;
    } finally { signal.removeEventListener('abort', abort); }
  }

  _layout() {
    const layout = this.captureService.listDisplays();
    if (!layout?.success || !Array.isArray(layout.displays) || !layout.layoutRevision) throw fail('CAPTURE_UNAVAILABLE', 'Could not list displays. Reconnect the display and retry.');
    return layout;
  }

  _screenAllowed() {
    const capability = this.platformAdapter.checkCapability('screen');
    if (['denied', 'restricted'].includes(capability.permission)) throw fail('SCREEN_PERMISSION_DENIED', 'Allow screen capture in system privacy settings, then check again.');
    if (capability.availability !== 'available') throw fail('CAPTURE_UNAVAILABLE', 'Screen capture is unavailable. Try a text question.');
  }

  async capturePreview(options = {}) {
    const operation = this._begin('capture');
    this.#preview = null;
    try {
      if (!object(options)) throw fail('INVALID_CAPTURE', 'Capture options must be an object.');
      for (const key of Object.keys(options)) {
        if (!['displayId', 'layoutRevision', 'area', 'areaCoordinateSpace'].includes(key)) throw fail('INVALID_CAPTURE', 'Unknown capture option.');
      }
      this._screenAllowed();
      const layout = this._layout();
      if (options.layoutRevision !== undefined && options.layoutRevision !== layout.layoutRevision) throw fail('STALE_DISPLAY_LAYOUT', 'Display layout changed. Select the area again.');
      const id = options.displayId ?? layout.primaryDisplayId;
      if (!['number', 'string'].includes(typeof id)) throw fail('INVALID_CAPTURE', 'Choose a display.');
      const display = layout.displays.find(item => String(item.id) === String(id));
      if (!display) throw fail('DISPLAY_NOT_FOUND', 'Selected display is no longer connected.');
      if (options.areaCoordinateSpace !== undefined && !['display-dip', 'desktop-dip', 'image-pixels'].includes(options.areaCoordinateSpace)) throw fail('INVALID_CAPTURE', 'Unknown capture coordinates.');
      if (Object.hasOwn(options, 'area') && (!object(options.area) || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(options.area[k])) || options.area.width <= 0 || options.area.height <= 0)) throw fail('INVALID_CROP', 'Choose a valid capture area.');
      if (Object.hasOwn(options, 'area') && options.layoutRevision !== layout.layoutRevision) throw fail('STALE_DISPLAY_LAYOUT', 'Select the area again using the current display layout.');
      const captureOptions = { displayId: display.id, layoutRevision: layout.layoutRevision,
        area: Object.hasOwn(options, 'area') ? { x: options.area.x, y: options.area.y, width: options.area.width, height: options.area.height }
          : { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height },
        areaCoordinateSpace: Object.hasOwn(options, 'area') ? options.areaCoordinateSpace || 'image-pixels' : 'display-dip' };
      const capture = await this._wait(this.captureService.captureAndProcess(captureOptions), operation);
      this._screenAllowed();
      if (this._layout().layoutRevision !== layout.layoutRevision) throw fail('STALE_DISPLAY_LAYOUT', 'Display layout changed. Capture a new preview.');
      const bytes = capture?.imageBuffer;
      if (!Buffer.isBuffer(bytes) || !bytes.length || capture.mimeType !== 'image/png' || bytes.length < 24 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw fail('EMPTY_CAPTURE', 'Capture returned no usable PNG image.');
      if (bytes.length > MAX_IMAGE) throw fail('IMAGE_LIMIT', 'Select a smaller area; images must be at most 2 MiB.');
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height) throw fail('EMPTY_CAPTURE', 'Capture returned an empty image.');
      const preview = { id: crypto.randomBytes(32).toString('hex'), bytes: Buffer.from(bytes), mimeType: capture.mimeType,
        width, height, expiresAt: this.now() + PREVIEW_TTL, layoutRevision: layout.layoutRevision, displayId: display.id };
      this.#preview = preview;
      return { id: preview.id, dataUrl: `data:${preview.mimeType};base64,${preview.bytes.toString('base64')}`, width, height };
    } finally { if (this.#operation === operation) this.#operation = null; }
  }

  async submit(input) {
    const operation = this._begin('submit');
    try {
      if (!object(input)) throw fail('INVALID_REQUEST', 'Enter a question.');
      if (input.consent !== true) throw fail('CONSENT_REQUIRED', 'Confirm sending this question and any preview to the service/provider.');
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > MAX_TEXT) throw fail('INPUT_LIMIT', `Enter a question of at most ${MAX_TEXT} characters.`);
      if (!['gemini', 'deepseek', 'qwen'].includes(input.provider)) throw fail('INVALID_PROVIDER', 'Choose Gemini, DeepSeek or Qwen.');
      if (Object.keys(input).some(key => !['text', 'previewId', 'provider', 'consent'].includes(key))) throw fail('INVALID_REQUEST', 'Only a question and a local preview reference can be submitted.');
      const managed = this.managedSession.status();
      if (this.getAIMode() === 'managed') {
        if (!managed.configured) throw fail('not_configured', 'Managed service is not configured in this build.');
        if (!managed.authenticated) throw fail('signed_out', 'Sign in to continue.');
        if (!managed.account?.providers?.includes(input.provider)) throw fail('INVALID_PROVIDER', 'This provider is unavailable for your account.');
      }
      const payload = { text: input.text, provider: input.provider };
      if (input.previewId !== undefined) {
        if (this.#preview && this.now() >= this.#preview.expiresAt) this.#preview = null;
        const preview = this.#preview;
        if (typeof input.previewId !== 'string' || !preview || preview.id !== input.previewId || this.now() >= preview.expiresAt) {
          throw fail('STALE_PREVIEW', 'Capture a new preview before sending.');
        }
        this._screenAllowed();
        const layout = this._layout();
        if (layout.layoutRevision !== preview.layoutRevision || !layout.displays.some(d => String(d.id) === String(preview.displayId))) {
          this.#preview = null;
          throw fail('STALE_DISPLAY_LAYOUT', 'Display layout changed. Capture a new preview.');
        }
        if (!(this.getAIMode()==='managed' && managed.account?.providerCapabilities ? managed.account.providerCapabilities[input.provider] : require('./ai-providers').getProviderCapabilities(input.provider, process.env[input.provider.toUpperCase()+'_MODEL'], process.env[input.provider.toUpperCase()+'_BASE_URL']))?.vision) throw fail('image_not_supported', 'The selected model does not support screenshot questions.');
        payload.image = { mimeType: preview.mimeType, data: preview.bytes.toString('base64') };
      }
      this.#answered = false;
      this.#lastRequestId = null;
      if(this._materialScope())this.materialDraft=input.text;
      // Persist the retryable question before spending allowance, never the answer/image.
      this._write({ ...this.#state, step: 'question', draft: input.text });
      if (!this.answerOrchestrator) {
        this.answerOrchestrator = require('../services/answer-orchestrator').createAnswerOrchestrator({
          materials: this.materialsManager, getAIMode: this.getAIMode, answerDirect: this.answer,
          managedSession: { answerScoped: (payload, options) => typeof this.managedSession.answerScoped === 'function'
            ? this.managedSession.answerScoped(payload, options) : this.managedSession.answer(payload) }
        });
      }
      const result = await this._wait(this.answerOrchestrator(payload, { signal: operation.controller.signal }), operation);
      if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 2 * 1024 * 1024) throw fail('EMPTY_ANSWER', 'No answer was returned. You can explicitly try again.');
      this.#answered = true;
      this.#lastRequestId = typeof result.requestId === 'string' ? result.requestId : null;
      return { text: result.text, requestId: this.#lastRequestId, sources: result.sources, materialSession: result.materialSession, materialStatus: result.materialStatus, materialNotice: result.materialNotice };
    } finally { if (this.#operation === operation) this.#operation = null; }
  }

  async cancel() {
    const needsLegacyCancellation = this.#operation?.kind === 'submit' && this.getAIMode() === 'managed'
      && typeof this.managedSession.answerScoped !== 'function';
    this.invalidate();
    if (needsLegacyCancellation) await this.managedSession.cancelAll();
    return this.getStatus();
  }

  complete() {
    this._syncContext();
    if (this.#operation || !this.#answered) throw fail('ANSWER_REQUIRED', 'Get a successful answer before finishing setup.');
    this._write({ ...this.#state, completed: true, step: 'complete', draft: '' });
    this.#preview = null;
    return this.getStatus();
  }
}

module.exports = { SetupService };
