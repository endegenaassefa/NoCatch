const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { launchEnvironment } = require('./start');
const { clean } = require('./clean');
const { buildOptions } = require('./build');
const { compileHelper } = require('./build-capture-helper');
const { validateArtifacts, collectArtifacts } = require('./release-artifacts');
const { verifyArchive } = require('./verify-package');
const asar = require('@electron/asar');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-packaging-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('opencluely-packaging-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return root;
}

function fixture(root, platforms = ['win', 'mac', 'linux'], version = '1.0.0') {
  const input = path.join(root, 'artifacts');
  fs.mkdirSync(input);
  for (const platform of platforms) {
    const folder = path.join(input, platform);
    fs.mkdirSync(folder);
    const names = platform === 'win'
      ? ['Setup', 'Portable'].map(kind => `OpenCluely-${kind}-${version}-x64.exe`)
      : (platform === 'mac' ? ['x64', 'arm64'] : ['x64']).flatMap(arch =>
        (platform === 'mac' ? ['dmg', 'zip'] : ['deb', 'AppImage']).map(ext => `OpenCluely-${version}-${platform}-${arch}.${ext}`));
    const files = names.map(name => {
      const data = Buffer.from(`test artifact ${name}`);
      fs.writeFileSync(path.join(folder, name), data);
      return { url: name, sha512: crypto.createHash('sha512').update(data).digest('base64'), size: data.length };
    });
    const channel = version.includes('-') ? version.split('-')[1].split('.')[0] : 'latest';
    const metadata = `${channel}${platform === 'win' ? '' : `-${platform}`}.yml`;
    fs.writeFileSync(path.join(folder, metadata), yaml.dump({ version, files, path: names[0], sha512: files[0].sha512 }));
    fs.writeFileSync(path.join(folder, `${names[0]}.blockmap`), 'blockmap fixture');
  }
  return input;
}

test('GUI launch removes inherited Node mode without changing the parent environment', () => {
  const original = { PATH: 'unchanged', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1' };
  assert.deepEqual(launchEnvironment(original), { PATH: 'unchanged' });
  assert.equal(original.ELECTRON_RUN_AS_NODE, '1');
});

test('clean removes only the project output and tolerates a missing output', t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'build.txt'), 'output');
  fs.writeFileSync(path.join(root, 'keep.txt'), 'source');
  clean(root);
  clean(root);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'source');
});

test('clean refuses a junction/symlink instead of following it', t => {
  const root = temporary(t);
  const outside = path.join(root, 'outside');
  const project = path.join(root, 'project');
  fs.mkdirSync(outside);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(project, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => clean(project), /linked output/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('build preserves CLI options and drops empty secret placeholders', () => {
  const options = buildOptions(['win', '--x64', '--dir'], { CSC_LINK: '', APPLE_ID: '', PATH: 'test' }, 'win32');
  assert.deepEqual(options.cliArgs, ['--win', '--x64', '--dir', '--publish', 'never']);
  assert.deepEqual(options.env, { PATH: 'test' });
});

test('Windows cannot accidentally claim a Mac build', () => {
  assert.throws(() => buildOptions(['mac'], {}, 'win32'), /requires a Mac/);
  assert.throws(() => buildOptions(['all'], {}, 'win32'), /requires a Mac/);
});

test('signed builds fail before packaging when credentials are absent', () => {
  assert.throws(() => buildOptions(['win', '--release'], {}, 'win32'), /Signed Windows/);
  assert.throws(() => buildOptions(['mac', '--release'], { CSC_LINK: 'certificate' }, 'darwin'), /notarization/);
  const valid = buildOptions(['mac', '--release'], {
    CSC_LINK: 'certificate', APPLE_ID: 'account', APPLE_APP_SPECIFIC_PASSWORD: 'password', APPLE_TEAM_ID: 'team',
  }, 'darwin');
  assert.ok(valid.cliArgs.includes('--config.forceCodeSigning=true'));
  assert.equal(valid.env.OPENCLUELY_RELEASE, '1');
});

test('Mac helper build fails for absent toolchains and verifies the requested architecture', t => {
  const root = temporary(t);
  assert.throws(() => compileHelper('arm64', { root, host: 'win32' }), /macOS/);
  assert.throws(() => compileHelper('arm64', { root, host: 'darwin', run() { throw new Error('compiler unavailable'); } }), /compiler unavailable/);
  const calls = [];
  compileHelper('x64', { root, host: 'darwin', run: (...args) => calls.push(args) });
  assert.ok(calls[0][1].includes('x86_64-apple-macos13.0'));
  assert.deepEqual(calls[1][1].slice(0, 2), ['-verify_arch', 'x86_64']);
});

test('complete releases retain Mac assets, portable builds, metadata and blockmaps', t => {
  const root = temporary(t);
  const input = fixture(root);
  const output = path.join(root, 'release');
  assert.equal(collectArtifacts(input, output, ['win', 'mac', 'linux'], '1.0.0'), 14);
  for (const name of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'SHA256SUMS.txt', 'OpenCluely-1.0.0-mac-arm64.zip']) {
    assert.ok(fs.existsSync(path.join(output, name)), name);
  }
  assert.throws(() => collectArtifacts(input, output, ['win', 'mac', 'linux'], '1.0.0'), /must be empty/);
});

test('missing architecture is a hard release failure', t => {
  const input = fixture(temporary(t));
  fs.unlinkSync(path.join(input, 'mac', 'OpenCluely-1.0.0-mac-arm64.zip'));
  assert.throws(() => validateArtifacts(input, ['win', 'mac', 'linux'], '1.0.0'), /Missing release artifact/);
});

test('missing update metadata cannot be published as a complete release', t => {
  const input = fixture(temporary(t), ['win']);
  fs.unlinkSync(path.join(input, 'win', 'latest.yml'));
  assert.throws(() => validateArtifacts(input, ['win'], '1.0.0'), /latest.yml/);
});

test('corrupt update payload fails checksum validation', t => {
  const input = fixture(temporary(t), ['win']);
  fs.appendFileSync(path.join(input, 'win', 'OpenCluely-Setup-1.0.0-x64.exe'), 'corruption');
  assert.throws(() => validateArtifacts(input, ['win'], '1.0.0'), /checksum mismatch/);
});

test('duplicate artifact names cannot overwrite another architecture/job', t => {
  const input = fixture(temporary(t), ['win']);
  const name = 'OpenCluely-Setup-1.0.0-x64.exe';
  fs.copyFileSync(path.join(input, 'win', name), path.join(input, name));
  assert.throws(() => validateArtifacts(input, ['win'], '1.0.0'), /Duplicate artifact/);
});

test('metadata cannot reference a path outside the artifact directory', t => {
  const input = fixture(temporary(t), ['win']);
  const file = path.join(input, 'win', 'latest.yml');
  const data = yaml.load(fs.readFileSync(file, 'utf8'));
  data.files[0].url = '../secret.exe';
  fs.writeFileSync(file, yaml.dump(data));
  assert.throws(() => validateArtifacts(input, ['win'], '1.0.0'), /Invalid update URL/);
});

test('prerelease channel metadata is validated using its own version', t => {
  const input = fixture(temporary(t), ['win'], '1.2.0-beta.1');
  assert.equal(validateArtifacts(input, ['win'], '1.2.0-beta.1').length, 4);
});

test('artifact collection ignores framework links inside unpacked Mac applications', t => {
  const input = fixture(temporary(t), ['mac']);
  const app = path.join(input, 'mac', 'Example.app');
  fs.mkdirSync(app);
  fs.symlinkSync(app, path.join(app, 'Framework'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(validateArtifacts(input, ['mac'], '1.0.0').length, 6);
});

test('Mac metadata must cover both architecture update ZIPs even when installers exist', t => {
  const input = fixture(temporary(t), ['mac']);
  const file = path.join(input, 'mac', 'latest-mac.yml');
  const data = yaml.load(fs.readFileSync(file, 'utf8'));
  data.files = data.files.filter(item => !item.url.endsWith('arm64.zip'));
  fs.writeFileSync(file, yaml.dump(data));
  assert.throws(() => validateArtifacts(input, ['mac'], '1.0.0'), /Missing update payload.*arm64.zip/);
});

test('Mac metadata cannot reference a valid Windows artifact during collection', t => {
  const input = fixture(temporary(t));
  const file = path.join(input, 'mac', 'latest-mac.yml');
  const data = yaml.load(fs.readFileSync(file, 'utf8'));
  data.files.push(yaml.load(fs.readFileSync(path.join(input, 'win', 'latest.yml'), 'utf8')).files[0]);
  fs.writeFileSync(file, yaml.dump(data));
  assert.throws(() => validateArtifacts(input, ['win', 'mac', 'linux'], '1.0.0'), /Wrong platform/);
});

test('duplicate update entries are rejected', t => {
  const input = fixture(temporary(t), ['win']);
  const file = path.join(input, 'win', 'latest.yml');
  const data = yaml.load(fs.readFileSync(file, 'utf8'));
  data.files.push(data.files[0]);
  fs.writeFileSync(file, yaml.dump(data));
  assert.throws(() => validateArtifacts(input, ['win'], '1.0.0'), /Duplicate update payload/);
});

test('archive verification rejects missing and same-size corrupt unpacked payloads', async t => {
  const root = temporary(t);
  const source = path.join(root, 'source');
  const names = ['main.js', 'preload.js', 'onboarding.html', 'settings.html', 'chat.html', 'index.html',
    'llm-response.html', 'src/core/first-run.js', 'scripts/whisper_worker.py', 'prompts/programming.md', 'LICENSE'];
  for (const name of names) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'test payload');
  }
  const archive = path.join(root, 'app.asar');
  await asar.createPackageWithOptions(source, archive, { unpack: '*.py' });
  assert.equal(verifyArchive(archive), names.length);
  const payload = path.join(`${archive}.unpacked`, 'scripts', 'whisper_worker.py');
  fs.writeFileSync(payload, 'BAD! payload');
  assert.throws(() => verifyArchive(archive), /checksum mismatch/);
  fs.unlinkSync(payload);
  assert.throws(() => verifyArchive(archive), /ENOENT/);
});
