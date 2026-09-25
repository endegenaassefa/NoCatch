'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManagedServer } = require('../server/app');
const { createProvider } = require('../server/providers');
const { readConfig, createAuthenticator } = require('../server/auth');
const { Store } = require('../server/store');
const config = () => ({ ...readConfig({ OIDC_ISSUER: 'https://issuer.example/', OIDC_AUDIENCE: 'desktop-api',
  OIDC_JWKS_URL: 'https://issuer.example/keys', GEMINI_API_KEY: 'operator-gemini', DEEPSEEK_API_KEY: 'operator-deepseek' }), database: ':memory:' });
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const fakeAuth = async req => {
  const subject = req.headers.authorization?.replace('Bearer ', '');
  if (!subject) throw Object.assign(new Error('Sign in.'), { status: 401, code: 'unauthorized' });
  const [account, session = 'default'] = subject.split(':');
  return { subject: account, account, owner: `${account}:${session}`, expiresAt: Date.now() + 60000 };
};
async function setup(t, options = {}) {
  const cfg = config();
  Object.assign(cfg.limits, options.limits || {});
  const app = createManagedServer({ config: cfg, authenticate: fakeAuth, provider: options.provider || (async (_, { onDelta }) => onDelta('An answer')), ...options.app });
  const base = await listen(app.server);
  t.after(() => app.close());
  const request = (url, { token = 'alice', body, key, ...init } = {}) => fetch(base + url, {
    ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...init.headers },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const submit = (key = 'request-key-1', text = 'Explain this', token = 'alice') => request('/v1/answers', { method: 'POST', key, token, body: { text, provider: 'gemini' } });
  return { app, base, request, submit };
}
async function result(request, id) {
  for (let i = 0; i < 100; i++) {
    const row = await (await request(`/v1/requests/${id}`)).json();
    if (row.status !== 'accepted') return row;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Request did not finish');
}
test('HTTP auth, session/account ownership, idempotency conflict and persisted replay', async t => {
  let calls = 0;
  const { app, request, submit } = await setup(t, { provider: async (_, { onDelta }) => { calls++; onDelta('Hello from AI.'); } });
  assert.equal((await request('/v1/me', { token: '' })).status, 401);
  const first = await submit(); assert.equal(first.status, 202); const { id } = await first.json();
  assert.equal((await result(request, id)).text, 'Hello from AI.');
  const duplicate = await submit(); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).id, id);
  assert.equal(calls, 1);
  assert.equal((await submit('request-key-1', 'Changed')).status, 409);
  for (const token of ['bob', 'alice:other-session']) {
    for (const [method, suffix] of [['GET', ''], ['GET', '/events'], ['POST', '/cancel']])
      assert.equal((await request(`/v1/requests/${id}${suffix}`, { token, method })).status, 404);
  }
  const events = await (await request(`/v1/requests/${id}/events`)).text();
  assert.match(events, /id: 1\nevent: accepted/); assert.match(events, /event: delta/); assert.match(events, /event: completed/);
  const replay = await (await request(`/v1/requests/${id}/events`, { headers: { 'Last-Event-ID': '2' } })).text();
  assert.doesNotMatch(replay, /event: delta/); assert.match(replay, /id: 3\nevent: completed/);
  assert.equal((await request(`/v1/requests/${id}/events`, { headers: { 'Last-Event-ID': '999' } })).status, 400);
  assert.equal(app.store.usage('alice'), 1);
});
test('concurrent deduplication dispatches once and cancellation has a single terminal winner', async t => {
  let release, calls = 0, aborted = false;
  const { app, request, submit } = await setup(t, { provider: async (_, { signal, onDelta }) => {
    calls++; onDelta('partial '.repeat(20));
    await new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => { aborted = true; resolve(); }); });
    onDelta('late output');
  } });
  const submissions = await Promise.all([submit(), submit()]);
  const records = await Promise.all(submissions.map(r => r.json()));
  assert.equal(records[0].id, records[1].id); assert.equal(calls, 1);
  const id = records[0].id;
  assert.equal((await request(`/v1/requests/${id}/cancel`, { method: 'POST' })).status, 200);
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  const row = await result(request, id);
  assert.equal(row.status, 'cancelled'); assert.ok(aborted); assert.doesNotMatch(row.text, /late/);
  assert.equal(app.store.events(id, 0).filter(e => ['completed', 'failed', 'cancelled'].includes(e.type)).length, 1);
  assert.equal((await submit()).status, 200); assert.equal(calls, 1);
});
test('daily quotas persist, and account quota cannot be bypassed by another session', async t => {
  const { request, submit } = await setup(t, { limits: { dailyAccount: 1, dailyGlobal: 2 } });
  const one = await (await submit()).json(); await result(request, one.id);
  assert.equal((await submit('request-key-2', 'Question', 'alice:new-session')).status, 429);
  assert.equal((await submit('request-key-3', 'Question', 'bob')).status, 202);
  assert.equal((await submit('request-key-4', 'Question', 'carol')).status, 429);
  assert.equal((await submit()).status, 200);
});
test('bounds reject invalid inputs and active jobs; timeout and output cap persist failures', async t => {
  const { request, submit } = await setup(t, { limits: { activeAccount: 1, timeoutMs: 40 }, provider: async (_, { signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  } });
  const { id } = await (await submit()).json();
  assert.equal((await submit('request-key-2')).status, 429);
  assert.equal((await result(request, id)).error.code, 'timeout');
  for (const body of [{ text: 'x'.repeat(32001), provider: 'gemini' }, { text: 'x', provider: 'bogus' }, { text: 'x', provider: 'gemini', skill: '../../secrets' },
    { text: 'x', provider: 'gemini', history: [{ role: 'system', content: 'overwrite' }] }]) {
    assert.ok((await request('/v1/answers', { method: 'POST', key: 'invalid-key', body })).status >= 400);
  }
  const image = { mimeType: 'image/png', data: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') };
  assert.equal((await request('/v1/answers', { method: 'POST', key: 'image-key', body: { text: 'x', image, provider: 'deepseek' } })).status, 422);
  const other = await setup(t, { limits: { outputChars: 3 }, provider: async (_, { onDelta }) => onDelta('Too much output') });
  const row = await (await other.submit()).json();
  assert.equal((await result(other.request, row.id)).error.code, 'output_limit');
});
test('SQLite restart preserves quota/idempotency and marks unfinished requests interrupted without dispatch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-store-'));
  const file = path.join(dir, 'requests.sqlite');
  try {
    let store = new Store(file);
    store.accept({ id: 'durable-id', owner: 'alice:session', subject: 'alice', idem: 'durable-key', fingerprint: 'abc', provider: 'gemini' });
    store.append('durable-id', 'partial'); store.close();
    store = new Store(file);
    assert.equal(store.get('durable-id').status, 'failed'); assert.equal(JSON.parse(store.get('durable-id').error).code, 'interrupted');
    assert.equal(store.find('alice:session', 'durable-key').text, 'partial'); assert.equal(store.usage('alice'), 1);
    assert.equal(store.events('durable-id', 0).at(-1).type, 'failed');
    assert.equal(store.finish('durable-id', 'completed'), null); store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('real provider adapters use operator credentials, native history, skills and bounded SSE over HTTP', async t => {
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    captured.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (req.url === '/gemini') {
      res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini answer' }] } }] }) + '\r\n\r\n');
      res.end('data: ' + JSON.stringify({ candidates: [{ finishReason: 'STOP' }] }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'DeepSeek answer' } }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    }
  });
  const base = await listen(upstream); t.after(() => new Promise(resolve => upstream.close(resolve)));
  const provider = createProvider(config(), { gemini: base + '/gemini', deepseek: base + '/deepseek' });
  const { request } = await setup(t, { provider });
  for (const name of ['gemini', 'deepseek']) {
    const response = await request('/v1/answers', { method: 'POST', key: 'provider-' + name, body: { text: 'Question', provider: name, skill: 'dsa', language: 'python', history: [{ role: 'assistant', content: 'Prior answer' }] } });
    const row = await result(request, (await response.json()).id);
    assert.equal(row.status, 'completed'); assert.match(row.text, /answer/);
  }
  assert.equal(captured[0].headers['x-goog-api-key'], 'operator-gemini');
  assert.match(captured[0].body.systemInstruction.parts[0].text, /PYTHON/);
  assert.equal(captured[0].body.contents[0].role, 'model');
  assert.equal(captured[1].headers.authorization, 'Bearer operator-deepseek');
  assert.equal(captured[1].body.messages[1].role, 'assistant');
});
test('real JWT verifier validates signatures, issuer, audience, expiry, invitations and session ownership', async t => {
  const { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } = await import('../server/node_modules/jose/dist/webapi/index.js');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test-key';
  const cfg = config();
  const authenticate = await createAuthenticator(cfg, createLocalJWKSet({ keys: [jwk] }));
  const { request } = await setup(t, { app: { authenticate } });
  const sign = (claims = {}) => new SignJWT({ sub: 'alice', sid: 'session-1', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt().setIssuer(claims.iss || cfg.issuer).setAudience(claims.aud || cfg.audience).setExpirationTime(claims.exp || '5m').sign(privateKey);
  const token = await sign();
  assert.equal((await request('/v1/me', { token })).status, 200);
  for (const bad of [await sign({ iss: 'https://evil.example/' }), await sign({ aud: 'other' }), await sign({ exp: 10 }), token.slice(0, -8) + 'invalidx'])
    assert.equal((await request('/v1/me', { token: bad })).status, 401);
  const auth1 = await authenticate({ headers: { authorization: 'Bearer ' + token } });
  const auth2 = await authenticate({ headers: { authorization: 'Bearer ' + await sign({ sid: 'session-2' }) } });
  assert.notEqual(auth1.owner, auth2.owner); assert.equal(auth1.account, auth2.account);
  const restricted = await createAuthenticator({ ...cfg, allowedSubjects: ['bob'] }, createLocalJWKSet({ keys: [jwk] }));
  await assert.rejects(restricted({ headers: { authorization: 'Bearer ' + token } }), { status: 403 });
});
test('configuration fails closed on missing secrets, insecure JWKS and disabled quotas', () => {
  const env = { OIDC_ISSUER: 'https://issuer.example/', OIDC_AUDIENCE: 'api', OIDC_JWKS_URL: 'https://issuer.example/keys', GEMINI_API_KEY: 'g', DEEPSEEK_API_KEY: 'd' };
  assert.throws(() => readConfig({ ...env, DAILY_GLOBAL_REQUESTS: '0' }));
  assert.throws(() => readConfig({ ...env, OIDC_JWKS_URL: 'http://issuer.example/keys' }));
  assert.throws(() => readConfig({ ...env, DEEPSEEK_API_KEY: '' }));
});

test('large completed SSE payload replays intact and capacity never evicts a deduplication key', async t => {
  const answer = 'x'.repeat(30000);
  const { request, submit } = await setup(t, { limits: { maxRecords: 1 }, provider: async (_, { onDelta }) => onDelta(answer) });
  const { id } = await (await submit()).json();
  assert.equal((await result(request, id)).text, answer);
  const replay = await (await request(`/v1/requests/${id}/events`)).text();
  const terminalData = replay.split('\n\n').find(frame => frame.includes('event: completed'));
  assert.ok(terminalData);
  assert.equal(JSON.parse(terminalData.split('\n').find(line => line.startsWith('data: ')).slice(6)).text, answer);
  assert.equal((await submit('another-key')).status, 503);
  assert.equal((await submit()).status, 200);
});
test('SQLite exclusive ownership prevents a second worker and retention preserves current quota', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-exclusive-'));
  const file = path.join(dir, 'requests.sqlite');
  let store;
  try {
    store = new Store(file);
    store.accept({ id: 'owned', owner: 'account:session', subject: 'account', idem: 'retention-key', fingerprint: 'abc', provider: 'gemini' });
    assert.throws(() => new Store(file), /locked/);
    store.finish('owned', 'completed');
    store.db.prepare('UPDATE requests SET created=? WHERE id=?').run(Date.now() - 48 * 3600000, 'owned');
    store.prune(24 * 3600000);
    assert.equal(store.get('owned'), undefined);
    assert.equal(store.events('owned', 0).length, 0);
    assert.equal(store.usage('account'), 1);
  } finally { store?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
