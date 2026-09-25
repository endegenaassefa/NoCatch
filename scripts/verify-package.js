const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const { validateConfig } = require('../src/managed/config');
const { validateBundledRuntime } = require('../src/core/whisper-runtime');
const releaseManifest = require('../src/core/whisper-runtime-manifest.json');

function verifyArchive(archive, { release = process.env.OPENCLUELY_RELEASE === '1' } = {}) {
  const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''));
  const required = ['main.js', 'preload.js', 'onboarding.html', 'settings.html', 'chat.html', 'index.html',
    'llm-response.html', 'src/core/first-run.js', 'scripts/whisper_worker.py', 'prompts/programming.md', 'LICENSE'];
  if (release || files.includes('managed-config.json')) {
    required.push('managed-config.json');
    if (!files.includes('managed-config.json')) throw new Error('Missing packaged managed-config.json for release.');
    let raw;
    try { raw = JSON.parse(asar.extractFile(archive, 'managed-config.json').toString('utf8')); }
    catch { throw new Error('Packaged managed-config.json could not be read as JSON.'); }
    const config = validateConfig(raw);
    if (!config.configured) throw new Error(`Packaged managed-config.json: ${config.reason}`);
  }
  for (const name of required) if (!files.includes(name)) throw new Error(`Missing packaged runtime file: ${name}`);
  // Listing an unpacked file in the archive does not prove its payload shipped.
  for (const name of files) {
    const entry = asar.statFile(archive, name.split('/').join(path.sep));
    if (!entry.unpacked || entry.files) continue;
    const payload = fs.readFileSync(path.join(`${archive}.unpacked`, name));
    if (payload.length !== entry.size) throw new Error(`Unpacked payload size mismatch: ${name}`);
    if (entry.integrity?.algorithm !== 'SHA256' ||
        crypto.createHash('sha256').update(payload).digest('hex') !== entry.integrity.hash) {
      throw new Error(`Unpacked payload checksum mismatch: ${name}`);
    }
  }
  const forbidden = files.filter(name => /^(docs|exam-scan|research|webapp|\.git|\.codex|\.agents)(\/|$)/.test(name) || /(^|\/)\.env($|\.)/.test(name) || /\.log$/.test(name));
  if (forbidden.length) throw new Error(`Development/private files in package: ${forbidden.join(', ')}`);
  return required.length;
}

async function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  verifyArchive(path.join(resources, 'app.asar'));
  if (context.electronPlatformName === 'win32') {
    validateBundledRuntime(path.join(resources, 'speech-runtime', 'windows-x64'),
      { verifyHashes: true, expectedManifestHash: releaseManifest.sha256 });
  }
  if (context.electronPlatformName === 'darwin') {
    const helper = path.join(resources, 'bin', 'keystroke-capture');
    if (!fs.statSync(helper).isFile() || !fs.statSync(helper).size) throw new Error('Missing packaged Mac capture helper');
  }
}

module.exports = afterPack;
module.exports.verifyArchive = verifyArchive;
if (require.main === module) {
  try { console.log(`Verified ${verifyArchive(process.argv[2])} required runtime files and package exclusions.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
