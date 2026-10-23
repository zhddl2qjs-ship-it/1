import Foundation
import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit

@main
enum ScreenCaptureConfigurationTests {
    static func require(_ condition: Bool, _ message: String) {
        // Swift assert() is disabled by -O; retain these checks in release mode.
        if !condition { fatalError(message) }
    }

    static func main() {
        let crop = CGRect(x: 30, y: 40, width: 320, height: 240)
        // Leave the factory and its allocation scope before any copy. A retained
        // configuration must not contain a pointer to a released temporary color.
        let configurations: [SCStreamConfiguration] = autoreleasepool {
            [ScreenCaptureConfiguration.make(width: 640, height: 480,
                                              framesPerSecond: 5, sourceRect: nil),
             ScreenCaptureConfiguration.make(width: 640, height: 480,
                                              framesPerSecond: 30, sourceRect: crop)]
        }
        var copies = 0
        for _ in 0..<128 {
            for (index, original) in configurations.enumerated() {
                autoreleasepool {
                    // This exercises the same framework copy operation that
                    // crashed inside SCStream.init, without screen permissions.
                    guard let copy = original.copy() as? SCStreamConfiguration else {
                        fatalError("SCStreamConfiguration copy returned the wrong type")
                    }
                    require(copy !== original, "copy must return another configuration")
                    require(copy.width == 640 && copy.height == 480, "dimensions changed")
                    require(copy.pixelFormat == kCVPixelFormatType_32BGRA, "pixel format changed")
                    require(copy.queueDepth == 3, "queue depth changed")
                    require(!copy.showsCursor && !copy.capturesAudio, "capture flags changed")
                    require(copy.scalesToFit, "scaling changed")
                    if index == 1 { require(copy.sourceRect == crop, "crop changed") }
                    let interval = CMTime(value: 1, timescale: index == 0 ? 5 : 30)
                    require(CMTimeCompare(copy.minimumFrameInterval, interval) == 0, "frame rate changed")
                    copies += 1
                }
            }
        }
        print("PASS: \(copies) optimized ScreenCaptureKit configuration copies; no screen capture requested.")
    }
}
