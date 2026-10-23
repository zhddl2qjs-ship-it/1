import Foundation
import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit

enum ScreenCaptureConfiguration {
    static func make(width: Int, height: Int, framesPerSecond: Int,
                     sourceRect: CGRect?) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1,
                                                    timescale: CMTimeScale(framesPerSecond))
        configuration.queueDepth = 3
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        // This is a global CFString constant, not a temporary CF object.
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.scalesToFit = true
        // Keep ScreenCaptureKit's clear background default. backgroundColor is
        // an assign CGColorRef property: assigning a temporary Swift CGColor
        // can leave a dangling pointer when SCStream copies the configuration.
        if let rect = sourceRect { configuration.sourceRect = rect }
        if #available(macOS 14.0, *) {
            configuration.preservesAspectRatio = false
            configuration.streamName = "좌석 감시 영역"
        }
        return configuration
    }
}
