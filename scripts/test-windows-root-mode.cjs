'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function privilegeFixture({ platform = 'win32', uid, whoami, env = {} } = {}) {
  const calls = [];
  const processStub = { platform, env };
  if (uid !== undefined) processStub.getuid = () => uid;
  const module = { exports: {} };
  const context = {
    module,
    process: processStub,
    require(id) {
      assert.equal(id, 'node:child_process');
      return {
        spawnSync(command, args, options) {
          calls.push({ command, args, options });
          if (whoami instanceof Error) throw whoami;
          return whoami || { status: 1, stdout: '' };
        },
      };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/platform/privilege.js'), 'utf8'), context);
  return { privilege: module.exports, calls };
}

test('Windows root mode follows the actual token integrity SID', () => {
  for (const [sid, expectedRoot, expectedIntegrity] of [
    ['S-1-16-12288', true, 'high'],
    ['S-1-16-16384', true, 'system'],
    ['S-1-16-8192', false, 'medium'],
    ['S-1-16-8448', false, 'medium-plus'],
    ['S-1-16-4096', false, 'low'],
  ]) {
    const { privilege, calls } = privilegeFixture({
      env: { CLUELY_ROOT_EXAM: '1' },
      whoami: { status: 0, stdout: `Mandatory Label\\Token ${sid} Enabled` },
    });
    const result = privilege.detect();
    assert.equal(result.isRoot, expectedRoot, sid);
    assert.equal(result.integrity, expectedIntegrity, sid);
    assert.equal(result.platform, 'win32');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'whoami');
    assert.equal(Array.from(calls[0].args).join(' '), '/groups');
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(privilege.detect(), result, 'privilege evidence should be cached for the process');
    assert.equal(calls.length, 1);
  }
});

test('Windows token probe failure fails closed despite a root-mode environment hint', () => {
  for (const whoami of [
    { status: 1, stdout: 'S-1-16-12288' },
    { status: 0, stdout: 'no integrity label' },
    { status: 0, stdout: 'Mandatory Label S-1-16-122880 Enabled' },
    new Error('whoami unavailable'),
  ]) {
    const { privilege } = privilegeFixture({ env: { CLUELY_ROOT_EXAM: '1' }, whoami });
    const result = privilege.detect();
    assert.equal(result.isRoot, false);
    assert.equal(result.integrity, 'unknown');
  }
});

test('integrity parsing requires an exact SID boundary', () => {
  const { privilege } = privilegeFixture();
  assert.equal(privilege.parseWindowsIntegrity('S-1-16-122880'), 'unknown');
  assert.equal(privilege.parseWindowsIntegrity('S-1-16-12288-1'), 'unknown');
  assert.equal(privilege.parseWindowsIntegrity('S-1-16-163840'), 'unknown');
  assert.equal(privilege.parseWindowsIntegrity('S-1-16-12288 Enabled'), 'high');
});

test('Unix root mode keeps the uid-zero behavior', () => {
  for (const [platform, uid, isRoot] of [
    ['darwin', 0, true], ['linux', 0, true], ['darwin', 501, false],
  ]) {
    const { privilege, calls } = privilegeFixture({ platform, uid });
    assert.equal(privilege.detect().isRoot, isRoot);
    assert.equal(calls.length, 0, 'Unix detection should not run whoami');
  }
});

function startupFixture(sid, { failRootProfile = false, hasNormalSentinel = true,
  normalSetupState, rootSetupState } = {}) {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const endMarker = 'require("dotenv").config({ path: ENV_PATH });';
  const end = main.indexOf(endMarker);
  assert.notEqual(end, -1, 'main startup must load dotenv after choosing the profile');
  const startup = main.slice(0, end + endMarker.length);
  const events = [];
  const normalData = 'C:\\Users\\Jane\\AppData\\Roaming\\screen-reader-util';
  const normalSentinelPath = path.win32.join(normalData, '.sru-firstrun-completed');
  const rootData = 'C:\\ProgramData\\CluelyRoot\\sessions\\7\\userdata';
  const normalSetupPath = path.win32.join(normalData, 'setup-state.json');
  const rootSetupPath = path.win32.join(rootData, 'setup-state.json');
  let userData = normalData;
  const app = {
    isPackaged: true,
    getName: () => 'screen-reader-util',
    getPath(name) {
      if (name === 'appData') return path.win32.dirname(normalData);
      if (name === 'userData') return userData;
      throw new Error(`unexpected path: ${name}`);
    },
    setPath(name, value) {
      assert.equal(name, 'userData');
      userData = value;
      events.push(['setPath', value]);
    },
  };
  const files = new Map();
  if (hasNormalSentinel) files.set(normalSentinelPath, 'completed');
  if (normalSetupState !== undefined) files.set(normalSetupPath, normalSetupState);
  if (rootSetupState !== undefined) files.set(rootSetupPath, rootSetupState);
  const fakeFs = {
    mkdirSync(value) {
      events.push(['mkdir', value]);
      if (failRootProfile) throw new Error('profile cannot be created');
    },
    existsSync(value) { return files.has(value); },
    statSync(value) {
      if (files.has(value)) return { size: Buffer.byteLength(files.get(value)) };
      throw Object.assign(new Error(`missing file: ${value}`), { code: 'ENOENT' });
    },
    readFileSync(value) {
      if (files.has(value)) return files.get(value);
      throw Object.assign(new Error(`missing file: ${value}`), { code: 'ENOENT' });
    },
    writeFileSync(value, contents) { events.push(['write', value, contents]); files.set(value, contents); },
    copyFileSync(from, to) { events.push(['copy', from, to]); files.set(to, files.get(from)); },
  };
  const { privilege } = privilegeFixture({ whoami: { status: 0, stdout: `Mandatory Label ${sid}` } });
  const context = vm.createContext({
    process: { platform: 'win32', cwd: () => 'C:\\repo' },
    require(id) {
      if (id === 'path') return path.win32;
      if (id === 'fs') return fakeFs;
      if (id === 'url') return { fileURLToPath() {} };
      if (id === 'electron') return { app };
      if (id === './src/capture-routing') return {};
      if (id === './src/platform/privilege') return privilege;
      if (id === './src/platform/windows-instance') return { currentSessionId: () => 7 };
      if (id === 'dotenv') return { config({ path: envPath }) { events.push(['dotenv', envPath]); } };
      throw new Error(`unexpected startup dependency: ${id}`);
    },
  });
  if (failRootProfile) {
    assert.throws(() => vm.runInContext(startup, context, { filename: 'main.js' }), /profile cannot be created/);
  } else {
    vm.runInContext(startup, context, { filename: 'main.js' });
  }
  return { events, files, userData, normalData, rootData, normalSetupPath, rootSetupPath };
}

test('elevated Windows startup selects the root profile before loading .env', () => {
  const { events, userData, normalData, rootData } = startupFixture('S-1-16-12288');
  assert.equal(userData, rootData);
  assert.deepEqual(events.map(event => event[0]), ['mkdir', 'setPath', 'copy', 'dotenv']);
  assert.deepEqual(events[2].slice(1), [
    path.win32.join(normalData, '.sru-firstrun-completed'),
    path.win32.join(rootData, '.sru-firstrun-completed'),
  ]);
  assert.equal(events[3][1], path.win32.join(rootData, '.env'));
});

test('ordinary Windows startup leaves the normal profile selected', () => {
  const { events, userData, normalData } = startupFixture('S-1-16-8192');
  assert.equal(userData, normalData);
  assert.deepEqual(events, [['dotenv', path.win32.join(normalData, '.env')]]);
});

test('elevated Windows startup aborts if its root profile cannot be initialized', () => {
  const { events, userData, normalData } = startupFixture('S-1-16-12288', { failRootProfile: true });
  assert.equal(userData, normalData);
  assert.deepEqual(events.map(event => event[0]), ['mkdir']);
});

test('completed normal setup migrates minimal completion to the root profile without a legacy sentinel', () => {
  const normalState = JSON.stringify({ version: 1, completed: true, step: 'complete',
    draft: '', inputMode: 'screenshot', token: 'do-not-copy' });
  const { events, files, normalSetupPath, rootSetupPath } = startupFixture('S-1-16-12288', {
    hasNormalSentinel: false, normalSetupState: normalState,
  });
  assert.equal(files.get(normalSetupPath), normalState, 'normal setup must remain untouched');
  assert.deepEqual(JSON.parse(files.get(rootSetupPath)), {
    version: 1, completed: true, step: 'complete', draft: '', inputMode: 'text',
  });
  assert.equal(events.filter(event => event[0] === 'write' && event[1] === rootSetupPath).length, 1);
  assert.equal(events.at(-1)[0], 'dotenv', 'setup migration must finish before config loads');
});

test('incomplete normal setup does not claim root setup completion', () => {
  const normalState = JSON.stringify({ version: 1, completed: false, step: 'question',
    draft: 'unfinished question', inputMode: 'text' });
  const { events, files, rootSetupPath } = startupFixture('S-1-16-12288', {
    hasNormalSentinel: false, normalSetupState: normalState,
  });
  assert.equal(files.has(rootSetupPath), false);
  assert.equal(events.some(event => event[0] === 'write' && event[1] === rootSetupPath), false);
});

test('an existing root setup state is left untouched during migration', () => {
  const normalState = JSON.stringify({ version: 1, completed: true, step: 'complete', draft: '', inputMode: 'text' });
  const rootState = JSON.stringify({ version: 1, completed: false, step: 'question', draft: 'root work', inputMode: 'screenshot' });
  const { events, files, rootSetupPath } = startupFixture('S-1-16-12288', {
    hasNormalSentinel: false, normalSetupState: normalState, rootSetupState: rootState,
  });
  assert.equal(files.get(rootSetupPath), rootState);
  assert.equal(events.some(event => event[0] === 'write' && event[1] === rootSetupPath), false);
});
