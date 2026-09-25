'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { ManagedManager } = require('../src/managed');
const { RefreshStore } = require('../src/managed/store');
const { createLoopback } = require('../src/managed/loopback');
const { loadConfig } = require('../src/managed/config');
const { events } = require('../src/managed/network');

const config = { issuer: 'https://identity.example', clientId: 'public-client', apiBaseUrl: 'https://api.example', audience: 'nocatch-api', scopes: ['openid', 'offline_access', 'answers:write'] };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const fakeSafeStorage = (backend = 'keychain') => {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
    encryptString: text => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    decryptString: buffer => { const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); decipher.setAuthTag(buffer.subarray(12, 28)); return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString(); },
  };
};
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nocatch-managed-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (options.config !== false) await fs.writeFile(path.join(root, 'managed-config.json'), JSON.stringify(options.config || config));
  const app = { isPackaged: true, getAppPath: () => root, getPath: () => root };
  const state = { requests: [], refreshes: 0, exchanges: 0, subject: 'user-1', expiresIn: 3600, browserUrl: null };
  const safeStorage = options.safeStorage || fakeSafeStorage();
  const fetchImpl = async (url, init = {}) => {
    state.requests.push({ url, init });
    if (options.handler) { const value = await options.handler(url, init, state); if (value) return value; }
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`, code_challenge_methods_supported: ['S256'] });
    if (url.endsWith('/token')) {
      const params = new URLSearchParams(init.body);
      if (params.get('grant_type') === 'refresh_token') state.refreshes++;
      else {
        state.exchanges++;
        assert.equal(params.get('code'), 'test-code');
        assert.equal(crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url'), state.browserUrl.searchParams.get('code_challenge'));
        assert.equal(params.get('redirect_uri'), state.browserUrl.searchParams.get('redirect_uri'));
      }
      return json({ access_token: `ACCESS-SECRET-${state.refreshes}`, refresh_token: `REFRESH-SECRET-${state.refreshes}`, token_type: 'Bearer', expires_in: state.expiresIn });
    }
    if (url.endsWith('/v1/me')) return json({ subject: state.subject, providers: ['gemini', 'deepseek'], limits: { requests: 20 }, usage: { requests: 2 }, access_token: 'DO-NOT-EXPOSE' });
    if (url.endsWith('/cancel')) return json({ status: 'cancelled' });
    throw new Error('Unexpected URL');
  };
  const manager = new ManagedManager({ app, safeStorage, fetchImpl, externalBrowser: async url => {
    state.browserUrl = new URL(url);
    const callback = new URL(state.browserUrl.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1'); callback.searchParams.set('state', state.browserUrl.searchParams.get('state')); callback.searchParams.set('code', 'test-code');
    const response = await fetch(callback); assert.equal(response.status, 200);
  }, ...options.manager });
  t.after(() => manager.signOut());
  return { root, app, manager, state, safeStorage, fetchImpl };
}

test('missing config is visibly unconfigured and packaged builds ignore environment overrides', async t => {
  const f = await fixture(t, { config: false });
  assert.equal(f.manager.status().configured, false);
  assert.equal(loadConfig(f.app, { NOCATCH_MANAGED_ISSUER: config.issuer, NOCATCH_MANAGED_CLIENT_ID: config.clientId, NOCATCH_MANAGED_API_BASE_URL: config.apiBaseUrl }).configured, false);
  assert.throws(() => f.manager.signIn(), { code: 'not_configured' });
});
test('real loopback enforces state, PKCE, one-time callback and expiry', async () => {
  const callback = await createLoopback({ timeoutMs: 1000 });
  assert.equal((await fetch(`${callback.redirectUri}?state=wrong&code=bad`)).status, 400);
  assert.equal((await fetch(`${callback.redirectUri}?state=${callback.state}&code=valid`)).status, 200);
  assert.equal(await callback.code, 'valid');
  await assert.rejects(fetch(`${callback.redirectUri}?state=${callback.state}&code=again`));
  const expired = await createLoopback({ timeoutMs: 15 }); await assert.rejects(expired.code, { code: 'auth_expired' });
});
test('configured callback ports fail explicitly when occupied', async t => {
  const blocker = http.createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve)); t.after(() => blocker.close());
  await assert.rejects(createLoopback({ ports: [blocker.address().port] }), { code: 'callback_unavailable' });
});
test('browser sign-in validates backend identity, keeps access token in memory and persists encrypted refresh only', async t => {
  const f = await fixture(t); await f.manager.signIn();
  assert.equal(f.manager.status().authenticated, true); assert.equal(f.state.exchanges, 1);
  assert.equal(f.manager.status().persistence, 'encrypted');
  const stored = await fs.readFile(path.join(f.root, 'managed-session.json'), 'utf8');
  assert.doesNotMatch(stored, /ACCESS-SECRET|REFRESH-SECRET/);
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /SECRET|DO-NOT-EXPOSE|access_token/);
  assert.equal(f.state.browserUrl.searchParams.get('audience'), config.audience);
  assert.equal(f.state.browserUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(f.state.requests.every(r => r.init.redirect === 'error'));
});
test('basic_text keyring stays session-only with no plaintext persistence', async t => {
  const f = await fixture(t, { safeStorage: fakeSafeStorage('basic_text') }); await f.manager.signIn();
  assert.equal(f.manager.status().persistence, 'session_only');
  await assert.rejects(fs.access(path.join(f.root, 'managed-session.json')));
});
test('encrypted store is atomic, bound to deployment and queued clear wins', async t => {
  const f = await fixture(t); const filename = path.join(f.root, 'refresh.json'); const store = new RefreshStore(filename, f.safeStorage, 'deployment-a');
  await store.write('sensitive-refresh'); assert.equal(await store.read(), 'sensitive-refresh');
  assert.equal(await new RefreshStore(filename, f.safeStorage, 'deployment-b').read(), null);
  await Promise.all([store.write('rotated-refresh'), store.clear()]); await assert.rejects(fs.access(filename));
  assert.equal((await fs.readdir(f.root)).filter(p => p.endsWith('.tmp')).length, 0);
});
test('concurrent expired requests share one refresh; rotated refresh restores a new manager', async t => {
  const f = await fixture(t); f.state.expiresIn = 1; await f.manager.signIn(); f.state.expiresIn = 3600;
  await Promise.all([f.manager.authenticatedRequest('/v1/me'), f.manager.authenticatedRequest('/v1/me'), f.manager.authenticatedRequest('/v1/me')]);
  assert.equal(f.state.refreshes, 1);
  const restored = new ManagedManager({ app: f.app, safeStorage: f.safeStorage, fetchImpl: f.fetchImpl, externalBrowser: () => assert.fail('restore should not launch browser') });
  assert.equal((await restored.restore()).authenticated, true); assert.equal(f.state.refreshes, 2); await restored.signOut();
});
test('metadata issuer mismatch and cross-origin token endpoints fail without leaking details', async t => {
  for (const metadata of [
    { issuer: 'https://imposter.example', authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`, code_challenge_methods_supported: ['S256'] },
    { issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: 'https://imposter.example/token', code_challenge_methods_supported: ['S256'] },
  ]) {
    const f = await fixture(t, { handler: url => url.endsWith('openid-configuration') ? json(metadata) : null });
    await assert.rejects(f.manager.signIn(), error => !error.message.includes('imposter')); assert.equal(f.state.exchanges, 0);
  }
});
test('managed answer posts exact contract, deduplicates replay IDs and recovers interrupted SSE', async t => {
  let streams = 0;
  const f = await fixture(t, { handler: (url, init) => {
    if (url.endsWith('/v1/answers')) { assert.ok(init.headers['Idempotency-Key']); assert.equal(JSON.parse(init.body).provider, 'gemini'); return json({ id: 'request_1' }, 202); }
    if (url.endsWith('/events')) { streams++; const body = streams === 1 ? 'id: 1\nevent: accepted\ndata: {"id":"request_1"}\n\nid: 2\nevent: delta\ndata: {"text":"Hello"}\n\n' : 'id: 2\nevent: delta\ndata: {"text":"Hello"}\n\nid: 3\nevent: delta\ndata: {"text":" world"}\n\nid: 4\nevent: completed\ndata: {"text":"Hello world"}\n\n'; if (streams === 2) assert.equal(init.headers['Last-Event-ID'], '2'); return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }); }
    if (url.endsWith('/v1/requests/request_1')) return json({ status: 'running' });
  } });
  await f.manager.signIn(); const chunks = []; const result = await f.manager.answer({ text: 'Question', provider: 'gemini', skill: 'general', language: 'English' }, text => chunks.push(text));
  assert.equal(result.text, 'Hello world'); assert.deepEqual(chunks, ['Hello', ' world']);
});
test('sign-out discards delayed API replies and clears encrypted session', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let pending;
  const f = await fixture(t, { handler: async url => { if (url.endsWith('/delayed')) { pending = true; await gate; return json({ secret: 'stale' }); } } });
  await f.manager.signIn(); const reply = f.manager.authenticatedRequest('/delayed'); const rejected = assert.rejects(reply, { code: 'cancelled' });
  while (!pending) await new Promise(resolve => setImmediate(resolve));
  await f.manager.signOut(); release(); await rejected; assert.equal(f.manager.status().authenticated, false);
  await assert.rejects(fs.access(path.join(f.root, 'managed-session.json')));
});
test('account change during sign-in invalidates work and closes authenticated sockets', async t => {
  const f = await fixture(t); await f.manager.signIn(); let closed = false;
  await f.manager.openAuthenticatedSocket('wss://api.example/speech', (url, options) => { assert.match(options.headers.Authorization, /^Bearer /); return { close: () => { closed = true; }, once: () => {} }; });
  // A new sign-in cancels old account work before the browser can switch account.
  f.state.subject = 'user-2'; await f.manager.signIn();
  assert.equal(closed, true); assert.equal(f.manager.status().account.subject, 'user-2');
  await assert.rejects(f.manager.openAuthenticatedSocket('wss://attacker.example/speech', () => assert.fail()), { code: 'invalid_request' });
});
test('account change discovered by refresh discards the old account request', async t => {
  const f = await fixture(t); f.state.expiresIn = 1; await f.manager.signIn();
  f.state.subject = 'user-2'; f.state.expiresIn = 3600;
  await assert.rejects(f.manager.authenticatedRequest('/v1/me'), { code: 'cancelled' });
  assert.equal(f.manager.status().account.subject, 'user-2');
  assert.equal(f.manager.status().authenticated, true);
});
test('sign-out while refresh is pending cannot resurrect access or encrypted refresh', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { handler: async (url, init) => {
    if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
      entered(); await gate; return json({ access_token: 'STALE-ACCESS', refresh_token: 'STALE-REFRESH', token_type: 'Bearer', expires_in: 3600 });
    }
  } });
  f.state.expiresIn = 1; await f.manager.signIn();
  const reply = f.manager.authenticatedRequest('/v1/me'); const rejection = assert.rejects(reply, { code: 'cancelled' });
  await started; await f.manager.signOut(); release(); await rejection;
  assert.equal(f.manager.status().authenticated, false); await assert.rejects(fs.access(path.join(f.root, 'managed-session.json')));
});
test('cancelAll stops an active answer upstream and discards late chunks while staying signed in', async t => {
  let streamController, started; const ready = new Promise(resolve => { started = resolve; }); let cancelled = false;
  const f = await fixture(t, { handler: (url) => {
    if (url.endsWith('/v1/answers')) return json({ id: 'active_request' }, 202);
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(Buffer.from('id: 1\nevent: delta\ndata: {"text":"first"}\n\n')); }, cancel() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (url.endsWith('/cancel')) { cancelled = true; return json({ status: 'cancelled' }); }
  } });
  await f.manager.signIn(); const chunks = [];
  const answer = f.manager.answer({ text: 'hi' }, text => { chunks.push(text); started(); }); const rejected = assert.rejects(answer, { code: 'cancelled' });
  await ready; f.manager.cancelAll(); streamController.enqueue(Buffer.from('id: 2\nevent: delta\ndata: {"text":"stale"}\n\n')); streamController.close(); await rejected;
  assert.deepEqual(chunks, ['first']); assert.equal(cancelled, true); assert.equal(f.manager.status().authenticated, true);
});
test('SSE handles CRLF frames split between chunks', async () => {
  const chunks = ['id: 1\r', '\nevent: delta\r\ndata: {"text":"hi"}\r', '\n\r', '\n'];
  const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(Buffer.from(chunk)); controller.close(); } });
  const output = []; for await (const event of events(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))) output.push(event);
  assert.deepEqual(output, [{ id: '1', event: 'delta', data: { text: 'hi' } }]);
});
test('ambiguous submit retries keep one idempotency key and never duplicate output', async t => {
  const keys = [];
  const f = await fixture(t, { handler: (url, init) => {
    if (url.endsWith('/v1/answers')) { keys.push(init.headers['Idempotency-Key']); if (keys.length === 1) throw new Error('response lost'); return json({ id: 'retry_request' }, 202); }
    if (url.endsWith('/events')) return new Response('id: 1\nevent: completed\ndata: {"text":"Once"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  await f.manager.signIn(); assert.equal((await f.manager.answer({ text: 'hi' })).text, 'Once'); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
});


test('cancelling a scoped setup answer preserves concurrent chat work and the session', async t => {
  const streams = new Map();
  const f = await fixture(t, { handler: (url, init) => {
    if (url.endsWith('/v1/answers')) return json({ id: JSON.parse(init.body).text === 'setup' ? 'setup_1' : 'chat_1' }, 202);
    if (url.endsWith('/events')) {
      const id = url.includes('/setup_1/') ? 'setup_1' : 'chat_1';
      return new Response(new ReadableStream({ start(controller) {
        streams.set(id, controller);
        init.signal.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch (_) {} }, { once: true });
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
  } });
  await f.manager.signIn();
  const controller = new AbortController();
  const setup = f.manager.answerScoped({ text: 'setup', provider: 'gemini' }, { signal: controller.signal });
  const rejected = assert.rejects(setup, { code: 'cancelled' });
  const chat = f.manager.answer({ text: 'chat', provider: 'gemini' });
  for (let tries = 0; streams.size < 2 && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(streams.size, 2);
  controller.abort();
  await rejected;
  streams.get('chat_1').enqueue(new TextEncoder().encode('id: 1\nevent: completed\ndata: {"text":"chat remains active"}\n\n'));
  assert.equal((await chat).text, 'chat remains active');
  assert.equal(f.manager.status().authenticated, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.state.requests.some(r => r.url.endsWith('/setup_1/cancel')));
  assert.ok(!f.state.requests.some(r => r.url.endsWith('/chat_1/cancel')));
});
