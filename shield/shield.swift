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
import CoreImage
import ImageIO

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

// ── Day 2–3: cached config, DeepSeek answer, Unix-socket IPC ─────────────
// Config/credentials are cached ROOT-OWNED so the helper answers autonomously
// after the Brain quits in exam mode (the Brain never needs to stay alive).
// The Unix socket is how the uid-501 Brain pushes config/commands to the root
// helper before quitting — and how an operator can drive the helper directly.

struct ShieldConfig: Codable {
    var apiKey: String = ""
    var baseUrl: String = "https://api.deepseek.com"
    var model: String = "deepseek-flash"
    var maxTokens: Int = 4096
    var temperature: Double = 0.7
    var prompt: String = "You are an exam assistant. Read the question shown on the screen and answer it correctly and concisely. If it is multiple choice, give the letter and a one-line reason. If it is a coding question, give the code in a fenced block with the language tag."
    var examMode: Bool = false
    // Shared secret for the socket. The helper stores it root-only (0600); the
    // Brain reads it from CLUELY_SHIELD_TOKEN and must echo it on every
    // mutating command. A uid-501 attacker (LDB) does not know it, so it cannot
    // reconfigure, disable, or answer-spam the helper. Empty = token auth
    // disabled (operator has not configured it).
    var token: String = ""

    // Tolerant decode: any absent key falls back to its default, so configs
    // written before a field was added still load (forward/backward compatible).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        apiKey = try c.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        baseUrl = try c.decodeIfPresent(String.self, forKey: .baseUrl) ?? "https://api.deepseek.com"
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? "deepseek-flash"
        maxTokens = try c.decodeIfPresent(Int.self, forKey: .maxTokens) ?? 4096
        temperature = try c.decodeIfPresent(Double.self, forKey: .temperature) ?? 0.7
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt) ?? "You are an exam assistant. Read the question shown on the screen and answer it correctly and concisely. If it is multiple choice, give the letter and a one-line reason. If it is a coding question, give the code in a fenced block with the language tag."
        examMode = try c.decodeIfPresent(Bool.self, forKey: .examMode) ?? false
        token = try c.decodeIfPresent(String.self, forKey: .token) ?? ""
    }

    init() {}
}

// baseUrl allowlist: the helper only ever sends frames + the API key to these
// hosts. A hostile `configure` cannot redirect the bearer key to an arbitrary
// host — exfiltration is unrepresentable regardless of socket auth.
let allowedBaseUrls: Set<String> = [
    "https://api.deepseek.com",
    "https://api.deepseek.com.cn"
]

let configPathDefault = "/var/root/.cluely-shield/config.json"
let socketPathDefault = "/tmp/cluely-shield.sock"

func shieldConfigPath() -> String {
    if let i = CommandLine.arguments.firstIndex(of: "--config"), i + 1 < CommandLine.arguments.count {
        return CommandLine.arguments[i + 1]
    }
    return configPathDefault
}

func loadConfig(_ path: String) -> ShieldConfig {
    guard let data = FileManager.default.contents(atPath: path),
          let cfg = try? JSONDecoder().decode(ShieldConfig.self, from: data) else {
        return ShieldConfig()
    }
    return cfg
}

func saveConfig(_ cfg: ShieldConfig, _ path: String) throws {
    let data = try JSONEncoder().encode(cfg)
    let dir = (path as NSString).deletingLastPathComponent
    if !dir.isEmpty && !FileManager.default.fileExists(atPath: dir) {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }
    try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    // root-only: 0600, owned by root (FileManager default owner is the writer)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
}

// ── JPEG encode (RAM only — frames never touch disk) ──────────────────────
func jpegData(from pixelBuffer: CVPixelBuffer) -> Data? {
    let ci = CIImage(cvPixelBuffer: pixelBuffer)
    let ctx = CIContext(options: nil)
    guard let cs = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    return ctx.jpegRepresentation(of: ci, colorSpace: cs, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8])
}

// ── DeepSeek (OpenAI-compatible) answer client ─────────────────────────────
// Mirrors src/services/deepseek.client.js buildChatBody: image_url data URL,
// thinking disabled (critical — otherwise reasoning burns the whole token
// budget and the API returns finish_reason=length with ZERO content).
enum AnswerError: Error {
    case noApiKey
    case http(Int, String)
    case empty
    case parse
    case badBaseUrl
}

func deepSeekAnswer(imageJPEG: Data, config: ShieldConfig) async throws -> String {
    guard !config.apiKey.isEmpty else { throw AnswerError.noApiKey }
    let base = config.baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    // Allowlist: never send the bearer key + frames to a foreign host.
    guard allowedBaseUrls.contains(base) else { throw AnswerError.badBaseUrl }
    guard let url = URL(string: base + "/chat/completions") else { throw AnswerError.parse }
    let b64 = imageJPEG.base64EncodedString()
    let body: [String: Any] = [
        "model": config.model,
        "messages": [
            ["role": "system", "content": config.prompt],
            ["role": "user", "content": [
                ["type": "text", "text": "Answer the question shown in this image."],
                ["type": "image_url", "image_url": ["url": "data:image/jpeg;base64," + b64]]
            ]]
        ],
        "stream": false,
        "thinking": ["type": "disabled"],
        "max_tokens": config.maxTokens,
        "temperature": config.temperature
    ]
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")
    req.setValue("CluelyShield/1.0", forHTTPHeaderField: "User-Agent")
    req.httpBody = try JSONSerialization.data(withJSONObject: body)
    req.timeoutInterval = 60
    req.cachePolicy = .reloadIgnoringLocalCacheData

    // Ephemeral (no disk cache): answers and image URLs never touch disk.
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 60
    let (data, resp) = try await URLSession(configuration: cfg).data(for: req)
    guard let http = resp as? HTTPURLResponse else { throw AnswerError.parse }
    guard http.statusCode == 200 else {
        let msg = String(data: data, encoding: .utf8) ?? ""
        throw AnswerError.http(http.statusCode, msg.prefix(300).description)
    }
    guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let choices = obj["choices"] as? [[String: Any]],
          let first = choices.first,
          let message = first["message"] as? [String: Any],
          let content = message["content"] as? String,
          !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw AnswerError.empty
    }
    return content.trimmingCharacters(in: .whitespacesAndNewlines)
}

// ── Unix-socket IPC server ─────────────────────────────────────────────────
// Listens on /tmp/cluely-shield.sock for newline-delimited JSON commands from
// the uid-501 Brain (or the operator). Runs on a background queue so it never
// blocks the Carbon hotkey main loop.
// Commands (one JSON object per line):
//   {"cmd":"configure","apiKey":"...","model":"...","prompt":"...","baseUrl":"...","examMode":true}
//   {"cmd":"exam-mode","on":true}
//   {"cmd":"answer"}                  — force a capture+answer now
//   {"cmd":"quit"}                    — orderly shutdown
// Replies: {"ok":true,...} or {"ok":false,"error":"..."}
final class SocketServer: @unchecked Sendable {
    let path: String
    private let queue = DispatchQueue(label: "cluely.shield.socket")
    private var listener: Int32 = -1
    private let onCommand: ([String: Any]) -> [String: Any]

    init(path: String, onCommand: @escaping ([String: Any]) -> [String: Any]) {
        self.path = path
        self.onCommand = onCommand
    }

    func start() {
        queue.async { self.runLoop() }
    }

    func stop() {
        queue.async {
            if self.listener >= 0 { close(self.listener); self.listener = -1 }
            unlink(self.path)
        }
    }

    private func runLoop() {
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { log("SOCKET_FAIL socket"); return }
        listener = fd
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let sunLen = MemoryLayout.size(ofValue: addr.sun_path)
        let pathBytes = Array(path.utf8)
        withUnsafeMutablePointer(to: &addr.sun_path) { p in
            p.withMemoryRebound(to: CChar.self, capacity: sunLen) { dst in
                for (i, b) in pathBytes.prefix(sunLen - 1).enumerated() {
                    dst[i] = CChar(bitPattern: b)
                }
                dst[min(pathBytes.count, sunLen - 1)] = 0
            }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, size)
            }
        }
        guard bound == 0 else { log("SOCKET_FAIL bind errno=\(errno)"); close(fd); listener = -1; return }
        chmod(path, 0o666)   // uid-501 Brain must be able to connect
        guard Darwin.listen(fd, 4) == 0 else { log("SOCKET_FAIL listen"); close(fd); listener = -1; return }
        log("SOCKET_READY path=\(path)")

        while listener >= 0 {
            let client = Darwin.accept(fd, nil, nil)
            guard client >= 0 else {
                if errno == EINTR { continue }
                if listener < 0 { break }
                continue
            }
            // Per-client receive timeout: a peer that connects and sends
            // nothing cannot starve the accept loop (one blocked read would
            // otherwise hold the whole server).
            var tv = timeval(tv_sec: 5, tv_usec: 0)
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
            handle(client)
            close(client)
        }
        unlink(path)
        log("SOCKET_CLOSED")
    }

    private func handle(_ client: Int32) {
        // Stream protocol: newline-delimited JSON, one reply per command,
        // process until the client closes (read returns 0). Lets the Brain send
        // a sequence (configure → exam-mode → …) over one connection.
        var pending = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = chunk.withUnsafeMutableBytes { Darwin.read(client, $0.baseAddress, 4096) }
            if n < 0 {
                if errno == EINTR { continue }
                break
            }
            if n == 0 { break }   // client closed
            pending.append(chunk, count: n)
            // process every complete line currently buffered
            while let nl = pending.firstIndex(of: 10) {
                let line = Data(pending[..<nl])
                pending.removeSubrange(...nl)
                guard let data = String(data: line, encoding: .utf8)?.data(using: .utf8),
                      let cmd = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    reply(client, ["ok": false, "error": "bad json"])
                    continue
                }
                let resp = onCommand(cmd)
                reply(client, resp)
            }
        }
    }

    private func reply(_ client: Int32, _ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        var out = data
        out.append(10)
        _ = out.withUnsafeBytes { Darwin.write(client, $0.baseAddress, out.count) }
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
    var config = ShieldConfig()           // config lives on main only; snapshot per capture
    private var socket: SocketServer?
    private let configPath: String

    init(configPath: String) {
        self.configPath = configPath
        super.init()
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
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

    // ── startup: load config, open socket, fetch filter ONCE, register hotkey
    func start() {
        registerHotKey()
        startSocket()
        self.config = loadConfig(configPath)
        log("CONFIG_LOADED examMode=\(config.examMode ? 1 : 0) model=\(config.model) apiKeySet=\(config.apiKey.isEmpty ? 0 : 1)")
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
            log(String(format: "CAPTURED meanLuma=%.1f darkFrac=%.3f ok=%d", s.mean, s.darkFrac, ok ? 1 : 0))
            guard ok else {
                DispatchQueue.main.async { self.updateOverlay("⚠ black frames — possible TCC loss (re-run --self-test)") }
                return
            }
            let cfg = DispatchQueue.main.sync { self.config }   // snapshot on main
            guard !cfg.apiKey.isEmpty else {
                DispatchQueue.main.async {
                    self.updateOverlay(String(format: "✓ captured — mean luma %.0f · dark %.0f%%\n(no API key — run the configure command over the socket)", s.mean, s.darkFrac * 100))
                }
                return
            }
            guard let jpeg = jpegData(from: pb) else {
                log("ANSWER_FAIL jpeg_encode")
                DispatchQueue.main.async { self.updateOverlay("⚠ JPEG encode failed") }
                return
            }
            DispatchQueue.main.async { self.updateOverlay("… answering …") }
            log("ANSWER_SENT bytes=\(jpeg.count) model=\(cfg.model)")
            do {
                let answer = try await deepSeekAnswer(imageJPEG: jpeg, config: cfg)
                log("ANSWER_OK len=\(answer.count)")
                DispatchQueue.main.async { self.updateOverlay(answer) }
            } catch {
                log("ANSWER_FAIL error=\(error)")
                DispatchQueue.main.async { self.updateOverlay("⚠ answer failed: \(error)") }
            }
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

    // ── socket command dispatch (uid-501 Brain → root helper) ──────────────
    func startSocket() {
        let s = SocketServer(path: socketPathDefault) { [weak self] cmd in
            self?.handleCommand(cmd) ?? ["ok": false, "error": "gone"]
        }
        self.socket = s
        s.start()
    }

    func handleCommand(_ cmd: [String: Any]) -> [String: Any] {
        guard let name = cmd["cmd"] as? String else { return ["ok": false, "error": "no cmd"] }
        // Token auth on every mutating command. `ping` stays open (read-only);
        // everything else requires the shared secret when one is configured.
        if name != "ping" {
            let expected = DispatchQueue.main.sync { self.config.token }
            let given = cmd["token"] as? String ?? ""
            if !expected.isEmpty && given != expected {
                log("SOCKET_AUTH_DENIED cmd=\(name)")
                return ["ok": false, "error": "unauthorized"]
            }
        }
        switch name {
        case "ping":
            let em = DispatchQueue.main.sync { self.config.examMode }
            return ["ok": true, "pid": getpid(), "examMode": em]
        case "configure":
            var ok = true
            var err = ""
            DispatchQueue.main.sync {
                // baseUrl allowlist enforced at the boundary too: reject a
                // hostile baseUrl before it ever reaches the answer path.
                if let b = cmd["baseUrl"] as? String {
                    let norm = b.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    guard allowedBaseUrls.contains(norm) else {
                        ok = false; err = "baseUrl not allowed"
                        return
                    }
                    self.config.baseUrl = norm
                }
                if ok {
                    if let k = cmd["apiKey"] as? String { self.config.apiKey = k }
                    if let m = cmd["model"] as? String { self.config.model = m }
                    if let p = cmd["prompt"] as? String { self.config.prompt = p }
                    if let t = cmd["maxTokens"] as? Int { self.config.maxTokens = t }
                    if let em = cmd["examMode"] as? Bool { self.config.examMode = em }
                    if let tok = cmd["token"] as? String, self.config.token.isEmpty { self.config.token = tok }
                }
            }
            guard ok else { return ["ok": false, "error": err] }
            do { try saveConfig(DispatchQueue.main.sync { self.config }, self.configPath) }
            catch { return ["ok": false, "error": "save failed: \(error)"] }
            let (em, m) = DispatchQueue.main.sync { (self.config.examMode, self.config.model) }
            log("CONFIG_SAVED examMode=\(em ? 1 : 0) model=\(m) apiKeySet=\(DispatchQueue.main.sync { self.config.apiKey.isEmpty } ? 0 : 1)")
            return ["ok": true, "examMode": em, "model": m]
        case "exam-mode":
            let on = cmd["on"] as? Bool ?? true
            DispatchQueue.main.sync { config.examMode = on }
            try? saveConfig(DispatchQueue.main.sync { self.config }, configPath)
            let em = DispatchQueue.main.sync { self.config.examMode }
            log("EXAM_MODE on=\(on ? 1 : 0)")
            return ["ok": true, "examMode": em]
        case "answer":
            guard DispatchQueue.main.sync(execute: { self.filter }) != nil else {
                return ["ok": false, "error": "filter not ready"]
            }
            DispatchQueue.main.async { self.onHotKey() }
            return ["ok": true, "queued": true]
        case "quit":
            log("SOCKET_QUIT")
            DispatchQueue.main.async {
                NSApplication.shared.terminate(nil)
                exit(0)
            }
            return ["ok": true]
        default:
            return ["ok": false, "error": "unknown cmd \(name)"]
        }
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
let isAnswerTest = CommandLine.arguments.contains("--answer-test")
let isSocketTest = CommandLine.arguments.contains("--socket-test")
let shield = Shield(configPath: shieldConfigPath())

if isSocketTest {
    // Day-2 seam test WITHOUT root/GUI: drive the REAL Shield.handleCommand
    // (token auth, baseUrl allowlist, saveConfig/loadConfig persistence) over
    // the socket, so the production command path is exercised headless.
    let testShield = Shield(configPath: "/tmp/cluely-shield-test/socket-config.json")
    let s = SocketServer(path: socketPathDefault) { cmd in
        testShield.handleCommand(cmd)
    }
    s.start()
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { exit(0) }
    RunLoop.main.run()
} else if isAnswerTest {
    // Day-2 seam test WITHOUT screen capture: encode a fixture image → call
    // DeepSeek → print the answer. Exercises JPEG+HTTP+JSON end-to-end as a
    // non-root run so the answer pipeline is verified before any exam.
    // image path = first positional arg that is not a flag and not the value of
    // --config. (--answer-test <image> [--config PATH])
    let args = Array(CommandLine.arguments.dropFirst())
    var imgPath = "vision-test-image.png"
    for i in 0..<args.count {
        if args[i] == "--config" { continue }        // skip the flag
        if i > 0 && args[i - 1] == "--config" { continue }  // skip its value
        if args[i].hasPrefix("--") { continue }
        imgPath = args[i]
        break
    }
    let cfg = loadConfig(shieldConfigPath())
    guard let data = FileManager.default.contents(atPath: imgPath) else {
        log("ANSWER_TEST_FAIL no image at \(imgPath)")
        exit(9)
    }
    guard let img = NSBitmapImageRep(data: data),
          let cg = img.cgImage else {
        log("ANSWER_TEST_FAIL cannot decode image")
        exit(9)
    }
    // re-encode through the same JPEG path used on captured frames
    let ci = CIImage(cgImage: cg)
    let ctx = CIContext(options: nil)
    guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
          let jpeg = ctx.jpegRepresentation(of: ci, colorSpace: cs, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.8]) else {
        log("ANSWER_TEST_FAIL jpeg encode")
        exit(9)
    }
    guard !cfg.apiKey.isEmpty else {
        log("ANSWER_TEST_FAIL no api key (configure --config PATH with apiKey, or set env)")
        exit(9)
    }
    log("ANSWER_TEST_SEND bytes=\(jpeg.count) model=\(cfg.model)")
    Task {
        do {
            let a = try await deepSeekAnswer(imageJPEG: jpeg, config: cfg)
            log("ANSWER_TEST_OK len=\(a.count)")
            print("---- ANSWER ----")
            print(a)
            print("---- /ANSWER ----")
            exit(0)
        } catch {
            log("ANSWER_TEST_FAIL error=\(error)")
            exit(9)
        }
    }
    RunLoop.main.run()
} else if isSelfTest {
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
