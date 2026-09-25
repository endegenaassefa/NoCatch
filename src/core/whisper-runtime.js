const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const releaseManifest = require('./whisper-runtime-manifest.json');

const REQUIRED_FILES = [
  'python.exe', 'python313.dll', 'python313.zip', 'python313._pth',
  'Lib/site-packages/whisper/__init__.py',
  'Lib/site-packages/torch/__init__.py',
  'Lib/site-packages/numpy/__init__.py'
];

function invalid(message, code = 'BUNDLED_RUNTIME_INVALID') {
  const error = new Error(`The included Windows speech engine needs repair. Reinstall the app. ${message}`);
  error.code = code;
  return error;
}

function fileHash(filename) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function safeFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw invalid('Unsafe runtime inventory path.');
  }
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw invalid('Runtime links are not supported.');
  }
  return current;
}

// Full inventory verification belongs to packaging. Launch verifies critical
// files without synchronously hashing hundreds of megabytes of tensor DLLs.
function validateBundledRuntime(root, { verifyHashes = false, expectedManifestHash } = {}) {
  try {
    if (!fs.existsSync(root)) throw invalid('Speech runtime is missing.', 'BUNDLED_RUNTIME_MISSING');
    if (fs.lstatSync(root).isSymbolicLink()) throw invalid('Runtime links are not supported.');
    const manifestFile = safeFile(root, 'manifest.json');
    if (expectedManifestHash && fileHash(manifestFile) !== expectedManifestHash) {
      throw invalid('The runtime inventory does not match this app release.');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
        manifest.python !== 'python.exe' || !manifest.id || !manifest.files || Array.isArray(manifest.files)) {
      throw invalid('Runtime manifest is invalid.');
    }
    const entries = Object.entries(manifest.files);
    for (const [relative, entry] of entries) {
      if (!relative || relative.includes('\\') || relative.includes(':') ||
          relative.split('/').some(part => !part || part === '.' || part === '..') || relative === 'manifest.json' ||
          !entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw invalid('Runtime inventory is invalid.');
      }
    }
    for (const relative of REQUIRED_FILES) {
      if (!Object.prototype.hasOwnProperty.call(manifest.files, relative)) throw invalid(`Missing inventory entry: ${relative}`);
    }
    for (const relative of verifyHashes ? Object.keys(manifest.files) : REQUIRED_FILES) {
      const filename = safeFile(root, relative);
      const stat = fs.statSync(filename);
      const expected = manifest.files[relative];
      if (!stat.isFile() || stat.size !== expected.size || fileHash(filename) !== expected.sha256) {
        throw invalid(`Runtime file changed: ${relative}`);
      }
    }
    const importPaths = fs.readFileSync(path.join(root, 'python313._pth'), 'utf8')
      .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const allowed = new Set(['python313.zip', '.', 'Lib', 'Lib/site-packages', 'import site']);
    if (!importPaths.includes('python313.zip') || !importPaths.includes('Lib/site-packages') ||
        importPaths.some(line => !allowed.has(line))) throw invalid('Python import isolation is invalid.');
    if (verifyHashes) {
      const visit = (dir, prefix = '') => {
        for (const name of fs.readdirSync(dir)) {
          const relative = prefix + name;
          const stat = fs.lstatSync(path.join(dir, name));
          if (stat.isSymbolicLink()) throw invalid('Runtime links are not supported.');
          if (stat.isDirectory()) visit(path.join(dir, name), `${relative}/`);
          else if (relative !== 'manifest.json' && !Object.prototype.hasOwnProperty.call(manifest.files, relative)) {
            throw invalid(`Untracked runtime file: ${relative}`);
          }
        }
      };
      visit(root);
    }
    return manifest;
  } catch (error) {
    if (error.code?.startsWith('BUNDLED_RUNTIME_')) throw error;
    throw invalid(error.code === 'ENOENT' ? 'A runtime file is missing.' : 'The runtime could not be verified.');
  }
}

function resolveWhisperRuntime({ platform = process.platform, isPackaged = false,
  resourcesPath = process.resourcesPath, configuredCommand, configuredPython, env = process.env,
  expectedManifestHash = releaseManifest.sha256 } = {}) {
  if (platform !== 'win32' || !isPackaged) return null;
  const command = String(configuredCommand || env.WHISPER_COMMAND || '').trim();
  const python = String(configuredPython || env.WHISPER_PYTHON || '').trim();
  // "whisper" is also the shipped/saved default, not a custom runtime path.
  if (python || (command && command.toLowerCase() !== 'whisper')) return null;
  if (!resourcesPath) throw invalid('Resources directory is missing.', 'BUNDLED_RUNTIME_MISSING');
  const root = path.join(resourcesPath, 'speech-runtime', 'windows-x64');
  const manifest = validateBundledRuntime(root, { expectedManifestHash });
  const isolatedEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^python/i.test(key)));
  Object.assign(isolatedEnv, { PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' });
  const pythonPath = path.join(root, manifest.python);
  return { kind: 'bundled', root, pythonPath, command: pythonPath, baseArgs: ['-m', 'whisper'],
    env: isolatedEnv, allowCliFallback: false, manifest, source: 'bundled Windows CPU runtime' };
}

module.exports = { resolveWhisperRuntime, validateBundledRuntime };
