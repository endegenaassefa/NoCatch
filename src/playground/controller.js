'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, screen, shell, globalShortcut } = require('electron');
const { PlaygroundSession } = require('./session');
const CHANNEL = 'ingestion-playground';
const RECOVERY = 'Control+Shift+Alt+Escape';
const failure = message => { throw new Error(message); };

class PlaygroundController {
  constructor({ application, captureService, showSettings }) {
    this.application = application; this.captureService = captureService; this.showSettings = showSettings;
    this.assets = path.join(app.getAppPath(), 'assets', 'playground');
    this.exam = new PlaygroundSession({ questions: JSON.parse(fs.readFileSync(path.join(this.assets, 'questions.json'), 'utf8')) });
    this.records = []; this.events = []; this.imageBytes = 0; this.pending = null; this.disposed = false;
    this.courseFolder = ''; this.materialSnapshot = null;
    this.captureAuthorizations = new WeakMap(); this.activeCapture = null;
  }
  async open() {
    const win = this.window = new BrowserWindow({ title: 'NoCatch • Ingestion playground', width: 1250, height: 850,
      minWidth: 760, minHeight: 600, backgroundColor: '#ffffff', autoHideMenuBar: true,
      minimizable: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
        sandbox: true, nodeIntegration: false, webSecurity: true, partition: `playground-${randomUUID()}`, devTools: false } });
    win.setContentProtection(true); win.removeMenu();
    const allowed = new Set(['playground.html', 'src/ui/playground.js', 'src/ui/playground.css'].map(p => pathToFileURL(path.join(app.getAppPath(), p)).href));
    win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !allowed.has(details.url) && !details.url.startsWith('data:image/') }));
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.session.on('will-download', event => { event.preventDefault(); this.log('Download blocked'); });
    win.webContents.setWindowOpenHandler(() => { this.log('New window blocked'); return { action: 'deny' }; });
    win.webContents.on('will-navigate', event => { event.preventDefault(); this.log('Navigation blocked'); });
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('context-menu', event => { event.preventDefault(); this.log('Context menu blocked'); });
    win.webContents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase();
      if (key === 'escape' && input.type === 'keyDown') { event.preventDefault(); this.requestExit(); }
      if ((input.control || input.meta) && ['c','v','x','p','r','l','w','n','+','-','=','0'].includes(key) || ['f5','f11','f12'].includes(key) || (input.alt && ['left','right'].includes(key))) {
        event.preventDefault(); this.log(`Keyboard action blocked: ${key}`);
      }
    });
    win.on('blur', () => {
      const previous = this.exam.status(); this.exam.focusLost();
      if (previous.mode === 'restriction' && previous.phase === 'running') {
        this.cancelWork(); this.log('Focus left the exam; acknowledgment required'); this.publish();
      }
    });
    win.on('close', event => { if (!this.disposed && !this.application._quitting) { event.preventDefault(); this.requestExit(); } });
    ipcMain.handle(CHANNEL, async (event, action, payload) => {
      if (this.disposed || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(path.join(app.getAppPath(), 'playground.html')).href) throw new Error('Untrusted playground request');
      try { return { success: true, value: await this.action(action, payload || {}) }; }
      catch (error) { return { success: false, error: String(error.message).slice(0, 512) }; }
    });
    this.recoveryRegistered = globalShortcut.register(RECOVERY, () => this.emergency());
    this.timer = setInterval(() => { this.check(); this.publish(); }, 1000); this.timer.unref?.();
    await win.loadFile(path.join(app.getAppPath(), 'playground.html'));
    win.webContents.setZoomFactor(1); await win.webContents.setVisualZoomLevelLimits(1, 1);
    win.show(); win.focus();
  }
  reveal() {
    if (this.disposed || !this.window || this.window.isDestroyed()) return;
    this.check();
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    this.publish();
  }
  check() {
    const status = this.exam.status();
    if (this.materialSnapshot && !this.application.materialsManager.isCurrent(this.materialSnapshot)) {
      this.wipe(); this.exam.clear(); this.materialSnapshot = null; this.cancelWork(); this.log('Materials changed or expired; run cleared');
    } else if (status.phase === 'expired' && this.lastPhase !== 'expired') { this.wipe(); this.cancelWork(); }
    this.lastPhase = this.exam.status().phase;
    if (this.lastPhase !== 'running') this.window?.setContentProtection(true);
  }
  materialsChanged() { if (!this.exam || this.disposed) return; this.check(); this.publish(); }
  state() {
    this.check();
    return { ...this.exam.status(), questions: this.exam.questions, materials: this.application.materialsStatus(),
      courseFolder: this.courseFolder, busy: Boolean(this.pending), recoveryRegistered: this.recoveryRegistered,
      events: this.events, records: this.records.map(({ image, snapshot, ...record }) => record) };
  }
  publish() {
    if (this.disposed || !this.window || this.window.isDestroyed()) return;
    const state = this.state(), serialized = JSON.stringify(state);
    if (serialized === this.lastPublished) return;
    this.lastPublished = serialized; this.window.webContents.send(`${CHANNEL}:state`, state);
  }
  log(message) { this.events.push({ at: new Date().toISOString(), message }); this.events = this.events.slice(-80); }
  wipe() { this.records = []; this.events = []; this.imageBytes = 0; this.lastPublished = null; }
  cancelWork() { this.pending = null; this.captureAuthorizations = new WeakMap(); this.activeCapture = null; this.application.resetPlaygroundHistory(); }
  consumeCaptureAuthorization(options, requestId) {
    const authorization = options && typeof options === 'object' ? this.captureAuthorizations.get(options) : null;
    if (!authorization) failure('Use Capture question in the playground to capture the displayed question.');
    this.captureAuthorizations.delete(options);
    this.beforeAnswer();
    if (authorization.requestId !== requestId || this.pending !== requestId || !this.exam.accepts(authorization.snapshot) || this.exam.questions[this.exam.status().questionIndex].id !== authorization.questionId) failure('The question changed. Use Capture question again.');
    this.activeCapture = authorization;
  }
  reportCaptureError(message) {
    this.log(message);
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(`${CHANNEL}:error`, message);
  }
  beforeAnswer() {
    this.check(); const state = this.exam.status();
    if (state.mode !== 'diagnostic' || !this.exam.accepts(this.exam.snapshot())) failure('Answers are available only during an active diagnostic run.');
    if (this.materialSnapshot && !this.application.materialsManager.isCurrent(this.materialSnapshot)) failure('The materials changed.');
  }
  observe(event) {
    try {
      this.beforeAnswer();
      let record = this.records.find(r => r.requestId === event.requestId);
      if (event.event === 'request:start') {
        if (this.records.length >= 24) { const old = this.records.shift(); this.imageBytes -= old.image?.data.length || 0; }
        record = { requestId: event.requestId, snapshot: this.exam.snapshot(), questionId: event.hasImage && this.activeCapture ? this.activeCapture.questionId : this.exam.questions[this.exam.status().questionIndex].id,
          kind: event.hasImage ? 'Screenshot answer' : 'Text answer', stages: [], text: '', sources: [] };
        this.records.push(record);
      }
      if (!record || !this.exam.accepts(record.snapshot)) return;
      record.stages.push({ event: event.event, elapsedMs: event.elapsedMs }); record.stages = record.stages.slice(-20);
      if (event.event === 'transcription:end') record.transcription = String(event.text).slice(0, 16000);
      if (event.event === 'retrieval:end') { record.retrievedSources = this.safeSources(event.sources); record.strategy = event.strategy; record.materialStatus = event.status; }
      if (event.event === 'answer:end') Object.assign(record, { text: String(event.text).slice(0, 32000), sources: this.safeSources(event.sources), materialNotice: event.materialNotice, strategy: event.strategy, materialStatus: event.materialStatus });
      if (event.event === 'request:error') record.error = `${event.code}: ${event.message}`;
      this.publish();
    } catch { /* Observers never interrupt production answers. */ }
  }
  safeSources(sources) { return (Array.isArray(sources) ? sources : []).slice(0, 24).map(s => ({ id: s.id, documentId: s.documentId, name: s.name, page: s.page, kind: s.kind, text: String(s.text || '').slice(0, 10000) })); }
  observeImage(id, image) {
    const record = this.records.find(r => r.requestId === id);
    if (!record || !this.exam.accepts(record.snapshot) || !['image/png','image/jpeg','image/webp'].includes(image.mimeType) || typeof image.data !== 'string') return;
    if (this.imageBytes + image.data.length > 16 * 1024 * 1024) { record.imageNotice = 'Screenshot omitted: the in-memory review limit was reached.'; return; }
    record.image = { mimeType: image.mimeType, data: image.data }; this.imageBytes += image.data.length;
  }
  requestExit() {
    if (this.exam.status().phase === 'running') { this.exam.requestExit(); this.cancelWork(); this.publish(); }
    else { this.window.setFullScreen(false); this.window.focus(); this.window.webContents.send(`${CHANNEL}:exit`); }
  }
  emergency() {
    if (this.disposed) return;
    this.exam.clear(); this.materialSnapshot = null; this.wipe(); this.cancelWork();
    this.window.setContentProtection(true); this.window.setFullScreen(false);
    const cleared = this.state(); this.publish();
    // Publish before starting cleanup: a rejected cleanup must never retain renderer evidence.
    Promise.resolve().then(() => this.application.materialsManager.end('playground-emergency')).catch(() => {});
    this.window.hide();
    Promise.resolve().then(() => this.application.showMaterials()).catch(() => {});
    return cleared;
  }
  async exportCourse() {
    const manifest = JSON.parse(fs.readFileSync(path.join(this.assets, 'corpus-manifest.json'), 'utf8'));
    const course = path.join(this.assets, 'course');
    if (fs.lstatSync(course).isSymbolicLink()) failure('The course folder must not be a symbolic link.');
    const entries = manifest.files.map(entry => {
      if (typeof entry.filename !== 'string' || path.basename(entry.filename) !== entry.filename || /[\\/]/.test(entry.filename) || !/\.(pptx|pdf)$/i.test(entry.filename)) failure('Invalid course filename.');
      const file = path.join(course, entry.filename); const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) failure('Invalid course file.');
      const bytes = fs.readFileSync(file);
      if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) failure('Course integrity check failed.');
      return { name: entry.filename, bytes };
    });
    const folder = fs.mkdtempSync(path.join(app.getPath('documents'), 'NoCatch-Harbor-course-'));
    for (const entry of entries) fs.writeFileSync(path.join(folder, entry.name), entry.bytes, { flag: 'wx' });
    this.courseFolder = folder; const error = await shell.openPath(folder); if (error) failure(error);
    return this.state();
  }
  async action(action, payload) {
    this.check();
    const state = this.exam.status();
    if (action === 'state') return this.state();
    if (action === 'event') { if (['copy','cut','paste','print','contextmenu'].includes(payload.name)) this.log(`${payload.name} prevented`); return; }
    if (action === 'rendered') {
      if (payload.generation === state.generation && state.phase === 'running' && state.mode === 'diagnostic') this.window.setContentProtection(false);
      return;
    }
    if (action === 'exit') { this.requestExit(); return this.state(); }
    if (action === 'emergency') return this.emergency();
    if (action === 'clear') { this.exam.clear(); this.materialSnapshot = null; this.wipe(); this.cancelWork(); this.window.setContentProtection(true); this.window.setFullScreen(false); await this.application.clearSessionMemory(); this.publish(); return this.state(); }
    if (action === 'quit') { this.dispose(); app.quit(); return; }
    if (action === 'confirmExit') { this.exam.confirmExit(payload.reason); this.cancelWork(); this.window.setContentProtection(true); this.window.setFullScreen(false); this.publish(); return this.state(); }
    if (action === 'cancelExit') { this.exam.cancelExit(); this.publish(); return this.state(); }
    if (action === 'acknowledge') { this.exam.acknowledgeFocus(); this.publish(); return this.state(); }
    if (action === 'finish') { this.exam.finish(); this.cancelWork(); this.window.setContentProtection(true); this.window.setFullScreen(false); this.publish(); return this.state(); }
    if (this.pending) failure('Wait for the current request, or exit to cancel it.');
    if (action === 'exportCourse') { if (state.phase === 'running') failure('Finish this run first.'); return this.exportCourse(); }
    if (action === 'openCourse') { if (!this.courseFolder) failure('Export the course folder first.'); const error = await shell.openPath(this.courseFolder); if (error) failure(error); return; }
    if (action === 'materials' || action === 'settings') { if (state.phase === 'running' && state.mode === 'restriction') failure('Finish the restriction run before opening another window.'); if (action === 'materials') await this.application.showMaterials(); else await this.showSettings(); return; }
    if (action === 'start') {
      if (state.phase !== 'idle') failure('End and clear the previous run first.');
      const manager = this.application.materialsManager, status = manager.status();
      if (!payload.consent) failure('Confirm the scope before starting.');
      if (payload.context === 'materials') { if (status.state !== 'active') failure('Prepare and start the materials session first.'); this.materialSnapshot = manager.snapshot(); }
      else if (payload.context === 'none') { if (['draft','active'].includes(status.state) || status.documents.length) failure('End and clear materials before a run without files.'); this.materialSnapshot = null; }
      else failure('Choose the materials context.');
      this.cancelWork(); this.wipe(); this.exam.start({ mode: payload.mode, materialSession: this.materialSnapshot });
      this.window.setContentProtection(true); this.window.setFullScreen(true); this.window.focus(); this.publish(); return this.state();
    }
    if (action === 'answer') { this.exam.saveAnswer(payload.questionId, payload.text); return; }
    if (action === 'question') { this.exam.goToQuestion(payload.index); this.publish(); return this.state(); }
    if (action === 'review') {
      if (!['completed','exited'].includes(state.phase)) failure('Finish or exit the exam to open the answer key.');
      this.window.setContentProtection(true);
      return { runId: state.runId, generation: state.generation, records: this.records.map(({ snapshot, ...record }) => record), oracle: JSON.parse(fs.readFileSync(path.join(this.assets, 'oracle.json'), 'utf8')) };
    }
    if (action === 'preview') {
      if (!['completed','exited'].includes(state.phase) || !this.materialSnapshot) failure('Source review is unavailable.');
      const generation = state.generation;
      if (!this.records.some(r => (r.retrievedSources || []).some(s => s.documentId === payload.documentId && s.page === payload.page))) failure('Choose a source used in this run.');
      const result = await this.application.materialsManager.previewWithImages(payload.documentId, payload.page);
      this.check(); if (this.exam.status().generation !== generation) failure('Source review expired.'); return result;
    }
    if (action === 'capture' || action === 'retrieve') {
      this.beforeAnswer(); const snapshot = this.exam.snapshot(), question = this.exam.questions[state.questionIndex];
      const token = this.pending = randomUUID(); this.publish();
      try {
        if (action === 'retrieve') {
          if (!this.materialSnapshot) failure('Start with prepared materials to inspect retrieval.');
          const start = Date.now(), result = await this.application.materialsManager.retrieveAsync(question.text, { history: [] });
          if (!this.exam.accepts(snapshot) || this.pending !== token) failure('The run changed or expired.');
          if (this.records.length >= 24) { const old = this.records.shift(); this.imageBytes -= old.image?.data.length || 0; }
          this.records.push({ requestId: token, questionId: question.id, kind: 'Local text retrieval only — no screenshot or model answer', snapshot,
            strategy: result.strategy, materialStatus: result.status, retrievedSources: this.safeSources(result.sources), stages: [{ event: 'retrieval:end', elapsedMs: Date.now() - start }] });
        } else {
          if (payload.questionId !== question.id) failure('The question changed. Use Capture question again.');
          const measured = await this.window.webContents.executeJavaScript(`(() => {
            const panel = document.getElementById('question-panel');
            if (!panel || !panel.getClientRects().length) return null;
            const rect = panel.getBoundingClientRect();
            return { questionId: panel.dataset.questionId, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
          })()`);
          if (!this.exam.accepts(snapshot) || this.pending !== token || measured?.questionId !== question.id) failure('The displayed question changed. Use Capture question again.');
          if (!payload.rect || !measured.rect || !['x','y','width','height'].every(key => Number.isFinite(payload.rect[key]) && Number.isFinite(measured.rect[key]) && Math.abs(payload.rect[key] - measured.rect[key]) <= 0.5)) failure('The question panel moved. Use Capture question again.');
          const rect = measured.rect, bounds = this.window.getContentBounds();
          if (!this.window.isFocused() || this.window.webContents.getZoomFactor() !== 1 || !rect || !['x','y','width','height'].every(k => Number.isFinite(rect[k])) || rect.x < 0 || rect.y < 0 || rect.width < 10 || rect.height < 10 || rect.x + rect.width > bounds.width || rect.y + rect.height > bounds.height) failure('Keep the question visible and focus the exam before capturing.');
          const area = { x: Math.ceil(bounds.x + rect.x), y: Math.ceil(bounds.y + rect.y), width: Math.floor(rect.width), height: Math.floor(rect.height) };
          const display = screen.getDisplayMatching(area), layout = this.captureService.listDisplays();
          if (!layout.success) failure('Display layout is unavailable.');
          const captureOptions = Object.freeze({ area: Object.freeze(area), areaCoordinateSpace: 'desktop-dip', displayId: display.id, layoutRevision: layout.layoutRevision });
          this.captureAuthorizations.set(captureOptions, { requestId: token, questionId: question.id, snapshot });
          const result = await this.application.triggerScreenshotOCR(token, captureOptions);
          if (!this.exam.accepts(snapshot) || this.pending !== token) failure('The run changed or expired.');
          if (!result?.success) failure(result?.error || 'Capture did not complete.');
        }
      } finally { if (this.pending === token) this.pending = null; if (this.activeCapture?.requestId === token) this.activeCapture = null; this.publish(); }
      return this.state();
    }
    failure('Unknown playground action.');
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    clearInterval(this.timer); if (this.recoveryRegistered) globalShortcut.unregister(RECOVERY);
    ipcMain.removeHandler(CHANNEL); this.exam.clear(); this.wipe(); this.cancelWork();
  }
}
module.exports = { PlaygroundController };
