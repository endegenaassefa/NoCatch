'use strict';
// Independent acceptance tracer: execute the complete production entrypoint.
// Electron and filesystem are host boundaries. FirstRunManager construction is
// an observation AFTER admission; controller construction runs unchanged. Readiness is held at Electron host boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ROOT = process.env.NOCATCH_QA_SOURCE || path.resolve(__dirname, '../..');
const net = require('node:net');
let scope = 100000000 + process.pid * 20;
const hostWindows = process.platform === 'win32';
const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');


function desktop(t, { probeFailure = false } = {}) {
  const sessionId = ++scope, servers = [], sockets = new Set();
  const trackedNet = { ...net, createServer(handler) {
    const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); handler(socket); });
    servers.push(server); return server;
  } };
  t.after(() => { for (const socket of sockets) socket.destroy(); for (const server of servers) { try { server.close(); } catch {} } });
  const electronLocks = new Set();
  const launches = [];
  function launch({ integrity = 'medium', profile = 'screen-reader-util', playground = false, isolatedQA = false } = {}) {
    const appData = 'C:\\Users\\QA\\AppData\\Roaming';
    let userData = path.win32.join(appData, profile);
    const run = { integrity, requestedProfile: profile, admitted: false, quit: false, electronLockPaths: [], dialogs: [], servicesLoaded: [] };
    const pendingReady = new Promise(() => {});
    launches.push(run);
    const app = Object.assign(new EventEmitter(), {
      isPackaged: true,
      commandLine: { appendSwitch() {}, getSwitchValue: key => key === 'user-data-dir' ? userData : '' },
      getName: () => 'screen-reader-util',
      getPath: name => name === 'appData' ? appData : userData,
      setPath: (_name, value) => { userData = value; },
      disableHardwareAcceleration() {},
      requestSingleInstanceLock() {
        // Electron's public contract scopes its singleton to userData.
        run.electronLockPaths.push(userData);
        if (electronLocks.has(userData.toLowerCase())) return false;
        electronLocks.add(userData.toLowerCase());
        return true;
      },
      quit() { run.quit = true; }, setName() {},
      whenReady() { return run.admitted ? pendingReady : Promise.resolve(); },
    });
    const inert = {};
    const fixtureFs = {
      mkdirSync() {}, existsSync: p => p.endsWith('.sru-firstrun-completed'),
      copyFileSync() {}, writeFileSync() {}, appendFileSync() {},
      readFileSync(p) { throw new Error('Fixture denies reading any configuration: ' + p); },
    };
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const processFixture = Object.assign(new EventEmitter(), {
      platform: 'win32', env: {}, argv: ['screen-reader-util.exe', ...(playground ? ['--ingestion-playground'] : []), ...(isolatedQA ? ['--cluely-qa-instance'] : [])],
      cwd: () => 'C:\\fixture', pid: 10000 + launches.length,
    });
    const fixtureRequire = id => {
      if (id === 'path' || id === 'node:path') return path.win32;
      if (id === 'fs' || id === 'node:fs') return fixtureFs;
      if (id === 'url') return require('node:url');
      if (id === 'os') return { homedir: () => 'C:\\Users\\QA' };
      if (id === 'electron') return { app, ipcMain: { handle() {}, on() {} }, dialog: { async showMessageBox(options) { run.dialogs.push(options); } } };
      if (id === 'dotenv') return { config() {} };
      if (id === './src/platform/privilege') return {
        detect: () => ({ isRoot: integrity !== 'medium', integrity, platform: 'win32' }),
        rootDataDir: () => 'C:\\ProgramData\\CluelyRoot',
      };
      if (id === './src/playground/profile') return require(path.join(ROOT, 'src/playground/profile.js'));
      if (id === './src/core/logger') return { createServiceLogger: () => logger };
      if (id === './src/core/config') return { get() {} };
      if (id === './src/core/first-run') return class FirstRunBoundary {
        constructor() { run.admitted = true; run.profile = userData; }
        getStatus() { return { sentinelExists: true }; }
      };
      if (id === './src/platform/windows-instance') {
        const module = { exports: {} }, filename = path.join(ROOT, 'src/platform/windows-instance.js');
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
          process: processFixture, Buffer, setTimeout, clearTimeout,
          require(dependency) {
            if (dependency === 'node:net') return trackedNet;
            if (dependency === 'node:path') return path.win32;
            if (dependency === 'node:child_process') return { execFileSync() { if (probeFailure) throw new Error('Session probe denied'); return String(sessionId); } };
            throw new Error('Unconfigured ownership host dependency: ' + dependency);
          }
        }, { filename });
        return module.exports;
      }
      if (id === './src/managed') return { createManagedManager: () => ({}) };
      if (id === './src/core/setup-service') return { SetupService: class {} };
      if (id === './src/core/setup-direct-answer') return { createDirectSetupAnswer() {} };
      if (id === './src/services/managed-routing') return { attachManagedSession() {} };
      if (id === './src/core/renderer-audio-session') return { RendererAudioSession: class {} };
      if (id === './src/services/speech.service') { run.servicesLoaded.push(id); return Object.assign(new EventEmitter(), { setRendererCapture() {} }); }
      if (id.startsWith('./src/services/')) run.servicesLoaded.push(id);
      if (/^\.\/src\/(capture-routing|services\/|core\/(renderer-audio-session|microphone-owner|trusted-renderer|setup-service|setup-direct-answer)|managers\/|managed$|materials$)/.test(id)) return inert;
      throw new Error('Unconfigured external boundary: ' + id);
    };
    vm.runInNewContext(source, { require: fixtureRequire, process: processFixture,
        __dirname: ROOT, __filename: path.join(ROOT, 'main.js'), console, Buffer,
        setTimeout, clearTimeout, setInterval, clearInterval }, { filename: path.join(ROOT, 'main.js') });
    return run;
  }
  return { launch, launches };
}


async function settled(run) {
  const deadline = Date.now() + 5000;
  while (!run.admitted && !run.quit) {
    if (Date.now() >= deadline) throw new Error('Main startup did not settle: ' + JSON.stringify(run));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // Flush controller registration and pipe response callbacks before asserting.
  await new Promise(resolve => setTimeout(resolve, 10));
  return run;
}
const options = { skip: !hostWindows, timeout: 15000 };
test('ordinary repeated launch admits one owner (harness calibration)', options, async t => {
  const d = desktop(t);
  assert.equal((await settled(d.launch())).admitted, true);
  const duplicate = await settled(d.launch());
  assert.equal(duplicate.admitted, false); assert.equal(duplicate.quit, true);
  assert.deepEqual(duplicate.servicesLoaded, [], 'loser must not initialize services');
});
for (const [first, second] of [['medium', 'high'], ['system', 'medium'], ['high', 'system']]) {
  test(`${first} then ${second} cannot admit two production owners`, options, async t => {
    const d = desktop(t);
    await settled(d.launch({ integrity: first }));
    const duplicate = await settled(d.launch({ integrity: second }));
    assert.equal(d.launches.filter(x => x.admitted).length, 1, JSON.stringify(d.launches));
    assert.deepEqual(duplicate.servicesLoaded, [], 'loser must not initialize services');
    assert(duplicate.dialogs.some(x => /already open/i.test(x.title) && /existing session stays open/i.test(x.detail)), 'mode conflict must explain preserved owner and mode switching');
  });
}
test('arbitrary ordinary profile does not bypass production ownership', options, async t => {
  const d = desktop(t); await settled(d.launch());
  const second = await settled(d.launch({ profile: 'Different-Ordinary-Profile' }));
  assert.equal(second.admitted, false); assert.deepEqual(second.servicesLoaded, []);
});
test('intentional ingestion playground retains independent admission', options, async t => {
  const d = desktop(t);
  assert.equal((await settled(d.launch())).admitted, true);
  assert.equal((await settled(d.launch({ profile: 'NoCatch-Ingestion-Playground', playground: true }))).admitted, true);
});
test('eight simultaneous whole-main starts admit one controller', options, async t => {
  const d = desktop(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => settled(d.launch({ profile: 'Ordinary-' + i }))));
  assert.equal(results.filter(x => x.admitted).length, 1, JSON.stringify(results));
  for (const loser of results.filter(x => !x.admitted)) assert.deepEqual(loser.servicesLoaded, []);
});

test('explicit unelevated QA launch retains independent admission', options, async t => {
  const d = desktop(t); await settled(d.launch());
  assert.equal((await settled(d.launch({ profile: 'Deliberate-QA', isolatedQA: true }))).admitted, true);
});
test('elevated launches cannot use QA flag to bypass production ownership', options, async t => {
  const d = desktop(t); await settled(d.launch());
  const second = await settled(d.launch({ integrity: 'high', profile: 'Deliberate-QA', isolatedQA: true }));
  assert.equal(second.admitted, false); assert.deepEqual(second.servicesLoaded, []);
});
test('separate sessions get separate elevated Chromium profiles and ownership', options, async t => {
  const a = desktop(t), b = desktop(t);
  const one = await settled(a.launch({ integrity: 'high' }));
  const two = await settled(b.launch({ integrity: 'high' }));
  assert(one.admitted && two.admitted); assert.notEqual(one.profile, two.profile);
});
test('failed session identity probe denies startup before services with visible explanation', options, async t => {
  const d = desktop(t, { probeFailure: true });
  const run = await settled(d.launch());
  assert.equal(run.admitted, false); assert.deepEqual(run.servicesLoaded, []);
  assert(run.dialogs.some(x => x.type === 'error' && /could not start/i.test(x.title)));
});
