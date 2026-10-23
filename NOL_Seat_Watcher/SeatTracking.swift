import Foundation
import CoreVideo
import CoreGraphics

struct AnalysisResult {
    let hit: SWSeat?
    let candidateCount: Int
    let processingMilliseconds: Double
    let receivedAt: TimeInterval
    let reportStatistics: Bool
    let error: String?
}

// One instance per monitoring run, used only by that capture session's serial
// output queue. C reads CVPixelBuffer rows directly; there is no Y-axis reversal.
final class SeatAnalysis {
    private var detector: OpaquePointer?
    private var tracker: OpaquePointer?
    private var width = 0
    private var height = 0
    private var seats = [SWSeat](repeating: SWSeat(x: 0, y: 0, diameter: 0, kind: 0), count: 4096)
    private let colors: UInt32
    private var lastStatistics: TimeInterval = 0

    init?(colors: UInt32, newOnly: Bool) {
        self.colors = colors
        tracker = sw_tracker_create(newOnly ? 1 : 0, 2, 0.35)
        if tracker == nil { return nil }
    }

    deinit {
        if let detector = detector { sw_detector_destroy(detector) }
        if let tracker = tracker { sw_tracker_destroy(tracker) }
    }

    func process(_ buffer: CVPixelBuffer, receivedAt: TimeInterval) -> AnalysisResult {
        let began = ProcessInfo.processInfo.systemUptime
        let report = receivedAt - lastStatistics >= 0.5
        if report { lastStatistics = receivedAt }
        func result(_ hit: SWSeat? = nil, count: Int = 0, error: String? = nil) -> AnalysisResult {
            AnalysisResult(hit: hit, candidateCount: count,
                           processingMilliseconds: (ProcessInfo.processInfo.systemUptime - began) * 1000,
                           receivedAt: receivedAt, reportStatistics: report, error: error)
        }
        let w = CVPixelBufferGetWidth(buffer), h = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
              w > 0, h > 0, w <= 16384, h <= 16384, w * h <= 32_000_000,
              stride >= w * 4, stride <= Int(Int32.max) else {
            return result(error: "분석할 화면 형식이나 크기가 지원 범위를 벗어났습니다. 영역을 줄여 다시 촬영하세요.")
        }
        if detector == nil {
            width = w; height = h
            detector = sw_detector_create(Int32(w), Int32(h))
        }
        guard w == width, h == height, let detector = detector, let tracker = tracker else {
            return result(error: "분석 버퍼를 준비하지 못했거나 화면 크기가 바뀌었습니다. 다시 촬영하세요.")
        }
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else {
            return result(error: "화면 픽셀을 읽지 못했습니다.")
        }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else {
            return result(error: "화면 픽셀 버퍼가 비어 있습니다.")
        }
        let count = seats.withUnsafeMutableBufferPointer { out in
            sw_detector_scan(detector, base.assumingMemoryBound(to: UInt8.self), Int32(stride),
                             colors, 9, 240, out.baseAddress, Int32(out.count))
        }
        guard count >= 0 else {
            return result(error: count == -2
                ? "감지 후보가 너무 많습니다. 좌석만 포함하도록 영역을 줄이세요."
                : "좌석 분석에 실패했습니다. 다시 촬영하세요.")
        }
        var confirmed = SWSeat(x: 0, y: 0, diameter: 0, kind: 0)
        let state = seats.withUnsafeBufferPointer { input in
            sw_tracker_update(tracker, input.baseAddress, count, receivedAt, &confirmed)
        }
        guard state >= 0 else { return result(error: "좌석 변화 추적에 실패해 감시를 중지했습니다.") }
        return result(state == 1 ? confirmed : nil, count: Int(count))
    }
}

// This is a snapshot copy for the selection UI only. Monitoring itself does not
// create CGImages or copy full-display buffers on each frame.
func snapshotImage(_ buffer: CVPixelBuffer) -> CGImage? {
    guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
          CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return nil }
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    guard let base = CVPixelBufferGetBaseAddress(buffer), width > 0, height > 0 else { return nil }
    let bytes = Data(bytes: base, count: stride * height)
    guard let provider = CGDataProvider(data: bytes as CFData),
          let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                   bytesPerRow: stride, space: space,
                   bitmapInfo: CGBitmapInfo.byteOrder32Little.union(
                       CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue)),
                   provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}
