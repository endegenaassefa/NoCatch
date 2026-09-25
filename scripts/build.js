const path = require('node:path');
const { spawn } = require('node:child_process');

const signingVariables = [
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_NAME',
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
  'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
];

function buildOptions(args, source = process.env, host = process.platform) {
  const env = { ...source };
  // Empty GitHub secrets must not become empty certificate file paths.
  for (const key of signingVariables) if (!env[key]?.trim()) delete env[key];
  const forwarded = [...args];
  const target = ['mac', 'win', 'linux', 'all'].includes(forwarded[0]) ? forwarded.shift() : null;
  if ((target === 'mac' || target === 'all') && host !== 'darwin') {
    throw new Error('macOS packaging requires a Mac; use the macOS CI job.');
  }
  const release = forwarded.includes('--release') || env.OPENCLUELY_RELEASE === '1';
  const platforms = target === 'all' ? ['mac', 'win', 'linux'] : [target || ({ darwin: 'mac', win32: 'win', linux: 'linux' })[host]];
  if (platforms.includes(undefined)) throw new Error(`Unsupported build host: ${host}`);
  if (release) {
    env.OPENCLUELY_RELEASE = '1';
    if (platforms.includes('mac')) {
      if (!env.CSC_LINK) throw new Error('Signed Mac builds require CSC_LINK.');
      const appleAccount = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
      const appleApi = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
      if (!appleAccount && !appleApi) throw new Error('Signed Mac builds require Apple notarization credentials.');
    }
    if (platforms.includes('win') && !(env.WIN_CSC_LINK || env.CSC_LINK)) {
      throw new Error('Signed Windows builds require WIN_CSC_LINK or CSC_LINK.');
    }
  }
  const cliArgs = [...platforms.map(p => `--${p}`), ...forwarded.filter(arg => arg !== '--release')];
  // Artifact publishing is handled separately by the draft-release workflow.
  cliArgs.push('--publish', 'never');
  if (release && platforms.some(p => p === 'mac' || p === 'win')) cliArgs.push('--config.forceCodeSigning=true');
  return { env, cliArgs };
}

if (require.main === module) {
  try {
    const { env, cliArgs } = buildOptions(process.argv.slice(2));
    const cli = require.resolve('electron-builder/out/cli/cli.js');
    const child = spawn(process.execPath, [cli, ...cliArgs], {
      cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', windowsHide: true,
    });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildOptions };
