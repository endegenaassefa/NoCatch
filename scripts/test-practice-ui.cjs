'use strict';

// One command: node scripts/test-practice-ui.cjs
// Windows includes native Electron; other hosts explicitly skip it. CI can use
// --require-native. --source-root overlays old source onto an isolated fixture.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`${name} requires a path`);
  return args[i + 1];
};
const output = path.resolve(option('--output') || fs.mkdtempSync(path.join(os.tmpdir(), 'nocatch-ui-evidence-')));
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nocatch-ui-fixture-'));
let failed = false;
try {
  let source = repo;
  if (option('--source-root')) {
    if (!fs.statSync(path.resolve(option('--source-root'))).isDirectory()) throw Error('--source-root must name a directory');
    source = path.join(temp, 'source');
    const allowed = /\.(?:js|cjs|css|json|woff2?|ttf|eot|svg|html)$/i;
    const copy = (from, to) => {
      if (!fs.existsSync(from)) return;
      if (fs.statSync(from).isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
      } else if (allowed.test(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
    };
    for (const item of ['main.js', 'preload.js', 'index.html', 'chat.html', 'src/managers/window.manager.js', 'src/ui', 'src/styles', 'lib', 'dist/output.css', 'node_modules/prismjs', 'node_modules/@fortawesome/fontawesome-free']) copy(path.join(repo, item), path.join(source, item));
    copy(path.resolve(option('--source-root')), source);
    fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
    for (const name of ['test-shortcut-lifecycle.cjs', 'test-windows-surface.cjs']) fs.copyFileSync(path.join(__dirname, name), path.join(source, 'scripts', name));
  }
  if (!args.includes('--native-only')) {
    const result = spawnSync(process.execPath, ['--test', path.join(source, 'scripts/test-shortcut-lifecycle.cjs'), path.join(source, 'scripts/test-windows-surface.cjs')], { encoding: 'utf8', timeout: 30000 });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    fs.writeFileSync(path.join(output, 'fast-tests.txt'), (result.stdout || '') + (result.stderr || ''));
    if (result.status !== 0) failed = true;
  }
  if (process.platform !== 'win32') {
    console.log('SKIP native Windows Electron: this host is ' + process.platform + '. Renderer/compositor and native registration are not verified here.');
    if (args.includes('--require-native')) failed = true;
  } else {
    const electron = require(path.join(repo, 'node_modules/electron'));
    const nativeArgs = [path.join(__dirname, 'test-practice-ui-native.cjs'), '--source', source, '--output', output, '--userdata', path.join(temp, 'userdata')];
    if (args.includes('--omit-startup-recovery')) nativeArgs.push('--omit-startup-recovery');
    if (args.includes('--inject-renderer-flicker')) nativeArgs.push('--inject-renderer-flicker');
    const reportFile = path.join(output, 'native-results.json');
    fs.rmSync(reportFile, { force: true });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, nativeArgs, { encoding: 'utf8', timeout: 40000, env });
    fs.writeFileSync(path.join(output, 'native-process.txt'), (result.stdout || '') + (result.stderr || ''));
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    if (!Array.isArray(report.checks) || report.checks.length === 0) throw Error('Native report contains no acceptance checks');
    for (const check of report.checks) console.log(`${check.pass === true ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ': ' + check.detail : ''}`);
    if (report.checks.some(check => check.pass !== true)) failed = true;
    console.log(report.limits);
    if (result.status !== 0) { failed = true; console.error('Native harness failed:', result.error?.message || `exit ${result.status}`); }
  }
} catch (error) { failed = true; console.error(error.stack); }
finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
console.log('Evidence: ' + output);
process.exitCode = failed ? 1 : 0;
