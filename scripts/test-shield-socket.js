#!/usr/bin/env node
/**
 * test-shield-socket.js — automated end-to-end socket IPC test for the Cluely
 * Shield helper.
 *
 *   node scripts/test-shield-socket.js
 *
 * Exercises the REAL Shield.handleCommand path over a live Unix socket, the
 * same code the uid-501 Brain drives before it quits in exam mode. Two phases:
 *
 *   Phase A (token seeded)  — the auth NEGATIVE CONTROL: an unauthenticated
 *                             mutating command must be rejected, while the
 *                             token-carrying command is accepted and persisted.
 *   Phase B (no token)      — the FAIL-CLOSED control: with no token seeded,
 *                             every mutating command must be rejected too
 *                             (a world-writable socket must not give LDB a
 *                             no-token configure/quit path).
 *
 * Exits non-zero on the first failed assertion. Cleans up the socket file and
 * test directory on both success and failure.
 */

const { execFileSync, spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const HELPER = path.join(REPO, 'shield', 'shield');
const SOCKET = '/tmp/cluely-shield.sock';
const TEST_DIR = '/tmp/cluely-shield-test';
const CONFIG = path.join(TEST_DIR, 'socket-config.json');
const TOKEN = 'test-token-' + Date.now().toString(36);

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log('  PASS  ' + msg);
  } else {
    failures++;
    console.error('  FAIL  ' + msg);
  }
}

/** Send one newline-delimited JSON command and resolve its reply. */
function send(cmd) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: SOCKET });
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('socket timeout'));
    }, 5000);
    sock.on('connect', () => sock.write(JSON.stringify(cmd) + '\n'));
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        sock.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function waitForSocket(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(SOCKET)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('socket never appeared at ' + SOCKET);
}

/** Write the test config (overwrites any previous one). */
function writeConfig(obj) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(obj));
  try {
    fs.unlinkSync(SOCKET);
  } catch (_) {
    /* no stale socket — fine */
  }
}

/** Spawn the helper in --socket-test mode; resolve once the socket is live. */
async function startHelper() {
  const child = spawn(HELPER, ['--socket-test'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('error', (e) => {
    // Surface spawn failures (e.g. missing binary) instead of an unhandled
    // 'error' event crashing the process.
    console.error('  ERROR  helper spawn failed:', e.message);
    process.exit(1);
  });
  await waitForSocket();
  return child;
}

async function stopHelper(child) {
  try {
    child.kill('SIGKILL');
  } catch (_) {
    /* already gone */
  }
  // Let the socket file unlink settle (helper's runLoop unlinks on exit).
  await new Promise((r) => setTimeout(r, 150));
}

async function main() {
  console.log('== build shield helper ==');
  execFileSync('bash', ['scripts/build-shield.sh'], { cwd: REPO, stdio: 'inherit' });

  // ── Phase A: token seeded — auth negative control + persistence ─────────
  console.log('== Phase A: token seeded ==');
  writeConfig({ token: TOKEN, apiKey: 'seed-key', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
  let child = await startHelper();

  const p1 = await send({ cmd: 'ping' });
  check(p1 && p1.ok === true, 'ping (no auth) -> ok');

  const unauth = await send({ cmd: 'configure', apiKey: 'evil-key', model: 'deepseek-flash' });
  check(
    unauth && unauth.ok === false && /unauthoriz/i.test(String(unauth.error)),
    'configure WITHOUT token -> rejected "unauthorized" (NEGATIVE CONTROL)'
  );

  const auth = await send({ cmd: 'configure', token: TOKEN, apiKey: 'real-key', model: 'deepseek-flash', examMode: true });
  check(auth && auth.ok === true, 'configure WITH token -> ok');

  const p2 = await send({ cmd: 'ping' });
  check(p2 && p2.ok === true && p2.examMode === true, 'ping after configure -> examMode:true');

  await send({ cmd: 'quit', token: TOKEN }).catch(() => {});
  await stopHelper(child);

  let persisted = null;
  try {
    persisted = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (_) {
    /* handled below */
  }
  check(persisted && persisted.token === TOKEN, 'persisted config keeps token');
  check(persisted && persisted.apiKey === 'real-key', 'persisted config has apiKey');
  check(persisted && persisted.examMode === true, 'persisted config has examMode:true');

  // ── Phase B: no token seeded — fail-closed control ──────────────────────
  console.log('== Phase B: no token seeded ==');
  writeConfig({ apiKey: 'seed-key', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
  child = await startHelper();

  const pb1 = await send({ cmd: 'ping' });
  check(pb1 && pb1.ok === true, 'ping (no auth, no token) -> ok');

  const failClosed = await send({ cmd: 'configure', apiKey: 'evil-key', model: 'deepseek-flash' });
  check(
    failClosed && failClosed.ok === false && /no token/i.test(String(failClosed.error)),
    'configure with NO token seeded -> rejected "no token configured" (FAIL-CLOSED)'
  );

  const failClosedQuit = await send({ cmd: 'quit' });
  check(
    failClosedQuit && failClosedQuit.ok === false && /no token/i.test(String(failClosedQuit.error)),
    'quit with NO token seeded -> rejected (FAIL-CLOSED)'
  );

  await stopHelper(child);

  // ── cleanup (success AND failure paths) ─────────────────────────────────
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (_) {
    /* best-effort */
  }
  try {
    fs.unlinkSync(SOCKET);
  } catch (_) {
    /* already gone */
  }

  console.log('');
  if (failures === 0) {
    console.log('SHIELD_SOCKET_TEST OK');
    process.exit(0);
  }
  console.error(`SHIELD_SOCKET_TEST FAIL (${failures} assertion(s))`);
  process.exit(1);
}

main().catch((e) => {
  console.error('SHIELD_SOCKET_TEST ERROR:', e.message);
  process.exit(1);
});
