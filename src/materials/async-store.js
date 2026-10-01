'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');

class AsyncEncryptedStore {
  constructor(directory, safeStorage) {
    this.safeStorage = safeStorage;
    this.mode = 'memory-only';
    this.cleanupPending = false;
    this.cleanupPersistent = true;
    this.closed = false;
    this.epoch = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.revoked = new Set();
    this.assets = new Map();
    this.assetBytes = 0;
    this.ready = Promise.resolve();
    if (!directory) return;
    this.file = path.join(directory, 'session-materials.sqlite');
    this.cleanupFile = path.join(directory, 'session-materials.cleanup');
    let available = false;
    try { available = safeStorage?.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; } catch {}
    if (!available) { this._mark(); this.retryCleanup(); return; }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.mode = 'encrypted';
    this.lease = new Int32Array(new SharedArrayBuffer(4));
    this.worker = new Worker(path.join(__dirname, 'storage-worker.js'), { workerData: { lease: this.lease.buffer } });
    this.worker.on('message', message => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (!this.pending.size) this.worker.unref();
      if (message.error) request.reject(new Error(message.error));
      else {
        this.mode = message.mode;
        this.cleanupPending = message.cleanupPending;
        this.cleanupPersistent = message.cleanupPersistent;
        request.resolve(message.result);
      }
    });
    this.worker.on('error', () => this.fallback());
    this.worker.on('exit', () => { if (!this.closed) this.fallback(); });
    this.ready = this._send('init', { directory }).catch(() => this.fallback());
  }
  _send(type, fields = {}, now = Date.now) {
    if (!this.worker || this.closed) return Promise.resolve(null);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.ref();
      try { this.worker.postMessage({ id, type, epoch: this.epoch, now: now(), sentAt: Date.now(), ...fields }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  _mark() {
    if (!this.cleanupFile) return;
    try { fs.writeFileSync(this.cleanupFile, 'pending\n', { mode: 0o600, flush: true }); this.cleanupPersistent = true; }
    catch { this.cleanupPersistent = false; }
    this.cleanupPending = true;
  }
  newKey() {
    if (this.mode !== 'encrypted') return null;
    try { const key = crypto.randomBytes(32); return { key, wrapped: this.safeStorage.encryptString(key.toString('base64')) }; }
    catch { this.fallback(); return null; }
  }
  async save(session, secret, owner, now = Date.now) {
    const epoch = this.epoch;
    // Copy the key before an End operation can erase the manager's buffer.
    if (!secret || this.mode !== 'encrypted' || this.closed || this.revoked.has(session.id)) return;
    this.lastId = session.id;
    const key = Buffer.from(secret.key), wrapped = Buffer.from(secret.wrapped);
    try {
      if (epoch !== this.epoch || this.closed || session.expiresAt <= now()) return;
      // The init message was posted in the constructor. Port ordering lets us
      // post immediately, snapshotting source bytes before a caller clears them.
      await this._send('save', { session, key, wrapped, owner }, now);
    } finally { key.fill(0); }
  }
  async restore(owner, now = Date.now) {
    await this.ready;
    const epoch = this.epoch;
    const revoke = () => epoch === this.epoch && !this.closed ? this.clear() : Promise.resolve();
    let key;
    try {
      const row = await this._send('metadata', { owner }, now);
      if (!row || epoch !== this.epoch || this.closed) return null;
      if (row.deadline <= now()) { await revoke(); return null; }
      key = Buffer.from(this.safeStorage.decryptString(Buffer.from(row.wrapped)), 'base64');
      if (key.length !== 32 || row.deadline <= now()) { await revoke(); return null; }
      const restored = await this._send('restore', { owner, key }, now);
      if (epoch !== this.epoch || this.closed) { restored?.secret?.key?.fill(0); return null; }
      if (!restored || row.deadline <= now()) { restored?.secret?.key?.fill(0); await revoke(); return null; }
      restored.secret.key = Buffer.from(restored.secret.key);
      restored.secret.wrapped = Buffer.from(restored.secret.wrapped);
      this.lastId = restored.session.id;
      return restored;
    } catch { await revoke(); return null; }
    finally { key?.fill(0); }
  }
  clear() {
    this.epoch++;
    if (this.lastId) this.revoked.add(this.lastId);
    if (this.lease) Atomics.store(this.lease, 0, this.epoch);
    this.assets.clear(); this.assetBytes = 0;
    // Durable revocation happens before yielding. A process crash while the
    // worker is finishing an old save cannot make that session recoverable.
    this._mark();
    return this.ready.then(() => this._send('clear')).then(() => {
      if (!this.worker) this.retryCleanup();
    }).catch(() => this.fallback());
  }
  async putAsset(session, secret, bytes, mimeType, now = Date.now) {
    if (this.closed || this.revoked.has(session.id) || session.expiresAt <= now() || bytes.length > 2 * 1024 * 1024) throw new Error('Source image unavailable');
    const id = crypto.randomUUID();
    this.lastId = session.id;
    if (!secret || this.mode !== 'encrypted') {
      if (this.assetBytes + bytes.length > 128 * 1024 * 1024) throw new Error('Source image storage limit reached');
      this.assets.set(id, { sessionId: session.id, mimeType, bytes: Buffer.from(bytes) });
      this.assetBytes += bytes.length;
    } else {
      const key = Buffer.from(secret.key);
      try { await this._send('put-asset', { sessionId: session.id, expiresAt: session.expiresAt, key, assetId: id, bytes, mimeType }, now); }
      finally { key.fill(0); }
    }
    return id;
  }
  async getAsset(id, session, secret, now = Date.now) {
    const epoch = this.epoch;
    if (this.closed || this.revoked.has(session.id) || session.expiresAt <= now()) return null;
    const stored = this.assets.get(id);
    let asset = stored?.sessionId === session.id ? { mimeType: stored.mimeType, data: stored.bytes.toString('base64') } : null;
    if (!asset && secret && this.mode === 'encrypted') {
      const key = Buffer.from(secret.key);
      try { asset = await this._send('get-asset', { assetId: id, sessionId: session.id, expiresAt: session.expiresAt, key }, now); }
      finally { key.fill(0); }
    }
    if (epoch !== this.epoch || session.expiresAt <= now()) return null;
    return asset || null;
  }
  fallback() {
    this.mode = 'memory-only';
    this._mark();
    for (const request of this.pending.values()) request.reject(new Error('Encrypted recovery unavailable'));
    this.pending.clear();
    const worker = this.worker; this.worker = null;
    if (worker) void worker.terminate().then(() => this.retryCleanup());
    else this.retryCleanup();
  }
  retryCleanup() {
    if (this.worker) return !this.cleanupPending;
    if (!this.file) return true;
    let failed = false;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.rmSync(this.file + suffix, { force: true }); } catch { failed = true; }
    }
    if (!failed) try { fs.rmSync(this.cleanupFile, { force: true }); } catch { failed = true; }
    this.cleanupPending = failed;
    this.cleanupPersistent = !failed || fs.existsSync(this.cleanupFile);
    clearTimeout(this.cleanupTimer);
    if (failed && !this.closed) { this.cleanupTimer = setTimeout(() => this.retryCleanup(), 30000); this.cleanupTimer.unref?.(); }
    try { this.onCleanupChange?.(); } catch {}
    return !failed;
  }
  async close() {
    if (this.closed) return;
    await this.ready;
    await this._send('close');
    this.closed = true;
    this.assets.clear(); this.assetBytes = 0;
    clearTimeout(this.cleanupTimer);
    const worker = this.worker; this.worker = null;
    await worker?.terminate();
  }
}
module.exports = { AsyncEncryptedStore };
