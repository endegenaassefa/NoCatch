'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { fork } = require('node:child_process');
const ROOT = process.env.NOCATCH_QA_SOURCE || path.resolve(__dirname, '../..');
const modulePath = path.join(ROOT, 'src/platform/windows-instance.js');
const api = require(modulePath);
const supported = process.platform === 'win32';
let sequence = 0;
const namespace = () => 100000000 + process.pid * 20 + sequence++;
function fixture(t) {
  const children = [];
  t.after(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
    await Promise.all(children.map(c => c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise(r => c.once('exit', r))));
  });
  function start(sessionId, integrity = 'medium') {
    const c = fork(path.join(__dirname, 'pipe-worker.cjs'), [modulePath, JSON.stringify({ sessionId, integrity })], { silent: true, windowsHide: true });
    children.push(c); c.messages = []; c.stderrText = '';
    c.stderr.on('data', x => { c.stderrText += x; });
    c.on('message', message => { c.messages.push(message); });
    c.wait = event => new Promise((resolve, reject) => {
      const existing = c.messages.find(m => m.event === event);
      if (existing) return resolve(existing);
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for ' + event + ': ' + c.stderrText)); }, 15000);
      const receive = message => { if (message.event === event) { cleanup(); resolve(message); } else if (message.event === 'error') { cleanup(); reject(new Error(JSON.stringify(message))); } };
      const failed = error => { cleanup(); reject(error); };
      function cleanup() { clearTimeout(timeout); c.off('message', receive); c.off('error', failed); }
      c.on('message', receive); c.on('error', failed);
    });
    return c;
  }
  return { start };
}

test('real Windows named pipe admits exactly one of eight concurrent processes', { skip: !supported, timeout: 30000 }, async t => {
  const f = fixture(t), session = namespace();
  const children = Array.from({ length: 8 }, (_, i) => f.start(session, ['medium', 'high', 'system'][i % 3]));
  const results = await Promise.all(children.map(c => c.wait('admission')));
  const winners = results.filter(r => r.acquired);
  assert.equal(winners.length, 1, JSON.stringify(results));
  for (const loser of results.filter(r => !r.acquired)) {
    assert.equal(loser.owner.pid, winners[0].pid);
    assert.equal(loser.owner.mode, winners[0].mode);
    assert.equal(loser.owner.ready, false);
  }
});

test('owner reports live ready state and only activates on supported request', { skip: !supported, timeout: 30000 }, async t => {
  const f = fixture(t), session = namespace(), c = f.start(session, 'system');
  const admitted = await c.wait('admission'); assert.equal(admitted.acquired, true);
  let status = await api.requestOwner(api.pipeName(session), 'status');
  assert.equal(status.pid, c.pid); assert.equal(status.mode, 'system'); assert.equal(status.ready, false);
  assert.equal(c.messages.some(m => m.event === 'activated'), false);
  c.send('ready'); await c.wait('ready');
  status = await api.requestOwner(api.pipeName(session), 'activate');
  await c.wait('activated'); assert.equal(status.ready, true);
  await assert.rejects(api.requestOwner(api.pipeName(session), 'shutdown'));
  assert.equal((await api.requestOwner(api.pipeName(session), 'status')).pid, c.pid, 'unsupported shutdown must preserve owner');
});

test('forced owner exit releases Windows pipe and permits retry', { skip: !supported, timeout: 30000 }, async t => {
  const f = fixture(t), session = namespace(), c = f.start(session);
  assert.equal((await c.wait('admission')).acquired, true);
  const exited = new Promise(resolve => c.once('exit', resolve)); c.kill(); await exited;
  const retry = f.start(session, 'high');
  assert.equal((await retry.wait('admission')).acquired, true);
});

test('distinct session scopes coexist without suppressing each other', { skip: !supported, timeout: 30000 }, async t => {
  const f = fixture(t), a = f.start(namespace()), b = f.start(namespace(), 'system');
  assert.equal((await a.wait('admission')).acquired, true);
  assert.equal((await b.wait('admission')).acquired, true);
});

test('unresponsive existing pipe prevents admitting a replacement', { skip: !supported, timeout: 15000 }, async t => {
  const session = namespace(), endpoint = api.pipeName(session), sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  await assert.rejects(api.acquire({ sessionId: session, integrity: 'medium', onActivate() {}, isReady: () => true }), /respond|timed|EACCES|EPERM/i);
});

test('session probe identifies an interactive Windows session', { skip: !supported }, () => {
  const session = api.currentSessionId();
  assert(Number.isSafeInteger(session) && session > 0);
});
