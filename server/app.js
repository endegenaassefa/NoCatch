'use strict';
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { Store } = require('./store');
const { PromptLoader } = require('../prompt-loader');
const promptLoader = new PromptLoader();
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
function publicRequest(row) {
  return { id: row.id, requestId: row.id, status: row.status, text: row.text, provider: row.provider,
    createdAt: new Date(row.created).toISOString(), updatedAt: new Date(row.updated).toISOString(),
    ...(row.error ? { error: JSON.parse(row.error) } : {}) };
}
function validateInput(value, limits) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(400, 'invalid_input', 'Expected a JSON object.');
  if (!['gemini', 'deepseek'].includes(value.provider)) throw error(400, 'invalid_provider', 'Choose Gemini or DeepSeek.');
  const text = value.text === undefined ? '' : value.text;
  if (typeof text !== 'string') throw error(400, 'invalid_input', 'Text must be a string.');
  const skill = value.skill || 'general';
  if (typeof skill !== 'string' || !['general', ...promptLoader.getAvailableSkills()].includes(skill)) throw error(400, 'invalid_skill', 'Unknown skill.');
  const language = value.language || '';
  if (typeof language !== 'string' || language.length > 40 || !/^[\w+#. -]*$/.test(language)) throw error(400, 'invalid_language', 'Invalid programming language.');
  const history = value.history || [];
  if (!Array.isArray(history) || history.length > limits.historyTurns || history.some(turn =>
    !turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string')) throw error(400, 'invalid_history', 'Invalid conversation history.');
  if (text.length + history.reduce((n, turn) => n + turn.content.length, 0) > limits.inputChars) throw error(413, 'input_limit', 'Text and history are too long.');
  let image;
  if (value.image !== undefined) {
    const img = value.image;
    if (!img || !['image/png', 'image/jpeg', 'image/webp'].includes(img.mimeType) || typeof img.data !== 'string' ||
      img.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(img.data)) throw error(400, 'invalid_image', 'Expected a base64 PNG, JPEG, or WebP image.');
    const bytes = Buffer.from(img.data, 'base64');
    if (!bytes.length || bytes.length > limits.imageBytes) throw error(413, 'image_limit', 'Image exceeds the allowed size.');
    const valid = img.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : img.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw error(400, 'invalid_image', 'Image bytes do not match the image type.');
    if (value.provider === 'deepseek') throw error(422, 'image_not_supported', 'Choose Gemini for image questions. DeepSeek supports text questions.');
    image = { mimeType: img.mimeType, data: img.data };
  }
  if (!text.trim() && !image) throw error(400, 'empty_input', 'Enter a question or attach an image.');
  return { text, skill, language, provider: value.provider, history: history.map(({ role, content }) => ({ role, content })), ...(image ? { image } : {}) };
}
async function readBody(req, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw error(415, 'content_type', 'Use application/json.');
  if (Number(req.headers['content-length'] || 0) > limit) throw error(413, 'payload_limit', 'Request is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw error(413, 'payload_limit', 'Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error(400, 'invalid_json', 'Invalid JSON.'); }
}
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function createManagedServer({ config, authenticate, provider, store = new Store(config.database), extraRoute, readiness }) {
  if (typeof authenticate !== 'function' || typeof provider !== 'function') throw new Error('Authentication and real provider required');
  const limits = config.limits;
  const jobs = new Map(), subscribers = new Map();
  let subscriberCount = 0, closing = false, storageHealthy = true;
  const publish = (id, event) => {
    if (!event) return;
    for (const client of subscribers.get(id) || []) client.send(event);
  };
  const finish = (id, state, failure) => {
    const event = store.finish(id, state, failure);
    publish(id, event);
    return event;
  };
  const execute = (id, input) => {
    const abort = new AbortController();
    let pending = '', outputLength = 0, eventCount = 0;
    const flush = () => {
      if (!pending || store.get(id)?.status !== 'accepted') { pending = ''; return; }
      if (++eventCount >= limits.eventsPerRequest - 2) throw error(502, 'output_limit', 'The answer exceeded the event limit.');
      const delta = pending; pending = '';
      publish(id, store.append(id, delta));
    };
    const timeout = setTimeout(() => {
      try { flush(); finish(id, 'failed', { code: 'timeout', message: 'The request exceeded the time limit.' }); }
      catch { storageHealthy = false; }
      abort.abort();
    }, limits.timeoutMs);
    jobs.set(id, abort);
    Promise.resolve().then(() => provider(input, { signal: abort.signal, onDelta(text) {
      if (abort.signal.aborted || store.get(id)?.status !== 'accepted') return;
      if (typeof text !== 'string') throw error(502, 'provider_error', 'Invalid AI response.');
      outputLength += text.length;
      if (outputLength > limits.outputChars) throw error(502, 'output_limit', 'The answer exceeded the output limit.');
      pending += text;
      // Persist reasonably sized deltas to bound event rows and disk writes.
      if (pending.length >= 128) flush();
    } })).then(() => {
      flush();
      if (!outputLength) throw error(502, 'empty_response', 'The AI provider returned no answer.');
      finish(id, 'completed');
    }).catch(cause => {
      abort.abort();
      try {
        flush();
        const safe = new Set(['provider_busy', 'provider_error', 'provider_refused', 'provider_interrupted', 'provider_response_limit', 'output_limit', 'empty_response']);
        finish(id, 'failed', safe.has(cause.code) ? { code: cause.code, message: cause.message } : { code: 'provider_error', message: 'The AI provider could not complete this request.' });
      } catch { storageHealthy = false; }
    }).finally(() => { clearTimeout(timeout); jobs.delete(id); });
  };
  const server = http.createServer(async (req, res) => {
    res.on('error', () => {});
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && ['/health/live', '/health/ready'].includes(url.pathname)) {
        const ready = !closing && storageHealthy && (!readiness || readiness());
        return send(res, url.pathname === '/health/live' || ready ? 200 : 503, { status: url.pathname === '/health/live' ? 'alive' : ready ? 'ready' : 'unavailable' });
      }
      if (closing || !storageHealthy) throw error(503, 'unavailable', 'The service is temporarily unavailable.');
      const auth = await authenticate(req);
      if (extraRoute && await extraRoute(req, res, auth, url)) return;
      if (req.method === 'GET' && url.pathname === '/v1/me') return send(res, 200, {
        subject: auth.subject, providers: ['gemini', 'deepseek'], limits,
        usage: { requestsToday: store.usage(auth.account), dailyLimit: limits.dailyAccount }
      });
      if (req.method === 'POST' && url.pathname === '/v1/answers') {
        const idem = req.headers['idempotency-key'];
        if (typeof idem !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(idem)) throw error(400, 'idempotency_key_required', 'Supply an Idempotency-Key of 8–128 safe characters.');
        const input = validateInput(await readBody(req, limits.bodyBytes), limits);
        const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
        store.prune(limits.retentionMs);
        const existing = store.find(auth.owner, idem);
        if (existing && existing.fingerprint !== fingerprint) throw error(409, 'idempotency_conflict', 'This request key was already used for different input.');
        if (existing) return send(res, 200, publicRequest(existing));
        if (store.usage(auth.account) >= limits.dailyAccount || store.usage('*') >= limits.dailyGlobal) throw error(429, 'daily_limit', 'The daily request allowance has been reached.');
        if (store.active(auth.account) >= limits.activeAccount || store.active() >= limits.activeGlobal) throw error(429, 'concurrency_limit', 'Too many requests are running.');
        if (store.count() >= limits.maxRecords) throw error(503, 'storage_limit', 'The service has reached its request capacity. Try again later.');
        const id = randomUUID();
        store.accept({ id, owner: auth.owner, subject: auth.account, idem, fingerprint, provider: input.provider });
        execute(id, input);
        return send(res, 202, { ...publicRequest(store.get(id)), eventsUrl: `/v1/requests/${id}/events`, requestUrl: `/v1/requests/${id}` });
      }
      const route = /^\/v1\/requests\/([0-9a-f-]{36})(?:\/(events|cancel))?$/.exec(url.pathname);
      if (!route) throw error(404, 'not_found', 'Not found.');
      const [, id, operation] = route;
      const row = store.get(id);
      if (!row || row.owner !== auth.owner) throw error(404, 'not_found', 'Not found.');
      if (req.method === 'GET' && !operation) return send(res, 200, publicRequest(row));
      if (req.method === 'POST' && operation === 'cancel') {
        finish(id, 'cancelled');
        jobs.get(id)?.abort();
        return send(res, 200, publicRequest(store.get(id)));
      }
      if (req.method !== 'GET' || operation !== 'events') throw error(405, 'method_not_allowed', 'Method not allowed.');
      const afterText = req.headers['last-event-id'] || '0';
      if (!/^\d{1,8}$/.test(afterText)) throw error(400, 'invalid_cursor', 'Invalid Last-Event-ID.');
      const after = Number(afterText), events = store.events(id, 0);
      if (after > events.length) throw error(400, 'invalid_cursor', 'Last-Event-ID is beyond this request.');
      if (subscriberCount >= limits.subscribersGlobal || (subscribers.get(id)?.size || 0) >= limits.subscribersPerRequest) throw error(429, 'stream_limit', 'Too many event streams.');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      let closed = false;
      const client = { send(event) {
        if (closed || res.destroyed) return;
        if (res.writableLength > 512 * 1024) { res.destroy(); return; }
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        if (terminal(event.type)) res.end();
      } };
      const group = subscribers.get(id) || new Set();
      group.add(client); subscribers.set(id, group); subscriberCount++;
      const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.destroy(); }, 15000);
      const expiry = setTimeout(() => res.end(), Math.max(1, Math.min(limits.timeoutMs + 15000, auth.expiresAt - Date.now())));
      res.on('close', () => {
        if (closed) return; closed = true;
        clearInterval(heartbeat); clearTimeout(expiry);
        group.delete(client); subscriberCount--; if (!group.size) subscribers.delete(id);
      });
      for (const event of events) if (event.seq > after) client.send(event);
      if (terminal(row.status)) res.end();
    } catch (cause) {
      if (cause.code === 'ERR_SQLITE_ERROR') storageHealthy = false;
      if (res.headersSent) return res.destroy();
      const status = cause.status || 500;
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      if (status === 429) res.setHeader('Retry-After', '30');
      if (status === 413) res.setHeader('Connection', 'close');
      send(res, status, { error: { code: cause.code && cause.status ? cause.code : 'internal_error', message: cause.status ? cause.message : 'The service could not handle this request.' } });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxConnections = 128;
  const pruning = setInterval(() => { try { store.prune(limits.retentionMs); } catch { storageHealthy = false; } }, 60000);
  pruning.unref();
  async function close() {
    closing = true; clearInterval(pruning);
    for (const [id, abort] of jobs) { finish(id, 'failed', { code: 'interrupted', message: 'The service stopped. This request was not retried.' }); abort.abort(); }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    // All real providers observe AbortSignal. Wait before closing their store.
    const deadline = Date.now() + 3000;
    while (jobs.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (!jobs.size) store.close();
  }
  return { server, store, close };
}
module.exports = { createManagedServer, validateInput };

