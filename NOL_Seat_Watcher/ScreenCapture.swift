import Foundation
import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit

// All rectangles in this file use a top-left origin. Display bounds are global
// screen points; sourceRect is local to that display and also measured in points.
// Pixel buffers are delivered directly in top-left, row-strided BGRA order.
struct CaptureGeometry {
    let displayID: CGDirectDisplayID
    let displayBounds: CGRect
    let pixelWidth: Int
    let pixelHeight: Int

    static func mainDisplay() -> CaptureGeometry? {
        let displayID = CGMainDisplayID()
        guard CGDisplayIsActive(displayID) != 0,
              let mode = CGDisplayCopyDisplayMode(displayID) else { return nil }
        let bounds = CGDisplayBounds(displayID)
        guard bounds.width > 0, bounds.height > 0,
              mode.pixelWidth > 0, mode.pixelHeight > 0 else { return nil }
        return CaptureGeometry(displayID: displayID, displayBounds: bounds,
                               pixelWidth: mode.pixelWidth, pixelHeight: mode.pixelHeight)
    }
}

// Requires macOS 13+. No legacy CGDisplayCreateImage calls are used.
// A session is single-use: create a new instance after stopping it.
final class ScreenCaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    private enum State { case idle, starting, running, stopped }

    private let geometry: CaptureGeometry
    private let sourceRect: CGRect?
    private let outputWidth: Int
    private let outputHeight: Int
    private let framesPerSecond: Int
    private let onFrame: (CVPixelBuffer, TimeInterval) -> Void
    private let onFailure: (String) -> Void
    private let sampleQueue = DispatchQueue(label: "local.seatwatcher.capture",
                                            qos: .userInitiated)
    // Recursive because a frame consumer can call stop() from its callback.
    // Consumers must use main.async, never main.sync, to update their UI.
    private let lock = NSRecursiveLock()
    private var state: State = .idle
    private var captureStream: SCStream?
    private var startCompletion: ((Result<Void, Error>) -> Void)?
    private var cachedFrame: CVPixelBuffer?
    private var lastCallback: TimeInterval = 0

    var lastCallbackTime: TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return lastCallback
    }

    init(geometry: CaptureGeometry, sourceRect: CGRect?, outputWidth: Int,
         outputHeight: Int, framesPerSecond: Int = 30,
         onFrame: @escaping (CVPixelBuffer, TimeInterval) -> Void,
         onFailure: @escaping (String) -> Void) {
        self.geometry = geometry
        self.sourceRect = sourceRect
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
        self.framesPerSecond = framesPerSecond
        self.onFrame = onFrame
        self.onFailure = onFailure
        super.init()
    }

    private static func error(_ message: String, code: Int = 1) -> NSError {
        NSError(domain: "SeatWatcher.ScreenCapture", code: code,
                userInfo: [NSLocalizedDescriptionKey: message])
    }

    func start(completion: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        guard state == .idle else {
            lock.unlock()
            DispatchQueue.main.async {
                completion(.failure(Self.error("이미 시작했거나 중지한 화면 캡처입니다.")))
            }
            return
        }
        state = .starting
        startCompletion = completion
        lastCallback = ProcessInfo.processInfo.systemUptime
        lock.unlock()

        guard outputWidth > 0, outputHeight > 0,
              outputWidth <= 16384, outputHeight <= 16384,
              outputWidth * outputHeight <= 64_000_000,
              (1...60).contains(framesPerSecond) else {
            fail(Self.error("캡처 영역이나 프레임 속도가 허용 범위를 벗어났습니다."))
            return
        }
        let displayRect = CGRect(origin: .zero, size: geometry.displayBounds.size)
        if let rect = sourceRect {
            guard rect.minX.isFinite, rect.minY.isFinite,
                  rect.width.isFinite, rect.height.isFinite,
                  rect.width > 0, rect.height > 0, displayRect.contains(rect) else {
                fail(Self.error("선택 영역이 현재 주 모니터 범위를 벗어났습니다. 다시 촬영하세요."))
                return
            }
        }
        guard let current = CaptureGeometry.mainDisplay(),
              current.displayID == geometry.displayID,
              current.displayBounds == geometry.displayBounds,
              current.pixelWidth == geometry.pixelWidth,
              current.pixelHeight == geometry.pixelHeight else {
            fail(Self.error("모니터 또는 화면 배율이 바뀌었습니다. 화면을 다시 촬영하세요."))
            return
        }

        Task { [weak self] in
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: true)
                self?.configureAndStart(content: content)
            } catch {
                self?.fail(error)
            }
        }
    }

    private func configureAndStart(content: SCShareableContent) {
        lock.lock()
        defer { lock.unlock() }
        guard state == .starting else { return }
        guard let display = content.displays.first(where: { $0.displayID == geometry.displayID }) else {
            fail(Self.error("주 모니터를 찾지 못했습니다. 화면 기록 권한과 모니터 연결을 확인하세요."))
            return
        }

        let configuration = SCStreamConfiguration()
        configuration.width = outputWidth
        configuration.height = outputHeight
        configuration.minimumFrameInterval = CMTime(value: 1,
                                                    timescale: CMTimeScale(framesPerSecond))
        configuration.queueDepth = 3
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.scalesToFit = true
        configuration.backgroundColor = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
        if let rect = sourceRect { configuration.sourceRect = rect }
        if #available(macOS 14.0, *) {
            configuration.preservesAspectRatio = false
            configuration.streamName = "좌석 감시 영역"
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        } catch {
            fail(error)
            return
        }
        captureStream = stream
        stream.startCapture { [weak self, weak stream] error in
            guard let self = self else {
                stream?.stopCapture(completionHandler: nil)
                return
            }
            if let error = error {
                self.fail(error)
                return
            }
            self.lock.lock()
            guard self.state == .starting, self.captureStream === stream else {
                self.lock.unlock()
                stream?.stopCapture(completionHandler: nil)
                return
            }
            self.state = .running
            self.lastCallback = ProcessInfo.processInfo.systemUptime
            self.lock.unlock()
            // Resolve on the main queue, checking the state again so a stop
            // during asynchronous setup cannot subsequently report success.
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.lock.lock()
                let callback = self.startCompletion
                self.startCompletion = nil
                let running = self.state == .running
                self.lock.unlock()
                if running {
                    callback?(.success(Void()))
                } else {
                    callback?(.failure(Self.error("화면 캡처가 취소되었습니다.", code: 2)))
                }
            }
        }
    }

    func stop() {
        lock.lock()
        guard state != .stopped else { lock.unlock(); return }
        state = .stopped
        let stream = captureStream
        captureStream = nil
        cachedFrame = nil
        let callback = startCompletion
        startCompletion = nil
        lock.unlock()
        stream?.stopCapture(completionHandler: nil)
        if let callback = callback {
            DispatchQueue.main.async {
                callback(.failure(Self.error("화면 캡처가 취소되었습니다.", code: 2)))
            }
        }
    }

    private func fail(_ error: Error) {
        lock.lock()
        guard state == .starting || state == .running else { lock.unlock(); return }
        state = .stopped
        let stream = captureStream
        captureStream = nil
        cachedFrame = nil
        let callback = startCompletion
        startCompletion = nil
        lock.unlock()
        stream?.stopCapture(completionHandler: nil)
        DispatchQueue.main.async { [onFailure] in
            // Startup failures go to the completion once; failures after a
            // successful start go to the run-time failure callback once.
            if let callback = callback {
                callback(.failure(error))
            } else {
                onFailure(error.localizedDescription)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        let isCurrent = captureStream === stream
        lock.unlock()
        if isCurrent { fail(error) }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen else { return }
        lock.lock()
        defer { lock.unlock() }
        guard (state == .starting || state == .running), captureStream === stream else { return }
        let now = ProcessInfo.processInfo.systemUptime
        lastCallback = now
        guard CMSampleBufferIsValid(sampleBuffer),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              let frameStatus = SCFrameStatus(rawValue: rawStatus) else {
            fail(Self.error("화면 프레임 상태를 확인하지 못해 감시를 중지했습니다."))
            return
        }

        switch frameStatus {
        case .complete, .started:
            guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
                // A started notification can precede the first image. If it
                // does carry one, cache it so a static screen can use idle frames.
                if frameStatus == .started { return }
                fail(Self.error("화면 이미지가 비어 있어 감시를 중지했습니다."))
                return
            }
            guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
                  CVPixelBufferGetWidth(buffer) == outputWidth,
                  CVPixelBufferGetHeight(buffer) == outputHeight else {
                fail(Self.error("캡처 이미지 크기 또는 형식이 바뀌어 감시를 중지했습니다."))
                return
            }
            cachedFrame = buffer
            onFrame(buffer, now)
        case .idle:
            // ScreenCaptureKit explicitly reports that the captured display
            // has not changed. Re-deliver the retained complete frame so a
            // stationary seat can satisfy a two-frame stability check. This
            // is not a newly captured frame and is not a latency measurement.
            if let buffer = cachedFrame { onFrame(buffer, now) }
        case .blank, .suspended, .stopped:
            cachedFrame = nil
            fail(Self.error("화면 캡처가 중단되거나 화면이 꺼져 감시를 중지했습니다. 화면을 확인한 뒤 다시 시작하세요."))
        @unknown default:
            cachedFrame = nil
            fail(Self.error("알 수 없는 화면 캡처 상태로 감시를 중지했습니다."))
        }
    }

    deinit {
        captureStream?.stopCapture(completionHandler: nil)
    }
}
