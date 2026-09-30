# Prepared native Windows topmost calibration

This script is prepared for an explicitly supplied post-install root PID. It has not been run against the app during authoring. PowerShell syntax was parsed and the C# helper was compiled without invoking native functions.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/window-visibility/calibrate-native-topmost.ps1 -TargetPid <NEW_ROOT_PID> -Capture <CAPTURE_DIRECTORY> -ExpectedExe <INSTALLED_EXE_PATH>
```

`ExpectedExe` defaults to `%LOCALAPPDATA%\Programs\screen-reader-util\screen-reader-util.exe`. `PidFile` defaults to `%TEMP%\cluely-root.pid`. Optional `MainHwndHex` and `ChatHwndHex` can identify both windows explicitly using current, separately verified safe diagnostic values.

## Ownership and selection

The script checks the launcher's exact pidfile PID + immutable WMI creation ticks + process-name contract. It also verifies the expected executable path using a pinned native process handle and checks that native creation time matches the WMI value at CIM's microsecond precision. Holding this handle and checking liveness prevents a reused PID from becoming a later mutation target. Launcher ownership is rechecked before each demotion and after observation. The script does not infer target ownership from a process name alone.

No elevation/token or command-line-stamp query is required, per the coordinator's instruction to follow the launcher ownership contract. This proves launcher-owned root identity, not an independent token-integrity attestation. Run in the same interactive desktop session; cross-integrity access restrictions fail the calibration rather than bypassing them.

Automatic HWND selection requires exactly two visible windows owned by that PID, one with distinct toolbar geometry (height 15–150, width at least 30) and the other with chat geometry (height and width at least 250). Ambiguity fails closed. Explicit HWNDs must both be visible, distinct, and owned by the pinned process; their semantic roles come from the operator's safe diagnostic mapping.

## Controlled change and observation

For each window in turn, the script requires visible/non-minimized/topmost starting state. It uses `SetWindowPos(HWND_NOTOPMOST, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)` and observes native `WS_EX_TOPMOST` recovery within 2,000 ms. A monotonic stopwatch measures the interval. It never calls a show/hide/focus API or sends a shortcut.

Polling checks visibility, minimized state, geometry, HWND ownership, and unchanged foreground HWND. WinEvent hooks observe target show/hide/focus events and global foreground changes, with a message pump and a short drain period. A clean pass requires actual demotion to be observed, timely recovery, stable recovered state during settling, and no relevant events. Avoid user interaction during the few-second run; unrelated foreground changes make the result fail rather than attributing them to the app.

If recovery fails, the script attempts to restore the original topmost state only after revalidating ownership, using the same nonactivating position flags. This cleanup is marked separately and can never make a failed app-recovery check pass.

Results use a unique `native-topmost-<UTC>-<random>-result.json` file under the selected capture directory. They include ownership metadata, native samples, timestamps, recovery latency, event IDs/handles, and any failure/cleanup result. No titles, renderer text, screen pixels, or exam content are accessed. No browser is launched.

## Limits

This calibrates actual native flag restoration without an exam browser. It does not prove visibility above another topmost window or successful recovery under browser activity. Event-hook silence plus polling is evidence, not proof that an arbitrarily brief change could never evade OS event delivery. A run whose demotion is not observed is inconclusive and reported failed. Native execution remains pending install/PID authorization.
