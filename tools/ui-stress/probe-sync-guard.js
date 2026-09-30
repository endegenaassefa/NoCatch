// Zero-frame validation probe for the root-mode topmost guard.
// Creates a victim window with the SAME synchronous guard logic shipped in
// src/managers/window.manager.js, then lets an external PowerShell attacker
// strip WS_EX_TOPMOST / re-order it. Any observed demotion sample = FAIL.
//
// Run: node_modules\electron\dist\electron.exe tools\ui-stress\probe-sync-guard.js [lifetimeMs] [x] [y] [w] [h]
// Files (in tools/ui-stress): probe-hwnd.txt (hwnd for the attacker),
// probe-sync-guard.log (victim-side evidence).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const HWND_FILE = path.join(DIR, 'probe-hwnd.txt');
const LOG_FILE = path.join(DIR, 'probe-sync-guard.log');
const log = (line) => fs.appendFileSync(LOG_FILE, `${Date.now()} ${line}\n`);

const lifetimeMs = Number(process.argv[2] || 90000);
const px = Number(process.argv[3] || 100);
const py = Number(process.argv[4] || 950);
const pw = Number(process.argv[5] || 300);
const ph = Number(process.argv[6] || 120);

const WM_WINDOWPOSCHANGING = 0x0046;
const WM_WINDOWPOSCHANGED = 0x0047;
const WM_STYLECHANGED = 0x007D;
const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;

process.on('exit', () => log('probe exit'));
process.on('uncaughtException', (e) => { log(`uncaught: ${e.message}`); process.exit(3); });

app.whenReady().then(() => {
  fs.rmSync(LOG_FILE, { force: true });
  const window = new BrowserWindow({
    x: px, y: py, width: pw, height: ph,
    show: false, frame: false, alwaysOnTop: true, skipTaskbar: true,
  });
  window.setAlwaysOnTop(true, 'pop-up-menu');

  let blocks = 0;
  const state = { reasserting: false };
  const reassert = () => {
    if (window.isDestroyed() || !window.isVisible()) return;
    if (state.reasserting) return;
    state.reasserting = true;
    try { window.setAlwaysOnTop(true, 'pop-up-menu'); }
    catch (e) { log(`reassert failed: ${e.message}`); }
    finally { state.reasserting = false; }
    blocks += 1;
    log(`blocked ${blocks}`);
  };
  const guardStyleChanged = (wParam, lParam) => {
    try {
      if (wParam.readInt32LE(0) !== GWL_EXSTYLE) return;
      const oldStyle = lParam.readUInt32LE(0);
      const newStyle = lParam.readUInt32LE(4);
      if ((oldStyle & WS_EX_TOPMOST) && !(newStyle & WS_EX_TOPMOST)) reassert();
    } catch (_) {}
  };
  const guardPositionChanged = () => {
    try { if (!window.isAlwaysOnTop()) reassert(); } catch (_) {}
  };

  window.hookWindowMessage(WM_STYLECHANGED, guardStyleChanged);
  window.hookWindowMessage(WM_WINDOWPOSCHANGING, guardPositionChanged);
  window.hookWindowMessage(WM_WINDOWPOSCHANGED, guardPositionChanged);

  window.loadURL('data:text/html,<body style="background:#123456;color:#fff;font-family:sans-serif">guard probe</body>')
    .then(() => {
      window.showInactive();
      const hwnd = window.getNativeWindowHandle().readBigUInt64LE(0).toString(16);
      fs.writeFileSync(HWND_FILE, hwnd);
      log(`ready hwnd=${hwnd} topmost=${window.isAlwaysOnTop()}`);
    });

  // Auto-exit after the configured lifetime (soak runs pass a large value).
  setTimeout(() => { log(`done blocks=${blocks}`); app.exit(0); }, lifetimeMs);
});
