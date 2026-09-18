// One-shot capture probe with PIXEL VERDICT — no files written to disk.
// Captures 2 frames of the main display and reports luma statistics so the
// gate question is answered: does the exam screen yield real pixels or black?
// (LDB runs cleanUpScreenShotsTimer — never write captures to disk.)
import ScreenCaptureKit
import CoreMedia
import CoreVideo
import Foundation

func out(_ s: String) { print(s); fflush(stdout) }

var frameCount = 0

func stats(_ pixelBuffer: CVPixelBuffer) -> (mean: Double, darkFrac: Double) {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return (0, 1) }
    let w = CVPixelBufferGetWidth(pixelBuffer)
    let h = CVPixelBufferGetHeight(pixelBuffer)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
    var sum = 0.0
    var dark = 0.0
    var n = 0.0
    let rowPtr = base.assumingMemoryBound(to: UInt8.self)
    for y in 0..<max(1, h / 4) {           // sample every 4th row
        let row = rowPtr.advanced(by: y * 4 * bytesPerRow)
        for x in stride(from: 0, to: w * 4, by: 16) {   // sample every 4th pixel
            let r = Double(row[x + 2]), g = Double(row[x + 1]), b = Double(row[x])
            let luma = 0.299 * r + 0.587 * g + 0.114 * b
            sum += luma
            if luma < 16 { dark += 1 }
            n += 1
        }
    }
    return (sum / max(n, 1), dark / max(n, 1))
}

final class Cap: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        frameCount += 1
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            out("FRAME \(frameCount): NO_PIXELBUFFER")
            return
        }
        let s = stats(pb)
        out(String(format: "FRAME %d meanLuma=%.1f darkFrac=%.3f", frameCount, s.mean, s.darkFrac))
        if frameCount >= 2 {
            let verdict = (s.mean > 8 && s.darkFrac < 0.995) ? "PIXELS_OK" : "PIXELS_BLACK"
            out("VERDICT \(verdict)")
            exit(verdict == "PIXELS_OK" ? 0 : 4)
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        out("STREAM_STOPPED error=\(error)")
        exit(5)
    }
}

let cap = Cap()

Task {
    do {
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else {
            out("VERDICT NO_DISPLAY")
            exit(6)
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 1280
        config.height = 720
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        config.showsCursor = false
        let stream = SCStream(filter: filter, configuration: config, delegate: cap)
        try stream.addStreamOutput(cap, type: .screen, sampleHandlerQueue: DispatchQueue.global())
        out("CAPTURE_STARTED")
        try await stream.startCapture()
        try await Task.sleep(nanoseconds: 8_000_000_000)
        out("VERDICT TIMEOUT_NO_FRAMES")
        exit(7)
    } catch {
        out("VERDICT CAPTURE_FAILED error=\(error)")
        exit(8)
    }
}

RunLoop.main.run()
