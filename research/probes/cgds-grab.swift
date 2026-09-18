// Probe: CGDisplayStream (legacy display capture) on macOS 26.
// Questions: (1) does it still deliver frames? (2) does it route through
// replayd / produce a kTCCServiceScreenCapture signature like SCK does?
import CoreGraphics
import Foundation

let d = CGMainDisplayID()
let w = 640
let h = 360
var frames = 0
let sem = DispatchSemaphore(value: 0)

let opts: [CFString: Any] = [kCGDisplayStreamShowCursor: false]

guard let stream = CGDisplayStreamCreate(
    d, w, h, Int32(kCVPixelFormatType_32BGRA), opts as CFDictionary
) { _, displayTime, frameSurface, _ in
    frames += 1
    if frames == 1 {
        print("CGDS_FRAME t=\(displayTime)")
        sem.signal()
    }
} else {
    print("CGDS_CREATE_FAILED")
    exit(1)
}

CGDisplayStreamStart(stream)
if sem.wait(timeout: .now() + 8) == .timedOut {
    print("CGDS_TIMEOUT_NO_FRAME")
}
print("CGDS_FRAMES \(frames)")
CGDisplayStreamStop(stream)
exit(frames > 0 ? 0 : 2)
