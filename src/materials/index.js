'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIMITS } = require('./limits');
const { extractBytes } = require('./extractor');
const { AsyncEncryptedStore } = require('./async-store');
const { LocalSearch } = require('./local-search');
const cancelled = () => Object.assign(new Error('This material session changed or expired.'), { code: 'CANCELLED' });

const clone = value => JSON.parse(JSON.stringify(value));
const accepted = document => document.state === 'ready' || document.state === 'partial';
function nameOf(file) { return path.basename(String(file)).replace(/[\x00-\x1f]/g, '').slice(0, 255) || 'Unnamed material'; }

class MaterialsManager {
  constructor({ userDataPath, safeStorage, owner, now = Date.now, onStatus, onInvalidate, extractor, visualAssets = false } = {}) {
    this.owner = owner || '';
    this.now = now;
    this.onStatus = onStatus;
    this.onInvalidate = onInvalidate;
    this.extractor = extractor;
    this.visualAssets = visualAssets;
    this.store = new AsyncEncryptedStore(userDataPath, safeStorage);
    this.userDataPath = userDataPath;
    this.preparation = { state: 'idle', completed: 0, total: 0 };
    this.session = { state: 'idle', id: null, expiresAt: null, generation: 0, documents: [] };
    this.secret = null;
    this.epoch = 0;
    this.closed = false;
    this.jobs = new Set();
    this.queue = Promise.resolve();
    this.timer = null;
    this.error = null;
    this.store.onCleanupChange = () => this._notify();
  }

  _notify() { try { this.onStatus?.(this.status()); } catch {} }
  _invalidate(reason) {
    this.session.generation++;
    try { this.onInvalidate?.(reason); } catch {}
  }
  _armTimer() {
    clearTimeout(this.timer);
    if (!this.session.expiresAt || this.closed) return;
    this.timer = setTimeout(() => { this._expire(); if (this.session.expiresAt) this._armTimer(); }, Math.max(1, this.session.expiresAt - this.now()));
    this.timer.unref?.();
  }
  _expire() {
    if (['active', 'draft'].includes(this.session.state) && this.now() >= this.session.expiresAt) {
      this._clear('expired', 'expired');
      return true;
    }
    return false;
  }
  _abortJobs() {
    this.epoch++;
    for (const job of this.jobs) job.controller.abort();
    this.jobs.clear();
    this.preparationController?.abort();
    this.search?.close(); this.search = null;
    this.preparation = { state: 'idle', completed: 0, total: 0 };
  }
  _clear(state, reason) {
    this._abortJobs();
    clearTimeout(this.timer);
    this.session = { state, id: null, expiresAt: null, generation: this.session.generation, documents: [] };
    this.secret?.key.fill(0);
    this.secret = null;
    this._invalidate(reason);
    const cleared = this.store.clear();
    this._notify();
    return cleared;
  }
  async _persist() {
    if (this.closed || this._expire() || !['active', 'draft'].includes(this.session.state)) return;
    try { await this.store.save(this.session, this.secret, this.owner, this.now); }
    catch { this.store.fallback(); this.error = 'Encrypted recovery unavailable; materials stay in memory only.'; }
  }
  _begin() {
    if (this.closed) throw new Error('Materials manager is closed');
    if (!['active', 'draft'].includes(this.session.state)) {
      // A new draft supersedes any in-flight recovery. Revoke that storage
      // lease synchronously and finish clearing before importing new bytes.
      const clearing = this.store.clear();
      this.session = { state: 'draft', id: crypto.randomUUID(), expiresAt: this.now() + LIMITS.draftDurationMs,
        generation: this.session.generation + 1, documents: [] };
      this.secret = this.store.newKey();
      this.error = null;
      this._armTimer();
      return clearing;
    }
  }

  status() {
    this._expire();
    return { state: this.session.state, id: this.session.id, expiresAt: this.session.expiresAt, generation: this.session.generation,
      persistence: this.store.mode, documents: this.session.documents.map(({ content, hash, textBytes, ...document }) => clone(document)),
      limits: LIMITS, preparation: { ...this.preparation }, busy: this.jobs.size > 0 || this.preparation.state === 'preparing', cleanupPending: this.store.cleanupPending, cleanupPersistent: this.store.cleanupPersistent, error: this.error };
  }

  retryCleanup() { const cleared = this.store.retryCleanup(); this._notify(); return cleared; }

  async restore() {
    if (this.closed || this.session.state !== 'idle' || this.jobs.size) return this.status();
    const epoch = this.epoch, owner = this.owner, previous = this.session;
    const restored = await this.store.restore(this.owner, this.now);
    if (this.closed || this.epoch !== epoch || this.owner !== owner || this.session !== previous || this.jobs.size) {
      restored?.secret?.key?.fill(0);
      return this.status();
    }
    if (restored) {
      this.session = restored.session;
      this.secret = restored.secret;
      // Pending jobs cannot survive process shutdown and do not reserve capacity.
      for (const document of this.session.documents) if (!accepted(document) && !document.error) {
        document.state = 'failed'; document.error = 'Import interrupted. Please add the file again.';
      }
      this._invalidate('restored');
      this._armTimer();
      await this._persist();
      await this.prepare();
    }
    this._notify();
    return this.status();
  }

  importFiles(files) {
    this._expire();
    if (this.session.state === 'active') return Promise.reject(new Error('Materials stay fixed during the session. End and clear before changing files.'));
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) return Promise.reject(new Error('Choose absolute local file paths'));
    if (files.length > 100) return Promise.reject(new Error('Too many selected files'));
    if(this.jobs.size || this.preparation.state === 'preparing')return Promise.reject(new Error('Preparation is already running. Wait or cancel it first.'));
    this.search?.close(); this.search = null;
    this.preparation = { state: 'idle', completed: 0, total: 0 };
    const beginning = this._begin();
    const job = { controller: new AbortController(), epoch: this.epoch, sessionId: this.session.id };
    this.jobs.add(job);
    this._notify();
    const work = this.queue.then(async () => {
      await beginning;
      for (const file of files) {
        if (!this._validJob(job)) break;
        await this._importOne(file, job);
      }
    }).finally(async () => {
      this.jobs.delete(job);
      await this._persist();
      this._notify();
    });
    this.queue = work.catch(() => {});
    return work.then(() => this.status());
  }

  _validJob(job) {
    this._expire();
    return !this.closed && !job.controller.signal.aborted && job.epoch === this.epoch && this.session.id === job.sessionId && ['draft', 'active'].includes(this.session.state);
  }

  async _read(file, signal) {
    const before=await fs.lstat(file);
    if(!before.isFile())throw new Error('Choose a regular local PDF or PPTX file.');
    if(signal.aborted)throw new Error('Import cancelled');
    const flags=require('node:fs').constants;
    const handle = await fs.open(file, flags.O_RDONLY | (flags.O_NONBLOCK||0) | (flags.O_NOFOLLOW||0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > LIMITS.maxFileBytes || stat.size < 5) throw new Error('File must be a PDF or PPTX no larger than 50 MiB');
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        if (signal.aborted) throw new Error('Import cancelled');
        const result = await handle.read(buffer, offset, Math.min(1024 * 1024, buffer.length - offset), offset);
        if (!result.bytesRead) throw new Error('File changed while being read');
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('File changed while being read');
      return buffer;
    } finally { await handle.close(); }
  }

  async _extract(file, bytes, kind, signal) {
    if (!this.extractor) {
      const snapshot = this.snapshot();
      return extractBytes(bytes, kind, { signal, limits: LIMITS, ...(this.visualAssets ? { onAsset: async ({ bytes, mimeType }) => {
        if (signal.aborted || !this.isCurrent(snapshot)) throw cancelled();
        const assetId = await this.store.putAsset(this.session, this.secret, bytes, mimeType, this.now);
        if (signal.aborted || !this.isCurrent(snapshot)) throw cancelled();
        return assetId;
      } } : {}) });
    }
    // Injected extractors obey the same cancellation, timeout and output checks.
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(new Error('Import cancelled'));
      const timer = setTimeout(() => finish(new Error('Extraction exceeded 60 seconds')), LIMITS.extractionTimeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      Promise.resolve().then(() => this.extractor(file, { signal, limits: LIMITS, bytes: Buffer.from(bytes), kind }))
        .then(result => finish(null, result), error => finish(error));
    });
  }

  _normalize(result, kind) {
    if (!result || !Array.isArray(result.pages) || !result.pages.length || result.pages.length > LIMITS.maxPagesPerFile) throw new Error('File exceeds 1000 pages or has no readable pages');
    let textBytes = 0;
    const pages = result.pages.map((source, i) => {
      if (!source || typeof source.text !== 'string' || (source.notes !== undefined && typeof source.notes !== 'string')) throw new Error('Invalid extraction output');
      const notes = source.notes || '';
      textBytes += Buffer.byteLength(source.text, 'utf8') + Buffer.byteLength(notes, 'utf8');
      if (textBytes > LIMITS.maxTextBytesPerFile) throw new Error('Decoded text exceeds 4 MiB');
      const visual = !!source.coverage?.visual;
      const images = (Array.isArray(source.images) ? source.images : []).filter(image => typeof image?.assetId === 'string' && image.assetId.length < 200 && ['image/png','image/jpeg'].includes(image.mimeType) && ['embedded-image','page-render'].includes(image.kind)).slice(0,4);
      return { page: i + 1, kind: kind === 'pptx' ? 'slide' : 'page', text: source.text, notes,
        ...(images.length ? { images } : {}),
        coverage: { state: source.coverage?.state === 'partial' || visual || !source.text ? 'partial' : 'text', visual,
          notice: images.length ? (kind === 'pdf' ? 'Original page preview available. Visual facts are read only when this page is selected for an answer; they are not indexed as text.' : 'Embedded images available. Slide shapes, layout and SmartArt are incomplete; export to PDF for a full page preview. Visual facts are not indexed as text.') : 'Only extracted text and notes are available. Images, diagrams and visual meaning may be missing.' } };
    });
    return { pages, textBytes, coverage: { state: pages.some(p => p.coverage.state === 'partial') ? 'partial' : 'text',
      totalPages: pages.length, textPages: pages.filter(p => p.text).length, visualPages: pages.filter(p => p.coverage.visual).length,
      imagePages: pages.filter(p => p.images?.length).length,
      notice: this.visualAssets ? 'Search uses text and notes. Selected source images can be sent with questions; image-only facts are not searchable. PDF renders and embedded images are best effort and bounded.' : 'Text extraction only; visual meaning is unavailable. No OCR is performed.' } };
  }

  async _importOne(file, job) {
    const document = { id: crypto.randomUUID(), name: nameOf(file), state: 'extracting', bytes: 0, pages: 0, coverage: null, error: null };
    // Keep failed rows bounded without discarding accepted material.
    if (this.session.documents.length >= 100) this.session.documents = this.session.documents.filter(accepted);
    this.session.documents.push(document);
    this._notify();
    try {
      const kind = path.extname(file).slice(1).toLowerCase();
      if (!['pdf', 'pptx'].includes(kind)) throw new Error('Only PDF and PPTX are supported. Export old PPT or Google Slides first.');
      const bytes = await this._read(file, job.controller.signal);
      if (!this._validJob(job)) return;
      document.bytes = bytes.length;
      if (kind === 'pdf' ? !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')) : bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('File contents do not match its PDF/PPTX extension');
      const hash = Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
      if (!this._validJob(job)) return;
      const existing = this.session.documents.filter(accepted);
      if (existing.some(d => d.hash === hash)) { this.session.documents = this.session.documents.filter(d => d !== document); return; }
      if (existing.length >= LIMITS.maxFiles || existing.reduce((n, d) => n + d.bytes, 0) + bytes.length > LIMITS.maxTotalBytes) throw new Error('Session limit: 11 files and 250 MiB total');
      const result = await this._extract(file, bytes, kind, job.controller.signal);
      if (!this._validJob(job)) return;
      const normalized = this._normalize(result, kind);
      if (existing.reduce((n, d) => n + d.pages, 0) + normalized.pages.length > LIMITS.maxTotalPages ||
          existing.reduce((n, d) => n + d.textBytes, 0) + normalized.textBytes > LIMITS.maxTotalTextBytes) throw new Error('Session limit: 1000 pages and 16 MiB decoded text');
      Object.assign(document, { state: normalized.coverage.state === 'partial' ? 'partial' : 'ready', hash, pages: normalized.pages.length,
        textBytes: normalized.textBytes, content: normalized.pages, coverage: normalized.coverage });
      this._invalidate('imported');
    } catch (error) {
      if (this._validJob(job)) {
        document.state = 'failed';
        document.error = error.code ? 'Unable to read the selected local file.' : String(error.message || 'Unable to extract file').slice(0, 300);
      }
    }
    if (this._validJob(job)) { await this._persist(); this._notify(); }
  }

  async start({ consent } = {}) {
    const expired = this._expire();
    if (this.closed || expired || !['active', 'draft'].includes(this.session.state)) throw new Error('Preparation expired or no materials are prepared');
    if (consent !== true) throw new Error('Explicit consent is required to share selected material excerpts');
    if (this.jobs.size) throw new Error('Wait for imports to finish before starting');
    if (this.session.state === 'active') return this.status();
    if (!this.session.documents.some(accepted)) throw new Error('Add at least one valid material first');
    const snapshot = this.snapshot();
    await this.prepare();
    if (!this.isCurrent(snapshot) || this.jobs.size || this.session.state !== 'draft') throw new Error('Preparation changed or expired');
    this.session.state = 'active';
    this.session.expiresAt = this.now() + LIMITS.sessionDurationMs;
    this._invalidate('started');
    this._armTimer(); await this._persist(); this._notify();
    return this.status();
  }

  async prepare({ signal } = {}) {
    if (signal?.aborted || this.closed || this._expire() || !['draft', 'active'].includes(this.session.state)) throw cancelled();
    if (this.preparation.state === 'ready' && this.search) return this.status();
    if (this.preparing) return this.preparing;
    if (this.jobs.size) throw new Error('Wait for file reading to finish.');
    const snapshot = this.snapshot();
    const controller = new AbortController();
    this.preparationController = controller;
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.search = new LocalSearch({ cacheDir: process.env.NOCATCH_RETRIEVAL_CACHE || path.join(this.userDataPath || require('node:os').tmpdir(), 'retrieval-models') });
    const search = this.search;
    this.preparation = { state: 'preparing', phase: 'reading', completed: 0, total: this.session.documents.reduce((n,d) => n + d.pages, 0) };
    this._notify();
    const work = search.build(this.session.documents.filter(accepted), { signal: combined,
      onProgress: progress => {
        if (this.isCurrent(snapshot) && !combined.aborted) { this.preparation = { state: 'preparing', phase: progress.state, completed: progress.completed, total: progress.total }; this._notify(); }
      }
    }).then(result => {
      if (!this.isCurrent(snapshot) || combined.aborted) throw cancelled();
      this.preparation = { state: 'ready', completed: result.indexedChunks, total: result.indexedChunks, ...result };
    }).catch(error => {
      search.close();
      if (this.search === search) this.search = null;
      if (!this.isCurrent(snapshot) || combined.aborted) throw cancelled();
      this.preparation = { state: 'failed', completed: 0, total: 0, error: 'Search preparation failed. You can still start with general reasoning.' };
    }).finally(() => { if (this.preparing === work) this.preparing = null; this._notify(); });
    this.preparing = work;
    await work;
    return this.status();
  }

  async retrieveAsync(question, { history = [], maxChars = LIMITS.maxContextChars, signal, strategy = 'auto' } = {}) {
    if (signal?.aborted || this.closed || this._expire() || this.session.state !== 'active') throw cancelled();
    if (!Number.isInteger(maxChars) || maxChars < 0) throw new Error('Invalid material text budget');
    const snapshot = this.snapshot();
    const marker = { sessionId: snapshot.sessionId, generation: snapshot.generation, expiresAt: snapshot.expiresAt };
    if (!this.search || this.preparation.state !== 'ready') return { ...marker, status: 'failed', sources: [] };
    try {
      const result = await this.search.search(question, { history, maxChars, signal, strategy });
      if (signal?.aborted || !this.isCurrent(snapshot)) throw cancelled();
      const partial = this.session.documents.some(d => d.state !== 'ready') || result.strategy === 'lexical-fallback';
      return { ...marker, ...result, status: !result.sources.length ? 'no-match' : partial ? 'partial' : 'available' };
    } catch (error) {
      if (signal?.aborted || !this.isCurrent(snapshot) || error.code === 'CANCELLED') throw cancelled();
      return { ...marker, status: 'failed', sources: [] };
    }
  }

  retrieve(question, { maxChars = LIMITS.maxContextChars } = {}) {
    if (this.closed || this._expire() || this.session.state !== 'active') return null;
    if (!Number.isInteger(maxChars) || maxChars < 0) throw new Error('Invalid material text budget');
    // Reserve room for source coordinates/JSON in the shared formatted budget.
    let remaining = Math.min(maxChars, LIMITS.maxContextChars - 3000, LIMITS.maxContextTokens * 4 - 3000);
    const terms = [...new Set(String(question || '').slice(0, 32000).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 40);
    const candidates = [];
    for (const document of this.session.documents.filter(accepted)) for (const page of document.content) {
      const text = [page.text, page.notes ? `Speaker notes:\n${page.notes}` : ''].filter(Boolean).join('\n');
      if (!text.trim()) continue;
      const lower = text.toLowerCase();
      const score = terms.reduce((n, term) => n + (lower.includes(term) ? 1 : 0), 0);
      candidates.push({ document, page, text, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const sources = [];
    // With no lexical match, a bounded overview gives image/setup requests useful
    // context while the instruction explicitly acknowledges evidentiary limits.
    for (const { document, page, text } of candidates) {
      if (sources.length >= LIMITS.maxSources || remaining <= 0) break;
      const length = Math.min(remaining, 6000);
      let excerpt = text;
      if (text.length > length) {
        const lower = text.toLowerCase();
        const positions = terms.map(t => lower.indexOf(t)).filter(i => i >= 0);
        const offset = positions.length ? Math.max(0, Math.min(...positions) - Math.floor(length / 4)) : 0;
        excerpt = text.slice(offset, offset + length);
      }
      sources.push({ id: `${document.id}:${page.kind}:${page.page}`, documentId: document.id, name: document.name,
        page: page.page, kind: page.kind, text: excerpt });
      remaining -= excerpt.length;
    }
    // Reserve exact JSON-escaped text and metadata, which can be larger than
    // raw text (quotes, newlines and control characters in source documents).
    // A caller requesting less than one source's metadata can still inspect a
    // tiny raw excerpt; the shared formatter rejects that impossible envelope.
    const formattedBudget = Math.min(maxChars, LIMITS.maxContextChars);
    if (formattedBudget >= 1024) {
      while (sources.length && JSON.stringify({ referenceMaterial: sources }).length > formattedBudget) {
        const last = sources[sources.length - 1];
        const excess = JSON.stringify({ referenceMaterial: sources }).length - formattedBudget;
        if (last.text.length > excess) last.text = last.text.slice(0, last.text.length - excess);
        else sources.pop();
      }
    }
    if (this._expire() || this.session.state !== 'active') return null;
    return { sessionId: this.session.id, generation: this.session.generation, expiresAt: this.session.expiresAt, sources };
  }

  preview(documentId, page) {
    if (this.closed || this._expire() || !['draft', 'active'].includes(this.session.state)) throw new Error('Material preview expired');
    const document = this.session.documents.find(d => d.id === documentId && accepted(d));
    const source = document?.content.find(p => p.page === page);
    if (!source) throw new Error('Material page is unavailable');
    const result = { documentId, name: document.name, ...clone(source) };
    if (this._expire()) throw new Error('Material preview expired');
    return result;
  }

  async previewWithImages(documentId, page) {
    const snapshot = this.snapshot(), result = this.preview(documentId, page);
    const images = [];
    for (const ref of result.images || []) {
      try {
        const image = await this.store.getAsset(ref.assetId, this.session, this.secret, this.now);
        if (!this.isCurrent(snapshot)) throw cancelled();
        if (image) images.push({ ...image, kind: ref.kind });
      } catch { if (!this.isCurrent(snapshot)) throw cancelled(); }
    }
    if (!this.isCurrent(snapshot)) throw cancelled();
    return { ...result, images };
  }

  async sourceImages(sources, { signal } = {}) {
    const snapshot = this.snapshot(), images = [];
    let bytes = 0;
    for (const source of sources) {
      if (images.length >= 4) break;
      if (signal?.aborted || !this.isCurrent(snapshot)) throw cancelled();
      const page = this.preview(source.documentId, source.page);
      for (const ref of page.images || []) {
        if (images.length >= 4) break;
        let image;
        try { image = await this.store.getAsset(ref.assetId, this.session, this.secret, this.now); } catch {}
        if (signal?.aborted || !this.isCurrent(snapshot)) throw cancelled();
        if (!image || bytes + image.data.length > 4 * 1024 * 1024) continue;
        bytes += image.data.length;
        images.push({ ...image, sourceId: source.id });
      }
    }
    return images;
  }

  snapshot() {
    this._expire();
    return { sessionId: this.session.id, generation: this.session.generation, expiresAt: this.session.expiresAt, owner: this.owner, state: this.session.state };
  }
  isCurrent(snapshot) {
    this._expire();
    return !!snapshot && !this.closed && snapshot.sessionId === this.session.id && snapshot.generation === this.session.generation &&
      snapshot.expiresAt === this.session.expiresAt && snapshot.owner === this.owner && (this.session.state !== 'expired' || snapshot.state === 'expired');
  }
  cancelImports() {
    this._expire();
    if (this.session.state === 'active') return this.status();
    this._abortJobs();
    for (const document of this.session.documents) if (document.state === 'extracting') { document.state = 'failed'; document.error = 'Import cancelled'; }
    this._invalidate('cancelled'); this._persist(); this._notify();
    return this.status();
  }
  async remove(documentId) {
    this._expire();
    if (this.session.state === 'active') throw new Error('Materials stay fixed during the session. End and clear before changing files.');
    this._abortJobs();
    this.session.documents = this.session.documents.filter(d => d.id !== documentId);
    for (const document of this.session.documents) if (document.state === 'extracting') { document.state = 'failed'; document.error = 'Import cancelled'; }
    this._invalidate('removed'); await this._persist(); this._notify();
    return this.status();
  }
  async end(reason = 'ended') { await this._clear('ended', reason); return this.status(); }
  async setOwner(owner) {
    if (owner === this.owner) return this.status();
    this.owner = owner || '';
    await this._clear('idle', 'owner-changed');
    return this.status();
  }
  async close() {
    if (this.closed) return;
    const saving = this._persist();
    this.closed = true;
    this._abortJobs();
    clearTimeout(this.timer);
    this.session.documents = [];
    this.secret?.key.fill(0); this.secret = null;
    this._invalidate('closed');
    await saving;
    await this.store.close();
  }
}

module.exports = { MaterialsManager, LIMITS };
