// g3a-canary.swift — G3A P2 control canary.
//
// A disposable uid-501 GUI app with a visible titled window: enumerable via
// NSRunningApplication and therefore a legitimate kill-loop target. Its
// EXPECTED death (SIGKILL by LDB, recorded in the eslogger JSONL) proves the
// kill loop was alive during the run — the measurement-validity control that
// makes a "nothing died" clean phase interpretable.
//
// Spawned by the root rig via `launchctl asuser <uid> sudo -u <uid>
// g3a-canary --ttl N` — asuser alone does NOT setuid, so sudo -u drops to
// uid 501 inside the user's bootstrap/audit session. It MUST run as uid 501:
// a root canary would be unkillable and the P2 control would invert.
// Runs at most --ttl seconds, then exits cleanly (CANARY_ALIVE_FULL_TTL).
// Heartbeats every 1 s to stdout (the rig redirects this to /tmp/g3a-canary.log).
// Deliberately does NOT capture, does NOT hide, does NOT resist: it must die
// if the loop is alive.
import AppKit
import Foundation

var ttl = 150
if let i = CommandLine.arguments.firstIndex(of: "--ttl"), i + 1 < CommandLine.arguments.count,
   let v = Int(CommandLine.arguments[i + 1]) {
    ttl = v
}

func out(_ s: String) { print(s); fflush(stdout) }

out("CANARY_START pid=\(getpid()) uid=\(getuid()) euid=\(geteuid()) ttl=\(ttl)")

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let win = NSWindow(
    contentRect: NSRect(x: 40, y: 40, width: 300, height: 60),
    styleMask: [.titled, .closable],
    backing: .buffered,
    defer: false
)
win.title = "G3A CANARY (uid \(getuid()))"
win.level = .normal
win.center()
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

let start = Date()
let hb = DispatchSource.makeTimerSource(queue: .main)
hb.schedule(deadline: .now(), repeating: 1.0)
hb.setEventHandler {
    let t = Date().timeIntervalSince(start)
    out(String(format: "CANARY_HB t=%.1f", t))
    if t >= Double(ttl) {
        out("CANARY_ALIVE_FULL_TTL")
        exit(0)
    }
}
hb.resume()

RunLoop.main.run()
