'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), { spawnSync } = require('node:child_process');
for (const scenario of ['pending', 'ready-hidden', 'ready-visible']) test(`packaged repeated launch: ${scenario}`, { skip: process.platform !== 'win32' }, () => {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'pending-launch-case.ps1'), '-Scenario', scenario];
  if (process.env.NOCATCH_QA_SOURCE) args.push('-Source', process.env.NOCATCH_QA_SOURCE);
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, scenario === 'ready-visible' ? 0 : 2, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp('PASS ' + scenario));
});
