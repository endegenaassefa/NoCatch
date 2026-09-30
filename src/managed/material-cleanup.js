'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_ENTRIES = 64;
const MAX_BYTES = 65536;
const DURATION = 90 * 60000;
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id);

// A bounded, content-free outbox. Delivery is authenticated by the manager;
// records for another account remain pending until that owner returns or TTL.
class MaterialCleanup {
  constructor({ file, binding, getOwner, send, onChange, now = Date.now }) {
    Object.assign(this, { file, binding, getOwner, send, onChange, now });
    this.entries = new Map();
    this.persistent = true;
    this.running = null;
    this.timer = null;
    this.closed = false;
    try {
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > MAX_BYTES) throw new Error('Oversized cleanup metadata');
        const values = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(values) || values.length > MAX_ENTRIES) throw new Error('Invalid cleanup metadata');
        for (const value of values) {
          if (!validId(value.sessionId) || !/^[a-f0-9]{64}$/.test(value.owner) || !['revision', 'end'].includes(value.action) ||
            !Number.isSafeInteger(value.expiresAt) || value.expiresAt > now() + DURATION ||
            !Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error('Invalid cleanup record');
          if (value.expiresAt > now()) this.entries.set(this.key(value), {
            sessionId: value.sessionId, owner: value.owner, action: value.action,
            expiresAt: value.expiresAt, generation: value.generation
          });
        }
      }
    } catch { this.entries.clear(); this.persistent = false; }
    this.persist();
    this.arm();
  }

  owner(subject) {
    return typeof subject === 'string' && subject ? crypto.createHash('sha256').update(JSON.stringify([this.binding, subject])).digest('hex') : null;
  }
  key(value) { return `${value.owner}:${value.sessionId}`; }
  persist() {
    try {
      const raw = JSON.stringify([...this.entries.values()]);
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Cleanup metadata limit');
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file + '.tmp', raw, { mode: 0o600 });
      fs.renameSync(this.file + '.tmp', this.file);
      this.persistent = true;
    } catch { this.persistent = false; }
  }
  changed() { this.persist(); try { this.onChange?.(); } catch {} }
  prune() {
    let changed = false;
    for (const [key, value] of this.entries) if (value.expiresAt <= this.now()) { this.entries.delete(key); changed = true; }
    if (changed) this.changed();
  }
  status() { this.prune(); return { pending: this.entries.size, persistent: this.persistent }; }

  enqueue(context, action, subject = this.getOwner()) {
    this.prune();
    const owner = this.owner(subject);
    if (!owner) return Promise.resolve(); // No authenticated server owner exists.
    if (!validId(context?.sessionId) || !Number.isSafeInteger(context.expiresAt) || context.expiresAt > this.now() + DURATION ||
      !Number.isSafeInteger(context.generation) || context.generation < 0) throw new Error('Invalid material cleanup metadata');
    if (context.expiresAt <= this.now()) return Promise.resolve();
    const value = { sessionId: context.sessionId, owner, action, expiresAt: context.expiresAt, generation: context.generation };
    const key = this.key(value), previous = this.entries.get(key);
    if (!previous && this.entries.size >= MAX_ENTRIES) throw new Error('Material cleanup queue is full');
    if (previous) {
      value.expiresAt = Math.min(value.expiresAt, previous.expiresAt);
      value.generation = Math.max(value.generation, previous.generation);
      if (previous.action === 'end') value.action = 'end';
    }
    this.entries.set(key, value);
    this.changed();
    return this.retry();
  }

  arm() {
    clearTimeout(this.timer);
    if (!this.closed && this.entries.size) {
      const nearest = Math.min(...[...this.entries.values()].map(value => value.expiresAt));
      this.timer = setTimeout(() => this.retry(), Math.max(1, Math.min(30000, nearest - this.now())));
      this.timer.unref?.();
    }
  }
  retry() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; this.arm(); });
    return this.running;
  }
  async drain() {
    this.prune();
    // Snapshot gives at most one attempt per record per drain; no failure spin.
    for (const [key, value] of [...this.entries]) {
      if (this.closed || this.owner(this.getOwner()) !== value.owner) continue;
      if (value.expiresAt <= this.now() || this.entries.get(key) !== value) continue;
      try {
        await this.send(value);
        if (this.entries.get(key) === value) { this.entries.delete(key); this.changed(); }
      } catch { break; } // One failed delivery stops this drain; no offline spin.
    }
    this.prune();
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}

module.exports = { MaterialCleanup };
