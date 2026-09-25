const fs = require('node:fs');
const path = require('node:path');
const { validateBundledRuntime } = require('../src/core/whisper-runtime');
const releaseManifest = require('../src/core/whisper-runtime-manifest.json');

// The input is a complete payload built from the pinned Windows speech lock.
// This command never installs Python, pip, or dependencies on the user's host.
function stageWindowsSpeech(source, project = path.resolve(__dirname, '..')) {
  const input = path.resolve(source);
  const destination = path.join(project, '.depthengine', 'speech-runtime', 'windows-x64');
  const manifest = validateBundledRuntime(input, { verifyHashes: true, expectedManifestHash: releaseManifest.sha256 });
  if (input === destination) return { destination, id: manifest.id };
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, 'stage-'));
  try {
    fs.cpSync(input, temporary, { recursive: true, errorOnExist: true, force: false });
    validateBundledRuntime(temporary, { verifyHashes: true, expectedManifestHash: releaseManifest.sha256 });
    // A previous staged payload is retained if copying/verification fails.
    const backup = `${destination}.previous`;
    if (fs.existsSync(backup)) throw new Error(`Previous runtime backup exists: ${backup}. Review it before staging again.`);
    if (fs.existsSync(destination)) fs.renameSync(destination, backup);
    try { fs.renameSync(temporary, destination); }
    catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
      throw error;
    }
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true });
    return { destination, id: manifest.id };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

module.exports = { stageWindowsSpeech };
if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/stage-windows-speech.js <verified-payload-directory>');
    console.log(JSON.stringify(stageWindowsSpeech(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
