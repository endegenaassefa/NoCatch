'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('./config');
const { RefreshStore } = require('./store');
const { createLoopback } = require('./loopback');
const { ManagedError, safeError } = require('./errors');
const { readJson, sameOriginUrl, events } = require('./network');

function safeAccount(data) {
  if (!data || typeof data.subject !== 'string' || !data.subject || data.subject.length > 512) throw new ManagedError('invalid_response');
  const numbers = value => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([k, v]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) && typeof v === 'number' && Number.isFinite(v)).slice(0, 32));
  return { subject: data.subject, providers: Array.isArray(data.providers) ? data.providers.filter(p => ['gemini', 'deepseek'].includes(p)) : [], limits: numbers(data.limits), usage: numbers(data.usage) };
}
function requestId(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new ManagedError('invalid_response'); return value; }

class ManagedManager {
  #access = null; #refresh = null; #expires = 0; #refreshing = null; #metadata = null;
  #sessionEpoch = 0; #workEpoch = 0; #authController = null; #signingPromise = null;
  #account = null; #error = null; #operations = new Set(); #sockets = new Set(); #persistent = false;
  constructor({ app, safeStorage, externalBrowser, fetchImpl = globalThis.fetch, onStatus = () => {}, env = process.env, authTimeoutMs = 180000 }) {
    this.config = loadConfig(app, env); this.fetchImpl = fetchImpl; this.externalBrowser = externalBrowser; this.onStatus = onStatus; this.authTimeoutMs = authTimeoutMs;
    const binding = crypto.createHash('sha256').update(JSON.stringify([this.config.issuer, this.config.clientId, this.config.audience, this.config.apiBaseUrl, this.config.scopes])).digest('hex');
    this.store = new RefreshStore(path.join(app.getPath('userData'), 'managed-session.json'), safeStorage, binding);
  }
  status() { return { configured: this.config.configured, authenticated: Boolean(this.#access && this.#account), signingIn: Boolean(this.#signingPromise), persistence: this.#persistent ? 'encrypted' : 'session_only', account: this.#account ? structuredClone(this.#account) : null, error: this.#error ? { code: this.#error.code, message: this.#error.message } : null, ...(this.config.reason ? { reason: this.config.reason } : {}) }; }
  #emit() { try { this.onStatus(this.status()); } catch {} }
  #check(epoch) { if (epoch !== this.#sessionEpoch) throw new ManagedError('cancelled'); }
  #configured() { if (!this.config.configured) throw new ManagedError('not_configured'); }
  async #fetch(url, options = {}, timeoutMs = 30000) {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try { return await this.fetchImpl(url, { ...options, signal, redirect: 'error' }); } catch (error) { throw safeError(error); }
  }
  async #discovery(signal) {
    if (this.#metadata) return this.#metadata;
    const response = await this.#fetch(`${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal });
    if (!response.ok) throw new ManagedError('auth_failed');
    const data = await readJson(response, 65536);
    if (data.issuer !== this.config.issuer) throw new ManagedError('auth_failed');
    if (!data.code_challenge_methods_supported?.includes('S256')) throw new ManagedError('auth_failed');
    const authorization = sameOriginUrl(this.config.issuer, data.authorization_endpoint);
    const token = sameOriginUrl(this.config.issuer, data.token_endpoint);
    if (!data.authorization_endpoint || !data.token_endpoint) throw new ManagedError('auth_failed');
    this.#metadata = { authorization, token }; return this.#metadata;
  }
  async #tokens(parameters, epoch, signal) {
    const metadata = await this.#discovery(signal); this.#check(epoch);
    const response = await this.#fetch(metadata.token, { method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ ...parameters, client_id: this.config.clientId }).toString() });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ManagedError('auth_failed'); }
    const data = await readJson(response, 65536); this.#check(epoch);
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 32768 || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw new ManagedError('auth_failed');
    if (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 32768)) throw new ManagedError('auth_failed');
    this.#access = data.access_token; this.#expires = Date.now() + Math.min(Number(data.expires_in), 86400) * 1000;
    this.#refresh = data.refresh_token || this.#refresh;
    this.#persistent = await this.store.write(this.#refresh).catch(() => false); this.#check(epoch);
  }
  async #identity(epoch, signal) {
    const data = await this.#json('/v1/me', { signal }, epoch, false);
    this.#check(epoch); const account = safeAccount(data);
    if (this.#account && this.#account.subject !== account.subject) this.cancelAll();
    this.#account = account; this.#error = null; this.#emit();
  }
  async #accessToken(epoch) {
    this.#check(epoch);
    if (this.#access && this.#expires > Date.now() + 30000) return this.#access;
    if (!this.#refresh) throw new ManagedError('signed_out');
    if (!this.#refreshing) {
      const refresh = this.#refresh; const controller = new AbortController(); this.#authController = controller;
      const pending = (async () => {
        try { await this.#tokens({ grant_type: 'refresh_token', refresh_token: refresh }, epoch, controller.signal); await this.#identity(epoch, controller.signal); }
        catch (error) {
          this.#check(epoch);
          if (error.code === 'auth_failed' || error.code === 'signed_out') { await this.signOut(); throw new ManagedError('signed_out'); }
          throw safeError(error);
        }
      })();
      this.#refreshing = pending;
      pending.finally(() => { if (this.#refreshing === pending) this.#refreshing = null; if (this.#authController === controller) this.#authController = null; }).catch(() => {});
    }
    await this.#refreshing; this.#check(epoch); return this.#access;
  }
  signIn() {
    if (this.#signingPromise) return this.#signingPromise;
    this.#configured();
    const pending = this.#runSignIn(); this.#signingPromise = pending; this.#emit();
    pending.finally(() => { if (this.#signingPromise === pending) this.#signingPromise = null; this.#emit(); }).catch(() => {});
    return pending;
  }
  async #runSignIn() {
    const epoch = this.#sessionEpoch + 1;
    await this.signOut(); this.#check(epoch); const controller = new AbortController(); this.#authController = controller;
    let callback;
    try {
      const metadata = await this.#discovery(controller.signal); this.#check(epoch);
      callback = await createLoopback({ signal: controller.signal, timeoutMs: this.authTimeoutMs, ports: this.config.loopbackPorts }); this.#check(epoch);
      const url = new URL(metadata.authorization);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: this.config.clientId, redirect_uri: callback.redirectUri, scope: this.config.scopes.join(' '), audience: this.config.audience, state: callback.state, code_challenge: callback.challenge, code_challenge_method: 'S256', prompt: 'select_account' })) url.searchParams.set(key, value);
      await this.externalBrowser(url.toString());
      const code = await callback.code; this.#check(epoch);
      await this.#tokens({ grant_type: 'authorization_code', code, redirect_uri: callback.redirectUri, code_verifier: callback.verifier }, epoch, controller.signal);
      await this.#identity(epoch, controller.signal); return this.status();
    } catch (error) {
      if (epoch === this.#sessionEpoch) { this.#access = null; this.#refresh = null; this.#account = null; this.#persistent = false; await this.store.clear().catch(() => {}); this.#error = safeError(error); this.#emit(); }
      throw safeError(error);
    } finally { callback?.close(); if (this.#authController === controller) this.#authController = null; }
  }
  async restore() {
    if (!this.config.configured || this.#access || this.#signingPromise) return this.status();
    const epoch = this.#sessionEpoch;
    try { const refresh = await this.store.read(); this.#check(epoch); if (!refresh) return this.status(); this.#refresh = refresh; await this.#accessToken(epoch); }
    catch (error) { if (epoch === this.#sessionEpoch) { this.#error = safeError(error); this.#emit(); } }
    return this.status();
  }
  async signOut() {
    this.cancelAll(); this.#sessionEpoch++; this.#authController?.abort(); this.#authController = null; this.#refreshing = null;
    this.#access = null; this.#refresh = null; this.#expires = 0; this.#account = null; this.#error = null; this.#persistent = false;
    // Notify ownership changes before aborted requests settle during storage I/O.
    this.#emit();
    await this.store.clear().catch(() => {}); return this.status();
  }
  cancelAll() {
    this.#workEpoch++;
    for (const operation of this.#operations) { operation.controller.abort(); if (operation.id) this.#cancelUpstream(operation.id); }
    this.#operations.clear(); for (const socket of this.#sockets) { try { socket.close(); } catch {} } this.#sockets.clear();
  }
  #cancelUpstream(id) {
    if (!this.#access) return Promise.resolve();
    const token = this.#access;
    return this.#fetch(sameOriginUrl(this.config.apiBaseUrl, `/v1/requests/${requestId(id)}/cancel`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } }, 5000).then(response => response.body?.cancel()).catch(() => {});
  }
  async cancel(id) { requestId(id); for (const operation of this.#operations) if (operation.id === id) operation.controller.abort(); await this.#cancelUpstream(id); }
  async #response(endpoint, options, epoch, refresh = true) {
    this.#configured(); this.#check(epoch);
    const token = refresh ? await this.#accessToken(epoch) : this.#access;
    if (!token) throw new ManagedError('signed_out');
    const response = await this.#fetch(sameOriginUrl(this.config.apiBaseUrl, endpoint), { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } }, options.timeoutMs || 30000);
    this.#check(epoch);
    if (response.status === 401 && refresh) {
      await response.body?.cancel().catch(() => {});
      // A parallel request may already have replaced the rejected access token.
      if (token === this.#access) { this.#expires = 0; await this.#accessToken(epoch); }
      return this.#response(endpoint, options, epoch, false);
    }
    if (!response.ok) {
      let data; try { data = await readJson(response, 65536); } catch {}
      if (response.status === 401) throw new ManagedError('signed_out');
      if (response.status === 429) throw new ManagedError(data?.error?.code === 'quota_exceeded' ? 'quota_exceeded' : 'rate_limited');
      throw new ManagedError(data?.error?.code || 'request_failed');
    }
    return response;
  }
  async #json(endpoint, options, epoch, refresh = true) { return readJson(await this.#response(endpoint, options, epoch, refresh)); }
  async authenticatedRequest(endpoint, { method = 'GET', body, headers = {} } = {}) {
    const epoch = this.#sessionEpoch, work = this.#workEpoch, controller = new AbortController(); const operation = { controller }; this.#operations.add(operation);
    try {
      const result = await this.#json(endpoint, { method, signal: controller.signal, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, epoch);
      this.#check(epoch); if (work !== this.#workEpoch) throw new ManagedError('cancelled'); return result;
    } catch (error) { throw safeError(error); } finally { this.#operations.delete(operation); }
  }
  async openAuthenticatedSocket(endpoint, createSocket) {
    const epoch = this.#sessionEpoch, work = this.#workEpoch;
    const httpUrl = endpoint.replace(/^wss:/, 'https:'); const target = sameOriginUrl(this.config.apiBaseUrl, httpUrl).replace(/^https:/, 'wss:');
    const token = await this.#accessToken(epoch); this.#check(epoch); if (work !== this.#workEpoch) throw new ManagedError('cancelled');
    const socket = createSocket(target, { headers: { Authorization: `Bearer ${token}` } }); this.#sockets.add(socket);
    socket.once?.('close', () => this.#sockets.delete(socket)); return socket;
  }
  requestStatus(id) { return this.authenticatedRequest(`/v1/requests/${requestId(id)}`); }
  answerScoped(payload, { signal } = {}) { return this.answer(payload, () => {}, { signal }); }
  async answer(payload, onDelta = () => {}, { signal } = {}) {
    this.#configured(); const epoch = this.#sessionEpoch, work = this.#workEpoch, controller = new AbortController();
    const operation = { controller, id: null }; this.#operations.add(operation);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const check = () => { this.#check(epoch); if (work !== this.#workEpoch || controller.signal.aborted) throw new ManagedError('cancelled'); };
    let text = '', lastId = 0;
    try {
      check();
      if (!payload || typeof payload.text !== 'string' || payload.text.length > 100000 || JSON.stringify(payload).length > 16 * 1024 * 1024) throw new ManagedError('invalid_request');
      const body = Object.fromEntries(['text', 'image', 'history', 'skill', 'language', 'provider'].filter(k => payload[k] !== undefined).map(k => [k, payload[k]]));
      const idempotencyKey = crypto.randomUUID(); let accepted;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          accepted = await this.#json('/v1/answers', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body) }, epoch); break;
        } catch (error) { check(); if (attempt > 0 || error.code !== 'network') throw error; }
      }
      operation.id = requestId(accepted.requestId || accepted.id);
      if (work !== this.#workEpoch || epoch !== this.#sessionEpoch || controller.signal.aborted) { await this.#cancelUpstream(operation.id); check(); }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await this.#response(`/v1/requests/${operation.id}/events`, { signal: controller.signal, timeoutMs: 180000, headers: { Accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': String(lastId) } : {}) } }, epoch);
          for await (const event of events(response)) {
            check(); const id = Number(event.id); if (!Number.isSafeInteger(id) || id <= 0) throw new ManagedError('invalid_response'); if (id <= lastId) continue; lastId = id;
            if (event.event === 'delta') { const delta = event.data.text ?? event.data.delta; if (typeof delta !== 'string' || text.length + delta.length > 2 * 1024 * 1024) throw new ManagedError('invalid_response'); text += delta; onDelta(delta); }
            if (event.event === 'completed') { if (typeof event.data.text === 'string') text = event.data.text; if (text.length > 2 * 1024 * 1024) throw new ManagedError('invalid_response'); return { requestId: operation.id, text }; }
            if (event.event === 'failed') throw new ManagedError(event.data.error?.code || 'request_failed');
            if (event.event === 'cancelled') throw new ManagedError('cancelled');
          }
        } catch (error) { check(); if (error instanceof ManagedError && error.code !== 'network') throw error; }
        check(); const status = await this.#json(`/v1/requests/${operation.id}`, { signal: controller.signal }, epoch); check();
        if (status.status === 'completed') { if (typeof status.text === 'string') text = status.text; if (text.length > 2 * 1024 * 1024) throw new ManagedError('invalid_response'); return { requestId: operation.id, text }; }
        if (status.status === 'failed') throw new ManagedError(status.error?.code || 'request_failed');
        if (status.status === 'cancelled') throw new ManagedError('cancelled');
      }
      throw new ManagedError('network');
    } catch (error) { if (operation.id) this.#cancelUpstream(operation.id); throw safeError(error); }
    finally { signal?.removeEventListener('abort', abort); controller.abort(); this.#operations.delete(operation); }
  }
}
function createManagedManager(options) { return new ManagedManager(options); }
module.exports = { ManagedManager, createManagedManager, ManagedError };
