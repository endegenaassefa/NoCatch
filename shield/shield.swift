// shield.swift — Cluely Shield helper (Day 1 minimal).
//
// Bare Swift Mach-O. Run as ROOT in the user's GUI session so LockDown
// Browser (uid 501) cannot SIGKILL it:
//     sudo -E ./shield                 # interactive: pre-created overlay + hotkey capture
//     sudo -E ./shield --self-test     # one-shot capture → luma verdict (PIXELS_OK/BLACK), exit
//
// Day-1 contract (docs/SOLUTION-DESIGN.md §7):
//   - SCContentFilter fetched ONCE at startup (no per-capture enumeration — F10)
//   - ONE overlay window created once; level asserted once; hotkey updates
//     redraw content in place (no hide/show, no level churn — F11)
//   - RegisterEventHotKey (⌘⇧Space) via Carbon — no TCC, the PRIMARY path (F9)
//   - on hotkey: one-shot capture with the CACHED filter → placeholder answer
//     → in-place overlay redraw
//   - --self-test: capture once → luma verdict, exit 0 (OK) / 4 (black)
//
// Day 2-3 (NOT yet here): local-LLM/API answer, Unix-socket IPC + cached
// config/credentials, launchd KeepAlive plist, Brain exam-mode quit.
//
// Hard guarantees encoded structurally (not warnings):
//   * frames never touch disk (LDB runs cleanUpScreenShotsTimer) — RAM only
//   * SCShareableContent enumerated exactly once per process lifetime
//   * window level asserted once; overlay content is the only thing that changes

import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import Foundation
import Carbon

func log(_ s: String) { print(s); fflush(stdout) }

enum ShieldError: Error {
    case timeout
}

// ── luma statistics (black-frame / TCC-loss detection) ────────────────────
// Same threshold logic as research/probes/sck-pixels.swift (proven in G1):
// real exam content → meanLuma 146.5; black → meanLuma ~0, darkFrac ~1.
func lumaStats(_ pixelBuffer: CVPixelBuffer) -> (mean: Double, darkFrac: Double) {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return (0, 1) }
    let w = CVPixelBufferGetWidth(pixelBuffer)
    let h = CVPixelBufferGetHeight(pixelBuffer)
    let bpr = CVPixelBufferGetBytesPerRow(pixelBuffer)
    var sum = 0.0, dark = 0.0, n = 0.0
    let rowPtr = base.assumingMemoryBound(to: UInt8.self)
    for y in 0..<max(1, h / 4) {                       // sample every 4th row
        let row = rowPtr.advanced(by: y * 4 * bpr)
        for x in stride(from: 0, to: w * 4, by: 16) {  // sample every 4th pixel
            let r = Double(row[x + 2]), g = Double(row[x + 1]), b = Double(row[x])
            let luma = 0.299 * r + 0.587 * g + 0.114 * b
            sum += luma
            if luma < 16 { dark += 1 }
            n += 1
        }
    }
    return (sum / max(n, 1), dark / max(n, 1))
}

// ── per-invocation one-shot capture ───────────────────────────────────────
// Each hotkey press creates a fresh CaptureSession that OWNS its own stream,
// continuation, and timeout. This makes the "overlapping capture corrupts
// shared state" and "stale timeout steals a later continuation" failure modes
// unrepresentable: no capture can touch another's state.
final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CMSampleBuffer, Error>?
    private var stream: SCStream?
    private var frameCount = 0
    let filter: SCContentFilter

    init(filter: SCContentFilter) { self.filter = filter }

    // Returns the CMSampleBuffer. Under macOS 26's automatic CF memory
    // management, ARC retains it across the async hop, which keeps the BORROWED
    // CVPixelBuffer backing alive — the consumer extracts the pixel buffer while
    // the sample buffer is in scope (this is the CRITICAL-1 use-after-free fix;
    // CVPixelBufferRetain/Release are unavailable on this SDK).
    func run() async throws -> CMSampleBuffer {
        try await withCheckedThrowingContinuation { cont in
            lock.lock(); self.continuation = cont; lock.unlock()
            let config = SCStreamConfiguration()
            config.width = 1280
            config.height = 720
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
            config.showsCursor = false
            let s = SCStream(filter: filter, configuration: config, delegate: self)
            lock.lock(); self.stream = s; lock.unlock()
            do {
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global())
            } catch {
                self.finish(.failure(error))
                return
            }
            Task {
                do { try await s.startCapture() }
                catch { self.finish(.failure(error)) }
            }
            // No-frame timeout, bound to THIS session (not a shared slot): if
            // startCapture succeeds but never delivers a frame (TCC edge), fail
            // loudly instead of hanging. Mirror sck-pixels.swift's 8 s guard.
            DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
                self.finish(.failure(ShieldError.timeout))
            }
        }
    }

    // Terminate the capture exactly once (frame, error, OR timeout), stopping
    // and releasing the stream on EVERY terminal path.
    private func finish(_ result: Result<CMSampleBuffer, Error>) {
        lock.lock()
        guard let c = self.continuation else { lock.unlock(); return }
        self.continuation = nil
        let s = self.stream
        self.stream = nil
        lock.unlock()
        if let s = s { Task { try? await s.stopCapture() } }   // no zombie stream
        switch result {
        case .success(let sb): c.resume(returning: sb)
        case .failure(let e):  c.resume(throwing: e)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        frameCount += 1
        guard frameCount >= 2 else { return }   // skip warm-up frame 1 (matches sck-pixels)
        finish(.success(sampleBuffer))          // ARC retains the sample buffer (owns the pixels)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish(.failure(error))
    }
}

// ── the helper ────────────────────────────────────────────────────────────
// Threading discipline (justifies @unchecked Sendable):
//   * `filter`, `isCapturing`, `window`, `label` are touched ONLY on the main
//     thread (filter is assigned via MainActor.run; onHotKey runs on the Carbon
//     main loop; overlay updates are dispatched to main).
//   * all capture state lives in CaptureSession, which owns its own lock.
final class Shield: NSObject, @unchecked Sendable {
    var filter: SCContentFilter?          // fetched ONCE, before LDB launches (main-only)
    var window: NSWindow?
    var label: NSTextField?
    private var isCapturing = false       // main-only in-flight guard (MAJOR-2)

    override init() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        super.init()
    }

    // Pre-created overlay window (F11: create once, level set once). Only in
    // interactive mode — --self-test stays headless (capture → verdict → exit).
    func showOverlay() {
        guard window == nil else { return }
        let win = NSWindow(
            contentRect: NSRect(x: 120, y: 120, width: 520, height: 120),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        win.level = .floating
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        win.isOpaque = false
        win.backgroundColor = NSColor(calibratedWhite: 0.0, alpha: 0.86)
        win.sharingType = .none            // content-protected (recording tradeoff — design §8)
        let field = NSTextField(labelWithString: "CLUELY SHIELD — ready (⌘⇧Space to capture)")
        field.frame = NSRect(x: 16, y: 20, width: 488, height: 80)
        field.textColor = .white
        field.font = NSFont.systemFont(ofSize: 15)
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 0
        win.contentView?.addSubview(field)
        win.orderFrontRegardless()
        self.window = win
        self.label = field
        log("SHIELD_READY pid=\(getpid()) uid=\(getuid()) euid=\(geteuid())")
    }

    // ── startup: fetch the filter ONCE, register the hotkey ───────────────
    func start() {
        registerHotKey()
        Task {
            do {
                let content = try await SCShareableContent.current
                guard let display = content.displays.first else {
                    await MainActor.run { self.updateOverlay("⚠ capture unavailable: no display") }
                    log("FILTER_FAIL no display")
                    return
                }
                let f = SCContentFilter(display: display, excludingWindows: [])
                await MainActor.run { self.filter = f }   // assign on main (MAJOR-5)
                log("FILTER_READY")
            } catch {
                // Fail loud at startup, not silently mid-exam (NIT-9): the
                // overlay shows the error so TCC loss is never discovered late.
                await MainActor.run { self.updateOverlay("⚠ capture unavailable: \(error)") }
                log("FILTER_FAIL error=\(error)")
            }
        }
    }

    // ── hotkey → one-shot capture → in-place redraw ───────────────────────
    func onHotKey() {
        guard !isCapturing else { log("CAPTURE_BUSY"); return }   // no overlap
        guard let filter = self.filter else {
            updateOverlay("⚠ filter not ready yet — try again in a second")
            return
        }
        isCapturing = true
        log("HOTKEY_PRESSED")
        Task {
            await self.captureAndUpdate(filter: filter)
            DispatchQueue.main.async { self.isCapturing = false }
        }
    }

    func captureAndUpdate(filter: SCContentFilter) async {
        do {
            let sb = try await captureFrame(filter: filter)
            guard let pb = CMSampleBufferGetImageBuffer(sb) else {
                log("CAPTURE_FAIL no pixel buffer")
                DispatchQueue.main.async { self.updateOverlay("⚠ capture failed: no pixels") }
                return
            }
            let s = lumaStats(pb)   // safe: sb is still in scope, backing alive
            let ok = s.mean > 8 && s.darkFrac < 0.995
            // Day-1 placeholder answer (the vision-LLM seam lands here on Day 2-3).
            let text = ok
                ? String(format: "✓ captured — mean luma %.0f · dark %.0f%%\n(answer pipeline: Day 2)", s.mean, s.darkFrac * 100)
                : "⚠ black frames — possible TCC loss (re-run --self-test)"
            log(String(format: "CAPTURED meanLuma=%.1f darkFrac=%.3f ok=%d", s.mean, s.darkFrac, ok ? 1 : 0))
            DispatchQueue.main.async { self.updateOverlay(text) }
        } catch {
            log("CAPTURE_FAIL error=\(error)")
            DispatchQueue.main.async { self.updateOverlay("⚠ capture failed: \(error)") }
        }
    }

    func captureFrame(filter: SCContentFilter) async throws -> CMSampleBuffer {
        try await CaptureSession(filter: filter).run()
    }

    func updateOverlay(_ text: String) {
        label?.stringValue = text   // in-place redraw — no level/hide/show churn
    }

    // ── Carbon RegisterEventHotKey (⌘⇧Space) — no TCC, PRIMARY path ───────
    private func registerHotKey() {
        let hotKeyID = EventHotKeyID(signature: OSType(0x434C_5545), id: 1) // 'CLUE'
        var hotKeyRef: EventHotKeyRef?
        let status = RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(cmdKey | shiftKey),
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        log(status == 0 && hotKeyRef != nil ? "HOTKEY_OK" : "HOTKEY_FAIL status=\(status)")

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        var handlerRef: EventHandlerRef?
        InstallEventHandler(
            GetApplicationEventTarget(),
            hotKeyCallback,
            1,
            &eventType,
            nil,
            &handlerRef
        )
        // handlerRef and hotKeyRef are intentionally retained by Carbon for process lifetime.
        // Delivery is verified by the interactive run: pressing ⌘⇧Space must log
        // HOTKEY_PRESSED and redraw the overlay (on-device, not self-test).
    }
}

// Carbon callback (non-capturing top-level function → valid @convention(c) UPP).
func hotKeyCallback(_ nextHandler: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    shield.onHotKey()
    return 0
}

// ── entry point ───────────────────────────────────────────────────────────
let isSelfTest = CommandLine.arguments.contains("--self-test")
let shield = Shield()

if isSelfTest {
    // One-shot capture → luma verdict → exit. Fails LOUD on black frames so
    // TCC loss is never discovered mid-exam (design §3 TCC / F5).
    Task {
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                log("VERDICT NO_DISPLAY")
                exit(6)
            }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let sb = try await shield.captureFrame(filter: filter)
            guard let pb = CMSampleBufferGetImageBuffer(sb) else {
                log("VERDICT NO_PIXELBUFFER")
                exit(8)
            }
            let s = lumaStats(pb)   // safe: sb is still in scope, backing alive
            let ok = s.mean > 8 && s.darkFrac < 0.995
            log(String(format: "VERDICT %@ meanLuma=%.1f darkFrac=%.3f", ok ? "PIXELS_OK" : "PIXELS_BLACK", s.mean, s.darkFrac))
            exit(ok ? 0 : 4)
        } catch ShieldError.timeout {
            log("VERDICT TIMEOUT_NO_FRAMES")
            exit(7)
        } catch {
            log("VERDICT CAPTURE_FAILED error=\(error)")
            exit(8)
        }
    }
} else {
    shield.showOverlay()
    shield.start()
}

RunLoop.main.run()
