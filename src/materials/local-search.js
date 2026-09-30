'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');

// The worker owns all passage text, vectors and native inference allocations.
// Terminating it revokes a material generation, including work already running.
class LocalSearch {
  constructor({ cacheDir }) {
    this.closed = false;
    this.nextId = 0;
    this.pending = new Map();
    this.worker = new Worker(path.join(__dirname, 'search-worker.js'), {
      workerData: { cacheDir }, resourceLimits: { maxOldGenerationSizeMb: 512 }
    });
    this.worker.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.progress) { pending.onProgress?.(message.progress); return; }
      pending.finish(message.error ? new Error(message.error) : null, message.result);
    });
    this.worker.on('error', () => this.close(new Error('Local search worker failed. Retry preparing materials.')));
    this.worker.on('exit', () => this.close(new Error('Local search worker stopped.')));
    this.worker.unref();
  }
  request(type, payload, { signal, onProgress } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Material search cancelled'));
    if (this.pending.size >= 3) return Promise.reject(new Error('Material search is busy. Wait for the current question.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const finish = (error, result) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (!this.pending.size) this.worker.unref();
        error ? reject(error) : resolve(result);
      };
      const abort = () => {
        // A cancelled native inference cannot safely be interrupted in place.
        // Dispose this index; the next request will build a fresh generation.
        this.close(new Error('Material search cancelled'));
      };
      const timer = setTimeout(() => this.close(new Error('Local search exceeded its time limit.')), type === 'build' ? 10 * 60000 : 60000);
      this.pending.set(id, { finish, onProgress });
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.ref();
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  build(documents, options) { return this.request('build', { documents }, options); }
  search(question, options = {}) {
    const { signal, history = [], maxChars = 24000 } = options;
    return this.request('search', { question, history, maxChars }, { signal });
  }
  close(error = new Error('Material session changed or expired')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) pending.finish(error);
    this.worker.terminate().catch(() => {});
  }
}
module.exports = { LocalSearch };
