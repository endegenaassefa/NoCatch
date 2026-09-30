# Platform capability and capture API

Use `captureService.platformAdapter` in setup IPC so actual capture outcomes and
setup status share the same adapter. `createPlatformAdapter({ electron, platform,
now })` also supports isolated tests. Production defaults load Electron lazily.

- `checkCapabilities()` returns `{ platform, screen, microphone }` without opening
  a prompt or capturing data. Each capability has `availability` (API/platform
  support), `permission`, `health` (last explicit operation), `reason`,
  `recoveryAction`, `checkedAt`, and `lastOperationAt`. Microphone availability
  does not imply that an audio input device exists.
- `requestCapability('screen' | 'microphone')` must follow a user action. On macOS,
  microphone uses `askForMediaAccess`; screen enumerates sources without image
  thumbnails, which may trigger consent. Neither marks runtime health healthy.
  On Windows microphone requests open privacy settings; screen requests explain
  that a real capture test is needed. Linux uses the desktop/portal flow during
  an explicit operation.
- `openSettings(kind)` opens System Settings on macOS and returns pane guidance,
  or a documented `ms-settings:` URI on Windows. Linux returns manual guidance.
- `reportOperation(kind, { success, reason })` records a completed operation.
  Call it from microphone tests only after obtaining/using a real audio stream,
  and close all test stream tracks afterward. Capture processing records its own
  outcome. Permission checks never count as successful operations.
- `getDisplayLayout()` and `captureService.listDisplays()` return cloned display
  metadata, primary identity, a `layoutRevision`, and `checkedAt`. Store and pass
  the revision with a selection. Origin, size, scale, rotation, display identity,
  and primary changes invalidate the snapshot.

`captureAndProcess({ displayId, area, areaCoordinateSpace, layoutRevision })`
preserves the PNG buffer/metadata response. `areaCoordinateSpace` defaults to
`image-pixels` for existing callers; new selection UIs can use `display-dip`
(local to the selected display) or `desktop-dip` (global Electron screen space).
DIP conversion uses actual thumbnail dimensions, rounds inward, and rejects
empty or out-of-bounds rectangles. Omitting `area` retains the left-half default.
An explicitly invalid area, failed crop, missing display, ambiguous source, or
changed layout rejects without returning a full-screen image.

Display sources must match `display_id`. Sources without that identity, including
some Linux portal configurations, fail with `DISPLAY_SOURCE_UNAVAILABLE`; the
service does not infer identity from matching resolution or source order.
Permission granted does not prove a nonempty or usable capture. The service
checks nonempty image data but does not claim protected/black content is readable.

Windows shortcuts should use Electron `CommandOrControl` for primary command
accelerators (Control on Windows/Linux, Command on macOS), and application-local
input should remain separate from OS permission state. This module installs no
global input hooks or native input helpers.

API references:

- [Electron media permission status and requests](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesgetmediaaccessstatusmediatype-windows-macos)
- [Electron display source identity and thumbnail sizing](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source)
- [Electron desktop capture and platform caveats](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Electron shell application opening](https://www.electronjs.org/docs/latest/api/shell#shellopenpathpath)
- [Microsoft Settings URIs](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings)

Run `node --test scripts/test-platform.js`. These are dependency-injected tests;
real OS consent prompts, capture backends, and mixed-DPI hardware still require
native acceptance testing.
