'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
class RefreshStore {
  constructor(filename, safeStorage, binding) { this.filename = filename; this.safeStorage = safeStorage; this.binding = binding; this.queue = Promise.resolve(); }
  available() { try { return Boolean(this.safeStorage?.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text'); } catch { return false; } }
  enqueue(work) { const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next; }
  read() {
    return this.enqueue(async () => {
      if (!this.available()) return null;
      try {
        const stat = await fs.stat(this.filename); if (stat.size > 65536) return null;
        const envelope = JSON.parse(await fs.readFile(this.filename, 'utf8'));
        if (envelope.version !== 1 || envelope.binding !== this.binding || typeof envelope.ciphertext !== 'string') return null;
        const value = JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64')));
        return typeof value.refreshToken === 'string' && value.refreshToken.length < 32768 ? value.refreshToken : null;
      } catch { return null; }
    });
  }
  write(refreshToken) {
    return this.enqueue(async () => {
      if (!refreshToken || !this.available()) { await fs.rm(this.filename, { force: true }); return false; }
      const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`;
      try {
        const ciphertext = this.safeStorage.encryptString(JSON.stringify({ refreshToken })).toString('base64');
        await fs.mkdir(path.dirname(this.filename), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify({ version: 1, binding: this.binding, ciphertext }), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, this.filename); return true;
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
  }
  clear() { return this.enqueue(() => fs.rm(this.filename, { force: true })); }
}
module.exports = { RefreshStore };
