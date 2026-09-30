'use strict';

// Native Windows fixture: real production controller lifecycle, manager,
// preload and renderer source. No full app bootstrap, credentials or backend.
const { app, BrowserWindow, ipcMain, session, globalShortcut, powerMonitor, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const root = option('--source'), out = option('--output'), userdata = option('--userdata');
const chord = 'Control+Alt+Shift+F23';
const ownerMode = args.includes('--owner');
app.setPath('userData', userdata + (ownerMode ? '-owner' : ''));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], errors = [], events = [], frames = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
const limits = 'Native capturePage checks renderer pixels, not desktop compositor/z-order or the original practice test. No physical key delivery or microphone is tested; a rare test chord uses the real Windows registration API.';
const logger = { info() {}, debug() {}, warn() {}, error: (...data) => errors.push(data) };
let manager, controller, owner;
const watchdog = setTimeout(() => app.exit(2), 30000);
if (ownerMode) {
  app.whenReady().then(async () => {
    const registered = globalShortcut.register(chord, () => {});
    fs.writeFileSync(path.join(out, 'owner-ready.json'), JSON.stringify({ registered, pid: process.pid }));
    while (!fs.existsSync(path.join(out, 'owner-release'))) await delay(50);
    globalShortcut.unregisterAll(); app.exit(registered ? 0 : 1);
  });
} else {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', details => { if (details.level === 'error') errors.push({ renderer: details.message }); });
    contents.on('render-process-gone', (_event, details) => errors.push({ rendererGone: details.reason }));
    contents.on('preload-error', (_event, _preload, error) => errors.push({ preload: error.message }));
    contents.on('did-fail-load', (_event, code, description) => errors.push({ load: code, description }));
  });
  app.whenReady().then(run).catch(error => { check('fixture execution', false, error.stack); }).finally(async () => {
    controller?.stopShortcutRecovery?.();
    globalShortcut.unregisterAll();
    manager?.destroyAllWindows();
    for (const win of BrowserWindow.getAllWindows()) win.destroy();
    if (owner && owner.exitCode === null) {
      fs.writeFileSync(path.join(out, 'owner-release'), 'release');
      await Promise.race([new Promise(resolve => owner.once('exit', resolve)), delay(1000)]);
      if (owner.exitCode === null) {
        owner.kill();
        await Promise.race([new Promise(resolve => owner.once('exit', resolve)), delay(2000)]);
      }
    }
    check('conflict owner process exited', Boolean(owner) && (owner.exitCode !== null || owner.signalCode !== null));
    check('owned windows and native shortcut released', BrowserWindow.getAllWindows().length === 0 && !globalShortcut.isRegistered(chord));
    fs.writeFileSync(path.join(out, 'native-results.json'), JSON.stringify({ checks, frames, events, errors, limits, pid: process.pid, scaleFactor: screen.getPrimaryDisplay().scaleFactor }, null, 2));
    clearTimeout(watchdog);
    app.exit(checks.every(item => item.pass) ? 0 : 1);
  });
}

async function run() {
  for (const file of ['owner-ready.json', 'owner-release']) fs.rmSync(path.join(out, file), { force: true });
  // Both actors own isolated userData. No other process or existing app is touched.
  owner = spawn(process.execPath, [__filename, ...args, '--owner'], { stdio: 'ignore' });
  const ownerDeadline = Date.now() + 6000;
  while (!fs.existsSync(path.join(out, 'owner-ready.json')) && Date.now() < ownerDeadline) await delay(50);
  const ownership = JSON.parse(fs.readFileSync(path.join(out, 'owner-ready.json'), 'utf8'));
  if (!ownership.registered) throw Error('Test chord was unavailable before the fixture; close the conflicting test process and retry.');
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const config = { get: key => ({ 'window.webPreferences': { preload: path.join(root, 'preload.js') }, 'window.minWidth': 200, 'window.minHeight': 100, 'window.maxWidth': 2000, 'window.maxHeight': 1400 })[key] };
  const base = { console, process, Buffer, Date, setTimeout, clearTimeout, setInterval, clearInterval, logger, config };
  const managerFile = path.join(root, 'src/managers/window.manager.js');
  const box = { ...base, module: { exports: {} }, __dirname: path.dirname(managerFile), require: key => key === 'electron' ? require('electron') : key === '../core/logger' ? { createServiceLogger: () => logger } : key === '../core/config' ? config : require(key) };
  vm.runInNewContext(fs.readFileSync(managerFile, 'utf8'), box, { filename: managerFile });
  manager = box.module.exports;
  for (const item of Object.values(manager.windowConfigs)) item.file = path.join(root, item.file);
  const fixtures = { 'get-settings': { activeSkill: 'dsa', codingLanguage: 'javascript' }, 'get-window-stats': { isInteractive: true }, 'get-speech-availability': { available: false }, 'get-shortcut-status': { shortcuts: [] }, 'managed-status': { authenticated: false }, 'get-session-history': [], 'get-capture-mode': { active: false }, 'get-root-mode': { isRootMode: false } };
  for (const channel of new Set([...fs.readFileSync(path.join(root, 'preload.js'), 'utf8').matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)/g)].map(match => match[1]))) {
    ipcMain.handle(channel, () => fixtures[channel] || { success: true });
  }
  // All UI files run unchanged. Window orchestration is narrowed to the two
  // tested surfaces, excluding settings, onboarding and unrelated services.
  manager.initializeWindows = async () => {
    for (const type of ['main', 'chat']) {
      const win = await manager.createWindow(type, false);
      manager.windows.set(type, win);
      for (const event of ['show', 'hide', 'resize', 'move']) win.on(event, () => events.push({ type, event, at: Date.now() }));
      manager.showWindow(type);
    }
  };
  let source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  if (args.includes('--omit-startup-recovery')) source = source.replace('this.startShortcutRecovery();', '/* negative control: startup recovery disconnected */');
  // Only Alt+A crosses the native boundary, remapped to a rare disposable chord.
  // Other production bindings are acknowledged without reserving user hotkeys.
  const shortcutBoundary = {
    register: (key, handler) => key === 'Alt+A' ? globalShortcut.register(chord, handler) : true,
    isRegistered: key => key === 'Alt+A' ? globalShortcut.isRegistered(chord) : true,
    unregister: key => { if (key === 'Alt+A') globalShortcut.unregister(chord); },
    unregisterAll: () => globalShortcut.unregisterAll()
  };
  const Controller = vm.runInNewContext(source.slice(source.indexOf('class ApplicationController {'), source.indexOf('const gotSingleInstanceLock')) + '\nApplicationController', { ...base, app, powerMonitor, globalShortcut: shortcutBoundary, windowManager: manager, sessionManager: { addEvent() {} } });
  controller = Object.create(Controller.prototype);
  Object.assign(controller, { isRootMode: false, windowGap: null, firstRunManager: { ensureEnv() {} }, managedSession: { restore: async () => {} }, getSetupStatus: () => ({ needsOnboarding: false }), getCaptureHotkey: () => 'CommandOrControl+Shift+Space', setupWhisperModelPreparation() {}, setupPermissions() {}, setupNetworkConfiguration() {}, updateAppIcon() {} });
  await controller.onAppReady();
  check('actual onAppReady reaches readiness', controller.isReady === true);
  check('native conflict is reported unavailable', controller.getShortcutStatus().shortcuts.find(row => row.accelerator === 'Alt+A')?.registered === false);
  fs.writeFileSync(path.join(out, 'owner-release'), 'release');
  await Promise.race([new Promise(resolve => owner.once('exit', resolve)), delay(2000)]);
  check('conflicting owner exits normally', owner.exitCode === 0);
  await delay(1700);
  const observedFrom = Date.now();
  const chat = manager.getWindow('chat');
  for (const dimensions of [[500, 700], [540, 620], [480, 640]]) {
    chat.setContentSize(...dimensions); await delay(250);
    const actual = chat.getContentSize();
    const tolerance = screen.getPrimaryDisplay().scaleFactor % 1 ? 1 : 0;
    check(`chat resizes to ${dimensions.join('x')}`, actual.every((value, i) => Math.abs(value - dimensions[i]) <= tolerance), actual.join('x'));
    const hashes = new Set(), headerHashes = new Set();
    let controlsPresent = true;
    let minimumAlpha = 255, sampledPixels = 0;
    for (let n = 0; n < 10; n++) {
      if (args.includes('--inject-renderer-flicker')) await chat.webContents.executeJavaScript(`document.querySelector('.chat-header').style.visibility = '${n % 2 ? 'hidden' : 'visible'}'`);
      const dom = await chat.webContents.executeJavaScript(`(() => {
        const visible = el => { if (!el) return false; const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility==='visible' && s.display!=='none' && Number(s.opacity)>0; };
        const header=document.querySelector('.header-title'),r=header.getBoundingClientRect();
        return {present: /Live Transcription.*Chat/s.test(header.textContent) && visible(header) && ['chatSkillSelect','chatCaptureBtn','chatExamBtn','clearHistoryBtn','messageInput','sendButton'].every(id=>visible(document.getElementById(id))) && !document.getElementById('chatCloseBtn'), header:{x:r.x,y:r.y,width:r.width,height:r.height}};
      })()`);
      controlsPresent = controlsPresent && dom.present;
      const image = await chat.webContents.capturePage();
      const { width, height } = image.getSize();
      const ratio = width / chat.getContentSize()[0];
      const headerRegion = image.crop({x:Math.floor(dom.header.x*ratio),y:Math.floor(dom.header.y*ratio),width:Math.floor(dom.header.width*ratio),height:Math.floor(dom.header.height*ratio)});
      headerHashes.add(crypto.createHash('sha256').update(headerRegion.toBitmap()).digest('hex'));
      const region = image.crop({ x: Math.floor(width * .1), y: Math.floor(height * .25), width: Math.floor(width * .8), height: Math.floor(height * .35) });
      const bitmap = region.toBitmap();
      for (let i = 3; i < bitmap.length; i += 4) minimumAlpha = Math.min(minimumAlpha, bitmap[i]);
      sampledPixels += bitmap.length / 4;
      const hash = crypto.createHash('sha256').update(bitmap).digest('hex'); hashes.add(hash);
      frames.push({ dimensions, sequence: n, hash, minimumAlpha });
      if (n === 0) fs.writeFileSync(path.join(out, `chat-${dimensions.join('x')}.png`), image.toPNG());
      await delay(100);
    }
    check(`chat blank region retains transparency ${dimensions.join('x')}`, minimumAlpha < 255, `${sampledPixels} pixels, minimum alpha ${minimumAlpha}`);
    check(`chat blank region stays stable ${dimensions.join('x')}`, hashes.size === 1, `${hashes.size} distinct hashes across ten frames`);
    check(`header text and controls remain present ${dimensions.join('x')}`, controlsPresent);
    check(`header pixels remain stable ${dimensions.join('x')}`, headerHashes.size === 1, `${headerHashes.size} distinct hashes across ten frames`);
  }
  const toolbar = await manager.getWindow('main').webContents.capturePage();
  fs.writeFileSync(path.join(out, 'toolbar.png'), toolbar.toPNG());
  const toolbarBitmap = toolbar.toBitmap();
  let toolbarAlpha = 255;
  for (let i = 3; i < toolbarBitmap.length; i += 4) toolbarAlpha = Math.min(toolbarAlpha, toolbarBitmap[i]);
  check('toolbar backing retains transparency', toolbarAlpha < 255, `minimum alpha ${toolbarAlpha}`);
  const deadline = Date.now() + 6000;
  while (!globalShortcut.isRegistered(chord) && Date.now() < deadline) await delay(100);
  check('startup lifecycle recovers released native shortcut automatically', globalShortcut.isRegistered(chord));
  check('no visibility churn while sampling and resizing', !events.some(event => event.at >= observedFrom && ['hide', 'show'].includes(event.event)));
  check('renderers remain visible and alive', [...manager.windows.values()].every(win => !win.isDestroyed() && win.isVisible() && !win.webContents.isCrashed()));
  check('no renderer or startup errors', errors.length === 0, JSON.stringify(errors));
}
