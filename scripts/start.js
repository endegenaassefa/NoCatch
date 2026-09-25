const path = require('node:path');
const { spawn } = require('node:child_process');

function launchEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  return env;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const child = spawn(require('electron'), [root, ...process.argv.slice(2)], {
    cwd: root,
    env: launchEnvironment(),
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', error => {
    console.error(`Cannot launch Electron: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}

module.exports = { launchEnvironment };
