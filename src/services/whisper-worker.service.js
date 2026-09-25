const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const logger = require('../core/logger').createServiceLogger('WHISPER-WORKER');

class WhisperWorkerService {
  constructor() {
    this.process = null;
    this.pythonPath = null;
    this.scriptPath = null;
    this.pending = new Map();
    // Reader ownership outlives rejected requests when exit is unconfirmed.
    this.inputReaders = new Map();
    this.sequence = 0;
    this.idleTimer = null;
    this.idleUnloadMs = 60000;
    this.readyInfo = null;
    this.closing = false;
    this.retirement = null;
  }

  configure({ pythonPath, scriptPath, idleUnloadMs = 60000, env = null }) {
    const changed = this.pythonPath !== pythonPath || this.scriptPath !== scriptPath ||
      JSON.stringify(this.env) !== JSON.stringify(env);
    this.pythonPath = pythonPath;
    this.scriptPath = scriptPath;
    this.idleUnloadMs = idleUnloadMs;
    this.env = env;
    if (changed) {
      this.close();
    }
  }

  isConfigured() {
    return Boolean(
      this.pythonPath &&
      this.scriptPath &&
      fs.existsSync(this.pythonPath) &&
      fs.existsSync(this.scriptPath)
    );
  }

  async transcribe(audioPath, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Persistent Whisper worker is not configured');
    }
    this._clearIdleTimer();
    const result = await this._request({
      action: 'transcribe',
      audio_path: audioPath,
      model: options.model || 'small',
      language: options.language || 'auto',
      model_dir: options.modelDir || null,
      device: options.device || 'auto'
    }, 180000, options.retainInput);
    this._scheduleIdleUnload();
    return result;
  }

  async warmup(options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Persistent Whisper worker is not configured');
    }
    this._clearIdleTimer();
    return this._request({
      action: 'warmup',
      model: options.model || 'small',
      model_dir: options.modelDir || null,
      device: options.device || 'auto'
    });
  }

  releaseWhenIdle() {
    if (this.process) {
      this._scheduleIdleUnload();
    }
  }

  isTerminationPending() {
    return this.retirement !== null;
  }

  _terminationError() {
    const error = new Error('Whisper worker termination is unconfirmed; retry after the process exits');
    error.code = 'WHISPER_WORKER_TERMINATION_UNCONFIRMED';
    return error;
  }

  _ensureProcess() {
    if (this.retirement) {
      throw this._terminationError();
    }
    if (this.process) {
      if (this.process.killed) {
        this._retireProcess(this.process, this._terminationError());
        throw this._terminationError();
      }
      return;
    }

    this.readyInfo = null;
    this.closing = false;
    const child = spawn(this.pythonPath, ['-u', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(this.env ? { env: this.env } : {})
    });
    this.process = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.process === child && !this.retirement) this._handleLine(line);
    });

    child.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) {
        logger.debug('Worker stderr', { message: message.substring(0, 1000) });
      }
    });

    const handleError = (error) => {
      if (this.process !== child) return;
      logger.error('Whisper worker process error', { error: error.message });
      this._retireProcess(child, error);
    };
    child.on('error', handleError);
    child.stdin.on?.('error', handleError);

    child.once('close', (code) => {
      lines.close?.();
      if (this.process !== child) return;
      const retirement = this.retirement;
      const error = retirement?.error || new Error(`Whisper worker exited with code ${code}`);
      if (!this.closing && !retirement && code !== 0) {
        logger.error(error.message);
      }
      if (retirement) clearTimeout(retirement.timer);
      this.retirement = null;
      this.process = null;
      this.readyInfo = null;
      this._clearIdleTimer();
      this._rejectAll(error);
      for (const release of this.inputReaders.values()) release();
      this.inputReaders.clear();
      this.closing = false;
    });
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      logger.warn('Ignoring non-JSON worker output', { line: line.substring(0, 500) });
      return;
    }

    if (message.event === 'ready') {
      this.readyInfo = message;
      logger.info('Persistent Whisper worker ready', message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    this.inputReaders.get(message.id)?.();
    this.inputReaders.delete(message.id);

    if (message.ok) {
      pending.resolve(message);
    } else {
      const error = new Error(message.error || 'Whisper worker request failed');
      error.workerTraceback = message.traceback;
      pending.reject(error);
    }
  }

  _request(payload, timeoutMs = 180000, retainInput) {
    this._ensureProcess();
    const child = this.process;
    const id = ++this.sequence;
    const request = { ...payload, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this._retireProcess(child, new Error(`Whisper worker timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (retainInput) this.inputReaders.set(id, retainInput());

      try {
        child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error && this.process === child) this._retireProcess(child, error);
        });
      } catch (error) {
        this._retireProcess(child, error);
      }
    });
  }

  _retireProcess(child, error) {
    if (!child || this.process !== child || this.retirement) return;
    this._clearIdleTimer();
    this.readyInfo = null;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    const retirement = { child, error, timer: null };
    this.retirement = retirement;
    // Keep ownership until close: ChildProcess.killed only confirms a signal
    // was sent. Neither late output nor a kill error may release this barrier.
    retirement.timer = setTimeout(() => {
      if (this.retirement !== retirement) return;
      retirement.timer = null;
      this._rejectAll(this._terminationError());
    }, 5000);
    try { child.kill(); } catch (_) { /* Wait for close or the grace deadline. */ }
  }

  _scheduleIdleUnload() {
    this._clearIdleTimer();
    if (!this.process || this.retirement) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.process || this.retirement) return;
      if (this.pending.size > 0) {
        // Keep the requested release alive while warmup or transcription
        // finishes. A new capture still cancels it through warmup().
        this._scheduleIdleUnload();
        return;
      }
      this._request({ action: 'unload' }, 30000)
        .then(() => logger.info('Whisper model unloaded after idle timeout'))
        .catch((error) => logger.warn('Could not unload idle Whisper model', { error: error.message }));
    }, this.idleUnloadMs);
  }

  _clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this._clearIdleTimer();
    const error = new Error('Whisper worker closed');
    error.code = 'WHISPER_WORKER_CLOSED';
    if (this.process) {
      this.closing = true;
      this._retireProcess(this.process, error);
    }
    // Reject cancellation immediately, retaining the child and its readers
    // until close. Reconfiguration uses this same ownership barrier.
    this.readyInfo = null;
    this._rejectAll(error);
  }
}

module.exports = WhisperWorkerService;
