// Hold an SCK stream open for 10s so a separate process can poll LDB's
// detection APIs (CGDisplayIsCaptured / CGDisplayIsInMirrorSet) against it.
import ScreenCaptureKit
import CoreMedia
import Foundation

final class Delegate: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        let ts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        print("HOLD_FRAME t=\(ts)"); fflush(stdout)
    }
}

let del = Delegate()

Task {
    do {
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else { exit(2) }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 1280
        config.height = 720
        config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
        config.showsCursor = false
        let stream = SCStream(filter: filter, configuration: config, delegate: del)
        try stream.addStreamOutput(del, type: .screen, sampleHandlerQueue: DispatchQueue.global())
        print("HOLD_STARTED"); fflush(stdout)
        try await stream.startCapture()
        try await Task.sleep(nanoseconds: 10_000_000_000)
        print("HOLD_DONE"); fflush(stdout)
        exit(0)
    } catch {
        print("HOLD_FAILED error=\(error)"); fflush(stdout)
        exit(3)
    }
}

RunLoop.main.run()
