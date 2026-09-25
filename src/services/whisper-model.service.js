const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class WhisperModelService extends EventEmitter {
  constructor({ modelDir, models = require('../core/whisper-models.json'), request = https.get, timeoutMs = 30000, validateModel } = {}) {
    super();
    this.modelDir = path.resolve(modelDir);
    this.models = models;
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.validateModel = validateModel;
    this.states = new Map();
    this.active = null;
    this.closed = false;
    this.initialized = null;
    this.pendingCleanup = new Set();
  }

  _initialize() {
    if (!this.initialized) this.initialized = (async () => {
      await fs.promises.mkdir(this.modelDir, { recursive: true });
      const filenames = new Set(Object.keys(this.models).map(name => this._spec(name).filename));
      for (const name of await fs.promises.readdir(this.modelDir)) {
        const match = /^(.*)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.part$/i.exec(name);
        if (match && filenames.has(match[1])) await fs.promises.rm(path.join(this.modelDir, name), { force: true });
      }
    })().catch(error => { this.initialized = null; throw error; });
    return this.initialized;
  }

  _spec(model) {
    if (!Object.prototype.hasOwnProperty.call(this.models, model)) throw new Error('Choose a supported Whisper model.');
    const spec = this.models[model];
    if (!spec.filename || path.basename(spec.filename) !== spec.filename || /[\\/:]/.test(spec.filename) ||
        !/^[a-f0-9]{64}$/.test(spec.sha256) || !Number.isSafeInteger(spec.size) || spec.size <= 0) {
      throw new Error('Model download metadata is invalid.');
    }
    return spec;
  }

  _file(model) { return path.join(this.modelDir, this._spec(model).filename); }
  _signature(file) {
    try { const s = fs.statSync(file); return s.isFile() ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}` : null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  _status(model, state, extra = {}) {
    const previous = this.states.get(model);
    const snapshot = { supported: true, model, operationId: null, receivedBytes: 0,
      totalBytes: this._spec(model).size, ...previous, state, ...extra };
    this.states.set(model, snapshot);
    this.emit('status', { ...snapshot });
    return { ...snapshot };
  }

  async getStatus(model) {
    this._spec(model);
    await this._initialize();
    if (this.active?.model === model) return { ...this.states.get(model) };
    const previous = this.states.get(model);
    if (previous && ['error', 'cancelled'].includes(previous.state)) return { ...previous };
    const signature = this._signature(this._file(model));
    if (previous?.state === 'ready' && previous.signature === signature && signature) return { ...previous };
    if (!signature) return this._status(model, 'missing', { operationId: null, signature: null, error: null });
    if (this.active) return this._status(model, 'missing', { message: 'Wait for the active model preparation to finish.' });
    return this._start(model, false);
  }

  isReady(model) {
    if (this.closed || !Object.prototype.hasOwnProperty.call(this.models, model)) return false;
    const status = this.states.get(model);
    return status?.state === 'ready' && Boolean(status.signature) && status.signature === this._signature(this._file(model));
  }

  async requireReady(model) {
    const status = await this.getStatus(model);
    if (status.state !== 'ready') throw new Error('Prepare the selected voice model in Settings before recording.');
    return this._file(model);
  }

  async prepare(model) {
    this._spec(model);
    if (this.closed) throw new Error('Voice model preparation is closed.');
    if (this.active) {
      if (this.active.model === model && !this.active.controller.signal.aborted) return this.active.promise;
      throw new Error('Model preparation is busy. Wait for it to finish or cancel.');
    }
    return this._start(model, true);
  }

  _start(model, allowDownload) {
    if (this.closed) return Promise.reject(new Error('Voice model preparation is closed.'));
    const job = { model, id: crypto.randomUUID(), controller: new AbortController() };
    this.active = job;
    this._status(model, 'checking', { operationId: job.id, receivedBytes: 0, error: null, message: null, signature: null });
    // Defer work until the promise is assigned, including for duplicate callers.
    job.promise = Promise.resolve().then(() => this._run(job, allowDownload));
    return job.promise;
  }

  _check(job) { job.controller.signal.throwIfAborted(); }
  async _hash(file, job) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const stream = fs.createReadStream(file, { signal: job.controller.signal });
    for await (const chunk of stream) { this._check(job); bytes += chunk.length; hash.update(chunk); }
    return { sha256: hash.digest('hex'), bytes };
  }

  async _download(job, spec, temporary) {
    const signal = job.controller.signal;
    this._status(job.model, 'downloading', { receivedBytes: 0 });
    let request;
    try {
      const response = await new Promise((resolve, reject) => {
        request = this.request(spec.url, { signal }, res => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Model download failed (HTTP ${res.statusCode}). Retry when your connection is available.`));
            return;
          }
          resolve(res);
        });
        request.on('error', reject);
        request.setTimeout(this.timeoutMs, () => request.destroy(new Error('Model download timed out. Please retry.')));
      });
      const declared = response.headers['content-length'];
      if (declared !== undefined && Number(declared) !== spec.size) {
        response.destroy();
        throw new Error('Model download size differs from the expected size. Please retry.');
      }
      let received = 0;
      const progress = new Transform({ transform: (chunk, encoding, done) => {
        received += chunk.length;
        if (received > spec.size) return done(new Error('Model download exceeded its expected size.'));
        this._status(job.model, 'downloading', { receivedBytes: received });
        done(null, chunk);
      } });
      await pipeline(response, progress, fs.createWriteStream(temporary, { flags: 'wx' }), { signal });
      if (received !== spec.size) throw new Error('Model download was interrupted. Please retry.');
    } finally {
      // Wait for the owned request to close before a replacement can start.
      if (request && !request.closed) {
        await new Promise(resolve => { request.once('close', resolve); request.destroy(); });
      }
    }
  }

  async _run(job, allowDownload) {
    const spec = this._spec(job.model);
    const final = this._file(job.model);
    const temporary = path.join(this.modelDir, `${spec.filename}.${job.id}.part`);
    let newFile = false;
    let terminal;
    let cleanupError;
    try {
      await this._initialize();
      for (const leftover of this.pendingCleanup) {
        await fs.promises.rm(leftover, { force: true, maxRetries: 3, retryDelay: 100 });
        this.pendingCleanup.delete(leftover);
      }
      this._check(job);
      let valid = false;
      if (this._signature(final)) {
        const digest = await this._hash(final, job);
        valid = digest.bytes === spec.size && digest.sha256 === spec.sha256;
      }
      if (!valid) {
        if (!allowDownload) { const error = new Error('Prepare the model to download or repair it.'); error.modelMissing = true; throw error; }
        await this._download(job, spec, temporary);
        this._check(job);
        this._status(job.model, 'verifying');
        const digest = await this._hash(temporary, job);
        if (digest.bytes !== spec.size || digest.sha256 !== spec.sha256) throw new Error('Model verification failed. Please retry the download.');
        newFile = true;
      }
      this._check(job);
      this._status(job.model, 'validating');
      if (typeof this.validateModel !== 'function') throw new Error('The speech engine is unavailable. Restart the app and retry.');
      await this.validateModel(newFile ? temporary : final, { signal: job.controller.signal });
      this._check(job);
      if (newFile) await fs.promises.rename(temporary, final);
      this._check(job);
      terminal = { state: 'ready', receivedBytes: spec.size, signature: this._signature(final), error: null };
    } catch (error) {
      terminal = { state: job.controller.signal.aborted ? 'cancelled' : error.modelMissing ? 'missing' : 'error',
        error: job.controller.signal.aborted ? null : error.message };
    } finally {
      try {
        await fs.promises.rm(temporary, { force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        this.pendingCleanup.add(temporary);
        cleanupError = `Could not remove a temporary model download (${error.code || error.message}). Close any program using the file and retry.`;
      } finally {
        if (this.active === job) this.active = null;
      }
    }
    if (job.controller.signal.aborted) terminal = { state: 'cancelled', error: null };
    if (cleanupError) terminal = { state: 'error', error: cleanupError };
    return this._status(job.model, terminal.state, terminal);
  }

  async cancel(operationId) {
    const job = this.active;
    if (!job || job.id !== operationId) return null;
    this._status(job.model, 'cancelling');
    job.controller.abort();
    return job.promise;
  }

  async dispose() {
    this.closed = true;
    if (this.active) await this.cancel(this.active.id);
  }
}

module.exports = WhisperModelService;
