'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const { LIMITS } = require('./limits');
const cancelled = () => Object.assign(new Error('Material work was cancelled.'), { code: 'CANCELLED' });

class LocalSearch {
  constructor({ cacheDir }) {
    this.pending = new Map(); this.nextId = 0; this.closed = false;
    // ONNX's native addon cannot reliably reload in successive worker isolates.
    // A dedicated process owns the runtime and all ephemeral indexed content.
    this.worker = fork(path.join(__dirname, 'search-worker.js'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: ['--max-old-space-size=512'], serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
    });
    this.settings = { cacheDir, limits: LIMITS };
    this.worker.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.progress) { pending.onProgress?.(message.progress); return; }
      pending.finish(message.error ? new Error(message.error) : null, message.result);
    });
    this.worker.on('error', () => this.close(new Error('Local material search is unavailable.')));
    this.worker.on('exit', () => this.close(new Error('Local material search stopped.')));
    this.worker.unref(); this.worker.channel?.unref();
  }
  request(type, fields, { signal, onProgress } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(cancelled());
    if (this.pending.size >= 6) return Promise.reject(new Error('Material search is busy.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const finish = (error, result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (!this.pending.size) { this.worker.unref(); this.worker.channel?.unref(); }
        error ? reject(error) : resolve(result);
      };
      // Cancelling a question detaches only its result, preserving the shared
      // prepared index and other callers. Session revocation closes the worker.
      const abort = () => { this._send({ type: 'cancel', id }); finish(cancelled()); };
      const timer = setTimeout(() => {
        if (type === 'build') this.close(new Error('Material preparation timed out.'));
        else { this._send({ type: 'cancel', id }); finish(new Error('Material search timed out.')); }
      }, type === 'build' ? LIMITS.preparationTimeoutMs : LIMITS.retrievalTimeoutMs);
      this.pending.set(id, { finish, onProgress });
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.ref(); this.worker.channel?.ref();
      this._send({ id, type, ...fields, ...(type === 'build' ? { settings: this.settings } : {}) });
    });
  }
  _send(message) {
    if (!this.worker.connected) { this.close(new Error('Local material search stopped.')); return; }
    try { this.worker.send(message, error => { if (error) this.close(new Error('Local material search stopped.')); }); }
    catch { this.close(new Error('Local material search stopped.')); }
  }
  build(documents, options) { return this.request('build', { documents }, options); }
  search(question, { signal, history = [], maxChars = LIMITS.maxContextChars, strategy = 'auto' } = {}) {
    const invalid = () => Promise.reject(Object.assign(new Error('Material search input exceeds its limits.'), { code: 'INPUT_LIMIT' }));
    if (typeof question !== 'string' || question.length > 16000 || !Array.isArray(history) || history.length > 20 || !Number.isInteger(maxChars) || maxChars < 0) return invalid();
    let chars = 0;
    for (const turn of history) {
      if (!turn || !['user','assistant','model'].includes(turn.role) || typeof turn.content !== 'string') return invalid();
      chars += turn.content.length;
      if (chars > 6000) return invalid();
    }
    return this.request('search', { question, history, maxChars, strategy }, { signal });
  }
  close(error = cancelled()) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.finish(error);
    this.worker.kill();
  }
}
module.exports = { LocalSearch };
