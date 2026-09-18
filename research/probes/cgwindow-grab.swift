// Probe: one-shot CGWindowListCreateImage grab.
// Purpose: measure whether a single-shot grab (no persistent stream) produces
// observable OS activity (WindowServer/replayd logs), and whether it works
// from this process context without Screen Recording TCC grant.
import CoreGraphics
import Foundation

let start = Date()
if let img = CGWindowListCreateImage(.infinite, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution, .boundsIgnoreFraming]) {
    print("CGWINDOW_OK \(img.width)x\(img.height) elapsed=\(String(format: "%.3f", Date().timeIntervalSince(start)))s")
} else {
    print("CGWINDOW_NIL elapsed=\(String(format: "%.3f", Date().timeIntervalSince(start)))s")
}
