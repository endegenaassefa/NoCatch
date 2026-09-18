# Platform Research — macOS Screen-Capture Detection Mechanics

Purpose: ground the "detection-resistant capture" design (stealthy capture + root-owned
capture helper LDB cannot kill + on-screen overlay) in verifiable platform facts.

Confidence labels: **documented** (official docs/man pages), **OSS-verified** (working code
in a public repo), **anecdotal** (community/forum reports), **speculation** (inference with
no direct source). Empirical evidence from this project's own incident forensics is marked
**empirical (project)** and cites the repo files.

---

## 1. How one macOS process detects that ANOTHER process is capturing the screen

### 1a. Are active ScreenCaptureKit (SCStream) sessions enumerable?
- **No public API enumerates active SCStream sessions.** ScreenCaptureKit's public surface
  (`SCShareableContent`, `SCContentFilter`, `SCStream`) only exposes *what is capturable*
  (displays/windows/apps), never *who is currently capturing*. A developer asking how to
  detect/prevent recording received no supported-API answer (thread unanswered with a public
  solution). Confidence: **documented-by-absence** + **speculation** (no Apple statement says
  "impossible").
  - https://developer.apple.com/forums/thread/773613
  - https://developer.apple.com/documentation/screencapturekit
- **Indirect observability — unified log.** Every ScreenCaptureKit capture generates tccd
  log lines (`kTCCServiceScreenCapture` REQUEST/`AUTHREQ_RESULT` with the capturing pid), and
  replayd activity is visible in the unified log; a same-user process can read these via
  `log show`/`log stream` with no special permission. This project observed LDB-adjacent
  capture requests this way (tccd msgID bursts with pid 15985 at 16:09:23.6).
  Confidence: **empirical (project)**.
  - docs/INCIDENT-2026-09-18-160938-LDB-SIGKILL.md (evidence items 4/9)

### 1b. Same for CGDisplayStream
- **No public enumeration API either.** CGDisplayStream is one-way (create a stream, get
  frames); there is no "list active streams" call. Confidence: **documented-by-absence**.
  - https://developer.apple.com/documentation/coregraphics/cgdisplaystream
- **CGDisplayStream is deprecated on macOS 14+** — Apple marked `CGDisplayStreamCreate()`
  deprecated in Sonoma, and Chromium refuses to use it on 14+ unless a private feature flag
  (`kUseCGDisplayStreamCreateSonoma`) is forced. Confidence: **OSS-verified** (Chromium source
  comments reference the deprecation).
  - https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/browser/desktop_capture.cc

### 1c. Is a one-shot CGWindowListCreateImage grab observable by others?
- **Not directly by other processes** — it produces no event other processes can subscribe to
  via public API. Confidence: **documented-by-absence**.
  - https://developer.apple.com/documentation/coregraphics/1455139-cgwindowlistcreateimage
- **But it IS observable to the system (and the human)**: on macOS 14+ a one-shot
  `CGWindowListCreateImage` grab lights the "your screen is being captured" menu-bar chip,
  shown for ~10 seconds after a one-time capture. Chromium documents this and switches to
  `SCScreenshotManager` (undocumented/private SCK API) precisely to capture "without any
  notification shown to the user" (usable on macOS ≥14.4 after an Apple bug fix).
  Confidence: **OSS-verified** (Chromium's own comments describe Apple's behavior).
  - https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/cocoa/permissions_utils.mm

### 1d. Private WindowServer / CoreGraphics capture state
- **Capture requests traverse WindowServer.** Reversing `screencapture` shows CoreGraphics's
  `SLDisplayCreateImage` → SkyLight's `SLSHWCaptureDesktop` → a Mach message handled by
  WindowServer's `_XHWCaptureDesktop`; the requesting process's PID is recoverable from the
  Mach port that sent the message (port ownership via `lsmp`). A detector can therefore hook
  WindowServer (`_XHWCaptureDesktop`) or intercept these Mach messages to learn who is
  grabbing pixels. Confidence: **OSS-verified** (Frida-based detection demonstrated).
  - https://objective-see.org/blog/blog_0x2C.html ("Who Moved My Pixels?!")
- **The menu-bar indicator stack (what the chip reads):** the privacy indicator is drawn by
  ControlCenter, fed by the private **SystemStatusServer** framework (`systemstatusd`,
  /System/Library/PrivateFrameworks/SystemStatusServer.framework), with `replayd` and
  `loginwindow` ("ShieldWindow" via its SessionAgentCom) participating; active recordings
  cause Continuous "sensor indicator" churn in ControlCenter/replayd. This project's logs
  captured the exact mechanism in action: `ControlCenter: [com.apple.controlcenter:
  sensor-indicators] ... [scr] <AppName>` attribution lines and
  `-[SessionAgentCom SACShieldWindowShowing:]` from loginwindow during capture.
  Confidence: **anecdotal** (reverse-engineering blog + issue report) + **empirical (project)**.
  - https://happymacadmin.wordpress.com/2022/02/22/orange-is-the-new-mac/
  - https://github.com/screenpipe/screenpipe/issues/2676
  - docs/EXAM-CAPTURE-2026-09-18.md / docs/INCIDENT-2026-09-18-160938-LDB-SIGKILL.md
- loginwindow's SessionAgentCom XPC surface (44 methods, incl. `SAC*` shield/lock controls)
  is callable by any process with **no entitlement check** — an OSS writeup documents
  `SMGetSessionAgentConnection:` handing out loginwindow's listener endpoint to anyone.
  This is the family of APIs behind the capture shields. Confidence: **OSS-verified**.
  - https://github.com/andrd3v/macOS-classroom-ransomware

### 1e. Open-source "screen recording detector" repos
- The only working detector found is the Frida-based WindowServer `_XHWCaptureDesktop` hook
  from the Objective-See guest post (1d). Confidence: **OSS-verified**.
- No mainstream OSS repo enumerates *active* SCStream/CGDisplayStream sessions — consistent
  with no public API existing. Confidence: **documented-by-absence**.
- Adjacent (capture-side, not detector-side): Peekaboo uses **private ScreenCaptureKit** SPI
  (window lookup by window-id via private `SCWindow` APIs) — evidence that private SCK
  surfaces exist and are used in shipping OSS. Confidence: **OSS-verified**.
  - https://github.com/steipete/Peekaboo/blob/1add96f2/Core/PeekabooAutomationKit/Sources/PeekabooAutomationKit/Services/Capture/LegacyScreenCaptureOperator%2BPrivateScreenCaptureKit.swift

---

## 2. EndpointSecurity (ES)

- **There is NO ES event for local screen capture.** The full `es_events_t` union contains
  exec/fork/exit/signal/kextload/file events — nothing about ScreenCaptureKit or
  CGDisplayStream sessions. Confidence: **documented**.
  - https://developer.apple.com/documentation/endpointsecurity/es_events_t
- **`ES_EVENT_TYPE_NOTIFY_SCREENSHARING_ATTACH/DETACH` exists but is remote-only**: "Screen
  Sharing has attached to a graphical session", emitted by `SSInvitationAgent`/
  `screensharingd`, with source/destination network addresses in the event struct — i.e.
  Apple Screen Sharing/VNC-style attach, not local capture.
  Confidence: **documented** (Apple docs + docs.rs mirror) / **OSS-verified** (emitter list).
  - https://developer.apple.com/documentation/endpointsecurity/es_event_screensharing_attach_t
  - https://docs.rs/endpoint-sec-sys/latest/endpoint_sec_sys/struct.es_event_screensharing_attach_t.html
  - https://github.com/Brandon7CC/mac-monitor/wiki/9.-ES-User-Space-Eventing
- **ES does see signals**: `ES_EVENT_TYPE_NOTIFY_SIGNAL` reports "the process being signaled
  and the signal number" — an ES client can therefore log every SIGKILL delivered system-wide
  (the mechanism that would attribute LDB's kills). Confidence: **documented**.
  - https://developer.apple.com/videos/play/wwdc2020/10159/ (SIGNAL event walkthrough)
  - https://developer.apple.com/documentation/endpointsecurity/es_events_t/signal
- **Cost of ES**: requires the `com.apple.developer.endpoint-security.client` entitlement and
  user/MDM approval of a system extension. There is no public evidence Respondus (a plain
  notarized app with no system extension or launchd jobs — per this project's forensics)
  runs an ES client. Confidence: **documented** (entitlement requirement) + **empirical (project)**.
  - https://developer.apple.com/documentation/endpointsecurity
  - docs/INCIDENT-2026-09-18-1105-FORENSICS.md

---

## 3. Proctor behavior — documented and anecdotal

- **Respondus LockDown Browser blocks and auto-closes apps** (university KB, semi-official):
  "Many types of applications are blocked from running at the same time as Respondus
  LockDown Browser. These include ... screen-sharing ... You can shut them down prior to the
  start ... **or you can let the browser close them automatically when it is launched**."
  Confidence: **documented** (institutional KB quoting Respondus behavior).
  - https://umbc.atlassian.net/wiki/spaces/faq/pages/30750319/Why+does+Respondus+Lockdown+Browser+tell+me+to+close+specific+programs+before+I+can+take+a+test
- **LDB flags "screen capture, messaging apps, virtual machines"** via its "Blocked
  Application Detected" error. Confidence: **documented** (institutional KB).
  - https://supportdesk.grcc.edu/TDClient/53/Portal/KB/PrintArticle?ID=3491
- **LDB blacklist mechanics (Mac)**: default blacklist names Zoom/Teams/Discord (each ships a
  background launch agent); "LDB's blacklist scan happens before exam launch and **re-runs at
  intervals**"; "LDB will detect the new process and may flag" if a conflicting app is
  restarted mid-exam; match is against the *running app*, strongest trigger is in-meeting/
  screen-share state. Confidence: **anecdotal** (single-source, an LDB-workaround site).
  - https://ldbypass.com/lockdown-browser-mac/conflicts/zoom
- **Empirical kill-loop**: this project's launchd captures show LDB SIGKILLing the Teams 2
  launch agent every ~10 s for entire exams, and SIGKILLing Cluely's Electron main seconds
  after its screen-capture activity (3 incidents). Confidence: **empirical (project)**.
  - docs/INCIDENT-2026-09-18-160938-LDB-SIGKILL.md
- **Proctorio** is a Chrome extension (no native install): official blog lists its requested
  permissions including "Capture content of your screen" and states it only runs on the
  testing site. Extensions run in Chrome's sandbox: they cannot enumerate macOS processes or
  read other apps' memory; their capture path is `getDisplayMedia` → macOS capture stack
  (which filters privacy-flagged windows). Confidence: **documented** (Proctorio blog) +
  **anecdotal** (sandbox-limits analysis from the LDBypass guide).
  - https://proctorio.com/about/blog/why-proctorio-requests-certain-browser-permissions
  - http://ldbypass.com/guides/chrome-extension-proctoring-limits
- **Honorlock / others**: community reports only (secondary-display and screen-mirroring
  detection anecdotes); no vendor documentation of process-kill or capture-detection
  mechanics found. Confidence: **anecdotal**.
  - https://www.reddit.com/r/smartstudent/comments/1ryjv79/can_proctoring_software_detect_if_you_were/
  - https://www.reddit.com/r/cheatonlineproctor/comments/1la285d/will_honorlock_detect_if_i_use_hdmi_to_connect_a/

---

## 4. Privileged GUI helper on modern macOS (13–26)

### 4a. Running a root process inside the user's GUI session
- **Domain model (documented)**: launchd has hierarchical bootstrap namespaces — system →
  per-user → per-session (Aqua, created by loginwindow/WindowServer); a process can only talk
  to WindowServer (and thus render UI) from the per-session namespace. Confidence: **documented**.
  - https://developer.apple.com/library/archive/technotes/tn2083/_index.html
- **Recipe `sudo launchctl bootstrap gui/<uid> <plist>`**: OSS installer scripts use exactly
  `DOMAIN="gui/$(id -u)"` + `sudo launchctl bootstrap "$DOMAIN" "$PLIST"` (and `bootout` for
  reload); for the system domain they additionally require `chown root:wheel` on the plist
  ("dubious ownership, Bootstrap failed: 5"). A `UserName` key set to root in a gui-domain
  plist runs the job as root inside the user's session. Confidence: **OSS-verified** (recipe)
  + **documented** (plist keys in launchd.plist man page).
  - https://github.com/daymade/claude-code-skills/blob/main/macos-watchdog/scripts/new-launchagent.sh
  - https://www.manpagez.com/man/5/launchd.plist/
- **One-shot from root: `sudo launchctl asuser <uid> osascript ...`** — community recipes use
  this to reach the user's GUI session from root context; daemons have "no default access to
  the user GUI session, even with `sudo -u`". Confidence: **anecdotal** (SO/Jamf recipes).
  - https://stackoverflow.com/questions/67079242/triggering-a-notification-from-within-a-bash-script
  - https://community.jamf.com/general-discussions-2/help-with-bash-script-osascript-e-display-notification-23388
- Namespace hierarchy walk-through for background: https://apple.stackexchange.com/questions/366281/launchd-confusion-on-semantics-of-bootstrap-and-bootout-etc-after-reading-manu

### 4b. Root process + ScreenCaptureKit + TCC
- **TCC attributes capture to the *responsible process*, not necessarily the capturing
  binary.** OSS capture daemons document granting Screen Recording to the terminal app AND to
  `/bin/bash` (the responsible process when launched via LaunchAgent), plus a Sonoma+
  "**bash** is requesting to bypass the system private window picker" prompt that must be
  allowed or frames come back black. Confidence: **OSS-verified** (working daemon's README).
  - https://github.com/msmolkin/screen-capture-daemon
- **Responsibility chains break through launch agents/wrappers**: a reported regression on
  macOS Tahoe (26) where `screencapture` exec'd by a LaunchAgent fails TCC even though the
  parent has permission — attribution lands on the exec'ing binary; fix is granting the
  *exact* binary (path-stable) or PPPC. Confidence: **anecdotal** (detailed OSS issue).
  - https://github.com/openclaw/openclaw/issues/14138
- **MDM PPPC is the sanctioned alternative**: Apple's official profile-policy schema
  (`com.apple.TCC.configuration-profile-policy`) includes a `ScreenCapture` service entry;
  payloads identify targets by bundle ID or (for non-bundled binaries) installation path;
  "Helper tools embedded within an application bundle automatically inherit the permissions
  of their enclosing app bundle"; user can't override MDM values. Confidence: **documented**
  (Apple's device-management repo).
  - https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.TCC.configuration-profile-policy.yaml
- Root-ness itself: no authoritative source says root bypasses or changes TCC for
  ScreenCaptureKit; combined with 4a/4b above, the supported path is: root helper with a
  stable path + PPPC grant (or responsible-process chain from an already-granted app).
  Confidence: **speculation** (synthesis of the above).

### 4c. Can a root process create windows on the user's desktop?
- **Only via the user's session namespace.** `osascript ... display dialog` works when
  targeted through the user's session (e.g. `tell application "SystemUIServer" to display
  dialog ...`); from a root daemon context it does not reach the desktop without
  `launchctl asuser`/gui-domain bootstrap. Confidence: **anecdotal** (recipes) +
  **documented** (TN2083 namespace model).
  - https://apple.stackexchange.com/questions/73290/display-dialog-from-command-line-like-xmessage-does
  - https://developer.apple.com/library/archive/technotes/tn2083/_index.html
- A root process bootstrapped into `gui/<uid>` therefore can both capture (with TCC) and
  render (overlay windows) — no public counter-source found. Confidence: **speculation**
  (mechanism-consistent, not directly demonstrated).

---

## 5. Electron desktopCapturer on macOS

- **Current default is ScreenCaptureKit** (webrtc `ScreenCapturerSck`): "The ScreenCaptureKit
  API was available in macOS 12.3, but full-screen capture was reported to be broken before
  macOS 13" (crbug 40234870) — so Chromium/Electron use SCK on macOS 13+, with
  `SCShareableContent` + `SCStream` under the hood. Confidence: **OSS-verified**.
  - https://webrtc.googlesource.com/src/+/d4a6c3f76fc3b187115d1cd65f4d1fffd7bebb7c/modules/desktop_capture/mac/screen_capturer_sck.mm
- **Fallback path is CGDisplayStream, feature-flagged and deprecated**: `kIOSurfaceCapturer`
  ("Enabling IO surface capturer means that we will be using the CGDisplayStreamCreate()
  API"); `CGDisplayStreamCreateIsAvailable()` returns false on macOS 14+ unless the private
  `kUseCGDisplayStreamCreateSonoma` flag is set. Confidence: **OSS-verified**.
  - https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/browser/desktop_capture.cc
- **One-shot thumbnails historically used CGWindowListCreateImage** (and on macOS 14+ that
  lights the chip for 10 s — §1c). Electron's `desktopCapturer.getSources` requires screen-
  recording consent (10.15+), checkable via `systemPreferences.getMediaAccessStatus`;
  macOS 14.2+ audio needs `NSAudioCaptureUsageDescription`. Confidence: **documented**.
  - https://www.electronjs.org/docs/latest/api/desktop-capturer

---

## 6. The screen-recording menu-bar indicator

- **Appears for ScreenCaptureKit streams**: persistent SCK streams keep ControlCenter's
  sensor-indicator badge active (screenpipe: "ControlCenter now sees an 'active recording'
  and continuously re-animates its sensor indicator badge"; replayd churn; not user-hideable
  except via System Settings → Control Center). Confidence: **OSS-verified** (issue) +
  **anecdotal**.
  - https://github.com/screenpipe/screenpipe/issues/2676
- **Appears for one-shot CGWindowListCreateImage grabs on macOS 14+** — chip shows for ~10 s
  (Chromium comment). On macOS <14 the same grab shows no chip. Confidence: **OSS-verified**
  (Chromium). - https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/cocoa/permissions_utils.mm
- **Underlying state**: private SystemStatusServer/`systemstatusd` → ControlCenter UI, with
  replayd + loginwindow ShieldWindow (`SessionAgentCom`) involved; this project's logs show
  per-process `[scr]` attributions flowing through ControlCenter sensor-indicators.
  Confidence: **anecdotal** + **empirical (project)**.
  - https://happymacadmin.wordpress.com/2022/02/22/orange-is-the-new-mac/
  - docs/INCIDENT-2026-09-18-160938-LDB-SIGKILL.md (evidence item 6, ControlCenter lines)
- **Apple's user docs** cover the privacy indicators (orange/green/purple dots) and the
  Screen & System Audio Recording permission list, but do not document the screen-capture
  chip's internal state source. Confidence: **documented** (user-facing only).
  - https://support.apple.com/guide/mac-help/control-access-screen-system-audio-recording-mchld6aa7d23/mac
  - https://support.apple.com/en-asia/guide/mac-help/mchl50f94f8f/mac

---

## 7. Uncertainties — what public sources do NOT establish

1. **How LDB actually detects capture** — no public source documents the detection signal
   (our capture→SIGKILL timing model is inference from this project's 3 incidents; LDB's
   session logs are encrypted).
2. **Whether third-party apps can read the indicator state** — SystemStatusServer is a
   private framework; no public doc says a non-Apple process can query active capture
   attributions. LDB *may* be doing exactly that, but this is speculation.
3. **Whether ES NOTIFY_SCREENSHARING_* fires for local capture** — Apple's wording
   ("attached to a graphical session", source/destination addresses, emitters
   `SSInvitationAgent`/`screensharingd`) strongly implies remote-only, but no source
   explicitly says "local SCK streams do not emit it".
4. **ES signal-event sender attribution** — WWDC says the event carries "the process being
   signaled and the signal number"; whether the *sending* process is exposed with the same
   fidelity is not documented in the public pages found.
5. **Root + ScreenCaptureKit without MDM** — no authoritative statement on whether a
   root-owned process launched in `gui/<uid>` passes TCC solely via responsible-process
   chaining; the supported, documented path is PPPC (`ScreenCapture` service) or a granted
   enclosing app bundle. The Tahoe launch-agent attribution regression (openclaw #14138)
   suggests this is fragile and version-dependent.
6. **`SCScreenshotManager` longevity** — it is undocumented SPI; Chromium attests it
   captures without the notification on ≥14.4, but Apple could change or gate it at any
   time. No evidence for its status on macOS 26 (Tahoe).
7. **CGDisplayStream behavior on macOS 13** — whether the deprecated-but-available
   CGDisplayStream path triggers the chip on 12.3–13.x is not covered by the found sources
   (the Chromium chip comment only covers macOS 14+ for CGWindowListCreateImage).
8. **LDB blacklist "re-runs at intervals"** — single-source (an LDB-workaround site),
   though consistent with this project's empirical kill-loop cadence.
9. **`launchctl asuser` long-term viability** — recipes are community-documented; Apple has
   deprecated/restricted `asuser` in the past and it may break in future macOS releases.
