'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), { spawnSync } = require('node:child_process');
const windows = process.platform === 'win32';
for (const scenario of ['valid-0', 'valid-1', 'valid-9', 'wrong-time', 'wrong-path', 'wrong-session', 'unknown-qa', 'missing-path', 'missing-command']) {
  test(`real launcher Stop boundary: ${scenario}`, { skip: !windows, timeout: 15000 }, () => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'stop-case.ps1'), '-Scenario', scenario];
    if (process.env.NOCATCH_QA_SOURCE) args.push('-Source', process.env.NOCATCH_QA_SOURCE);
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 12000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp('PASS ' + scenario));
  });
}
