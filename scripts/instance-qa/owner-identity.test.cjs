'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), { fork, spawn } = require('node:child_process');
let serial = 0;
for (const scenario of ['system-denied-token', 'native-system', 'native-normal', 'normal-sid', 'missing-sid', 'sid-failure', 'sid-query-error', 'missing-process', 'wrong-image', 'wrong-session', 'wrong-pid', 'bad-ready', 'unknown-administrator', 'missing-image', 'exited-peer', 'peer-exits-during-sid']) {
  test(`actual pipe owner verification: ${scenario}`, { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
    const sessionId = 200000000 + process.pid * 20 + serial++;
    const peer = fork(path.join(__dirname, 'owner-peer.cjs'), [JSON.stringify({ sessionId,
      wrongPid: scenario === 'wrong-pid', badReady: scenario === 'bad-ready', mode: scenario === 'unknown-administrator' ? 'administrator' : 'system' })], { silent: true, windowsHide: true });
    t.after(() => { if (peer.exitCode === null) peer.kill(); });
    await new Promise((resolve, reject) => { peer.once('message', resolve); peer.once('error', reject); });
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'owner-identity-case.ps1'), '-Scenario', scenario, '-PeerProcessId', String(peer.pid), '-SessionId', String(sessionId)];
    if (process.env.NOCATCH_QA_SOURCE) args.push('-Source', process.env.NOCATCH_QA_SOURCE);
    const child = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args, { windowsHide: true });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, output); assert.match(output, new RegExp('PASS ' + scenario));
  });
}
