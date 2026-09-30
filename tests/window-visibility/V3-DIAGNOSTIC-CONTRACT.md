# Temporary in-app visibility diagnostics

This diagnostic contract adds to the v2 persistent-visibility behavior. V2 remains active. No production or previously authored QA files were edited to author these checks.

```powershell
node --test tests/window-visibility/diagnostic-v3.test.cjs
```

## Acceptance boundary

The tests exercise the real ApplicationController constructor, startup, Electron event registration, global-shortcut registration, and full WindowManager. The fake Electron BrowserWindows are the same objects owned by WindowManager. Their visible/topmost/minimized/health/bounds values can change without emitting app events, so a passing observer must actually resample window state. A virtual clock advances startup, sampling, and a minute of heartbeats in under a second. The real `will-quit` event must stop diagnostic output.

Unrelated startup services, providers, setup persistence, and trust validation are fixtures. Unlike v2, this harness keeps the real controller `setupEventHandlers` method so lifecycle cleanup is tested through Electron's event boundary.

## Agreed log interface

- `logger.info('Root visibility snapshot', data)` includes an ISO `timestamp`, a `reason` of `initial`, `change`, or `heartbeat`, and `windows.main` / `windows.chat`. An optional immediate snapshot after a shortcut can use reason `shortcut`.
- Each window includes `visible`, `alwaysOnTop`, `minimized`, `destroyed`, `webContentsDestroyed`, `bounds` (`x`, `y`, `width`, `height`), and a string `hwnd` when available or null otherwise. Unavailable fields on destroyed windows may be null.
- `logger.info('Root visibility shortcut', data)` includes an ISO `timestamp` and `accelerator` on receipt of root Ctrl+Shift+V/C, even if revealing an already-visible window does not change state. Before/after snapshots are optional.
- Root Windows starts the observer automatically. Normal Windows and all macOS modes produce neither diagnostic snapshots nor diagnostic shortcut receipts.
- Sampling is approximately 500 ms. The acceptance check requires a changed window to appear in a snapshot within 750 ms. Unchanged state emits only a heartbeat about every 10 seconds; a simulated minute must produce five to eight such records, with nine-to-eleven-second gaps.
- No page content, window titles, screenshots, or pixels are read or logged. Fixture methods for title/page/pixel reads are monitored and rejected. Diagnostic metadata is checked for content-bearing keys.

## Red result and calibration

On 2026-09-26, Node v22.23.3: **9 checks, 4 pass, 5 fail, exit 1**. Current code has no diagnostic snapshot/receipt output, so initial state, changed state, heartbeat, shortcut receipts, and running-observer cleanup acceptance all fail. Startup itself reaches readiness without fixture errors.

The passing calibration check accepts literal known-good state/heartbeat records and rejects absent snapshots, stale state, per-sample noisy output, and title/content/pixel metadata. Three non-target-mode cases pass. These oracle controls validate the assertions; they are not a claim that a complete known-good production implementation already exists. The existing no-recorder source supplies the integration negative control.

`v3-red-result.txt` preserves TAP output. `v3-red-evidence.json` records command, runtime, source/test hashes before and after the run. The test uses Node's experimental MockTimers API, which emits an expected runtime warning.

## Practical limits

These checks prove main-process application behavior at fake Electron boundaries. They do not establish native HWND readability under another application, actual Windows Z order, native key delivery, on-disk Winston flushing/rotation, installed-package parity, or browser-page visibility. The virtual clock cannot reproduce a blocked main-process event loop. It is possible to fail to receive a native hotkey without a receipt; the tests only prove that delivered callbacks are recorded. No browser, installed app, or external recorder is launched.

The source-class load boundary and the agreed diagnostic log schema are intentional harness dependencies. Cleanup checks output cessation, not process termination or all unrelated timers. Renderer crash detection beyond `webContentsDestroyed` may be added as extra metadata without changing this contract.
