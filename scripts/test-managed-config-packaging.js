const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const yaml = require('js-yaml');
const { validateConfig, loadConfig } = require('../src/managed/config');
const { checkManagedConfig, prepareManagedConfig } = require('./prepare-managed-config');
const beforePack = require('./before-pack');
const afterPack = require('./verify-package');
const { verifyArchive } = afterPack;

const good = {
  issuer: 'https://identity.example.test/tenant/', clientId: 'native-public',
  apiBaseUrl: 'https://api.example.test/v1-base/', audience: 'opencluely-api',
  scopes: ['openid', 'offline_access', 'answers:write'], loopbackPorts: [0, 48151],
};
const runtimeFiles = ['main.js', 'preload.js', 'onboarding.html', 'settings.html', 'chat.html', 'index.html',
  'llm-response.html', 'src/core/first-run.js', 'scripts/whisper_worker.py', 'prompts/programming.md', 'LICENSE'];

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-config-packaging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function writeConfig(root, raw) {
  fs.writeFileSync(path.join(root, 'managed-config.json'), JSON.stringify(raw));
}

async function archiveFixture(t, config, platform = 'win32') {
  const root = temporary(t);
  const source = path.join(root, 'source');
  for (const name of runtimeFiles) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'runtime fixture');
  }
  if (config !== undefined) fs.writeFileSync(path.join(source, 'managed-config.json'), config);
  const resources = platform === 'darwin'
    ? path.join(root, 'screen-reader-util.app', 'Contents', 'Resources')
    : path.join(root, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  const archive = path.join(resources, 'app.asar');
  await asar.createPackage(source, archive);
  t.after(() => asar.uncache(archive));
  return { root, source, archive, resources, context: {
    electronPlatformName: platform, appOutDir: root,
    packager: { projectDir: source, appInfo: { productFilename: 'screen-reader-util' } },
  } };
}

test('public config preserves exact issuer, normalizes API/scopes and returns independent arrays', () => {
  const raw = { ...good, scopes: ['openid', 'openid', 'offline_access'] };
  const result = validateConfig(raw);
  assert.deepEqual(result, { ...raw, configured: true, apiBaseUrl: 'https://api.example.test/v1-base', scopes: ['openid', 'offline_access'] });
  result.scopes.push('changed');
  result.loopbackPorts.push(12345);
  assert.deepEqual(raw.scopes, ['openid', 'openid', 'offline_access']);
  assert.deepEqual(raw.loopbackPorts, [0, 48151]);
  const { loopbackPorts, ...withoutPorts } = good;
  assert.deepEqual(validateConfig(withoutPorts).loopbackPorts, [0]);
  assert.deepEqual(validateConfig({ ...good, loopbackPorts: [1024, 65535] }).loopbackPorts, [1024, 65535]);
});

test('absent, malformed and incomplete configurations are unconfigured with a safe reason', () => {
  for (const raw of [undefined, null, {}, [], 'config', 5, true, { issuer: good.issuer }, { scopes: ['openid'] }]) {
    const result = validateConfig(raw);
    assert.equal(result.configured, false);
    assert.equal(typeof result.reason, 'string');
    assert.deepEqual(Object.keys(result).sort(), ['configured', 'reason']);
  }
});

test('unknown public properties and credential fields reject the whole configuration', () => {
  for (const key of ['clientSecret', 'providerKey', 'apiKey', 'credentials', 'typo', '__proto__', 'constructor', 'configured']) {
    const result = validateConfig(JSON.parse(JSON.stringify({ ...good, [key]: 'NEVER-SHIP-THIS' })));
    assert.equal(result.configured, false, key);
    assert.doesNotMatch(JSON.stringify(result), /NEVER-SHIP-THIS/);
  }
});

test('both deployment URLs require plain HTTPS without credentials, query or fragment', () => {
  const urls = [undefined, null, 42, {}, '', 'http://unsafe.test', 'file:///tmp/config', '//api.example.test',
    'https:api.example.test', 'https://user:NEVER-SHIP-THIS@api.example.test', 'https://user@api.example.test',
    'https://api.example.test?key=NEVER-SHIP-THIS', 'https://api.example.test#fragment',
    'https://api.example.test?', 'https://api.example.test#', ' https://api.example.test',
    'https://api.example.test\n', 'https://api.exa\nmple.test', 'https://api.example.test\\route'];
  for (const key of ['issuer', 'apiBaseUrl']) {
    for (const value of urls) {
      const result = validateConfig({ ...good, [key]: value });
      assert.equal(result.configured, false, `${key}: ${JSON.stringify(value)}`);
      assert.doesNotMatch(JSON.stringify(result), /NEVER-SHIP-THIS/);
    }
  }
});

test('public IDs, scopes and callback ports enforce the existing contract', () => {
  for (const key of ['clientId', 'audience']) {
    for (const value of [undefined, null, 12, {}, '', '  ', 'id\nsecret']) {
      assert.equal(validateConfig({ ...good, [key]: value }).configured, false, key);
    }
  }
  for (const scopes of [null, 'openid', [], ['offline_access'], ['openid', 'bad scope'], ['openid', 'bad"scope'], ['openid', 'bad\\scope'], ['openid', 3], ['openid', , 'offline_access']]) {
    assert.equal(validateConfig({ ...good, scopes }).configured, false);
  }
  for (const loopbackPorts of [null, '0', [], [-1], [1], [1023], [65536], [1024.5], ['1234'], [0, , 3000], Array(9).fill(0)]) {
    assert.equal(validateConfig({ ...good, loopbackPorts }).configured, false);
  }
});

test('packaged loading ignores every development override with and without a file', t => {
  const root = temporary(t);
  const app = { isPackaged: true, getAppPath: () => root };
  const env = {
    NOCATCH_MANAGED_ISSUER: 'https://override.test/', NOCATCH_MANAGED_CLIENT_ID: 'override',
    NOCATCH_MANAGED_API_BASE_URL: 'https://override-api.test', NOCATCH_MANAGED_AUDIENCE: 'override-api',
    NOCATCH_MANAGED_SCOPES: 'openid override:write',
  };
  assert.equal(loadConfig(app, env).configured, false);
  writeConfig(root, good);
  assert.deepEqual(loadConfig(app, env), validateConfig(good));
  assert.deepEqual(loadConfig({ ...app, isPackaged: false }, env), validateConfig({
    issuer: env.NOCATCH_MANAGED_ISSUER, clientId: env.NOCATCH_MANAGED_CLIENT_ID,
    apiBaseUrl: env.NOCATCH_MANAGED_API_BASE_URL, audience: env.NOCATCH_MANAGED_AUDIENCE,
    scopes: ['openid', 'override:write'], loopbackPorts: good.loopbackPorts,
  }));
  fs.unlinkSync(path.join(root, 'managed-config.json'));
  assert.equal(loadConfig({ ...app, isPackaged: false }, env).configured, true);
  fs.writeFileSync(path.join(root, 'managed-config.json'), '{"clientSecret":"NEVER-SHIP-THIS",');
  assert.equal(loadConfig(app, env).configured, false);
  assert.doesNotMatch(JSON.stringify(loadConfig(app, env)), /NEVER-SHIP-THIS/);
});

test('beforePack requires config on every release platform before native compilation', async t => {
  environment(t, { OPENCLUELY_RELEASE: '1' });
  const root = temporary(t);
  for (const platform of ['win32', 'darwin', 'linux']) {
    const context = { electronPlatformName: platform, packager: { projectDir: root } };
    await assert.rejects(() => beforePack(context), /managed-config\.json/);
    writeConfig(root, { ...good, clientSecret: 'NEVER-SHIP-THIS' });
    await assert.rejects(() => beforePack(context), error => /managed-config\.json/.test(error.message) && !error.message.includes('NEVER-SHIP-THIS'));
    fs.unlinkSync(path.join(root, 'managed-config.json'));
  }
  writeConfig(root, good);
  await beforePack({ electronPlatformName: 'linux', packager: { projectDir: root } });
  // A valid public config does not waive the newer required Windows speech bundle.
  await assert.rejects(() => beforePack({ electronPlatformName: 'win32', arch: require('builder-util').Arch.x64, packager: { projectDir: root } }), error => error.code === 'BUNDLED_RUNTIME_MISSING');
});

test('unsigned packaging tolerates absent deployment but rejects an invalid file', async t => {
  environment(t, { OPENCLUELY_RELEASE: '0' });
  const root = temporary(t);
  await beforePack({ electronPlatformName: 'linux', packager: { projectDir: root } });
  // A valid public config does not waive the newer required Windows speech bundle.
  await assert.rejects(() => beforePack({ electronPlatformName: 'win32', arch: require('builder-util').Arch.x64, packager: { projectDir: root } }), error => error.code === 'BUNDLED_RUNTIME_MISSING');
  for (const raw of [{}, { ...good, apiBaseUrl: 'http://unsafe.test' }, { ...good, apiKey: 'NEVER-SHIP-THIS' }]) {
    writeConfig(root, raw);
    await assert.rejects(() => beforePack({ electronPlatformName: 'win32', packager: { projectDir: root } }), /config/);
  }
});

test('release validation cannot be satisfied by development environment values', t => {
  environment(t, {
    OPENCLUELY_RELEASE: '1', NOCATCH_MANAGED_ISSUER: good.issuer, NOCATCH_MANAGED_CLIENT_ID: good.clientId,
    NOCATCH_MANAGED_API_BASE_URL: good.apiBaseUrl, NOCATCH_MANAGED_AUDIENCE: good.audience, NOCATCH_MANAGED_SCOPES: 'openid',
  });
  assert.throws(() => checkManagedConfig(temporary(t)), /config/);
});

test('CI public input validates before writing, preserves issuer and never echoes bad values', t => {
  const root = temporary(t);
  assert.equal(prepareManagedConfig(root, {}).configured, false);
  assert.throws(() => prepareManagedConfig(root, { OPENCLUELY_RELEASE: '1' }), /config/);
  for (const input of ['{"secret":"NEVER-SHIP-THIS",', JSON.stringify({ ...good, providerKey: 'NEVER-SHIP-THIS' })]) {
    assert.throws(() => prepareManagedConfig(root, { OPENCLUELY_MANAGED_CONFIG_JSON: input }), error => /config/.test(error.message) && !error.message.includes('NEVER-SHIP-THIS'));
    assert.equal(fs.existsSync(path.join(root, 'managed-config.json')), false);
  }
  assert.equal(prepareManagedConfig(root, { OPENCLUELY_RELEASE: '1', OPENCLUELY_MANAGED_CONFIG_JSON: JSON.stringify(good) }).issuer, good.issuer);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'managed-config.json'), 'utf8')), good);
  assert.equal(prepareManagedConfig(root, { OPENCLUELY_RELEASE: '1' }).configured, true);
  assert.throws(() => prepareManagedConfig(root, { OPENCLUELY_MANAGED_CONFIG_JSON: '{}' }), /config/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'managed-config.json'), 'utf8')), good);
});

test('archive validation reads shipped config, ignoring a valid source file and environment', async t => {
  environment(t, { OPENCLUELY_RELEASE: '0', NOCATCH_MANAGED_API_BASE_URL: good.apiBaseUrl });
  for (const raw of ['{malformed-NEVER-SHIP-THIS', '{}', JSON.stringify({ ...good, clientSecret: 'NEVER-SHIP-THIS' }), JSON.stringify({ ...good, apiBaseUrl: 'http://unsafe.test' })]) {
    const f = await archiveFixture(t, raw);
    writeConfig(f.source, good);
    assert.throws(() => verifyArchive(f.archive), error => /config/.test(error.message) && !error.message.includes('NEVER-SHIP-THIS'));
    await assert.rejects(() => afterPack(f.context), /config/);
  }
});

test('afterPack requires actual archive config in release mode on all platforms', async t => {
  environment(t, { OPENCLUELY_RELEASE: '1' });
  for (const platform of ['win32', 'darwin', 'linux']) {
    const f = await archiveFixture(t, undefined, platform);
    writeConfig(f.source, good);
    await assert.rejects(() => afterPack(f.context), /managed-config\.json/);
  }
});

test('archive validation retains unsigned unconfigured builds and accepts configured release fixtures', async t => {
  environment(t, { OPENCLUELY_RELEASE: '0' });
  const unsigned = await archiveFixture(t);
  assert.equal(verifyArchive(unsigned.archive), runtimeFiles.length);
  await assert.rejects(() => afterPack(unsigned.context), error => error.code === 'BUNDLED_RUNTIME_MISSING');
  for (const platform of ['win32', 'darwin', 'linux']) {
    const f = await archiveFixture(t, JSON.stringify(good), platform);
    assert.deepEqual(JSON.parse(asar.extractFile(f.archive, 'managed-config.json').toString()), good);
    assert.equal(verifyArchive(f.archive, { release: true }), runtimeFiles.length + 1);
    if (platform === 'darwin') {
      fs.mkdirSync(path.join(f.resources, 'bin'));
      fs.writeFileSync(path.join(f.resources, 'bin', 'keystroke-capture'), 'helper fixture, not native qualification');
    }
    process.env.OPENCLUELY_RELEASE = '1';
    if (platform === 'win32') await assert.rejects(() => afterPack(f.context), error => error.code === 'BUNDLED_RUNTIME_MISSING');
    else await afterPack(f.context);
  }
});

test('package includes public config and CI prepares it as environment data', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.build.files.includes('managed-config.json'));
  assert.equal(pkg.build.files.includes('managed-config.example.json'), false);
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8'));
  const steps = workflow.jobs.build.steps;
  const prepareIndex = steps.findIndex(step => step.run === 'node scripts/prepare-managed-config.js');
  assert.ok(prepareIndex >= 0);
  assert.equal(steps[prepareIndex].env.OPENCLUELY_MANAGED_CONFIG_JSON, '${{ vars.OPENCLUELY_MANAGED_CONFIG_JSON }}');
  const buildIndex = steps.findIndex(step => step.run === 'npm run build:${{ matrix.platform }}');
  assert.ok(prepareIndex < buildIndex);
  assert.equal(steps[prepareIndex].env.OPENCLUELY_RELEASE, steps[buildIndex].env.OPENCLUELY_RELEASE);
});
