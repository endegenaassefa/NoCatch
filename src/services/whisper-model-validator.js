const WhisperWorkerService = require('./whisper-worker.service');

// Model preparation owns a separate worker and does not release its operation
// until Node confirms that worker closed, including after an abort or failure.
function createModelValidator({ pythonPath, scriptPath, env }) {
  return async (checkpoint, { signal }) => {
    signal.throwIfAborted();
    const worker = new WhisperWorkerService();
    worker.configure({ pythonPath, scriptPath, env });
    const work = worker.warmup({ model: checkpoint, device: 'cpu' });
    const child = worker.process;
    const closed = child ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve();
    const abort = () => worker.close();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      await work;
      signal.throwIfAborted();
    } finally {
      worker.close();
      await closed;
      signal.removeEventListener('abort', abort);
    }
  };
}

module.exports = { createModelValidator };
