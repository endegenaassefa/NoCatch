'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function bundledPython() {
  const { app } = require('electron');
  const { validateBundledRuntime } = require('../../core/whisper-runtime');
  const manifest = require('../../core/whisper-runtime-manifest.json');
  const root = app.isPackaged
    ? path.join(process.resourcesPath, 'speech-runtime', 'windows-x64')
    : path.resolve(__dirname, '../../../.depthengine/speech-runtime/windows-x64');
  validateBundledRuntime(root, { expectedManifestHash: manifest.sha256 });
  return path.join(root, 'python.exe');
}

function validTargets(targets) {
  return Array.isArray(targets) && targets.length > 0 && targets.length <= 2 &&
    targets.every(target => target && typeof target.handle === 'string' &&
      /^[1-9][0-9]{0,18}$/.test(target.handle) && BigInt(target.handle) <= 0x7fffffffffffffffn &&
      ['x', 'y'].every(key => Number.isInteger(target[key]) &&
        target[key] >= -2147483648 && target[key] <= 2147483647));
}

// One private stdio child, with no network endpoint or elevation. The native
// operation preserves size instead of round-tripping it through Electron DIPs.
class WindowsWindowPositioner {
  constructor({ ownerPid = process.pid, spawn: spawnChild = spawn, pythonPath,
    startupTimeoutMs = 10000, requestTimeoutMs = 3000 } = {}) {
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error('Invalid window owner PID');
    if (![startupTimeoutMs, requestTimeoutMs].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error('Invalid movement timeout');
    }
    Object.assign(this, { ownerPid, spawnChild, pythonPath, startupTimeoutMs, requestTimeoutMs });
    this.pending = new Map();
    this.sequence = 0;
    this.waiting = 0;
    this.disposed = false;
    this.worker = null;
    this.retiring = new Set();
  }

  ready() {
    if (this.disposed) return Promise.reject(new Error('Windows movement helper is disposed'));
    if (this.worker) return this.worker.ready;
    if (this.retiring.size) return Promise.reject(new Error('Previous Windows movement helper has not exited'));
    const worker = { child: null, buffer: '', started: false };
    worker.ready = new Promise((resolve, reject) => Object.assign(worker, { resolve, reject }));
    this.worker = worker;
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
      const source = fs.readFileSync(path.join(__dirname, 'window_position.py'), 'utf8');
      const child = this.spawnChild(this.pythonPath || bundledPython(),
        ['-I', '-S', '-B', '-u', '-c', source, String(this.ownerPid)], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir() }
        });
      worker.child = child;
      worker.timer = setTimeout(() => this.stop(worker, new Error('Windows movement helper ready timeout')), this.startupTimeoutMs);
      child.stdout.on('data', chunk => this.receive(worker, chunk));
      // Drain stderr without copying arbitrary interpreter output into app logs.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => this.stop(worker, new Error('Windows movement helper input failed')));
      child.on('error', () => {
        if (!child.pid) worker.exited = true; // A failed spawn has no process to retire.
        this.stop(worker, new Error('Windows movement helper could not start'));
      });
      const exited = () => {
        worker.exited = true;
        this.retiring.delete(worker);
        this.stop(worker, new Error('Windows movement helper exited'));
      };
      child.on('exit', exited);
      child.on('close', exited);
    } catch (error) {
      this.stop(worker, error);
    }
    return worker.ready;
  }

  receive(worker, chunk) {
    if (this.worker !== worker) return;
    worker.buffer += String(chunk);
    if (worker.buffer.length > 65536) return this.stop(worker, new Error('Movement response buffer limit exceeded'));
    let end;
    while ((end = worker.buffer.indexOf('\n')) !== -1) {
      const line = worker.buffer.slice(0, end);
      worker.buffer = worker.buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { return this.stop(worker, new Error('Malformed movement response')); }
      if (!message || typeof message !== 'object') return this.stop(worker, new Error('Invalid movement response'));
      if (!worker.started) {
        if (message.type !== 'ready' || message.ownerPid !== this.ownerPid) {
          return this.stop(worker, new Error('Movement helper owner handshake rejected'));
        }
        worker.started = true;
        clearTimeout(worker.timer);
        worker.resolve();
        continue;
      }
      const request = this.pending.get(message.id);
      if (!Number.isSafeInteger(message.id) || !request || request.worker !== worker ||
          typeof message.ok !== 'boolean' || message.type !== undefined) {
        return this.stop(worker, new Error('Unknown movement response'));
      }
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve();
      else request.reject(new Error(`Windows movement rejected: ${String(message.error || 'native operation failed').slice(0, 160)}`));
    }
  }

  async move(targets) {
    if (!validTargets(targets)) throw new Error('Invalid movement targets');
    if (this.waiting >= 32) throw new Error('Windows movement queue limit exceeded');
    // Snapshot caller data before asynchronous startup.
    const snapshot = targets.map(({ handle, x, y }) => ({ handle, x, y }));
    this.waiting++;
    try {
      await this.ready();
      const worker = this.worker;
      if (!worker || !worker.started || this.disposed) throw new Error('Windows movement helper is unavailable');
      const id = ++this.sequence;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.stop(worker, new Error('Windows movement request timeout')), this.requestTimeoutMs);
        this.pending.set(id, { resolve, reject, timer, worker });
        try {
          worker.child.stdin.write(JSON.stringify({ type: 'move', id, targets: snapshot }) + '\n');
        } catch {
          this.stop(worker, new Error('Windows movement helper write failed'));
        }
      });
    } finally {
      this.waiting--;
    }
  }

  stop(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    clearTimeout(worker.timer);
    worker.reject(error);
    for (const [id, request] of this.pending) {
      if (request.worker !== worker) continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
      request.reject(error);
    }
    // A kill attempt is not proof of exit. Keep ownership and forbid a
    // replacement until Node observes this exact child's exit/close event.
    if (worker.child && !worker.exited) this.retiring.add(worker);
    try { worker.child?.stdin.end(); } catch { /* already closed */ }
    try { worker.child?.kill(); } catch { /* already exited */ }
  }

  dispose() {
    this.disposed = true;
    if (this.worker) this.stop(this.worker, new Error('Windows movement helper disposed'));
    for (const worker of this.retiring) {
      try { worker.child.kill(); } catch { /* Owner watchdog remains active. */ }
    }
  }
}

module.exports = WindowsWindowPositioner;
