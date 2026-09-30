'use strict';
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.transient = new Map();
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
          count INTEGER NOT NULL, PRIMARY KEY(day, subject));
        CREATE TABLE IF NOT EXISTS material_sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL,
          deadline INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0);`);
      if (!this.db.prepare('PRAGMA table_info(requests)').all().some(c => c.name === 'material_session'))
        this.db.exec('ALTER TABLE requests ADD COLUMN material_session TEXT; ALTER TABLE requests ADD COLUMN material_deadline INTEGER');
      if(!this.db.prepare('PRAGMA table_info(material_sessions)').all().some(c=>c.name==='generation'))this.db.exec('ALTER TABLE material_sessions ADD COLUMN generation INTEGER');
      if(!this.db.prepare('PRAGMA table_info(requests)').all().some(c=>c.name==='material_generation'))this.db.exec('ALTER TABLE requests ADD COLUMN material_generation INTEGER');
      this.db.exec('BEGIN EXCLUSIVE; COMMIT;');
      // Material-derived content is never recovered after a server restart.
      this.db.prepare("UPDATE requests SET status='failed',error=?,text='' WHERE material_session IS NOT NULL")
        .run(JSON.stringify({code:'interrupted',message:'The service restarted. This temporary answer is unavailable.'}));
      for (const row of this.db.prepare("SELECT id FROM requests WHERE status='accepted'").all())
        this.finish(row.id, 'failed', { code: 'interrupted', message: 'The service restarted. This request was not retried.' });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  material(id) { return this.db.prepare('SELECT * FROM material_sessions WHERE id=?').get(id); }
  registerMaterial(id, owner, deadline, generation = null) {
    const previous = this.material(id);
    if (previous) return previous;
    this.db.prepare('INSERT INTO material_sessions(id,owner,deadline,generation) VALUES(?,?,?,?)').run(id,owner,deadline,generation);
    return this.material(id);
  }
  bindGeneration(id,generation) { this.db.prepare('UPDATE material_sessions SET generation=? WHERE id=?').run(generation,id); }
  endMaterial(id) {
    this.db.prepare('UPDATE material_sessions SET ended=1 WHERE id=?').run(id);
    return this.revokeMaterialAnswers(id);
  }
  revokeMaterialAnswers(id) {
    const requests = this.db.prepare('SELECT id FROM requests WHERE material_session=?').all(id);
    for (const row of requests) {
      this.transient.delete(row.id);
      this.db.prepare("UPDATE requests SET status='cancelled',text='',error=?,updated=? WHERE id=?")
        .run(JSON.stringify({code:'material_expired',message:'This material session has ended.'}), Date.now(),row.id);
    }
    return requests.map(row=>row.id);
  }
  materialAlive(row) {
    if (!row?.material_session) return true;
    const session = this.material(row.material_session);
    return !!session && !session.ended && Date.now()<session.deadline && row.material_deadline===session.deadline && row.material_generation===session.generation;
  }
  get(id) {
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if (row?.material_session) {
      if (!this.materialAlive(row)) { this.transient.delete(id); return {...row,text:'',status:'cancelled'}; }
      return {...row,text:this.transient.get(id)?.text || ''};
    }
    return row;
  }
  find(owner, idem) { const row=this.db.prepare('SELECT id FROM requests WHERE owner=? AND idem=?').get(owner,idem);return row&&this.get(row.id); }
  event(id, type, data) {
    const row=this.get(id);
    if (row?.material_session) {
      if (!this.materialAlive(row)) return null;
      const value=this.transient.get(id);
      if (!value) return null;
      const event={seq:value.events.length+1,type,data};value.events.push(event);return event;
    }
    const seq = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE request_id=?').get(id).seq;
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(id, seq, type, JSON.stringify(data));
    return { seq, type, data };
  }
  events(id, after) {
    const row=this.get(id);
    if (row?.material_session) return this.materialAlive(row) ? (this.transient.get(id)?.events||[]).filter(e=>e.seq>after) : [];
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
    for (const row of this.db.prepare('SELECT id FROM material_sessions WHERE ended=0 AND deadline<=?').all(Date.now())) this.endMaterial(row.id);
    this.transaction(() => {
      this.db.prepare("DELETE FROM events WHERE request_id IN (SELECT id FROM requests WHERE status!='accepted' AND created<?)").run(Date.now() - retentionMs);
      this.db.prepare("DELETE FROM requests WHERE status!='accepted' AND created<?").run(Date.now() - retentionMs);
      this.db.prepare('DELETE FROM material_sessions WHERE deadline<? AND id NOT IN (SELECT material_session FROM requests WHERE material_session IS NOT NULL)').run(Date.now()-retentionMs);
      this.db.prepare('DELETE FROM quotas WHERE day<?').run(new Date().toISOString().slice(0, 10));
    });
    for (const id of this.transient.keys()) if (!this.get(id)) this.transient.delete(id);
  }
  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n; }
  accept(record) {
    return this.transaction(() => {
      const now = Date.now();
      this.db.prepare('INSERT INTO requests(id,owner,subject,idem,fingerprint,provider,status,created,updated,material_session,material_deadline,material_generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(record.id, record.owner, record.subject, record.idem, record.fingerprint, record.provider, 'accepted', now, now,record.materialContext?.sessionId||null,record.materialContext?.expiresAt||null,record.materialContext?.generation??null);
      if(record.materialContext) this.transient.set(record.id,{text:'',events:[]});
      const day = new Date(now).toISOString().slice(0, 10);
      for (const subject of [record.subject, '*'])
        this.db.prepare('INSERT INTO quotas VALUES(?,?,1) ON CONFLICT(day,subject) DO UPDATE SET count=count+1').run(day, subject);
      return this.event(record.id, 'accepted', { id: record.id, status: 'accepted' });
    });
  }
  append(id, text) {
    return this.transaction(() => {
      const row=this.get(id);if(row?.status!=='accepted'||!this.materialAlive(row)) return null;
      if(row.material_session) { const value=this.transient.get(id);if(!value)return null;value.text+=text; }
      else this.db.prepare('UPDATE requests SET text=text||?,updated=? WHERE id=?').run(text, Date.now(), id);
      return this.event(id, 'delta', { text });
    });
  }
  finish(id, status, error) {
    return this.transaction(() => {
      const row = this.get(id);
      if (!row || row.status !== 'accepted' || !this.materialAlive(row)) return null;
      this.db.prepare('UPDATE requests SET status=?,error=?,updated=? WHERE id=?').run(status, error ? JSON.stringify(error) : null, Date.now(), id);
      return this.event(id, status, { id, status, ...(status === 'completed' ? { text: row.text } : {}), ...(error ? { error } : {}) });
    });
  }
  close() { this.transient.clear();this.db.close(); }
}
module.exports = { Store };
