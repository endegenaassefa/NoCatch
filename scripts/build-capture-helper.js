const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function compileHelper(arch, { root = path.resolve(__dirname, '..'), host = process.platform, run = execFileSync } = {}) {
  if (host !== 'darwin') throw new Error('The macOS capture helper must be compiled on macOS.');
  const nativeArch = { x64: 'x86_64', arm64: 'arm64' }[arch];
  if (!nativeArch) throw new Error(`Unsupported Mac helper architecture: ${arch}`);
  const output = path.join(root, 'resources', 'bin', arch, 'keystroke-capture');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  run('xcrun', ['--sdk', 'macosx', 'swiftc', '-O', '-target', `${nativeArch}-apple-macos13.0`,
    path.join(root, 'scripts', 'keystroke-capture', 'main.swift'), '-o', output], { stdio: 'inherit' });
  run('lipo', ['-verify_arch', nativeArch, output], { stdio: 'inherit' });
  // electron-builder signs the bundled helper along with the application.
  return output;
}

if (require.main === module) {
  try { console.log(compileHelper(process.argv[2] || process.arch)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { compileHelper };
