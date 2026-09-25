const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

const architectures = { win: ['x64'], mac: ['x64', 'arm64'], linux: ['x64'] };
const hash = (data, algorithm) => crypto.createHash(algorithm).update(data).digest(algorithm === 'sha512' ? 'base64' : 'hex');

function validateArtifacts(directory, platforms, version, targets = architectures) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
  const channel = version.includes('-') ? version.split('-')[1].split('.')[0] : 'latest';
  const metadataName = p => `${channel}${p === 'win' ? '' : `-${p}`}.yml`;
  const metadataNames = platforms.map(metadataName);
  const files = new Map();
  function walk(folder, depth = 0) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Linked artifact is not allowed: ${entry.name}`);
      // Builder outputs are flat; downloaded CI artifacts add one job folder.
      // Do not traverse packaged .app frameworks or unpacked application data.
      if (entry.isDirectory() && depth === 0) walk(file, 1);
      else if (entry.isFile() && (metadataNames.includes(entry.name) || /^OpenCluely-.*\.(exe|dmg|zip|deb|AppImage)(\.blockmap)?$/.test(entry.name))) {
        if (files.has(entry.name)) throw new Error(`Duplicate artifact filename: ${entry.name}`);
        if (!fs.statSync(file).size) throw new Error(`Empty artifact: ${entry.name}`);
        if (!metadataNames.includes(entry.name) && !entry.name.includes(`-${version}-`)) throw new Error(`Stale artifact: ${entry.name}`);
        files.set(entry.name, file);
      }
    }
  }
  walk(directory);
  const requireFile = name => {
    if (!files.has(name)) throw new Error(`Missing release artifact: ${name}`);
    return files.get(name);
  };
  for (const platform of platforms) {
    if (!targets[platform]?.length) throw new Error(`Unknown platform: ${platform}`);
    const allowed = new Set();
    const updates = [];
    for (const arch of targets[platform]) {
      const expected = platform === 'win'
        ? [`OpenCluely-Setup-${version}-${arch}.exe`, `OpenCluely-Portable-${version}-${arch}.exe`]
        : (platform === 'mac' ? ['dmg', 'zip'] : ['deb', 'AppImage']).map(ext => `OpenCluely-${version}-${platform}-${arch}.${ext}`);
      expected.forEach(requireFile);
      expected.forEach(name => allowed.add(name));
      updates.push(platform === 'win' ? expected[0] : expected[1]);
    }
    const name = metadataName(platform);
    const metadata = yaml.load(fs.readFileSync(requireFile(name), 'utf8'));
    if (metadata?.version !== version || !Array.isArray(metadata.files) || !metadata.files.length) throw new Error(`Invalid update metadata: ${name}`);
    const referenced = new Set();
    for (const item of metadata.files) {
      const target = typeof item.url === 'string' ? decodeURIComponent(item.url) : '';
      if (!target || path.basename(target) !== target || /[\\/:]/.test(target)) throw new Error(`Invalid update URL in ${name}`);
      if (!allowed.has(target)) throw new Error(`Wrong platform or architecture in ${name}: ${target}`);
      if (referenced.has(target)) throw new Error(`Duplicate update payload in ${name}: ${target}`);
      referenced.add(target);
      const data = fs.readFileSync(requireFile(target));
      if (item.sha512 !== hash(data, 'sha512')) throw new Error(`Update checksum mismatch: ${target}`);
      if (item.size !== undefined && item.size !== data.length) throw new Error(`Update size mismatch: ${target}`);
    }
    for (const target of updates) if (!referenced.has(target)) throw new Error(`Missing update payload in ${name}: ${target}`);
    if (metadata.path) {
      const target = metadata.files.find(item => decodeURIComponent(item.url) === decodeURIComponent(metadata.path));
      if (!target) throw new Error(`Update path does not match files: ${name}`);
      if (metadata.sha512 && metadata.sha512 !== target.sha512) throw new Error(`Update path checksum mismatch: ${name}`);
    }
  }
  return [...files.values()];
}

function collectArtifacts(input, output, platforms, version, targets) {
  const files = validateArtifacts(input, platforms, version, targets);
  const destination = path.resolve(output);
  if (destination === path.resolve(input) || destination.startsWith(path.resolve(input) + path.sep)) throw new Error('Release destination must be outside the input directory');
  fs.mkdirSync(destination, { recursive: true });
  if (fs.readdirSync(destination).length) throw new Error('Release destination must be empty');
  const checksums = [];
  for (const file of files.sort()) {
    const name = path.basename(file);
    fs.copyFileSync(file, path.join(destination, name), fs.constants.COPYFILE_EXCL);
    checksums.push(`${hash(fs.readFileSync(file), 'sha256')}  ${name}`);
  }
  fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  return files.length;
}

if (require.main === module) {
  try {
    const [mode, input, outputOrPlatform, suppliedVersion, arch] = process.argv.slice(2);
    const version = suppliedVersion || require('../package.json').version;
    if (mode === 'verify') {
      const targets = arch ? { ...architectures, [outputOrPlatform]: [arch] } : architectures;
      console.log(`Verified ${validateArtifacts(input, [outputOrPlatform], version, targets).length} ${outputOrPlatform} artifacts and update checksums.`);
    } else if (mode === 'collect') {
      console.log(`Collected ${collectArtifacts(input, outputOrPlatform, ['win', 'mac', 'linux'], version)} verified artifacts.`);
    } else throw new Error('Usage: release-artifacts.js verify <input> <platform> [version] [arch], or collect <input> <output> [version]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { validateArtifacts, collectArtifacts };
