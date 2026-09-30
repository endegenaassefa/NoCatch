'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIMITS } = require('./limits');
const { extractBytes } = require('./extractor');
const { EncryptedStore } = require('./store');

const clone = value => JSON.parse(JSON.stringify(value));
const accepted = document => document.state === 'ready' || document.state === 'partial';
function nameOf(file) { return path.basename(String(file)).replace(/[\x00-\x1f]/g, '').slice(0, 255) || 'Unnamed material'; }
function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Material search cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

class MaterialsManager {
  constructor({ userDataPath, safeStorage, owner, now = Date.now, onStatus, onInvalidate, extractor, searchFactory, modelCachePath } = {}) {
    this.owner = owner || '';
    this.now = now;
    this.onStatus = onStatus;
    this.onInvalidate = onInvalidate;
    this.extractor = extractor;
    this.store = new EncryptedStore(userDataPath, safeStorage);
    this.session = { state: 'idle', id: null, expiresAt: null, generation: 0, documents: [] };
    this.secret = null;
    this.epoch = 0;
    this.closed = false;
    this.jobs = new Set();
    this.queue = Promise.resolve();
    this.timer = null;
    this.error = null;
    this.searchFactory = searchFactory || (() => new (require('./local-search').LocalSearch)({ cacheDir: modelCachePath || path.join(userDataPath, 'retrieval-models') }));
    this.searchIndex = null;
    this.searchBuild = null;
    this.searchState = { state: 'idle', completed: 0, total: 0, error: null };
    this.store.onCleanupChange = () => this._notify();
  }

  _notify() { try { this.onStatus?.(this.status()); } catch {} }
  _invalidate(reason) {
    this.searchIndex?.close();
    this.searchIndex = null;
    this.searchBuild = null;
    this.searchState = { state: 'idle', completed: 0, total: 0, error: null };
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
  }
  _clear(state, reason) {
    this._abortJobs();
    clearTimeout(this.timer);
    this.session = { state, id: null, expiresAt: null, generation: this.session.generation, documents: [] };
    this.secret?.key.fill(0);
    this.secret = null;
    this._invalidate(reason);
    try { this.store.clear(); } catch { this.store.fallback(); this.error = 'Encrypted recovery unavailable; materials stay in memory only.'; }
    this._notify();
  }
  _persist() {
    if (this.closed || this._expire() || !['active', 'draft'].includes(this.session.state)) return;
    try { this.store.save(this.session, this.secret, this.owner, this.now); }
    catch { this.store.fallback(); this.error = 'Encrypted recovery unavailable; materials stay in memory only.'; }
  }
  _begin() {
    if (this.closed) throw new Error('Materials manager is closed');
    if (!['active', 'draft'].includes(this.session.state)) {
      this.session = { state: 'draft', id: crypto.randomUUID(), expiresAt: this.now() + LIMITS.draftDurationMs,
        generation: this.session.generation + 1, documents: [] };
      this.secret = this.store.newKey();
      this.error = null;
      this._armTimer();
    }
  }

  status() {
    this._expire();
    if (this.searchIndex?.closed && this.searchState.state === 'ready') this.searchState = { ...this.searchState,
      state: 'error', error: 'Local search stopped. Prepare the index again.' };
    return { state: this.session.state, id: this.session.id, expiresAt: this.session.expiresAt, generation: this.session.generation,
      persistence: this.store.mode, documents: this.session.documents.map(({ content, hash, textBytes, ...document }) => clone(document)),
      limits: LIMITS, busy: this.jobs.size > 0, search: { ...this.searchState }, cleanupPending: this.store.cleanupPending, cleanupPersistent: this.store.cleanupPersistent, error: this.error };
  }

  retryCleanup() { const cleared = this.store.retryCleanup(); this._notify(); return cleared; }

  async restore() {
    if (this.closed || this.session.state !== 'idle' || this.jobs.size) return this.status();
    const restored = this.store.restore(this.owner, this.now);
    if (restored) {
      this.session = restored.session;
      this.secret = restored.secret;
      // Pending jobs cannot survive process shutdown and do not reserve capacity.
      for (const document of this.session.documents) if (!accepted(document) && !document.error) {
        document.state = 'failed'; document.error = 'Import interrupted. Please add the file again.';
      }
      this._invalidate('restored');
      this._armTimer();
      this._persist();
    }
    this._notify();
    return this.status();
  }

  importFiles(files) {
    this._expire();
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) return Promise.reject(new Error('Choose absolute local file paths'));
    if (files.length > 100) return Promise.reject(new Error('Too many selected files'));
    if(this.jobs.size)return Promise.reject(new Error('An import is already running. Wait or cancel it first.'));
    this._begin();
    const job = { controller: new AbortController(), epoch: this.epoch, sessionId: this.session.id };
    this.jobs.add(job);
    this._notify();
    const work = this.queue.then(async () => {
      for (const file of files) {
        if (!this._validJob(job)) break;
        await this._importOne(file, job);
      }
    }).finally(() => {
      this.jobs.delete(job);
      this._persist();
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
    if (!this.extractor) return extractBytes(bytes, kind, { signal, limits: LIMITS });
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
      return { page: i + 1, kind: kind === 'pptx' ? 'slide' : 'page', text: source.text, notes,
        coverage: { state: source.coverage?.state === 'partial' || visual || !source.text ? 'partial' : 'text', visual,
          notice: 'Only extracted text and notes are available. Images, diagrams and visual meaning may be missing.' } };
    });
    return { pages, textBytes, coverage: { state: pages.some(p => p.coverage.state === 'partial') ? 'partial' : 'text',
      totalPages: pages.length, textPages: pages.filter(p => p.text).length, visualPages: pages.filter(p => p.coverage.visual).length,
      notice: 'Text extraction only; visual meaning is unavailable. No OCR is performed.' } };
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
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
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
    if (this._validJob(job)) { this._persist(); this._notify(); }
  }

  async start({ consent } = {}) {
    const expired = this._expire();
    if (this.closed || expired || !['active', 'draft'].includes(this.session.state)) throw new Error('Preparation expired or no materials are prepared');
    if (consent !== true) throw new Error('Explicit consent is required to share selected material excerpts');
    if (this.jobs.size) throw new Error('Wait for imports to finish before starting');
    if (this.session.state === 'active') return this.status();
    if (!this.session.documents.some(accepted)) throw new Error('Add at least one valid material first');
    this.session.state = 'active';
    this.session.expiresAt = this.now() + LIMITS.sessionDurationMs;
    this._invalidate('started');
    this._armTimer(); this._persist(); this._notify();
    return this.status();
  }

  async prepareSearch() {
    if (this.closed || this._expire() || this.session.state !== 'active') throw new Error('Start a material session before searching');
    if (this.searchBuild && !this.searchIndex?.closed) return this.searchBuild;
    const snapshot = this.snapshot();
    const index = this.searchFactory();
    this.searchIndex = index;
    this.searchState = { state: 'loading', completed: 0, total: 0, error: null };
    this._notify();
    const build = Promise.resolve().then(() => index.build(this.session.documents.filter(accepted), {
      onProgress: progress => {
        if (this.searchIndex !== index || !this.isCurrent(snapshot)) return;
        this.searchState = { ...this.searchState, ...progress }; this._notify();
      }
    })).then(result => {
      if (this.searchIndex !== index || !this.isCurrent(snapshot)) throw new Error('Material session changed while preparing search');
      this.searchState = { ...this.searchState, state: 'ready', error: null }; this._notify();
      return result;
    }).catch(error => {
      index.close();
      if (this.searchIndex === index) {
        this.searchIndex = null; this.searchBuild = null;
        this.searchState = { ...this.searchState, state: 'error', error: 'Local search could not be prepared. Check the model download and retry.' }; this._notify();
      }
      throw error;
    });
    this.searchBuild = build;
    return build;
  }

  _searchFailed(index) {
    index?.close();
    if (this.searchIndex !== index) return;
    this.searchIndex = null; this.searchBuild = null;
    this.searchState = { ...this.searchState, state: 'error', error: 'Local search failed or was cancelled. Prepare the index again.' };
    this._notify();
  }

  _searchSource(source) {
    if (!source || typeof source !== 'object') return null;
    const document = this.session.documents.find(d => d.id === source.documentId && accepted(d));
    const page = document?.content.find(p => p.page === source.page && p.kind === source.kind);
    const original = page && [page.text, page.notes ? `Speaker notes:\n${page.notes}` : ''].filter(Boolean).join('\n');
    if (!page || source.name !== document.name || source.id !== `${document.id}:${page.kind}:${page.page}` ||
        typeof source.text !== 'string' || !original.includes(source.text)) return null;
    const { id, documentId, name, page: number, kind, text } = source;
    return { id, documentId, name, page: number, kind, text };
  }

  _searchDiagnostics(value) {
    const candidates = [];
    for (const raw of (Array.isArray(value?.candidates) ? value.candidates : []).slice(0, 24)) {
      const source = this._searchSource(raw);
      if (!source) continue;
      candidates.push(source);
      if (Buffer.byteLength(JSON.stringify(candidates)) > 64 * 1024) { candidates.pop(); break; }
    }
    const result = { candidates };
    for (const [key, max] of [['chunks', 16000], ['queryCount', 4]]) {
      if (Number.isSafeInteger(value?.[key]) && value[key] >= 0 && value[key] <= max) result[key] = value[key];
    }
    for (const key of ['embedding', 'reranker']) {
      const metadata = value?.[key];
      if (metadata && ['model', 'revision'].every(k => typeof metadata[k] === 'string' && /^[\w/.:\-]{1,150}$/.test(metadata[k]))) {
        result[key] = { model: metadata.model, revision: metadata.revision };
      }
    }
    return result;
  }

  async search(question, { history = [], maxChars = LIMITS.maxContextChars, signal, includeDiagnostics = false } = {}) {
    if (this.closed || this._expire() || this.session.state !== 'active') return null;
    if (typeof question !== 'string' || question.length > 16000 || !Number.isInteger(maxChars) || maxChars < 0) throw new Error('Invalid material search input');
    signal?.throwIfAborted();
    const snapshot = this.snapshot();
    if (this.searchIndex?.closed) { this._searchFailed(this.searchIndex); throw new Error('Local search stopped. Prepare the index again.'); }
    await waitWithSignal(this.prepareSearch(), signal);
    signal?.throwIfAborted();
    if (!this.isCurrent(snapshot)) throw new Error('Material session changed while preparing search');
    const index = this.searchIndex;
    const recent = (Array.isArray(history) ? history : []).filter(t => t?.role === 'user' && typeof t.content === 'string').slice(-2).map(t => ({ role: 'user', content: t.content.slice(-2000) }));
    let result;
    try { result = await waitWithSignal(index.search(question, { history: recent, maxChars: Math.min(maxChars, LIMITS.maxContextChars), signal }), signal); }
    catch (error) { this._searchFailed(index); throw error; }
    signal?.throwIfAborted();
    if (!this.isCurrent(snapshot) || this.searchIndex !== index) throw new Error('Material session changed during search');
    if (!Array.isArray(result?.sources) || result.sources.length > LIMITS.maxSources) throw new Error('Invalid search result');
    const sources = result.sources.map(source => this._searchSource(source));
    if (sources.some(source => !source)) throw new Error('Search returned an invalid source');
    const context = { sessionId: snapshot.sessionId, generation: snapshot.generation, expiresAt: snapshot.expiresAt, sources, abstained: result.abstained === true };
    require('./context').formatMaterialContext(context, { now: this.now, maxChars });
    if (includeDiagnostics === true) context.diagnostics = this._searchDiagnostics(result.diagnostics);
    return context;
  }

  // Historical lexical path retained for controlled comparisons. The semantic
  // candidate is exercised through search(), pending its quality acceptance.
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
    this._abortJobs();
    for (const document of this.session.documents) if (document.state === 'extracting') { document.state = 'failed'; document.error = 'Import cancelled'; }
    this._invalidate('cancelled'); this._persist(); this._notify();
    return this.status();
  }
  async remove(documentId) {
    this._expire();
    this._abortJobs();
    this.session.documents = this.session.documents.filter(d => d.id !== documentId);
    for (const document of this.session.documents) if (document.state === 'extracting') { document.state = 'failed'; document.error = 'Import cancelled'; }
    this._invalidate('removed'); this._persist(); this._notify();
    return this.status();
  }
  async end(reason = 'ended') { this._clear('ended', reason); return this.status(); }
  async setOwner(owner) {
    if (owner === this.owner) return this.status();
    this.owner = owner || '';
    this._clear('idle', 'owner-changed');
    return this.status();
  }
  async close() {
    if (this.closed) return;
    this._persist();
    this.closed = true;
    this._abortJobs();
    clearTimeout(this.timer);
    this.session.documents = [];
    this.secret?.key.fill(0); this.secret = null;
    this._invalidate('closed');
    this.store.close();
  }
}

module.exports = { MaterialsManager, LIMITS };
