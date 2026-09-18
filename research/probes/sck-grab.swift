// Probe: ScreenCaptureKit one-frame stream capture.
// Purpose: measure the observable OS signature of a real SCK capture session,
// and whether it works from this process context (TCC Screen Recording).
import ScreenCaptureKit
import CoreMedia
import Foundation

final class Delegate: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        let ts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        print("SCK_FRAME_RECEIVED t=\(ts)")
        exit(0)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("SCK_STREAM_STOPPED error=\(error)")
        exit(6)
    }
}

let del = Delegate()

Task {
    do {
        let content = try await SCShareableContent.current
        guard let display = content.displays.first else {
            print("SCK_NO_DISPLAYS")
            exit(2)
        }
        print("SCK_DISPLAYS \(content.displays.count) id=\(display.displayID)")
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 320
        config.height = 180
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.showsCursor = false
        let stream = SCStream(filter: filter, configuration: config, delegate: del)
        try stream.addStreamOutput(del, type: .screen, sampleHandlerQueue: DispatchQueue.global())
        print("SCK_OUTPUT_ADDED")
        try await stream.startCapture()
        print("SCK_STARTED")
        try await Task.sleep(nanoseconds: 4_000_000_000)
        print("SCK_DONE_NO_FRAME")
        exit(5)
    } catch {
        print("SCK_FAILED error=\(error)")
        exit(3)
    }
}

RunLoop.main.run()
