'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function ownerHash(owner) { return crypto.createHash('sha256').update(String(owner || '')).digest('hex'); }
function available(safeStorage) {
  try { return !!safeStorage?.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
  catch { return false; }
}

// All SQLite and safeStorage operations are synchronous. No outstanding async
// write can race a later deletion, owner change, or deadline check.
class EncryptedStore {
  constructor(userDataPath, safeStorage) {
    this.safeStorage = safeStorage;
    this.mode = 'memory-only';
    this.db = null;
    this.cleanupPending = false;
    this.cleanupPersistent = true;
    this.cleanupTimer = null;
    this.closed = false;
    if (!userDataPath) return;
    this.file = path.join(userDataPath, 'session-materials.sqlite');
    this.cleanupFile = path.join(userDataPath, 'session-materials.cleanup');
    // An interrupted/locked deletion must never revive an ended session.
    // This marker contains no material or key and is written before deletion.
    if (fs.existsSync(this.cleanupFile) && !this.eraseFiles()) return;
    if (!available(safeStorage)) { this.markCleanup(); this.eraseFiles(); return; }
    try {
      fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
      const { DatabaseSync } = require('node:sqlite');
      this.db = new DatabaseSync(this.file);
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS material_session (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, owner TEXT NOT NULL, deadline INTEGER NOT NULL, state TEXT NOT NULL, wrapped BLOB NOT NULL, payload BLOB NOT NULL)');
      try { fs.chmodSync(this.file, 0o600); } catch {}
      this.mode = 'encrypted';
    } catch { this.fallback(); }
  }

  eraseFiles() {
    if (!this.file) return true;
    let failed = false;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.rmSync(this.file + suffix, { force: true }); } catch { failed = true; }
    }
    if (!failed) {
      try { fs.rmSync(this.cleanupFile, { force: true }); } catch { failed = true; }
    }
    const persistent = !failed || fs.existsSync(this.cleanupFile);
    const changed = this.cleanupPending !== failed || this.cleanupPersistent !== persistent;
    this.cleanupPending = failed;
    this.cleanupPersistent = persistent;
    clearTimeout(this.cleanupTimer);
    if (failed && !this.closed) {
      this.cleanupTimer = setTimeout(() => this.retryCleanup(), 30000);
      this.cleanupTimer.unref?.();
    }
    if (changed) { try { this.onCleanupChange?.(); } catch {} }
    return !failed;
  }

  retryCleanup() { return this.cleanupPending ? this.eraseFiles() : true; }

  markCleanup() {
    try { fs.writeFileSync(this.cleanupFile, 'pending\n', { mode: 0o600 }); } catch {}
  }

  fallback() {
    this.markCleanup();
    try { this.db?.close(); } catch {}
    this.db = null;
    this.mode = 'memory-only';
    this.eraseFiles();
  }

  newKey() {
    if (!this.db) return null;
    try {
      const key = crypto.randomBytes(32);
      const wrapped = this.safeStorage.encryptString(key.toString('base64'));
      return { key, wrapped };
    } catch { this.fallback(); return null; }
  }

  save(session, secret, owner, now) {
    if (!this.db || !secret) return;
    if (session.expiresAt <= now()) { this.clear(); return; }
    const meta = { id: session.id, owner: ownerHash(owner), deadline: session.expiresAt, state: session.state };
    const iv = crypto.randomBytes(12);
    const encryption = crypto.createCipheriv('aes-256-gcm', secret.key, iv);
    encryption.setAAD(Buffer.from(JSON.stringify(meta)));
    const payload = Buffer.concat([iv, encryption.update(JSON.stringify(session), 'utf8'), encryption.final(), encryption.getAuthTag()]);
    if (session.expiresAt <= now()) { this.clear(); return; }
    this.db.prepare('INSERT OR REPLACE INTO material_session VALUES (1,?,?,?,?,?,?)').run(meta.id, meta.owner, meta.deadline, meta.state, secret.wrapped, payload);
  }

  restore(owner, now) {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM material_session WHERE singleton=1').get();
    if (!row) return null;
    // Check ownership and exact deadline BEFORE asking the OS to unwrap a key.
    if (row.owner !== ownerHash(owner) || row.deadline <= now() || !['draft', 'active'].includes(row.state)) { this.clear(); return null; }
    try {
      const key = Buffer.from(this.safeStorage.decryptString(Buffer.from(row.wrapped)), 'base64');
      if (key.length !== 32 || row.deadline <= now()) { this.clear(); return null; }
      const payload = Buffer.from(row.payload);
      const decryption = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
      decryption.setAAD(Buffer.from(JSON.stringify({ id: row.id, owner: row.owner, deadline: row.deadline, state: row.state })));
      decryption.setAuthTag(payload.subarray(-16));
      const session = JSON.parse(Buffer.concat([decryption.update(payload.subarray(12, -16)), decryption.final()]).toString('utf8'));
      if (session.id !== row.id || session.expiresAt !== row.deadline || session.state !== row.state || row.deadline <= now()) throw new Error('Invalid recovered session');
      return { session, secret: { key, wrapped: Buffer.from(row.wrapped) } };
    } catch { this.clear(); return null; }
  }

  clear() {
    if (this.db) this.markCleanup();
    try {
      this.db?.exec('DELETE FROM material_session');
      if (this.db) fs.rmSync(this.cleanupFile, { force: true });
    }
    catch { this.fallback(); }
    if (this.cleanupPending) this.retryCleanup();
  }
  close() { this.closed = true; clearTimeout(this.cleanupTimer); this.db?.close(); this.db = null; }
}

module.exports = { EncryptedStore };
