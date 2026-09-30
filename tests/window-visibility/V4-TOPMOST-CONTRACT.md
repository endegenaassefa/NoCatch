# V4: repair lost topmost state in Windows root mode

This additive contract targets the observed loss of the main/chat topmost flag while the process and windows remained alive and visible. Earlier visibility and diagnostic contracts remain active. Only new QA-owned files were created.

```powershell
node --test tests/window-visibility/topmost-v4.test.cjs
```

## Required behavior

- If a visible root Windows main/chat window externally loses its topmost flag, the existing observer detects and repairs it within one second. The native topmost call must not hide, show, or focus a window.
- Delivered Ctrl+Shift+V **and** Ctrl+Shift+C immediately repair either visible main/chat window, without waiting for an observer tick. This both-window scope was confirmed by the coordinator before authoring.
- Healthy windows receive no repair calls, including across repeated shortcuts. A successful repair stops further calls while state stays healthy.
- If a native repair is ignored or throws, the observer and both shortcut paths share a per-window retry interval of at least two seconds. Tests generate 200 alternating callbacks during six seconds and require bounded retries, not a stopped recovery loop or repeated native churn.
- Every attempted repair emits `Root visibility topmost repair` with ISO `timestamp`, `type` (`main` or `chat`), and boolean `success`. Success reflects the observed native topmost flag after the call; an ignored request or exception reports false. Additional fields are allowed.
- Intentionally hidden chat stays hidden and receives no automatic repair. Its existing explicit reveal action remains available.
- Normal Windows and macOS receive no automatic topmost repair.

## Independent red calibration

On 2026-09-26, Node v22.23.3: **10 checks, 5 pass, 5 fail, exit 1**. Current production does not attempt repair, so automatic recovery, immediate V recovery, immediate C recovery, and both failed-native retry cases fail. Healthy-window stability, deliberate hiding, and all three excluded-mode cases pass.

`v4-red-result.txt` preserves TAP output. `v4-red-evidence.json` records command, runtime, and source/test hashes before and after the run. These files establish red before the production repair was written.

## Test boundaries and limitations

The new test copies the existing QA fixture into a new file, preserving all frozen predecessors. It executes the real controller startup/observer/registered shortcuts and complete WindowManager. Only the Electron process boundary is fake. Topmost loss is injected directly into the fake BrowserWindow state without emitting a hide/show/focus event. Native topmost, show, hide, and focus calls are recorded with virtual timestamps. Native refusal is modeled both as a no-op and a thrown error.

The assertions observe Electron API outputs; they do not require a particular helper method or where recovery is implemented. The log schema is an agreed diagnostic interface. Virtual time makes retry windows deterministic and does not prove behavior during an actually blocked main-process event loop.

A successful native flag repair does **not** establish that the overlay is above LockDown Browser or any other topmost window. Native Z order, visual occlusion, renderer content, installed parity, and real keyboard delivery require separate live evidence. No browser or installed app is launched by this command.
