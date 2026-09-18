# Capture Signature Probes — macOS 26.5.2 (2026-09-18)

Empirical results from running each capture API on this exact machine while
observing the unified log (`log stream`) and polling the same CoreGraphics
detection APIs LockDown Browser imports (per `research/ldb-static-recon.md`).

All probes ran from the user session (uid 501); TCC responsibility resolved to
`com.apple.Terminal` (already granted Screen Recording → `authValue=2`).

## 1. API ladder on macOS 26: exactly one working rung

| API | SDK status | Runtime result | Observable signature |
|---|---|---|---|
| ScreenCaptureKit (`SCStream`) | supported | **works** (frames delivered) | `replayd` accepts a client connection + `fetchShareableContent`; `tccd` logs `kTCCServiceScreenCapture` request naming the accessor binary |
| `CGWindowListCreateImage` | obsoleted 15.0 | symbol present, returns **nil** | still emits a `kTCCServiceScreenCapture` request before failing |
| `CGDisplayStream` | obsoleted 15.0 | stream object created, **zero frames** | none observed |

**Conclusion: ScreenCaptureKit is the only capture path that yields pixels on
this OS. There is no legacy fallback.**

## 2. What LDB's own detection APIs see (simulated)

Probe: `sck-hold` held a live 1280×720 SCK stream at 10 fps for 10 s while a
separate process polled, every 250 ms:

- `CGDisplayIsCaptured(main)` → **false for the entire stream lifetime**
- `CGDisplayIsInMirrorSet(main)` → **false for the entire stream lifetime**

LDB imports both (`_CGDisplayIsCaptured`, `_CGDisplayIsInMirrorSet`,
`checkDisplayMirroringTimer`). **An SCK capture session is invisible to LDB's
CoreGraphics capture-detection path.** (These legacy checks cover IOFramebuffer-
style whole-display capture / display mirroring, not modern SCK streams.)

## 3. What IS observable during a capture (from the logs)

- `replayd`: `RPConnectionManager` accepts the capturing process as a client
  (`accepted client connection PID: <pid>`), then
  `fetchShareableContentWithOption` + a `tcc_send_request_authorization` IPC.
- `tccd`: `TCCAccessRequest service=kTCCServiceScreenCapture` with a full
  attribution chain: `responsible=<process that launched the capturer>`,
  `accessing=<capturer binary path>`.
- These log lines are visible to any same-user process via
  `log stream` / `log show` (we captured them unprivileged). A motivated
  proctor could stream these — but there is no static evidence LDB does.

## 4. TCC attribution chain observed

```
responsible = com.apple.Terminal (pid 691, the launching terminal)
accessing   = <capturer binary> (e.g. sck-grab, /opt/anaconda3/bin/python3.12)
requesting  = com.apple.replayd (the broker that performs the capture)
```

Implication for the shield helper: if the helper is first run via `sudo` from
this same Terminal context, the Screen Recording grant already held by
`com.apple.Terminal` covers it. For launchd-spawned runs the responsible
process becomes launchd — the helper binary must then be granted Screen
Recording explicitly (one-time System Settings approval, or MDM PPPC).

## 5. Open items

- Whether LDB observes capture via replayd/tccd log streaming, WindowServer
  `_XHWCaptureDesktop` observation, or not at all — undetermined statically;
  the overlay-window trigger (via `CGWindowListCopyWindowInfo` owner PIDs) is
  the better-fitting hypothesis for the three kill incidents (see
  SOLUTION-DESIGN.md threat model).
- `SCScreenshotManager` (undocumented, macOS ≥14.4, chip-free per Chromium
  source) was not probed — listed as a possible future fallback, not primary.
