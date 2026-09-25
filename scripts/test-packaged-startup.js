// Run the actual packaged main and renderers with an isolated first-run profile.
// The debugger hides windows before main.js executes; no app code is replaced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawn, execFileSync } = require('node:child_process');
const { launchEnvironment } = require('./start');

async function smoke(executable) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'opencluely-startup-'));
  // main.js prefers an existing userData/.env to its working-directory fallback.
  // The debugger sets userData to this profile before the resolver executes.
  fs.writeFileSync(path.join(profile, '.env'), '');
  const env = launchEnvironment();
  const isolatedKeys = ['GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'WHISPER_COMMAND', 'WHISPER_PYTHON'];
  for (const key of Object.keys(env)) if (isolatedKeys.includes(key.toUpperCase())) delete env[key];
  env.USERPROFILE = profile;
  env.HOME = profile;
  env.APPDATA = profile;
  env.LOCALAPPDATA = profile;
  const child = spawn(path.resolve(executable), ['--inspect-brk=127.0.0.1:0'], {
    cwd: tempRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let socket;
  let exited = false;
  let output = '';
  let rejectStartup;
  const failure = new Promise((_, reject) => { rejectStartup = reject; });
  // A handler is attached immediately, including before inspector connection.
  failure.catch(() => {});
  child.on('error', rejectStartup);
  child.on('exit', (code) => { exited = true; rejectStartup(new Error(`App exited before startup verification: ${code}`)); });
  const deadline = setTimeout(() => rejectStartup(new Error('Packaged startup timed out')), 60000);
  try {
    const inspector = new Promise(resolve => {
      const capture = data => {
        output += data.toString();
        const match = output.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
        if (match) resolve(match[0]);
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
    });
    socket = new WebSocket(await Promise.race([inspector, failure]));
    let id = 0;
    const pending = new Map();
    let resolvePaused;
    const paused = new Promise(resolve => { resolvePaused = resolve; });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Debugger.paused') resolvePaused(message.params);
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      }
    });
    socket.addEventListener('error', () => rejectStartup(new Error('Inspector connection failed')));
    const call = (method, params = {}) => Promise.race([new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    }), failure]);
    await Promise.race([new Promise(resolve => socket.addEventListener('open', resolve, { once: true })), failure]);
    await call('Debugger.enable');
    await call('Runtime.runIfWaitingForDebugger');
    const pause = await Promise.race([paused, failure]);
    const setup = await call('Debugger.evaluateOnCallFrame', {
      callFrameId: pause.callFrames[0].callFrameId,
      expression: `(() => {
        const electron = require('electron');
        electron.app.setPath('userData', ${JSON.stringify(profile)});
        electron.BrowserWindow.prototype.show = function() {};
        electron.BrowserWindow.prototype.showInactive = function() {};
        const state = globalThis.__packagedSmoke = { electron, errors: [] };
        electron.app.on('render-process-gone', (_, contents, details) => state.errors.push(details.reason));
        electron.app.on('web-contents-created', (_, contents) => {
          contents.on('preload-error', (_, file, error) => state.errors.push(error.message));
          contents.on('did-fail-load', (_, code, description, url, mainFrame) => { if (mainFrame) state.errors.push(description); });
          contents.debugger.attach('1.3');
          contents.debugger.on('message', (_, method, params) => {
            if (method === 'Runtime.exceptionThrown') state.errors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
          });
          contents.debugger.sendCommand('Runtime.enable').catch(error => state.errors.push(error.message));
        });
        return true;
      })()`,
      returnByValue: true,
    });
    if (setup.exceptionDetails) throw new Error(`Cannot isolate startup: ${setup.exceptionDetails.text}`);
    await call('Debugger.resume');
    let result;
    for (;;) {
      const response = await call('Runtime.evaluate', {
        expression: `(() => {
          const state = globalThis.__packagedSmoke;
          return { errors: state.errors, packaged: state.electron.app.isPackaged,
            appPath: state.electron.app.getAppPath(),
            userData: state.electron.app.getPath('userData'),
            credentialsAbsent: ${JSON.stringify(isolatedKeys)}.every(key => !process.env[key]),
            windows: state.electron.BrowserWindow.getAllWindows().map(w => ({ url: w.webContents.getURL(), loading: w.webContents.isLoading() })) };
        })()`, returnByValue: true,
      });
      result = response.result?.value;
      if (result?.errors.length) throw new Error(JSON.stringify(result.errors));
      if (result?.windows.length >= 5 && result.windows.every(w => w.url.startsWith('file:') && !w.loading)) break;
      await Promise.race([new Promise(resolve => setTimeout(resolve, 200)), failure]);
    }
    assert.equal(result.packaged, true);
    assert.equal(result.userData, profile);
    assert.equal(result.credentialsAbsent, true, 'Provider credentials must remain absent after config loads');
    const expectedPages = ['onboarding.html', 'settings.html', 'llm-response.html', 'chat.html', 'index.html'];
    assert.deepEqual(result.windows.map(w => path.resolve(fileURLToPath(w.url))).sort(),
      expectedPages.map(name => path.join(result.appPath, name)).sort());
    const bridges = await call('Runtime.evaluate', {
      expression: `Promise.all(globalThis.__packagedSmoke.electron.BrowserWindow.getAllWindows().map(w => w.webContents.executeJavaScript('typeof window.electronAPI')))`,
      awaitPromise: true, returnByValue: true,
    });
    assert.ok(bridges.result?.value?.every(value => value === 'object'), 'Renderer preload bridges must load');
    await Promise.race([new Promise(resolve => setTimeout(resolve, 500)), failure]);
    const errors = await call('Runtime.evaluate', { expression: 'globalThis.__packagedSmoke.errors', returnByValue: true });
    assert.deepEqual(errors.result?.value, [], 'Renderer startup must have no uncaught exceptions');
    console.log(JSON.stringify({ packaged: true, windows: result.windows.map(w => path.basename(w.url)), preloadBridges: bridges.result.value.length, errors: result.errors }));
    await call('Runtime.evaluate', { expression: 'setTimeout(() => globalThis.__packagedSmoke.electron.app.quit(), 0)' });
    socket.close();
    await new Promise(resolve => { if (exited) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 5000).unref(); } });
  } finally {
    clearTimeout(deadline);
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    if (!exited) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
      } else child.kill('SIGTERM');
    }
    assert.equal(path.dirname(fs.realpathSync(profile)), tempRoot);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (require.main === module) {
  const executable = process.argv[2];
  if (!executable) { console.error('Usage: node scripts/test-packaged-startup.js <packaged executable>'); process.exitCode = 1; }
  else smoke(executable).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { smoke };
