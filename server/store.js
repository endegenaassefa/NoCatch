'use strict';
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE;
      PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, subject TEXT NOT NULL,
        idem TEXT NOT NULL, fingerprint TEXT NOT NULL, provider TEXT NOT NULL,
        status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', error TEXT,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, UNIQUE(owner, idem));
      CREATE TABLE IF NOT EXISTS events (request_id TEXT NOT NULL, seq INTEGER NOT NULL,
        type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(request_id, seq));
      CREATE TABLE IF NOT EXISTS quotas (day TEXT NOT NULL, subject TEXT NOT NULL,
        count INTEGER NOT NULL, PRIMARY KEY(day, subject));`);
    // EXCLUSIVE locking persists until close: exactly one server per database.
    this.db.exec('BEGIN EXCLUSIVE; COMMIT;');
    for (const row of this.db.prepare("SELECT id FROM requests WHERE status='accepted'").all())
      this.finish(row.id, 'failed', { code: 'interrupted', message: 'The service restarted. This request was not retried.' });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) { return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id); }
  find(owner, idem) { return this.db.prepare('SELECT * FROM requests WHERE owner=? AND idem=?').get(owner, idem); }
  event(id, type, data) {
    const seq = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE request_id=?').get(id).seq;
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(id, seq, type, JSON.stringify(data));
    return { seq, type, data };
  }
  events(id, after) {
    return this.db.prepare('SELECT seq,type,data FROM events WHERE request_id=? AND seq>? ORDER BY seq').all(id, after)
      .map(event => ({ ...event, data: JSON.parse(event.data) }));
  }
  usage(subject, day = new Date().toISOString().slice(0, 10)) {
    return this.db.prepare('SELECT count FROM quotas WHERE day=? AND subject=?').get(day, subject)?.count || 0;
  }
  active(subject) {
    return subject === undefined
      ? this.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status='accepted'").get().n
      : this.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status='accepted' AND subject=?").get(subject).n;
  }
  prune(retentionMs) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM events WHERE request_id IN (SELECT id FROM requests WHERE status!='accepted' AND created<?)").run(Date.now() - retentionMs);
      this.db.prepare("DELETE FROM requests WHERE status!='accepted' AND created<?").run(Date.now() - retentionMs);
      this.db.prepare('DELETE FROM quotas WHERE day<?').run(new Date().toISOString().slice(0, 10));
    });
  }
  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n; }
  accept(record) {
    return this.transaction(() => {
      const now = Date.now();
      this.db.prepare('INSERT INTO requests(id,owner,subject,idem,fingerprint,provider,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(record.id, record.owner, record.subject, record.idem, record.fingerprint, record.provider, 'accepted', now, now);
      const day = new Date(now).toISOString().slice(0, 10);
      for (const subject of [record.subject, '*'])
        this.db.prepare('INSERT INTO quotas VALUES(?,?,1) ON CONFLICT(day,subject) DO UPDATE SET count=count+1').run(day, subject);
      return this.event(record.id, 'accepted', { id: record.id, status: 'accepted' });
    });
  }
  append(id, text) {
    return this.transaction(() => {
      if (this.get(id)?.status !== 'accepted') return null;
      this.db.prepare('UPDATE requests SET text=text||?,updated=? WHERE id=?').run(text, Date.now(), id);
      return this.event(id, 'delta', { text });
    });
  }
  finish(id, status, error) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || row.status !== 'accepted') return null;
      this.db.prepare('UPDATE requests SET status=?,error=?,updated=? WHERE id=?').run(status, error ? JSON.stringify(error) : null, Date.now(), id);
      return this.event(id, status, { id, status, ...(status === 'completed' ? { text: row.text } : {}), ...(error ? { error } : {}) });
    });
  }
  close() { this.db.close(); }
}
module.exports = { Store };


