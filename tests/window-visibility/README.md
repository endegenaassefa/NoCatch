# Window visibility regression checks

The active requirement and command are in `V2-CONTRACT.md`. V1 below is historical: `visibility.test.cjs` was retired as `historical-visibility-v1.cjs.txt` because its later-root-shortcut-hides expectation was superseded. Its original bytes and red evidence are preserved; see `v1-retirement.json`. The active test is `root-persistent-v2.test.cjs`.

Run from the repository root in native Windows PowerShell:

```powershell
node --test tests/window-visibility/visibility.test.cjs
```

The independent QA author run on 2026-09-26, Node v22.23.3, exited 1 with four failures and two passes. `red-result.txt` contains the TAP output; `red-evidence.json` records the command and source/test hashes.

## Behavioral boundaries

- Completed root startup displays toolbar and chat without a shortcut.
- Incomplete onboarding leaves these hidden; completion displays both.
- Electron's registered chat callback is idempotent over 40 repeated callbacks spaced 30 ms apart.
- Electron's registered visibility callback opens hidden windows once across 41 repeats spaced 30 ms apart, spanning more than one second. A separate press after 1.2 seconds of quiet still hides them.
- The registered close-window IPC keeps chat hidden through delayed startup work and permits explicit reopening.
- Ordinary Windows startup retains its toolbar-only behavior.

The first four checks fail on the authoring baseline. Visibility repeats produce 42 alternating transitions, beginning with show and ending with hide. Chat repeats produce 40 alternating hide/show transitions. Deliberate close and ordinary startup pass.

## Scope and limitations

The tests execute the actual ApplicationController constructor, startup, shortcut registration, IPC registration/completion/close callbacks, and the complete WindowManager module. Fake Electron windows expose visible state and transition history. Unrelated controller boot services (stealth, event wiring, model preparation, permissions, network configuration, and app icon updates) are disconnected. Setup persistence and provider services are fixtures; trust validation is outside this contract.

The controller is loaded at the existing class boundary because main.js starts the application when required. A change to that source boundary can require harness maintenance. These are app-facing behavior checks, not a native Electron launch. They do not establish Windows Z order, actual global keyboard delivery, arbitrary key-repeat delays, installed-package parity, or visibility over LockDown Browser. No browser or installed app is launched or modified. Native live verification remains necessary for occlusion.

These QA assets are owned under tests/window-visibility. The builder may read and run them; production changes must not weaken the contract to pass.
