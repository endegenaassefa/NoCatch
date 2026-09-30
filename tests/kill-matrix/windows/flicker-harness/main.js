// flicker-harness — throwaway Electron harness that replicates the chat
// window's composition config exactly, to make the exam-time flicker
// reproducible without the elevated app or an LDB session.
//
// Modes (argv --mode=...):
//   glass  (default) transparent window + backdrop-filter (production chat)
//   noblur            transparent window, no backdrop-filter
//   opaque            opaque window + solid background, no backdrop-filter
//
// Run: <electron-binary> <this-dir> --mode=glass
const { app, BrowserWindow } = require('electron');

const argv = process.argv.slice(1);
const modeArg = argv.find((a) => a.startsWith('--mode='));
const mode = modeArg ? modeArg.split('=')[1] : 'glass';

app.setPath('userData', require('path').join(require('os').tmpdir(), 'flicker-harness-data'));

const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  html, body { margin: 0; padding: 0; overflow: hidden; ${mode === 'opaque' ? 'background: #151923;' : 'background: transparent;'} font-family: "Segoe UI", sans-serif; }
  .container {
    width: 100%; height: 100vh; box-sizing: border-box;
    background: linear-gradient(135deg, rgba(0,0,0,${mode === 'opaque' ? '0.85' : '0.3'}) 0%, rgba(20,20,20,${mode === 'opaque' ? '0.92' : '0.4'}) 100%);
    ${mode !== 'opaque' ? 'backdrop-filter: blur(25px);' : ''}
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.1);
    display: flex; flex-direction: column;
  }
  .header {
    padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.08);
    background: rgba(0,0,0,0.2);
    ${mode !== 'opaque' ? 'backdrop-filter: blur(10px);' : ''}
    color: rgba(255,255,255,0.95); font-size: 14px; font-weight: 600;
  }
  .messages { flex: 1; padding: 20px; overflow: hidden; }
  .message {
    margin-bottom: 16px; padding: 12px 16px;
    background: rgba(255,255,255,0.08);
    ${mode !== 'opaque' ? 'backdrop-filter: blur(5px);' : ''}
    border-radius: 8px; border-left: 3px solid rgba(255,255,255,0.2);
    color: rgba(255,255,255,0.9); font-size: 13px; line-height: 1.5;
  }
</style></head><body>
  <div class="container">
    <div class="header">Flicker harness — mode: ${mode}</div>
    <div class="messages">
      <div class="message">Question: Which two topics does the syllabus quiz cover?</div>
      <div class="message">Answer: Chapters one and two, with an emphasis on definitions and first principles.</div>
      <div class="message">This panel is the Cluely chat surface over a locked-down exam page.</div>
    </div>
  </div>
</body></html>`;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 500,
    height: 700,
    x: 1150,
    y: 100,
    frame: false,
    titleBarStyle: 'hidden',
    transparent: mode !== 'opaque',
    backgroundColor: mode === 'opaque' ? '#151923' : '#00000000',
    hasShadow: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: { backgroundThrottling: false, devTools: true, contextIsolation: true, nodeIntegration: false }
  });
  win.setTitle('FlickerHarness');
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.on('closed', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
