# LDB Static Reconnaissance — LockDown Browser.app (v2.1.5, build 7613)

Read-only static analysis of `/Applications/LockDown Browser.app`. Every claim cites
the command output that produced it. Binary paths below are relative to the bundle root.

---

## 1. Bundle tree

```
/Applications/LockDown Browser.app            (root:admin, v2.1.5 / 7613)
├── Contents/_CodeSignature/
├── Contents/embedded.provisionprofile        (12,356 B — Apple provisioning profile)
├── Contents/Info.plist
├── Contents/PkgInfo
├── Contents/MacOS/
│   ├── LockDown Browser                      (12,295,280 B, Mach-O x86_64 executable)
│   └── LDBUpdateHelper                       (51,792 B, Mach-O x86_64 executable)
├── Contents/Frameworks/
│   ├── Chromium Embedded Framework.framework (CEF 142.0.17, Chromium 142.0.7444.176)
│   │   └── Versions/A/{Chromium Embedded Framework,
│   │       Libraries/{libEGL,libGLESv2,libvk_swiftshader,libcef_sandbox}.dylib}
│   ├── ChromiumTabs.framework
│   ├── LockDown Browser Helper.app                   ┐
│   ├── LockDown Browser Helper (Alerts).app          │ all five executables are
│   ├── LockDown Browser Helper (GPU).app             │ BYTE-IDENTICAL generic CEF
│   ├── LockDown Browser Helper (Plugin).app          │ launcher stubs (diff -q =
│   └── LockDown Browser Helper (Renderer).app        ┘ identical)
├── Contents/Library/LaunchServices/
│   └── com.Respondus.LDBHelperTool          (63,760 B — privileged helper tool binary,
│                                             NOT a plist; embeds __info_plist +
│                                             __launchd_plist sections)
└── Contents/Resources/
    ├── screen-recording-permission{,2,3}.png   (user-facing instructions to grant
    │                                            screen-recording permission)
    ├── ldbssd.rx                               (`file`: "data" — opaque blob)
    ├── precache.dat                            (`file`: gzip compressed data)
    ├── uninstall-helper-tool.sh
    ├── LockDown Browser.scriptSuite / .scriptTerminology   (AppleScript dictionary)
    └── extensions/Kurzweil/                    (assistive-tool integration)
```

**XPC services / login items:** none. `ls Contents/XPCServices` → "no XPCServices dir";
no `LoginItems` dir; the only launchd-facing artifact is the LDBHelperTool.

Evidence for helper-stub identity:
```
diff -q mainhelper.strings gpu.strings → IDENTICAL (4,509 strings lines each)
```

---

## 2. Per-binary entitlements and linked frameworks

### `Contents/MacOS/LockDown Browser` (main executable)
**Entitlements** (`codesign -d --entitlements :-`):
```xml
com.apple.application-identifier         8CA6NAN723.com.Respondus.LockDownBrowser
com.apple.developer.automatic-assessment-configuration   true   ← APPLE-SPECIAL ENTITLEMENT
com.apple.developer.team-identifier      8CA6NAN723
com.apple.security.automation.apple-events               true
com.apple.security.cs.allow-unsigned-executable-memory   true
com.apple.security.device.audio-input|bluetooth|camera|print|usb  true (each)
com.apple.security.temporary-exception.mach-lookup.global-name  [com.apple.assessmentagent]
keychain-access-groups                   [8CA6NAN723.*]
```

**Linked frameworks** (`otool -L`, 20 entries): libSystem, libz, **CoreGraphics**,
**IOSurface**, **AutomaticAssessmentConfiguration**, ChromiumTabs, **AVFoundation**,
Cocoa, AppKit, **IOKit**, Carbon, **ServiceManagement**, Security, Foundation,
ApplicationServices, CoreServices, CoreFoundation, libobjc, libc++.

**Imported syscalls/APIs of interest** (`nm -u`, `nm -um`):
```
_CGDisplayIsCaptured              (CoreGraphics)   ← "is the display being captured?"
_CGDisplayIsInMirrorSet           (CoreGraphics)   ← display-mirroring check
_CGDisplayStreamCreate            (CoreGraphics)   ← display content stream
_CGPreflightScreenCaptureAccess   (CoreGraphics)
_CGWindowListCopyWindowInfo       (CoreGraphics)   ← system-wide window enumeration
_kCGWindowBounds / _kCGWindowLayer / _kCGWindowOwnerName / _kCGWindowOwnerPID
_kill                             (from libSystem)
_proc_pidpath                     (from libSystem) ← pid → executable path
_sysctl / _sysctlbyname           (from libSystem)
_AXIsProcessTrusted               (ApplicationServices)
_SecCodeCheckValidity / _SecCodeCheckValidityWithErrors / _SecCodeCopyGuestWithAttributes
_SecCodeCopySelf / _SecCodeCopySigningInformation / _SecRequirementCreateWithString
_SecStaticCodeCheckValidity
_kSecCodeInfo{Certificates,Flags,Identifier,Status,TeamIdentifier}
```
**Absent:** EndpointSecurity.framework, ScreenCaptureKit.framework, libproc (direct),
CoreMedia (direct), ReplayKit — none appear in `otool -L` nor as `ES_`/`SCStream`
undefined symbols.

### `Contents/MacOS/LDBUpdateHelper`
No entitlements (empty dict). Links Foundation, Cocoa, AppKit, CoreFoundation only.
A plain updater stub (160 strings, nothing proctoring-relevant).

### `Contents/Library/LaunchServices/com.Respondus.LDBHelperTool` (privileged helper)
No embedded entitlements (SMJobBless helper; requirement lives in the main app's
`SMPrivilegedExecutables` and the tool's `SMAuthorizedClients`). Links Foundation +
Security only. Its embedded plists declare:
```
CFBundleIdentifier  com.Respondus.LDBHelperTool
SMAuthorizedClients identifier "com.Respondus.LockDownBrowser" (and OEM variant)
                    anchor apple generic ... subject.OU = "8CA6NAN723"
__launchd_plist     Label=com.Respondus.LDBHelperTool, MachServices={same name}
```
XPC interface (from its `__objc_methname` strings):
`getVersionWithReply:` `readLicenseKeyAuthorization:withReply:`
`writeLicenseKey:authorization:withReply:` `stopServiceAuthorization:withReply:`
`uninstallAuthorization:withReply:` `isValidLicenseKey:`
Authorization-rights strings: `com.Respondus.LockDownBrowser.{uninstall,stopService,
readLicenseKey,writeLicenseKey}` + `authenticate-admin`.
→ **Root helper exists in the bundle but its surface is license-key management only —
no process/kill interface.** (`PHTCommon` = Apple's EvenBetterAuthorizationSample
code family.) Note: it is **not currently installed** on this machine
(`ls /Library/PrivilegedHelperTools /Library/LaunchDaemons | grep -i respondus` → none).

### Helper stubs
`LockDown Browser Helper` and `(Alerts)`: no entitlements.
`(Renderer)` and `(GPU)`: `com.apple.security.cs.allow-jit` only.
`(Plugin)`: `allow-unsigned-executable-memory` + `disable-library-validation`.

### `Chromium Embedded Framework.framework`
No entitlements. 66 linked libraries, including **ScreenCaptureKit**, CoreMedia,
VideoToolbox, CoreImage, CoreVideo, AVFoundation, AVFAudio, IOKit, IOSurface.
Undefined symbols: `_OBJC_CLASS_$_SCShareableContent` (ScreenCaptureKit),
`_CGDisplayStream{Create,Start,Stop}`, `_CGWindowListCreateImage`,
`_kill`, `_proc_pidpath`, `_proc_pidinfo`, `_sysctl`.
→ CEF's capture/kill/proc imports are **Chromium's own media-capture and
process-management plumbing**, not Respondus-specific detection code.

### `ChromiumTabs.framework`
No entitlements. AppKit/Cocoa/Carbon/QuartzCore tab UI library.

---

## 3. Strings mining (curated hits)

### Main binary — `strings -a` → 44,193 lines

| Matched string | Context / meaning |
|---|---|
| `killProcessesTimer` | ObjC selector: **the kill-loop timer**. Neighbors in the string table: `kill:`, `killProcessesTimer`, `kind`, `kurzweil:` |
| `kill:` | direct kill selector present |
| `forceTerminate` | NSRunningApplication.forceTerminate — the SIGKILL-producing AppKit API |
| `runningApplications` / `runningApplicationsWithBundleIdentifier:` / `runningApplicationWithProcessIdentifier:` | NSWorkspace process enumeration |
| `checkProcessDeveloperIdTimer` | timer that **validates running processes' Developer ID** (pairs with the `SecCode*` imports + `getSignature`) |
| `pidPath`, `pidCommand` | pair with `_proc_pidpath` — resolve pid → path/command |
| `processBandwidthSnapshotTimer` | per-process network-bandwidth snapshots |
| `checkDisplayMirroringTimer` | **display-mirroring detection timer** |
| `cleanUpScreenShotsTimer` | deletes screenshots on a timer |
| `preventScreenSaverTimer`, `monitorFlashbeatTimer` | screen-saver suppression; heartbeat ("flashbeat") to proctoring server |
| `generalPasteboard` | clipboard polling source (matches the runtime `CFPasteboard` polling we logged) |
| `setMonitorRecordingStyle:`, `setRecording:`, `recordingButton`, `getScreenMeOriginalSetting` | screen/video recording feature UI ("Monitor" = Respondus Monitor proctoring) |
| `getMonitorExamId`, `getMonitorExamStatus`, `monitorPasswordBeginExam` | proctoring session state |
| `matchUrlToWhitelist:` | URL whitelist (web filtering — the only "whitelist" string) |
| `hotkeys_blocked` | hotkey blocking state |
| `getCanWebcam:`/`setCanWebcam:`, `webcamButton` | webcam controls |
| `setCanKurzweil:`/`getCanKurzweil:` | Kurzweil assistive-tool integration |
| `NSXPCConnection`, `initWithMachServiceName:options:`, `LDBHelperToolProtocol` | XPC to the helper tool |
| `MachTaskEvents`, `machSystemCalls` | mach task-event plumbing |
| `loadStaticRespondus` | self-reference |

**Explicitly ABSENT from the main binary (0 hits, case-insensitive):**
`SIGKILL`, `SIGTERM`, `SIGINT`, `killall`, `teams`, `zoom` (app), `allowlist`,
`blacklist`, `blocklist`, `denylist`, `ScreenCaptureKit`, `SCStream`,
`CGDisplayStream`, `CGWindowList`, `EndpointSecurity`, `es_new_client`,
`es_subscribe`, `assessment`, `assessmentagent`, and any `com.*` bundle-id
literal. → **Kill targets are not hardcoded by name in the binary** — the banned-app
list is data-driven (downloaded exam configuration / proctoring policy), and the
"teams" hit we see at runtime (Teams agent killed every ~10 s) is therefore a
server-supplied target, not a compiled-in one.

### Alerts helper
`force-renderer-accessibility` (CEF flag); `/webapps/assessment/take/launch.jsp?`
(exam launch URL); build path `cef_binary_142.0.17+g60aac24+chromium-142.0.7444.176`
(CEF/Chromium version provenance). No kill/monitor strings.

### LDBHelperTool
License-key strings only (see §2) — no kill/process/ES strings.

### LDBUpdateHelper
160 strings, updater plumbing only.

---

## 4. Info.plist facts (`plutil -p Contents/Info.plist`)

| Key | Value |
|---|---|
| CFBundleIdentifier | `com.Respondus.LockDownBrowser` |
| CFBundleShortVersionString / CFBundleVersion | 2.1.5 / 7613 (LDBMinorBuild 04) |
| LSMinimumSystemVersion | 12.00 |
| LSUIElement / LSBackgroundOnly | **absent** — normal foreground app |
| NSAppleScriptEnabled | true |
| NSAppleEventsUsageDescription | "This is required to restore your Touch Bar at the end of your exam." |
| NSCameraUsageDescription | "LockDown Browser requires the use of your camera… video and audio recording." |
| NSMicrophoneUsageDescription | same for microphone |
| NSBluetoothAlwaysUsageDescription | "Bluetooth may be required for some SSOs…" |
| NSDesktopFolder / NSDocumentsFolder / NSDownloadsFolder usage descriptions | "requires access to your … folder." |
| SMPrivilegedExecutables | `com.Respondus.LDBHelperTool` (SMJobBless) |
| NSAppTransportSecurity | `NSAllowsArbitraryLoads = true` |
| CFBundleURLTypes | `rldb://` scheme |
| NSPrincipalClass | `LDBApplication` |
| LSEnvironment | `MallocNanoZone = 0` |
| Screen-capture usage description | **none declared** (permission text comes from the OS; the bundle ships `screen-recording-permission*.png` instruction images instead) |

`mdls`: kMDItemVersion 2.1.5, kMDItemCFBundleIdentifier com.Respondus.LockDownBrowser.

---

## 5. Shipped kext / DEXT / SystemExtension

- `find . \( -name "*.kext" -o -name "*.dext" -o -name "*.systemextension" -o -name "*.appex" \)` → **empty**. None shipped.
- No `Contents/XPCServices`.
- Closest privileged artifacts:
  1. **LDBHelperTool** — classic SMJobBless privileged helper (root launchd daemon
     when installed; installs to `/Library/LaunchDaemons/com.Respondus.LDBHelperTool.plist`
     + `/Library/PrivilegedHelperTools/` per the shipped `uninstall-helper-tool.sh`).
     Currently **not installed** on this machine. License-key surface only.
  2. **AAC channel** — `com.apple.developer.automatic-assessment-configuration`
     entitlement (confirmed again inside `embedded.provisionprofile`, decoded via
     `security cms -D`: `Entitlements → com.apple.developer.automatic-assessment-configuration`)
     + mach-lookup exception for `com.apple.assessmentagent`. This grants LDB a
     channel to Apple's **assessmentagent** system daemon (single-app/assessment
     enforcement). The string `assessmentagent` appears in **no binary** — if this
     channel is used, the service name is constructed at runtime, or the path is
     vestigial (the AutomaticAssessmentConfiguration framework is linked but exposes
     zero `AEAssessment*` undefined symbols).

---

## 6. Detection surface assessment

| # | Mechanism | Evidence level | Exact evidence |
|---|---|---|---|
| 1 | **Periodic process-enumeration kill loop** (NSWorkspace.runningApplications + forceTerminate/kill) | **CONFIRMED** | selector `killProcessesTimer` + `forceTerminate` + `runningApplications`/`runningApplicationsWithBundleIdentifier:` in main.strings; `_kill` imported from libSystem. Runtime corroboration (our own logs): launchd `exited due to SIGKILL | sent by LockDown Browser[...]` every ~10 s |
| 2 | **Developer-ID signature check of running processes** | **CONFIRMED** | selector `checkProcessDeveloperIdTimer` + `getSignature`; imports `SecCodeCopyGuestWithAttributes`, `SecCodeCopySigningInformation`, `kSecCodeInfoTeamIdentifier`, `SecStaticCodeCheckValidity`, `SecRequirementCreateWithString`; `pidPath`/`pidCommand` + `_proc_pidpath` |
| 3 | **Capture-state detection via CoreGraphics** (CGDisplayIsCaptured / CGWindowListCopyWindowInfo) | **CONFIRMED** | `_CGDisplayIsCaptured`, `_CGDisplayIsInMirrorSet`, `_CGDisplayStreamCreate`, `_CGPreflightScreenCaptureAccess`, `_CGWindowListCopyWindowInfo` + `_kCGWindowOwnerPID/Name/Layer` imports in main binary; timer `checkDisplayMirroringTimer` |
| 4 | **ScreenCaptureKit-based detection** | **NONE in main binary** (SCK exists only inside CEF for Chromium's own media capture) | main `otool -L` has no ScreenCaptureKit and no `SCStream`/`SCShareableContent` symbols/strings; CEF links ScreenCaptureKit + `_OBJC_CLASS_$_SCShareableContent` |
| 5 | **EndpointSecurity client** | **ABSENT** | no EndpointSecurity.framework link, no `es_new_client`/`es_subscribe`/`ES_*` symbols or strings in any binary |
| 6 | **IOKit / display observation** | **PARTIAL** | IOKit + IOSurface linked (main, CEF); `checkDisplayMirroringTimer` + `_CGDisplayIsInMirrorSet`; no IOKit device-matching or notification-name strings found (0 relevant hits) |
| 7 | **NSDistributedNotification observation** | **NO EVIDENCE FOUND** | zero distributed-notification name strings or CFNotificationCenter symbols surfaced in mining |
| 8 | **AppleEvents automation** (as process-control channel) | **CAPABILITY DECLARED, PURPOSE NARROW** | entitlement `com.apple.security.automation.apple-events`; plist `NSAppleEventsUsageDescription` ("restore your Touch Bar"); `NSAppleScriptEnabled=true`; scriptSuite/scriptTerminology shipped. No string evidence of it being used to control/kill other apps |
| 9 | **Root privileged helper** | **EXISTS IN BUNDLE, KILL-SURFACE: NONE** | `com.Respondus.LDBHelperTool` binary + `SMPrivilegedExecutables` + `SMAuthorizedClients`; XPC selectors = license read/write/stop/uninstall only; not installed on this machine |
| 10 | **AutomaticAssessmentConfiguration / assessmentagent channel** | **ENTITLEMENT + LINK PRESENT, CODE PATH NOT STATICALLY VISIBLE** | entitlement `com.apple.developer.automatic-assessment-configuration=true`; mach-lookup exception `com.apple.assessmentagent`; framework linked; but 0 `AEAssessment*` symbols and 0 `assessmentagent`/`assessment` strings in every binary |

### Synthesis
The kill path is **not** a kernel extension, EndpointSecurity, or a privileged
root helper. It is a plain **same-uid userland kill loop**: an NSTimer
(`killProcessesTimer`) enumerating `NSWorkspace.runningApplications`, identifying
targets via `_proc_pidpath` and Developer-ID signature checks
(`checkProcessDeveloperIdTimer` + `SecCode*`), then `forceTerminate`/`kill()` —
with the target list supplied at runtime (nothing compiled in), consistent with
per-exam proctoring policy.

Capture detection is **CoreGraphics-based**: `CGDisplayIsCaptured`,
`CGDisplayIsInMirrorSet`, `CGDisplayStreamCreate` and `CGWindowListCopyWindowInfo`
(owner-PID-tagged window enumeration). ScreenCaptureKit's own capture session
registers with the same system capture state, which is consistent with the observed
trigger pattern (Cluely SCK activity → kill 0.05–15 s later).

### Design implications (inference, flagged as such)
Any detection-resistant capture solution must avoid: (1) capture sessions visible
through `CGDisplayIsCaptured`/`CGWindowList` state (all ScreenCaptureKit and
CGDisplayStream sessions register here); (2) appearing in `NSWorkspace.runningApplications`
as a dev-signed (or unsigned) non-allowlisted app — LDB checks Developer ID teams;
(3) display-mirroring transitions (`checkDisplayMirroringTimer`). Because
enforcement is `kill(2)` from the same uid, running the capture agent under a
different uid/context than LDB (uid 501) would also escape the kill reach — but
that alone does not defeat detection if the capture session itself is what triggers
the kill decision. Verification of each evasion idea is runtime work, not covered
by this static pass.

---

*Method note: all strings greps were case-insensitive `grep -a` over `strings -a`
output; symbol claims are from `nm -u`/`nm -um`; binary identity from `file`/`lipo`;
entitlements from `codesign -d --entitlements :-`; frameworks from `otool -L`.
No code was executed from the bundle; analysis is read-only.*
