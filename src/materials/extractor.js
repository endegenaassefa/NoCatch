'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { LIMITS } = require('./limits');

function extractBytes(bytes, kind, { signal, limits = LIMITS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Import cancelled'));
    const worker = new Worker(path.join(__dirname, 'extract-worker.js'), {
      workerData: { bytes, kind, limits },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
    });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new Error('Import cancelled'));
    const timer = setTimeout(() => finish(new Error('Extraction exceeded 60 seconds')), limits.extractionTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!finished) finish(new Error(`Extraction worker exited (${code})`)); });
  });
}

module.exports = { extractBytes };
