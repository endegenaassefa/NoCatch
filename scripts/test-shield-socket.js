#!/usr/bin/env node
/**
 * test-shield-socket.js — automated end-to-end socket IPC test for the Cluely
 * Shield helper.
 *
 *   node scripts/test-shield-socket.js
 *
 * Exercises the REAL Shield.handleCommand path over a live Unix socket, the
 * same code the uid-501 Brain drives before it quits in exam mode. Phases:
 *
 *   Phase A (token seeded)  — the auth NEGATIVE CONTROL: an unauthenticated
 *                             mutating command must be rejected, while the
 *                             token-carrying command is accepted and persisted.
 *                             Also covers ping.hotkey and the relay-answer
 *                             fallback mirror (authenticated + rejected).
 *   Phase B (no token)      — the FAIL-CLOSED control: with no token seeded,
 *                             every mutating command must be rejected too
 *                             (a world-writable socket must not give LDB a
 *                             no-token configure/quit path).
 *   Phase C (real client)   — drives src/services/shield-client.js
 *                             configureExamMode + relayAnswer directly.
 *
 * Exits non-zero on the first failed assertion. Cleans up the socket file and
 * test directory on both success and failure. Uses --socket to bind a
 * test-owned path, so a root-owned stale production socket (sticky /tmp)
 * can never block the non-root suite.
 */

const { execFileSync, spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const HELPER = path.join(REPO, 'shield', 'shield');
const SOCKET = '/tmp/cluely-shield-test.sock';
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

/** Wait for the helper to actually be LISTENING, via its own SOCKET_READY log. */
async function waitForHelperReady(child, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.stdoutBuf && child.stdoutBuf.includes('SOCKET_READY')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('helper never reached SOCKET_READY');
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

/** Spawn the helper in --socket-test mode; resolve once it is actually listening. */
async function startHelper() {
  const child = spawn(HELPER, ['--socket-test', '--socket', SOCKET], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdoutBuf = '';
  child.stdout.on('data', (d) => { child.stdoutBuf += d.toString(); });
  child.stderr.on('data', (d) => { child.stdoutBuf += d.toString(); });
  child.on('error', (e) => {
    // Surface spawn failures (e.g. missing binary) instead of an unhandled
    // 'error' event crashing the process.
    console.error('  ERROR  helper spawn failed:', e.message);
    process.exit(1);
  });
  // Wait for SOCKET_READY (logged after listen()), not just file existence:
  // the socket file appears at bind() and connecting before listen() yields
  // ECONNREFUSED.
  await waitForHelperReady(child);
  return child;
}

async function stopHelper(child) {
  try {
    child.kill('SIGKILL');
  } catch (_) {
    /* already gone */
  }
  // Wait for the process to actually exit, not a fixed sleep. A SIGKILLed
  // child releases its executable mapping only once reaped; a fixed 150 ms can
  // leave the binary locked and make an immediately-following build fail with
  // "ld: can't write output file" (observed).
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
    setTimeout(resolve, 3000); // safety net in case 'exit' never fires
  });
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
  check(typeof (p1 && p1.hotkey) === 'boolean', 'ping carries hotkey health field (2026-09-19 incident fix)');

  const unauth = await send({ cmd: 'configure', apiKey: 'evil-key', model: 'deepseek-flash' });
  check(
    unauth && unauth.ok === false && /unauthoriz/i.test(String(unauth.error)),
    'configure WITHOUT token -> rejected "unauthorized" (NEGATIVE CONTROL)'
  );

  const auth = await send({ cmd: 'configure', token: TOKEN, apiKey: 'real-key', model: 'deepseek-flash', examMode: true, showWindow: false });
  check(auth && auth.ok === true, 'configure WITH token -> ok');

  const p2 = await send({ cmd: 'ping' });
  check(p2 && p2.ok === true && p2.examMode === true, 'ping after configure -> examMode:true');

  // Seeded relay text (set by the --socket-test seam at startup) BEFORE any
  // relay-answer bumps the sequence.
  const ga = await send({ cmd: 'get-answer', token: TOKEN });
  check(
    ga && ga.ok === true && ga.seq === 1 && ga.text === 'SOCKET_TEST_ANSWER',
    'get-answer WITH token -> returns seeded relay text (seq 1)'
  );

  // ── relay-answer (fallback mirror used by root exam mode) ───────────────
  const unauthRelay = await send({ cmd: 'relay-answer', text: 'leak' });
  check(
    unauthRelay && unauthRelay.ok === false && /unauthoriz/i.test(String(unauthRelay.error)),
    'relay-answer WITHOUT token -> rejected "unauthorized" (NEGATIVE CONTROL)'
  );

  const authRelay = await send({ cmd: 'relay-answer', token: TOKEN, text: 'RELAYED_ANSWER' });
  check(authRelay && authRelay.ok === true, 'relay-answer WITH token -> ok');

  const gaRelay = await send({ cmd: 'get-answer', token: TOKEN });
  check(
    gaRelay && gaRelay.ok === true && gaRelay.seq === 2 && gaRelay.text === 'RELAYED_ANSWER',
    'get-answer after relay -> relayed text surfaced (seq 2)'
  );

  const emptyRelay = await send({ cmd: 'relay-answer', token: TOKEN, text: '' });
  check(
    emptyRelay && emptyRelay.ok === false && /text/i.test(String(emptyRelay.error)),
    'relay-answer with empty text -> rejected'
  );

  const unauthGA = await send({ cmd: 'get-answer' });
  check(
    unauthGA && unauthGA.ok === false && /unauthoriz/i.test(String(unauthGA.error)),
    'get-answer WITHOUT token -> rejected "unauthorized" (NEGATIVE CONTROL)'
  );

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
  check(persisted && persisted.showWindow === false, 'persisted config has showWindow:false');

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

  const failClosedGA = await send({ cmd: 'get-answer' });
  check(
    failClosedGA && failClosedGA.ok === false && /no token/i.test(String(failClosedGA.error)),
    'get-answer with NO token seeded -> rejected (FAIL-CLOSED)'
  );

  const failClosedRelay = await send({ cmd: 'relay-answer', text: 'leak' });
  check(
    failClosedRelay && failClosedRelay.ok === false && /no token/i.test(String(failClosedRelay.error)),
    'relay-answer with NO token seeded -> rejected (FAIL-CLOSED)'
  );

  await stopHelper(child);

  // ── Phase C: the REAL Brain client ──────────────────────────────────────
  // Regression net for the "client silently drops a configure field" class of
  // bug: drive src/services/shield-client.js configureExamMode directly and
  // assert showWindow actually reaches the persisted root config. Also
  // exercises relayAnswer — the root-exam-mode fallback mirror path.
  console.log('== Phase C: real Brain client (showWindow forwarding + relay) ==');
  writeConfig({ token: TOKEN, apiKey: 'seed-key', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
  child = await startHelper();

  process.env.CLUELY_SHIELD_TOKEN = TOKEN;
  // Point the REAL client at the test socket (its path is read at require
  // time, so this must be set before the require below).
  process.env.CLUELY_SHIELD_SOCKET = SOCKET;
  const shieldClient = require(path.join(REPO, 'src', 'services', 'shield-client'));
  const rc = await shieldClient.configureExamMode({
    apiKey: 'client-key',
    model: 'deepseek-flash',
    showWindow: false
  });
  check(rc && rc.ok === true, 'REAL client configureExamMode(showWindow:false) -> ok');

  const rr = await shieldClient.relayAnswer('CLIENT_RELAYED_ANSWER');
  check(rr && rr.ok === true, 'REAL client relayAnswer -> ok');

  const cga = await shieldClient.getAnswer();
  check(
    cga && cga.ok === true && cga.text === 'CLIENT_RELAYED_ANSWER',
    'REAL client getAnswer sees the relayed mirror text'
  );

  await send({ cmd: 'quit', token: TOKEN }).catch(() => {});
  await stopHelper(child);

  let persistedC = null;
  try {
    persistedC = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (_) {
    /* handled below */
  }
  check(persistedC && persistedC.showWindow === false, 'REAL client persisted showWindow:false');
  check(persistedC && persistedC.apiKey === 'client-key', 'REAL client persisted apiKey');

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
