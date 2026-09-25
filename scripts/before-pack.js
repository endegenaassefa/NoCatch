const { compileHelper } = require('./build-capture-helper');
const { checkManagedConfig } = require('./prepare-managed-config');
const path = require('node:path');
const { validateBundledRuntime } = require('../src/core/whisper-runtime');
const releaseManifest = require('../src/core/whisper-runtime-manifest.json');

module.exports = async context => {
  const config = checkManagedConfig(context.packager.projectDir);
  if (!config.configured) console.warn(config.reason);
  if (context.electronPlatformName === 'win32') {
    const { Arch } = require('builder-util');
    if (Arch[context.arch] !== 'x64') throw new Error('The included Windows speech engine supports x64 builds only.');
    validateBundledRuntime(path.join(context.packager.projectDir, '.depthengine', 'speech-runtime', 'windows-x64'),
      { verifyHashes: true, expectedManifestHash: releaseManifest.sha256 });
  }
  if (context.electronPlatformName !== 'darwin') return;
  const { Arch } = require('builder-util');
  compileHelper(Arch[context.arch], { root: context.packager.projectDir });
};
