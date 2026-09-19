// Cluely Shield smoke test helper.
// When run as root (sudo) from the user's Terminal, verifies:
//   A) ScreenCaptureKit capture works under root in this GUI session (TCC)
//   B) an NSWindow drawn by root appears on the user's desktop
//   C) prints pid/uid so the runner can test kill(2) from the user account.
import AppKit
import ScreenCaptureKit
import CoreMedia
import Foundation
import Carbon

func out(_ s: String) { print(s); fflush(stdout) }

out("SMOKE_PID \(getpid()) uid=\(getuid()) euid=\(geteuid())")

// Initialize the Cocoa app FIRST so Carbon's GetApplicationEventTarget() and
// the CGEvent tap both have a live event target — matches the helper's
// startup order (NSApplication.shared before registerHotKey).
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// --- D) event tap as root (hotkey path, without Accessibility TCC?) ---------
let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
    callback: { _, _, _, _ in nil },
    userInfo: nil
)
if let tap = tap {
    out("EVENT_TAP_OK")
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
} else {
    out("EVENT_TAP_FAILED (root did not bypass Accessibility TCC — hotkey fallback needed)")
}

// --- F) RegisterEventHotKey (Carbon) — the PRIMARY hotkey path ------------
// No Accessibility TCC. This is what Cluely's globalShortcut uses and what the
// shield must use as primary (CGEventTap is the fallback; SecureEventInput can
// kill taps). Registers ⌘⇧Space (Cluely's capture chord). Event DELIVERY is
// exercised in the helper's --self-test; here we prove registration succeeds
// with zero TCC.
let hotKeyID = EventHotKeyID(signature: OSType(0x434C_5545), id: 1) // 'CLUE'
var hotKeyRef: EventHotKeyRef?
let hotKeyStatus = RegisterEventHotKey(
    UInt32(kVK_Space),                  // space bar (49)
    UInt32(cmdKey | shiftKey),          // ⌘⇧
    hotKeyID,
    GetApplicationEventTarget(),
    0,
    &hotKeyRef
)
if hotKeyStatus == 0 && hotKeyRef != nil {
    out("REGISTER_EVENT_HOTKEY_OK")
} else {
    out("REGISTER_EVENT_HOTKEY_FAIL status=\(hotKeyStatus)")
}

// --- B) root-drawn window on the user's desktop ---------------------------
let win = NSWindow(
    contentRect: NSRect(x: 200, y: 200, width: 420, height: 90),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
win.level = .floating
win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
win.isOpaque = false
win.backgroundColor = NSColor(calibratedWhite: 0.0, alpha: 0.85)
win.sharingType = .none // content-protected: black in other apps' captures
let label = NSTextField(labelWithString: "CLUELY SHIELD SMOKE TEST — root-drawn window")
label.frame = NSRect(x: 16, y: 20, width: 388, height: 50)
label.textColor = .white
label.font = NSFont.systemFont(ofSize: 16)
win.contentView?.addSubview(label)
win.orderFrontRegardless()
out("WINDOW_SHOWN")

// --- E) fullscreen-space overlay test -------------------------------------
// LDB runs fullscreen (its own space). The overlay must join that space via
// .fullScreenAuxiliary + .canJoinAllSpaces. Simulate it: a titled "exam"
// window goes fullscreen, then the overlay must be present on the active space.
let examWin = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
    styleMask: [.titled, .resizable],
    backing: .buffered,
    defer: false
)
examWin.title = "FAKE EXAM (fullscreen space — the shield overlay should float over this)"
examWin.collectionBehavior = [.fullScreenPrimary]
examWin.center()
examWin.makeKeyAndOrderFront(nil)
examWin.toggleFullScreen(nil)
out("FULLSCREEN_SPACE_REQUESTED")

DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
    win.orderFrontRegardless()          // overlay joins the fullscreen space
    out(win.isOnActiveSpace
        ? "FULLSCREEN_OVERLAY_OK"
        : "FULLSCREEN_OVERLAY_FAIL (isOnActiveSpace=false)")
}

// --- A) SCK capture under root --------------------------------------------
final class Cap: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        out("CAPTURE_OK frame t=\(CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds)")
    }
}
let cap = Cap()

Task {
    do {
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else {
            out("CAPTURE_FAIL no display")
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { exit(2) }
            return
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 640
        config.height = 360
        config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        config.showsCursor = false
        let stream = SCStream(filter: filter, configuration: config, delegate: cap)
        try stream.addStreamOutput(cap, type: .screen, sampleHandlerQueue: DispatchQueue.global())
        out("CAPTURE_STREAM_STARTED")
        try await stream.startCapture()
        out("CAPTURE_STARTED")
        try await Task.sleep(nanoseconds: 3_000_000_000)
        out("CAPTURE_ENDED")
    } catch {
        out("CAPTURE_FAIL error=\(error)")
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
        out("SMOKE_DONE")
        exit(0)
    }
}

RunLoop.main.run()
