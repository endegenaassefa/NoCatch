const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateConfig } = require('../src/managed/config');

function checkManagedConfig(root, release = process.env.OPENCLUELY_RELEASE === '1') {
  const present = fs.existsSync(path.join(root, 'managed-config.json'));
  // The package must stand alone: development environment overrides cannot satisfy this gate.
  const config = loadConfig({ getAppPath: () => root, isPackaged: true });
  if (!config.configured && (release || present)) {
    throw new Error(`managed-config.json: ${config.reason} Supply validated public deployment configuration before packaging.`);
  }
  return config;
}

function prepareManagedConfig(root, env = process.env) {
  const input = env.OPENCLUELY_MANAGED_CONFIG_JSON;
  if (input?.trim()) {
    let raw;
    try { raw = JSON.parse(input); }
    catch { throw new Error('Public managed-config.json input is not valid JSON.'); }
    if (!validateConfig(raw).configured) throw new Error('Public managed-config.json input is incomplete or invalid; only public deployment fields are allowed.');
    // Validate before writing; never log input values or parser errors containing them.
    fs.writeFileSync(path.join(root, 'managed-config.json'), `${JSON.stringify(raw, null, 2)}\n`);
  }
  return checkManagedConfig(root, env.OPENCLUELY_RELEASE === '1');
}

if (require.main === module) {
  try {
    const config = prepareManagedConfig(path.resolve(__dirname, '..'));
    console.log(config.configured ? 'Public managed-config.json validated for packaging.' : config.reason);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { checkManagedConfig, prepareManagedConfig };
