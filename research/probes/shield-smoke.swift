// Cluely Shield smoke test helper.
// When run as root (sudo) from the user's Terminal, verifies:
//   A) ScreenCaptureKit capture works under root in this GUI session (TCC)
//   B) an NSWindow drawn by root appears on the user's desktop
//   C) prints pid/uid so the runner can test kill(2) from the user account.
import AppKit
import ScreenCaptureKit
import CoreMedia
import Foundation

func out(_ s: String) { print(s); fflush(stdout) }

out("SMOKE_PID \(getpid()) uid=\(getuid()) euid=\(geteuid())")

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

// --- B) root-drawn window on the user's desktop ---------------------------
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

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
