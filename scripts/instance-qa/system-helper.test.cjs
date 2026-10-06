'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
test('SYSTEM helper compiles and preserves JSON without launching', { skip: process.platform !== 'win32', timeout: 20000 }, () => {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'system-helper-json.ps1')];
  if (process.env.NOCATCH_QA_SOURCE) args.push('-Source', process.env.NOCATCH_QA_SOURCE);
  try {
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const proof = JSON.parse(result.stdout);
    for (const field of ['compiled', 'escapedPaths', 'quotedArguments', 'invokingSession', 'environmentStrings']) assert.equal(proof[field], true);
    assert.equal(proof.rejectedMalformed, 5); assert.equal(proof.launched, false);
  } finally { fs.rmSync(path.join(__dirname, 'SystemLauncher.QA.exe'), { force: true }); }
});
