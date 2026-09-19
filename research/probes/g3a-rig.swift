// g3a-rig.swift — G3A go/no-go experiment rig (runs as ROOT in the user's GUI session).
//
// Measures what LockDown Browser does when capture fires with NO KILLABLE
// uid-501 GUI target present — the most load-bearing unobserved fact in the
// Shield design (docs/SOLUTION-DESIGN.md §6 G3a). Built from the proven
// machinery of shield/shield.swift (CaptureSession one-shot discipline,
// lumaStats) and research/probes/shield-smoke.swift (window patterns).
//
// Modes:
//   g3a-rig                              full instrumented run (root, GUI)
//   g3a-rig --arm-check                  one capture -> G3A_ARMCHECK verdict, exit 0/4/6/7/8
//   g3a-rig --mock [--mock-ldb-at N]     state-machine only (no GUI/SCK) — for local tests
//
// Flags: --duration N (default 2700 s), --time-scale N (divide phase offsets),
// --log PATH (default /tmp/g3a-rig.log), --canary PATH (canary binary),
// --mock-ldb-at N (mock: simulate LDB detection after N s).
//
// Timeline (offsets from first LDB detection, each divided by --time-scale;
// captures are numbered chronologically):
//   +90s   P1 capture 1   — capture with no killable GUI target (clean phase)
//   +300s  P1 capture 2   — second clean-phase trigger opportunity
//   +480s  P2 canary spawn — uid-501 GUI canary (loop-aliveness control)
//   +540s  P2 capture 3   — capture while canary visible: rule (b) target test
//   +660s  P1 capture 4   — post-canary capture (clean condition restored)
//   +720s  P3 decoy window — root GUI window (EPERM-behavior observation)
//   +780s  P3 capture 5   — capture while decoy visible: rule (b) vs root → EPERM
//   +duration                 — G3A_END summary, exit 0 (duration counts from
//                               rig START; phase offsets count from LDB)
//
// Discipline carried over from the design:
//   * SCContentFilter fetched ONCE at startup (pre-LDB) — no per-capture
//     enumeration (F10).
//   * One-shot captures: fresh CaptureSession per capture, own timeout,
//     no shared capture state (shield.swift discipline).
//   * Frames never touch disk (RAM only).
//   * Window created only in phase P3 (a single, deliberate show event —
//     this is the experiment's probe, not production overlay discipline).
//   * Heartbeats every 2 s are EXPERIMENT instrumentation (production ships
//     no periodic noise); they are the survival ground truth since eslogger
//     cannot be assumed to record EPERM-blocked kill attempts.
import Foundation
import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import Carbon

// ── logging: stdout + unbuffered append to the log file ──────────────────
var logFile: FileHandle?
func log(_ s: String) {
    print(s)
    fflush(stdout)
    if let f = logFile, let d = (s + "\n").data(using: .utf8) {
        f.write(d)
    }
}

// ── CLI flags ─────────────────────────────────────────────────────────────
func flagStr(_ name: String, _ d: String) -> String {
    if let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count {
        return CommandLine.arguments[i + 1]
    }
    return d
}
func flagInt(_ name: String, _ d: Int) -> Int {
    Int(flagStr(name, String(d))) ?? d
}
let MOCK = CommandLine.arguments.contains("--mock")
let ARMCHECK = CommandLine.arguments.contains("--arm-check")
let DURATION = flagInt("--duration", 2700)
let SCALE = max(1, flagInt("--time-scale", 1))
let LOG_PATH = flagStr("--log", "/tmp/g3a-rig.log")
let CANARY_PATH = flagStr("--canary", "/tmp/g3a-kit/g3a-canary")
let MOCK_LDB_AT = flagInt("--mock-ldb-at", 30)

// phase offsets in seconds from LDB detection (divided by SCALE)
let OFF_C1 = 90, OFF_C2 = 300, OFF_C3 = 540, OFF_C4 = 660, OFF_C5 = 780
let OFF_CANARY = 480, OFF_DECOY = 720
let CANARY_TTL = 150
let CANARY_LOG = "/tmp/g3a-canary.log"

let startTime = Date()
func uptime() -> Double { Date().timeIntervalSince(startTime) }

// UTC wall-clock for the start line (correlates rig log with eslogger's UTC times)
let startWallFmt: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

// ── state (main-thread only; capture state lives in CaptureSession) ───────
var phase = "ARM"
var ldbSeenAt: Double? = nil
var capturesDone = 0
var canaryStatus = "none"   // none | spawned | dead | survived
var canarySpawnAt: Double = 0
var canaryLauncher: Process?
var decoyShown = false
var isCapturing = false     // main-only in-flight guard (shield.swift MAJOR-2)
var filter: SCContentFilter?
var endTimer: DispatchSourceTimer?

// ── luma statistics (copied from shield/shield.swift — proven in G1) ──────
func lumaStats(_ pixelBuffer: CVPixelBuffer) -> (mean: Double, darkFrac: Double) {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return (0, 1) }
    let w = CVPixelBufferGetWidth(pixelBuffer)
    let h = CVPixelBufferGetHeight(pixelBuffer)
    let bpr = CVPixelBufferGetBytesPerRow(pixelBuffer)
    var sum = 0.0, dark = 0.0, n = 0.0
    let rowPtr = base.assumingMemoryBound(to: UInt8.self)
    for y in 0..<max(1, h / 4) {
        let row = rowPtr.advanced(by: y * 4 * bpr)
        for x in stride(from: 0, to: w * 4, by: 16) {
            let r = Double(row[x + 2]), g = Double(row[x + 1]), b = Double(row[x])
            let luma = 0.299 * r + 0.587 * g + 0.114 * b
            sum += luma
            if luma < 16 { dark += 1 }
            n += 1
        }
    }
    return (sum / max(n, 1), dark / max(n, 1))
}

// ── one-shot capture (copied from shield/shield.swift — proven pattern) ───
enum RigError: Error { case timeout }

final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<CMSampleBuffer, Error>?
    private var stream: SCStream?
    private var frameCount = 0
    let filter: SCContentFilter

    init(filter: SCContentFilter) { self.filter = filter }

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
            DispatchQueue.global().asyncAfter(deadline: .now() + 8) {
                self.finish(.failure(RigError.timeout))
            }
        }
    }

    private func finish(_ result: Result<CMSampleBuffer, Error>) {
        lock.lock()
        guard let c = self.continuation else { lock.unlock(); return }
        self.continuation = nil
        let s = self.stream
        self.stream = nil
        lock.unlock()
        if let s = s { Task { try? await s.stopCapture() } }
        switch result {
        case .success(let sb): c.resume(returning: sb)
        case .failure(let e):  c.resume(throwing: e)
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        frameCount += 1
        guard frameCount >= 2 else { return }   // skip warm-up frame 1 (matches sck-pixels)
        finish(.success(sampleBuffer))
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish(.failure(error))
    }
}

// ── capture one frame through the cached filter ───────────────────────────
func captureFrame(_ f: SCContentFilter) async throws -> CMSampleBuffer {
    try await CaptureSession(filter: f).run()
}

func runCapture(n: Int, manual: Bool) {
    guard !isCapturing else { log("G3A_CAPTURE n=\(n) skipped=BUSY t=\(uptime())"); return }
    guard let f = filter else { log("G3A_CAPTURE n=\(n) result=FAIL error=NO_FILTER t=\(uptime())"); return }
    isCapturing = true
    log("G3A_CAPTURE n=\(n) manual=\(manual ? 1 : 0) t=\(uptime()) begin")
    Task {
        do {
            let sb = try await captureFrame(f)
            guard let pb = CMSampleBufferGetImageBuffer(sb) else {
                log("G3A_CAPTURE n=\(n) result=FAIL error=NO_PIXELBUFFER t=\(uptime())")
                DispatchQueue.main.async { isCapturing = false }
                return
            }
            let s = lumaStats(pb)
            let ok = s.mean > 8 && s.darkFrac < 0.995
            log(String(format: "G3A_CAPTURE n=%d result=%@ meanLuma=%.1f darkFrac=%.3f t=%.1f",
                       n, ok ? "OK" : "BLACK", s.mean, s.darkFrac, uptime()))
        } catch {
            log("G3A_CAPTURE n=\(n) result=FAIL error=\(error) t=\(uptime())")
        }
        DispatchQueue.main.async { isCapturing = false }
    }
}

// ── process-table checks (KVM/pgrep — not LaunchServices enumeration) ─────
func pgrepAlive(_ name: String, _ done: @escaping (Bool) -> Void) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    p.arguments = ["-x", name]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.terminationHandler = { _ in
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let out = String(data: data, encoding: .utf8) ?? ""
        done(out.contains("\n"))
    }
    do { try p.run() } catch { done(false) }
}

// ── canary (uid-501 GUI app, spawned via launchctl asuser) ────────────────
func spawnCanary() {
    guard !MOCK else {
        canarySpawnAt = uptime()
        canaryStatus = "spawned"
        log("G3A_CANARY_SPAWN t=\(uptime()) mock=1")
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(5.0 / Double(SCALE))) {
            guard canaryStatus == "spawned" else { return }
            canaryStatus = "dead"
            phase = "P1"
            log("G3A_CANARY_DEAD t=\(uptime()) mock=1")
        }
        return
    }
    var uid: UInt32 = 501
    if let attrs = try? FileManager.default.attributesOfItem(atPath: "/dev/console"),
       let n = attrs[.ownerAccountID] as? NSNumber {
        uid = n.uint32Value
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/launchctl")
    // NOTE: `launchctl asuser` adopts the user's bootstrap/audit session but
    // does NOT change credentials — the child would stay root. `sudo -u` drops
    // to the console uid inside that session (root needs no password). Without
    // this the canary would be unkillable and the P2 control would invert.
    p.arguments = ["asuser", String(uid), "/usr/bin/sudo", "-u", String(uid), CANARY_PATH, "--ttl", String(CANARY_TTL / SCALE)]
    let fh: FileHandle
    if let f = FileHandle(forWritingAtPath: CANARY_LOG) {
        fh = f
    } else {
        FileManager.default.createFile(atPath: CANARY_LOG, contents: nil)
        fh = FileHandle(forWritingAtPath: CANARY_LOG) ?? FileHandle.standardOutput
    }
    fh.truncateFile(atOffset: 0)
    p.standardOutput = fh
    p.standardError = fh
    do {
        try p.run()
        canaryLauncher = p   // retain: reap the launcher on rig exit
        canarySpawnAt = uptime()
        canaryStatus = "spawned"
        log("G3A_CANARY_SPAWN t=\(uptime()) launcher_pid=\(p.processIdentifier)")
        pollCanary()
    } catch {
        log("G3A_CANARY_SPAWN_FAIL error=\(error) t=\(uptime())")
    }
}

// ── what the canary's own log says about its exit (killed vs crashed) ─────
func canaryExitRead() -> (status: String, detail: String) {
    guard let content = try? String(contentsOfFile: CANARY_LOG, encoding: .utf8) else {
        return ("dead", "cause=no_log")
    }
    if content.contains("CANARY_ALIVE_FULL_TTL") {
        return ("survived", "cause=clean_exit")
    }
    var hb = 0
    for line in content.split(separator: "\n") where line.hasPrefix("CANARY_HB") { hb += 1 }
    return ("dead", hb > 0 ? "cause=after_heartbeats hb=\(hb)" : "cause=no_heartbeat")
}

func pollCanary() {
    guard canaryStatus == "spawned" else { return }
    pgrepAlive("g3a-canary") { alive in
        DispatchQueue.main.async {
            guard canaryStatus == "spawned" else { return }
            if !alive {
                // Process gone: distinguish an LDB kill (died after heartbeats,
                // no clean-exit line) from a spawn crash (no heartbeats ever)
                // and a clean full-TTL exit. This is what makes the canary a
                // valid measurement control.
                let (status, detail) = canaryExitRead()
                canaryStatus = status
                phase = "P1"   // clean condition restored once the canary is gone
                log("G3A_CANARY_\(status == "survived" ? "SURVIVED_FULL_TTL" : "DEAD") t=\(uptime()) \(detail)")
                return
            }
            if uptime() - canarySpawnAt > Double((CANARY_TTL + 60) / SCALE) {
                canaryStatus = "survived"
                log("G3A_CANARY_SURVIVED_FULL_TTL t=\(uptime()) cause=still_alive_past_ttl")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(5.0 / Double(SCALE))) {
                pollCanary()
            }
        }
    }
}

// ── decoy window (P3) — single deliberate show event ──────────────────────
func showDecoy() {
    guard !MOCK else { decoyShown = true; log("G3A_DECOY_SHOWN t=\(uptime()) mock=1"); return }
    let win = NSWindow(
        contentRect: NSRect(x: 80, y: 80, width: 320, height: 56),
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
    )
    win.level = .floating
    win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    win.isOpaque = false
    win.backgroundColor = NSColor(calibratedWhite: 0.0, alpha: 0.85)
    win.sharingType = .none
    let label = NSTextField(labelWithString: "G3A DECOY (root process window)")
    label.frame = NSRect(x: 12, y: 12, width: 296, height: 32)
    label.textColor = .white
    label.font = NSFont.systemFont(ofSize: 13)
    win.contentView?.addSubview(label)
    win.orderFrontRegardless()
    decoyShown = true
    log("G3A_DECOY_SHOWN t=\(uptime())")
}

// ── Carbon hotkey (copied from shield/shield.swift — PRIMARY path, no TCC) ─
func onHotKey() {
    capturesDone += 1
    runCapture(n: capturesDone, manual: true)
}
func hotKeyCallback(_ nextHandler: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    onHotKey()
    return 0
}
func registerHotKey() {
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
    log(status == 0 && hotKeyRef != nil ? "G3A_HOTKEY_OK" : "G3A_HOTKEY_FAIL status=\(status)")
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
}

// ── phase scheduling (from LDB detection) ─────────────────────────────────
func onLdbSeen() {
    if ldbSeenAt != nil { return }
    ldbSeenAt = uptime()
    phase = "P1"
    log("G3A_LDB_SEEN t=\(uptime())")
    log("G3A_SCHEDULE c1=+\(OFF_C1) c2=+\(OFF_C2) c3=+\(OFF_C3) c4=+\(OFF_C4) c5=+\(OFF_C5) canary=+\(OFF_CANARY) decoy=+\(OFF_DECOY) end=+\(DURATION) (end counts from rig start) scale=\(SCALE)")
    func at(_ off: Int, _ body: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(off) / Double(SCALE), execute: body)
    }
    // scheduled in chronological offset order so capture numbers are chronological
    at(OFF_C1) { capturesDone += 1; runCapture(n: capturesDone, manual: false) }
    at(OFF_C2) { capturesDone += 1; runCapture(n: capturesDone, manual: false) }
    at(OFF_C3) { capturesDone += 1; runCapture(n: capturesDone, manual: false) }
    at(OFF_C4) { capturesDone += 1; runCapture(n: capturesDone, manual: false) }
    at(OFF_C5) { capturesDone += 1; runCapture(n: capturesDone, manual: false) }
    at(OFF_CANARY) {
        phase = "P2"
        spawnCanary()
    }
    at(OFF_DECOY) {
        phase = "P3"
        showDecoy()
    }
    // If the quiz started late, the wall-clock end (DURATION from rig start)
    // could fire before the final capture. Extend only when it would cut the
    // phases short; otherwise keep the documented 45-min-from-arming contract.
    let remainingWall = Double(DURATION) - uptime()
    let phaseNeed = Double(OFF_C5) / Double(SCALE) + 15   // last capture + margin
    if remainingWall < phaseNeed {
        log(String(format: "G3A_END_EXTENDED wall_remaining=%.1f phase_need=%.1f t=%.1f",
                   remainingWall, phaseNeed, uptime()))
        scheduleEnd(after: phaseNeed)
    }
}

// ── end ───────────────────────────────────────────────────────────────────
func end(reason: String) {
    log("G3A_END reason=\(reason) captures=\(capturesDone) canary=\(canaryStatus) decoy=\(decoyShown ? 1 : 0) ldb_seen=\(ldbSeenAt.map { String(format: "%.1f", $0) } ?? "never") t=\(uptime())")
    // A signal during --arm-check must NOT look like a passed capture gate.
    exit(ARMCHECK ? 3 : 0)
}

// one-shot end timer; can be rescheduled (late LDB detection must not cut the
// final phases short)
func scheduleEnd(after interval: TimeInterval) {
    endTimer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + interval)
    t.setEventHandler { end(reason: "duration") }
    t.resume()
    endTimer = t
}

// ── entry point ───────────────────────────────────────────────────────────
FileManager.default.createFile(atPath: LOG_PATH, contents: nil)
logFile = FileHandle(forWritingAtPath: LOG_PATH)
logFile?.truncateFile(atOffset: 0)

log("G3A_START pid=\(getpid()) uid=\(getuid()) euid=\(geteuid()) mode=\(MOCK ? "mock" : ARMCHECK ? "arm-check" : "full") duration=\(DURATION) scale=\(SCALE) wall_utc=\(startWallFmt.string(from: Date()))")

// signal handlers for graceful end
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigTerm.setEventHandler { end(reason: "SIGTERM") }
sigTerm.resume()
let sigInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigInt.setEventHandler { end(reason: "SIGINT") }
sigInt.resume()

// end timer (wall-clock contract: DURATION from rig start)
scheduleEnd(after: Double(DURATION))

// heartbeat (experiment instrumentation — 2 s cadence, scaled)
let hb = DispatchSource.makeTimerSource(queue: .main)
hb.schedule(deadline: .now(), repeating: Double(2.0 / Double(SCALE)))
hb.setEventHandler {
    log(String(format: "G3A_HB t=%.1f ldb=%d phase=%@", uptime(), ldbSeenAt != nil ? 1 : 0, phase))
}
hb.resume()

if ARMCHECK {
    // one-shot capture -> verdict -> exit (mirrors shield --self-test codes)
    Task {
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                log("G3A_ARMCHECK NO_DISPLAY")
                exit(6)
            }
            let f = SCContentFilter(display: display, excludingWindows: [])
            let sb = try await captureFrame(f)
            guard let pb = CMSampleBufferGetImageBuffer(sb) else {
                log("G3A_ARMCHECK NO_PIXELBUFFER")
                exit(8)
            }
            let s = lumaStats(pb)
            let ok = s.mean > 8 && s.darkFrac < 0.995
            log(String(format: "G3A_ARMCHECK %@ meanLuma=%.1f darkFrac=%.3f", ok ? "PIXELS_OK" : "PIXELS_BLACK", s.mean, s.darkFrac))
            exit(ok ? 0 : 4)
        } catch RigError.timeout {
            log("G3A_ARMCHECK TIMEOUT_NO_FRAMES")
            exit(7)
        } catch {
            log("G3A_ARMCHECK CAPTURE_FAILED error=\(error)")
            exit(8)
        }
    }
    RunLoop.main.run()
} else if MOCK {
    log("G3A_HOTKEY_OK mock=1")
    log("G3A_FILTER_READY mock=1")
    if MOCK_LDB_AT <= 0 {
        pgrepAlive("LockDown Browser") { alive in
            DispatchQueue.main.async {
                if alive { onLdbSeen() }
            }
        }
    } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(MOCK_LDB_AT) / Double(SCALE)) {
            onLdbSeen()
        }
    }
    dispatchMain()
} else {
    // full mode: GUI init, hotkey, LDB guard, filter, poll
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    registerHotKey()

    // abort if LDB is already running (filter must be fetched PRE-LDB — F10)
    pgrepAlive("LockDown Browser") { alive in
        DispatchQueue.main.async {
            if alive {
                log("G3A_ABORT LDB_ALREADY_RUNNING t=\(uptime())")
                exit(2)
            }
        }
    }

    // fetch filter ONCE at startup (pre-LDB enumeration hygiene — F10)
    Task {
        do {
            let content = try await SCShareableContent.current
            guard let display = content.displays.first else {
                log("G3A_ABORT FILTER_FAIL error=NO_DISPLAY")
                exit(6)
            }
            let f = SCContentFilter(display: display, excludingWindows: [])
            await MainActor.run { filter = f }   // assign on main (shield.swift MAJOR-5)
            // re-check the pre-LDB guard AFTER the fetch: LDB must not have
            // launched during the enumeration window (F10 race closure)
            pgrepAlive("LockDown Browser") { alive in
                DispatchQueue.main.async {
                    if alive {
                        log("G3A_ABORT LDB_APPEARED_DURING_FETCH t=\(uptime())")
                        exit(2)
                    }
                    log("G3A_FILTER_READY t=\(uptime())")
                }
            }
        } catch {
            log("G3A_ABORT FILTER_FAIL error=\(error)")
            exit(8)
        }
    }

    // LDB detection poll (pgrep = process table, not LaunchServices)
    let poll = DispatchSource.makeTimerSource(queue: .global())
    poll.schedule(deadline: .now(), repeating: Double(10.0 / Double(SCALE)))
    poll.setEventHandler {
        pgrepAlive("LockDown Browser") { alive in
            if alive {
                DispatchQueue.main.async { onLdbSeen() }
            }
        }
    }
    poll.resume()

    RunLoop.main.run()
}
