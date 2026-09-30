# Diagnostic v3.1: regression checks for review findings

This additive contract preserves the existing frozen v3 tests. It adds checks for both repeated shortcut callbacks and failure of the optional native-window-handle read.

Current implementation:

```powershell
node --test tests/window-visibility/diagnostic-v31.test.cjs
```

Known-broken control:

```powershell
node --require ./tests/window-visibility/v31-broken-control.cjs.txt --test tests/window-visibility/diagnostic-v31.test.cjs
```

The control intercepts only the QA VM's read of main.js, replacing its in-memory window sampler with the exact earlier reviewed method and removing unchanged-shortcut snapshot suppression. It never writes main.js or modifies an installed app. The `.txt` extension keeps the preload control outside test discovery. Source anchors are checked so a changed implementation cannot silently skip the intended mutation.

## Required behavior

1. Thirty Ctrl+Shift+V callbacks at 30 ms intervals retain all thirty receipt events and emit zero full snapshots when window state is unchanged. A real hide followed by shortcut recovery still gets sampled.
2. Ctrl+Shift+C has the same behavior.
3. A native-handle exception leaves the known-live window correctly reported as alive, visible, topmost, not minimized, and with valid bounds/webContents health. Its HWND becomes null. A continuing outage produces one warning and one state-change snapshot, followed by the ordinary heartbeat policy. Successful handle recovery permits one fresh warning if a later separate outage occurs.

## Calibration results

On 2026-09-26, Node v22.23.3:

- Current production source: **3 passed, 0 failed, exit 0**.
- Restored broken behavior in memory: **0 passed, 3 failed, exit 1**. Both shortcut cases produce 30 full unchanged snapshots in 900 ms; optional HWND failure reports `destroyed: true` for a live window.

`v31-green-result.txt` and `v31-broken-result.txt` preserve output. `v31-evidence.json` records commands, results, and hashes. The original v3 SHA256 remains `BA4E34A147D9BBD7298C1D3A3E850D19218DCE60AB9E4F694339B288CA053D73`.

## Boundaries

The new test carries forward the real controller/window-manager seam and virtual-clock harness in a new file; logger warnings are now also captured. Tests do not call a private sampler directly. The HWND exception is injected at fake Electron's native-handle API boundary, and shortcuts use the callbacks registered with fake Electron.

The broken control is a reconstruction of the two previously inspected methods, not a complete archived checkout of the earlier working tree. Native HWND behavior, installed parity, disk log transport, and actual overlay visibility remain outside this check. Receipt events intentionally remain one per callback; this contract bounds redundant full snapshots, not delivery-attribution records.
