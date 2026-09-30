'use strict';

// Isolated native fixture: the real WindowManager creates the real main/chat
// BrowserWindows. The only mocked dependencies are config/logger; no app
// controller, account, hotkeys, or running exam instance is involved.
const { app, BrowserWindow, screen, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const [source, output, type, mode] = process.argv.filter(arg => !['--capture-pixels', '--trace-native', '--focus-test'].includes(arg)).slice(-4);
if (!source || !output || !['main', 'chat'].includes(type) || !['guard', 'control'].includes(mode)) {
  process.stderr.write('Usage: electron native-window-manager-probe.cjs SOURCE OUTPUT main|chat guard|control\n');
  process.exit(2);
}
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
const report = { type, mode, events: [], errors: [] };
const record = (event, fields = {}) => report.events.push({ at: Date.now(), event, ...fields });
const flush = () => fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify(report, null, 2));
const logger = {
  info: (message, fields) => record(message, fields),
  warn: (message, fields) => record(message, fields),
  debug: (message, fields) => record(message, fields),
  error: (message, fields) => report.errors.push({ message, fields }),
};
let manager;
process.on('uncaughtException', error => { report.errors.push({ fatal: error.stack }); flush(); app.exit(3); });

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const config = { get: key => ({
    'window.webPreferences': { preload: path.join(source, 'preload.js') },
    'window.minWidth': 200, 'window.minHeight': 100,
    'window.maxWidth': 2000, 'window.maxHeight': 1400,
  })[key] };
  const managerFile = path.join(source, 'src/managers/window.manager.js');
  const box = {
    module: { exports: {} }, __dirname: path.dirname(managerFile),
    require: key => key === 'electron' ? require('electron')
      : key === '../core/logger' ? { createServiceLogger: () => logger }
      : key === '../core/config' ? config : require(key),
    process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.runInNewContext(fs.readFileSync(managerFile, 'utf8'), box, { filename: managerFile });
  manager = box.module.exports;
  manager.bindWindows = false;
  for (const item of Object.values(manager.windowConfigs)) item.file = path.join(source, item.file);
  const main = await manager.createWindow('main', false);
  manager.windows.set('main', main);
  const chat = await manager.createWindow('chat', false);
  manager.windows.set('chat', chat);
  const target = type === 'main' ? main : chat;
  const other = type === 'main' ? chat : main;
  let collectNative = false;
  if (process.argv.includes('--trace-native')) {
    const originalHook = target.hookWindowMessage.bind(target);
    let captured = 0;
    target.hookWindowMessage = (message, callback) => originalHook(message, (wParam, lParam) => {
      if (collectNative && captured++ < 300) {
        record('native-message', { message: `0x${message.toString(16)}`,
          wLength: wParam.length, lLength: lParam.length,
          wHex: wParam.subarray(0, 48).toString('hex'),
          lHexBefore: lParam.subarray(0, 48).toString('hex') });
      }
      const result = callback(wParam, lParam);
      if (collectNative && captured <= 300) {
        record('native-after', { message: `0x${message.toString(16)}`,
          lHexAfter: lParam.subarray(0, 48).toString('hex') });
      }
      return result;
    });
  }
  if (mode === 'guard') manager.enableRootTopmostGuards();
  if (process.argv.includes('--focus-test')) {
    const owner = new BrowserWindow({ width: 200, height: 90, x: 40, y: 320,
      show: false, skipTaskbar: true, focusable: true, backgroundColor: '#202020' });
    await owner.loadURL('data:text/html,<body style="background:#202020;color:white">focus owner</body>');
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const focused = stage => record(stage, { ownerFocused: owner.isFocused(),
      mainFocused: main.isFocused(), chatFocused: chat.isFocused(),
      mainVisible: main.isVisible(), chatVisible: chat.isVisible() });
    async function prime() {
      main.hide(); chat.hide(); manager.isVisible = false;
      owner.show(); owner.focus(); await delay(150);
      focused('owner-ready');
    }
    await prime();
    manager.showWindow('main'); await delay(650); focused('showWindow-main');
    await prime();
    manager.showWindow('chat'); await delay(650); focused('showWindow-chat-screenshot');
    await prime();
    manager.activeWindow = 'main'; manager.toggleVisibility(); await delay(150); focused('toggleVisibility-main-active');
    await prime();
    manager.activeWindow = 'chat'; manager.toggleVisibility(); await delay(150); focused('toggleVisibility-chat-active');
    await prime();
    manager.switchToWindow('chat'); await delay(150); focused('switchToWindow-chat');
    flush();
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    app.exit(0);
    return;
  }
  other.hide();
  // Optional measurement mode. Production capture exclusion hides its pixels
  // from GDI, so turn it off only when measuring compositor output.
  if (process.argv.includes('--capture-pixels')) target.setContentProtection(false);
  const display = screen.getPrimaryDisplay().workArea;
  const bounds = { x: display.x + 35, y: display.y + 60, width: type === 'main' ? 300 : 260, height: type === 'main' ? 45 : 220 };
  target.setBounds(bounds);
  target.webContents.on('render-process-gone', (_event, details) => report.errors.push({ rendererGone: details.reason }));
  await target.webContents.executeJavaScript(`(() => {
    const marker=document.createElement('div'); marker.id='native-probe-marker';
    Object.assign(marker.style,{position:'fixed',left:'8px',top:'8px',width:'24px',height:'24px',background:'#ff00ff',zIndex:'2147483647',pointerEvents:'auto'});
    document.body.appendChild(marker);
  })()`);
  manager.showOnCurrentDesktop(target);
  const cover = new BrowserWindow({ ...bounds, show: false, frame: false, transparent: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, backgroundColor: '#00ff00' });
  await cover.loadURL('data:text/html,<html><body style="margin:0;background:%2300ff00"></body></html>');
  cover.setAlwaysOnTop(true, 'pop-up-menu');
  cover.showInactive();
  // Raise the protected production window above the competing topmost window.
  manager.setWindowAlwaysOnTop(target);
  await new Promise(resolve => setTimeout(resolve, 650));
  const hwnd = win => win.getNativeWindowHandle().readBigUInt64LE(0).toString(16);
  Object.assign(report, { targetHwnd: hwnd(target), coverHwnd: hwnd(cover), bounds,
    sample: { x: bounds.x + 20, y: bounds.y + 20 },
    topmost: target.isAlwaysOnTop(), visible: target.isVisible(),
    marker: await target.webContents.executeJavaScript('Boolean(document.getElementById("native-probe-marker"))') });
  collectNative = true;
  flush();
  const endAt = Date.now() + 90000;
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(output, 'stop')) || Date.now() >= endAt) {
      clearInterval(timer);
      record('finished', { topmost: target.isDestroyed() ? null : target.isAlwaysOnTop() });
      flush();
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
      app.exit(0);
    }
  }, 100);
}).catch(error => { report.errors.push({ fatal: error.stack }); flush(); app.exit(3); });
