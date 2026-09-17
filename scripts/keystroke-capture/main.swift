// keystroke-capture — macOS global keystroke capture helper for OpenCluely.
//
// Creates a session-level CGEventTap at the head of the event stream that
// SWALLOWS every keyDown/flagsChanged event while running. Each swallowed
// keyDown is emitted to stdout as one JSON line:
//
//   {"t":"down","code":36,"char":"a"}
//
//   code = macOS virtual keycode (kVK_ANSI_A=0, kVK_Return=36, kVK_Escape=53,
//          kVK_Delete=51, kVK_Tab=48, arrows 123-126, space 49, …)
//   char = the character(s) the event would produce under the active
//          keyboard layout, INCLUDING modifier effects (e.g. "A" for
//          Shift+a). Empty for non-character keys.
//
// The tap returns nil from its callback for every event, so nothing reaches
// the focused application while capture is active — this is what lets the
// app type into its own focusable:false windows without the proctored page
// ever losing focus.
//
// Lifecycle: run the binary to start capturing; send SIGTERM to stop. The
// tap requires the "Input Monitoring" TCC permission, granted to whatever
// app launches this binary. If the tap cannot be created (permission not
// granted), it prints EVENT_TAP_CREATE_FAILED on stderr and exits 1.
//
// Build:  bash scripts/build-capture-helper.sh
//        (produces resources/bin/keystroke-capture)

import Cocoa
import ApplicationServices
import Foundation

// ─────────────────────────────────────────────────────────────────────
// POST MODE (test-harness only): "keystroke-capture post"
// Reads one JSON command per line from stdin and synthesizes REAL OS
// input events (mouse: no permission needed; keyboard: requires the
// Accessibility TCC grant on the spawning app).
//   {"op":"move","x":100,"y":200}
//   {"op":"click","x":100,"y":200}
//   {"op":"dblclick","x":100,"y":200}
//   {"op":"key","chars":"abc"}
//   {"op":"hotkey","keys":["cmd","shift","space"]}
//   {"op":"exit"}
// ─────────────────────────────────────────────────────────────────────
if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "post" {
    func postPoint(_ op: String, _ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: x, y: y)
    }

    func postMouse(_ type: CGEventType, _ p: CGPoint) {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: p,
            mouseButton: .left
        ) else { return }
        event.post(tap: .cghidEventTap)
        usleep(30000)
    }

    func processLine(_ line: String) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let op = obj["op"] as? String else { return }

        let x = obj["x"] as? Double ?? 0
        let y = obj["y"] as? Double ?? 0
        let p = CGPoint(x: x, y: y)

        switch op {
        case "move":
            postMouse(.mouseMoved, p)
        case "click":
            postMouse(.mouseMoved, p)
            postMouse(.leftMouseDown, p)
            postMouse(.leftMouseUp, p)
        case "down":
            postMouse(.mouseMoved, p)
            postMouse(.leftMouseDown, p)
        case "up":
            postMouse(.leftMouseUp, p)
        case "dblclick":
            postMouse(.mouseMoved, p)
            for _ in 0..<2 {
                postMouse(.leftMouseDown, p)
                postMouse(.leftMouseUp, p)
            }
        case "key":
            if let chars = obj["chars"] as? String {
                guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { break }
                let units = Array(chars.utf16)
                units.withUnsafeBufferPointer { buffer in
                    down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
                    up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: buffer.baseAddress!)
                }
                down.post(tap: .cghidEventTap)
                usleep(20000)
                up.post(tap: .cghidEventTap)
            }
        case "hotkey":
            if let keys = obj["keys"] as? [String] {
                var flags = CGEventFlags()
                var keyCode: CGKeyCode = 0
                for key in keys {
                    switch key {
                    case "cmd": flags.insert(.maskCommand)
                    case "shift": flags.insert(.maskShift)
                    case "ctrl": flags.insert(.maskControl)
                    case "alt": flags.insert(.maskAlternate)
                    case "space": keyCode = 49
                    case "return": keyCode = 36
                    case "escape": keyCode = 53
                    case "s": keyCode = 1
                    case "v": keyCode = 9
                    case "c": keyCode = 8
                    case "i": keyCode = 34
                    case "q": keyCode = 12
                    case "t": keyCode = 17
                    default: keyCode = 0
                    }
                }
                guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
                      let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else { break }
                down.flags = flags
                up.flags = flags
                down.post(tap: .cghidEventTap)
                usleep(20000)
                up.post(tap: .cghidEventTap)
            }
        case "exit":
            exit(0)
        case "where":
            if let loc = CGEvent(source: nil)?.location {
                print("{\"where\":[\(loc.x),\(loc.y)]}")
                fflush(stdout)
            }
        default:
            break
        }
    }

    let input = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = input.availableData
        if chunk.isEmpty { break }
        buffer.append(chunk)
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer[..<newlineIndex]
            buffer = buffer[buffer.index(after: newlineIndex)...]
            if let line = String(data: lineData, encoding: .utf8), !line.trimmingCharacters(in: .whitespaces).isEmpty {
                processLine(line)
            }
        }
    }
    exit(0)
}

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

let keyDownMask = CGEventMask(1) << CGEventType.keyDown.rawValue
let flagsChangedMask = CGEventMask(1) << CGEventType.flagsChanged.rawValue

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,
    eventsOfInterest: keyDownMask | flagsChangedMask,
    callback: { (_ proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, _ refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? in
        // Swallow modifier-only events: the unicode string of the keyDown
        // already reflects the modifier state.
        if type == .flagsChanged {
            return nil
        }
        if type != .keyDown {
            return nil
        }

        let code = event.getIntegerValueField(.keyboardEventKeycode)

        var units = [UniChar](repeating: 0, count: 8)
        var actualLength = 0
        event.keyboardGetUnicodeString(
            maxStringLength: units.count,
            actualStringLength: &actualLength,
            unicodeString: &units
        )
        let chars = actualLength > 0
            ? String(utf16CodeUnits: units, count: actualLength)
            : ""

        emit(["t": "down", "code": code, "char": chars])
        return nil // nil = swallow the event
    },
    userInfo: nil
) else {
    FileHandle.standardError.write("EVENT_TAP_CREATE_FAILED\n".data(using: .utf8)!)
    exit(1)
}

guard let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
    FileHandle.standardError.write("EVENT_TAP_RUNLOOP_FAILED\n".data(using: .utf8)!)
    exit(1)
}

CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
FileHandle.standardError.write("EVENT_TAP_READY\n".data(using: .utf8)!)

// Run until SIGTERM.
CFRunLoopRun()
