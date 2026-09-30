'use strict';
// Research experiment, not a production module. Uses synthetic slide text only.
// Run: node docs/session-materials-20260929/storage-experiment.cjs
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nocatch-materials-lab-'));
const checks = [], runs = [];
const TTL = 90 * 60 * 1000;
const round = value => Math.round(value * 100) / 100;
function check(name, fn) { fn(); checks.push({ name, passed: true }); }
function encrypted(key, aad, value) {
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
}
function decrypted(key, aad, blob) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(blob.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(blob.subarray(12, -16)), decipher.final()]).toString('utf8'));
}
function openStore(filename, key, now, deadline) {
  // The harness supplies a key to model restoration. It does not test safeStorage.
  const disk = new DatabaseSync(filename);
  disk.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY;
    CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, payload BLOB NOT NULL);`);
  let session = disk.prepare('SELECT * FROM session').get();
  if (!session) {
    if (deadline === undefined) { disk.close(); throw new Error('Missing original deadline'); }
    session = { id: crypto.randomUUID(), expires_at: deadline };
    disk.prepare('INSERT INTO session VALUES (?,?)').run(session.id, session.expires_at);
  }
  let index = null, closed = false;
  const aad = id => `${session.id}:${session.expires_at}:${id}`;
  const live = () => { if (closed) throw new Error('Store closed'); if (now() >= session.expires_at) throw new Error('Session expired'); };
  const close = () => { if (closed) return; index?.close(); disk.close(); closed = true; };
  const clear = () => { close(); for (const name of [filename, `${filename}-journal`, `${filename}-wal`, `${filename}-shm`]) fs.rmSync(name, { force: true }); };
  // Check deadline before decrypting anything or rebuilding the RAM index.
  if (now() >= session.expires_at) { clear(); throw new Error('Session expired'); }
  try {
    index = new DatabaseSync(':memory:');
    index.exec('PRAGMA temp_store=MEMORY; CREATE VIRTUAL TABLE search USING fts5(body, filename UNINDEXED, slide UNINDEXED);');
    const insert = index.prepare('INSERT INTO search(rowid,body,filename,slide) VALUES (?,?,?,?)');
    for (const row of disk.prepare('SELECT * FROM chunks').all()) {
      const chunk = decrypted(key, aad(row.id), Buffer.from(row.payload)); insert.run(row.id, chunk.body, chunk.filename, chunk.slide);
    }
    live();
  } catch (error) { close(); throw error; }
  return {
    deadline: session.expires_at,
    put(id, chunk) {
      live(); const payload = encrypted(key, aad(id), chunk); live();
      disk.prepare('INSERT INTO chunks VALUES (?,?)').run(id, payload);
      index.prepare('INSERT INTO search(rowid,body,filename,slide) VALUES (?,?,?,?)').run(id, chunk.body, chunk.filename, chunk.slide);
    },
    search(query) {
      live();
      const tokens = (query.match(/[\p{L}\p{N}_]+/gu) || []).slice(0, 24);
      if (!tokens.length) return [];
      const match = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ');
      const hits = index.prepare('SELECT rowid,body,filename,slide FROM search WHERE search MATCH ? ORDER BY bm25(search) LIMIT 8').all(match);
      live(); return hits;
    },
    close, clear,
  };
}
try {
  for (const workload of [{ decks: 5, slides: 60, words: 180 }, { decks: 10, slides: 60, words: 180 }, { decks: 10, slides: 100, words: 1200 }]) {
    const filename = path.join(root, `workload-${workload.decks}-${workload.words}.sqlite`);
    const key = crypto.randomBytes(32); let now = 100000;
    const started = performance.now(); const rssBefore = process.memoryUsage().rss;
    let store = openStore(filename, key, () => now, now + TTL);
    let textBytes = 0, totalWords = 0, id = 0;
    const paragraph = 'Transactions database indexes recovery replication snapshots records queries concurrency isolation planning tables consistency constraints ';
    for (let deck = 0; deck < workload.decks; deck++) {
      for (let slide = 1; slide <= workload.slides; slide++) {
        const words = paragraph.repeat(Math.ceil(workload.words / 14)).trim().split(/\s+/).slice(0, workload.words);
        const body = `uniqueanchor_${deck}_${slide} PRIVATE_CANARY_${deck}_${slide} ${words.join(' ')}`;
        textBytes += Buffer.byteLength(body); totalWords += words.length + 2;
        store.put(++id, { filename: `Private deck ${deck + 1}.pptx`, slide, body });
      }
    }
    const buildMs = performance.now() - started;
    const latencies = [];
    for (let n = 0; n < 60; n++) {
      const deck = n % workload.decks, slide = 1 + n % workload.slides;
      const start = performance.now(); const hits = store.search(`uniqueanchor_${deck}_${slide}`); latencies.push(performance.now() - start);
      assert.equal(hits[0]?.filename, `Private deck ${deck + 1}.pptx`); assert.equal(Number(hits[0]?.slide), slide);
    }
    check(`${workload.decks} decks/${id} slides: encrypted disk has no content or filenames`, () => {
      const bytes = fs.readFileSync(filename); assert.equal(bytes.includes(Buffer.from('PRIVATE_CANARY')), false); assert.equal(bytes.includes(Buffer.from('Private deck')), false);
      for (const suffix of ['-journal', '-wal', '-shm']) if (fs.existsSync(filename + suffix)) assert.equal(fs.readFileSync(filename + suffix).includes(Buffer.from('PRIVATE_CANARY')), false);
    });
    const deadline = store.deadline; store.close(); now += 67 * 60 * 1000;
    const restoreStarted = performance.now(); store = openStore(filename, key, () => now); const restoreMs = performance.now() - restoreStarted;
    check(`${workload.decks} decks/${id} slides: reopen restores citations without extending deadline`, () => {
      assert.equal(store.deadline, deadline); assert.equal(store.deadline - now, 23 * 60 * 1000); assert.equal(store.search('uniqueanchor_0_18')[0].slide, 18);
    });
    latencies.sort((a, b) => a - b);
    runs.push({ ...workload, totalSlides: id, totalWords, extractedTextMiB: round(textBytes / 1048576), encryptedDatabaseMiB: round(fs.statSync(filename).size / 1048576), buildMs: round(buildMs), restoreMs: round(restoreMs), lookupMedianMs: round(latencies[Math.floor(latencies.length / 2)]), lookupP95Ms: round(latencies[Math.floor(latencies.length * .95)]), rssBeforeMiB: round(rssBefore / 1048576), rssAfterMiB: round(process.memoryUsage().rss / 1048576) });
    now = deadline;
    check(`${workload.decks} decks/${id} slides: exact deadline rejects reads and writes`, () => {
      assert.throws(() => store.search('uniqueanchor_0_18'), /expired/);
      assert.throws(() => store.put(id + 1, { body: 'late worker result', filename: 'late.pptx', slide: 1 }), /expired/);
    });
    store.close(); key.fill(0);
    check(`${workload.decks} decks/${id} slides: expired startup deletes database before decryption`, () => {
      assert.throws(() => openStore(filename, Buffer.alloc(32), () => now), /expired/); assert.equal(fs.existsSync(filename), false);
    });
  }
  check('authenticated encryption rejects changed content and a different session binding', () => {
    const key = crypto.randomBytes(32), payload = encrypted(key, 'session:deadline:1', { body: 'private' });
    const changed = Buffer.from(payload); changed[15] ^= 1;
    assert.throws(() => decrypted(key, 'session:deadline:1', changed)); assert.throws(() => decrypted(key, 'other:deadline:1', payload)); key.fill(0);
  });
  const result = { experiment: 'Encrypted SQLite payloads and RAM-only FTS5 on synthetic slide text', recordedAt: new Date().toISOString(), runtime: process.version, platform: `${process.platform}/${process.arch}`, ttlMinutes: 90, checks, runs, limitations: ['Not connected to NoCatch and not a production implementation.', 'Generated text; no PPTX/PDF parsing, OCR, images, Google OAuth, or live AI answers.', 'Key supplied by the harness; Windows DPAPI/macOS Keychain were not tested.', 'Unique-anchor lookups test mechanical retrieval and source mapping, not semantic answer quality.', 'RSS is process-wide and cumulative across runs; these are not isolated peak-memory measurements.', 'AES protects content at rest; logical file deletion does not prove physical erasure or backup deletion.', 'No process can delete local files while the computer is off; startup cleanup demonstrates the next-launch policy.', 'Production still needs atomic disk/index commits, process isolation, owner checks, and full cancellation/cleanup coverage.'] };
  fs.writeFileSync(path.join(__dirname, 'storage-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
