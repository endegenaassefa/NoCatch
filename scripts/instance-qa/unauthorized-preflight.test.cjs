'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), { spawnSync } = require('node:child_process');
for (const mode of ['administrator', 'system']) test(`unreadable existing SYSTEM owner requires authorization before ${mode} launch`, { skip: process.platform !== 'win32' }, () => {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'unauthorized-preflight-case.ps1'), '-RequestedMode', mode];
  if (process.env.NOCATCH_QA_SOURCE) args.push('-Source', process.env.NOCATCH_QA_SOURCE);
  const r = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, new RegExp('PASS ' + mode));
});
