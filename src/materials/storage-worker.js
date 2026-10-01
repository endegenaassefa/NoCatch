'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { EncryptedStore } = require('./store');
let store, unwrapKey;
const lease = new Int32Array(workerData.lease);
const clock = message => () => message.now + Math.max(0, Date.now() - message.sentAt);
const clear = () => { store.db?.exec('DELETE FROM material_asset'); store.clear(); };
// OS key wrapping belongs to Electron main. Only authenticated ciphertext and
// the transient unwrapped key cross this private worker boundary.
parentPort.on('message', message => {
  let result;
  try {
    const now = clock(message);
    if (message.type === 'init') {
      store = new EncryptedStore(message.directory, {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'main-process-key-wrapper',
        decryptString: () => unwrapKey,
      });
      store.db?.exec('CREATE TABLE IF NOT EXISTS material_asset (id TEXT PRIMARY KEY, sessionid TEXT NOT NULL, mime TEXT NOT NULL, payload BLOB NOT NULL, bytes INTEGER NOT NULL); DELETE FROM material_asset WHERE sessionid NOT IN (SELECT id FROM material_session)');
    } else if (message.type === 'save') {
      if (message.epoch === Atomics.load(lease, 0) && !fs.existsSync(store.cleanupFile)) {
        store.save(message.session, { key: Buffer.from(message.key), wrapped: Buffer.from(message.wrapped) }, message.owner, now);
        if (message.epoch !== Atomics.load(lease, 0)) clear();
      }
    } else if (message.type === 'metadata') {
      const row = store.db?.prepare('SELECT id, owner, deadline, state, wrapped FROM material_session WHERE singleton=1').get();
      const owner = crypto.createHash('sha256').update(String(message.owner || '')).digest('hex');
      if (row && row.owner === owner && row.deadline > now() && ['draft', 'active'].includes(row.state) && !fs.existsSync(store.cleanupFile)) result = row;
      else if (row) clear();
    } else if (message.type === 'restore') {
      unwrapKey = Buffer.from(message.key).toString('base64');
      if (!fs.existsSync(store.cleanupFile)) result = store.restore(message.owner, now);
      if (!result) clear();
    } else if (message.type === 'put-asset') {
      if (!store.db || message.epoch !== Atomics.load(lease, 0) || message.expiresAt <= now() || fs.existsSync(store.cleanupFile)) throw new Error('Revoked source image');
      const bytes = Buffer.from(message.bytes);
      const used = Number(store.db.prepare('SELECT COALESCE(SUM(bytes),0) AS total FROM material_asset').get().total);
      const disk = fs.statfsSync(require('node:path').dirname(store.file));
      if (bytes.length > 2 * 1024 * 1024 || used + bytes.length > 128 * 1024 * 1024 || disk.bavail * disk.bsize < bytes.length + 128 * 1024 * 1024) throw new Error('Source image storage limit');
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(message.key), iv);
      cipher.setAAD(Buffer.from(JSON.stringify([message.assetId, message.sessionId, message.mimeType])));
      const payload = Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
      if (message.epoch !== Atomics.load(lease, 0)) throw new Error('Revoked source image');
      store.db.prepare('INSERT INTO material_asset VALUES (?,?,?,?,?)').run(message.assetId, message.sessionId, message.mimeType, payload, bytes.length);
    } else if (message.type === 'get-asset') {
      if (message.epoch !== Atomics.load(lease, 0) || message.expiresAt <= now() || fs.existsSync(store.cleanupFile)) throw new Error('Revoked source image');
      const row = store.db?.prepare('SELECT * FROM material_asset WHERE id=? AND sessionid=?').get(message.assetId, message.sessionId);
      if (row && row.payload.length <= 2 * 1024 * 1024 + 28) {
        const data = Buffer.from(row.payload), cipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(message.key), data.subarray(0,12));
        cipher.setAAD(Buffer.from(JSON.stringify([row.id, row.sessionid, row.mime]))); cipher.setAuthTag(data.subarray(-16));
        result = { mimeType: row.mime, data: Buffer.concat([cipher.update(data.subarray(12,-16)), cipher.final()]).toString('base64') };
      }
    } else if (message.type === 'clear') clear();
    else if (message.type === 'close') store.close();
    parentPort.postMessage({ id: message.id, result, mode: store.mode, cleanupPending: store.cleanupPending, cleanupPersistent: store.cleanupPersistent });
  } catch {
    parentPort.postMessage({ id: message.id, error: 'Encrypted recovery is unavailable.' });
  } finally {
    unwrapKey = null;
    message.key?.fill(0);
  }
});
