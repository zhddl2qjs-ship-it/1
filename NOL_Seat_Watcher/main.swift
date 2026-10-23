import AppKit
import ApplicationServices
import CoreGraphics
import CoreVideo

private func axAttribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

// Checking a bundle ID alone cannot distinguish two tabs/windows in one browser.
// Auto-click requires a stable focused accessibility window, title and geometry.
private struct BrowserAnchor {
    let pid: pid_t
    let bundle: String
    let window: AXUIElement
    let title: String
    let document: String?
    let bounds: CGRect

    static func read() -> BrowserAnchor? {
        let browsers = ["com.google.Chrome", "com.apple.Safari", "org.mozilla.firefox",
                        "com.microsoft.edgemac", "com.brave.Browser", "com.operasoftware.Opera"]
        guard let app = NSWorkspace.shared.frontmostApplication,
              let bundle = app.bundleIdentifier, browsers.contains(bundle),
              let rawWindow = axAttribute(AXUIElementCreateApplication(app.processIdentifier),
                                          kAXFocusedWindowAttribute as CFString),
              CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { return nil }
        let window = rawWindow as! AXUIElement
        guard let title = axAttribute(window, kAXTitleAttribute as CFString) as? String,
              !title.isEmpty,
              let rawPosition = axAttribute(window, kAXPositionAttribute as CFString),
              let rawSize = axAttribute(window, kAXSizeAttribute as CFString),
              CFGetTypeID(rawPosition) == AXValueGetTypeID(),
              CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
        var position = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position),
              AXValueGetValue(rawSize as! AXValue, .cgSize, &size),
              size.width > 0, size.height > 0 else { return nil }
        return BrowserAnchor(pid: app.processIdentifier, bundle: bundle, window: window,
                             title: title,
                             document: axAttribute(window, kAXDocumentAttribute as CFString) as? String,
                             bounds: CGRect(origin: position, size: size))
    }

    func isUnchanged() -> Bool {
        guard let current = BrowserAnchor.read() else { return false }
        return current.pid == pid && current.bundle == bundle && CFEqual(current.window, window)
            && current.title == title && current.document == document
            && abs(current.bounds.minX - bounds.minX) < 1
            && abs(current.bounds.minY - bounds.minY) < 1
            && abs(current.bounds.width - bounds.width) < 1
            && abs(current.bounds.height - bounds.height) < 1
    }
}

final class AppController: NSObject, NSApplicationDelegate {
    private enum State { case idle, snapshot, starting, monitoring }
    private var state: State = .idle
    private var generation: UInt64 = 0
    private var session: ScreenCaptureSession?
    private var watchdog: Timer?
    private var geometry: CaptureGeometry?
    private var browser: BrowserAnchor?
    private var automatic = false
    private var controls: [NSControl] = []
    private var globalEvents: Any?
    private var localEvents: Any?
    private var window: NSWindow!
    private var preview: PreviewView!
    private var message: NSTextField!
    private var statistics: NSTextField!
    private var blue: NSButton!
    private var green: NSButton!
    private var purple: NSButton!
    private var newOnly: NSButton!
    private var testOnly: NSButton!
    private var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        createMenu()
        buildWindow()
        installInputMonitors()
        showWindow()
    }

    private func createMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Seat Watcher 종료", action: #selector(quit), keyEquivalent: "q").target = self
        appItem.submenu = appMenu; menu.addItem(appItem); NSApp.mainMenu = menu
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "좌석감시: 대기"
        let statusMenu = NSMenu()
        statusMenu.addItem(withTitle: "창 열기 · 감시 중지", action: #selector(stopAndShow), keyEquivalent: "").target = self
        statusMenu.addItem(withTitle: "즉시 중지", action: #selector(stopAndShow), keyEquivalent: "").target = self
        statusMenu.addItem(.separator())
        statusMenu.addItem(withTitle: "종료", action: #selector(quit), keyEquivalent: "").target = self
        statusItem.menu = statusMenu
    }

    private func label(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat,
                       height: CGFloat = 20, size: CGFloat = 13) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.frame = CGRect(x: x, y: y, width: width, height: height)
        field.font = .systemFont(ofSize: size)
        return field
    }

    private func checkbox(_ title: String, x: CGFloat, y: CGFloat, width: CGFloat,
                          checked: Bool) -> NSButton {
        let button = NSButton(checkboxWithTitle: title, target: nil, action: nil)
        button.frame = CGRect(x: x, y: y, width: width, height: 24)
        button.state = checked ? .on : .off
        window.contentView?.addSubview(button); controls.append(button)
        return button
    }

    private func buildWindow() {
        window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 980, height: 730),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Seat Watcher 2.2 · 좌석 변화 감지"
        window.center(); window.isReleasedWhenClosed = false
        guard let host = window.contentView else { return }
        host.addSubview(label("좌석 변화 감지 · 한 번 클릭", x: 24, y: 685, width: 920, height: 28, size: 21))
        host.addSubview(label("① 브라우저에 좌석 화면 표시  ② 화면 촬영  ③ 좌석 영역 선택  ④ 테스트로 확인", x: 24, y: 658, width: 932))
        preview = PreviewView(frame: CGRect(x: 24, y: 220, width: 932, height: 427))
        preview.onRegionChange = { [weak self] rect in
            guard let self = self else { return }
            if let r = rect {
                self.report("선택 영역: \(Int(r.width)) × \(Int(r.height))px. 좌석 원이 잘리지 않게 여백을 남겨 주세요.")
            } else { self.report("좌석이 있는 영역을 드래그해 선택하세요.") }
        }
        host.addSubview(preview)
        let capture = NSButton(title: "화면 촬영", target: self, action: #selector(captureScreenshot))
        capture.frame = CGRect(x: 24, y: 175, width: 112, height: 32)
        host.addSubview(capture); controls.append(capture)
        blue = checkbox("파랑", x: 156, y: 180, width: 68, checked: true)
        green = checkbox("초록", x: 226, y: 180, width: 68, checked: true)
        purple = checkbox("보라", x: 296, y: 180, width: 68, checked: true)
        let start = NSButton(title: "감시 시작", target: self, action: #selector(startMonitoring))
        start.frame = CGRect(x: 729, y: 171, width: 111, height: 38)
        start.bezelStyle = .rounded; host.addSubview(start); controls.append(start)
        let stop = NSButton(title: "중지", target: self, action: #selector(stopAndShow))
        stop.frame = CGRect(x: 848, y: 171, width: 108, height: 38); host.addSubview(stop)
        newOnly = checkbox("시작할 때 있는 좌석 제외 · 이후 등장만", x: 24, y: 141, width: 330, checked: true)
        testOnly = checkbox("테스트 모드 · 클릭 안 함", x: 370, y: 141, width: 236, checked: true)
        message = label("먼저 화면을 촬영하고 감시 영역을 선택하세요.", x: 24, y: 88, width: 932, height: 43)
        message.textColor = .systemBlue; host.addSubview(message)
        statistics = label("연속 2회 확인 · 선택 영역만 감시 · 주 모니터 사용", x: 24, y: 62, width: 932, size: 12)
        statistics.textColor = .secondaryLabelColor; host.addSubview(statistics)
        host.addSubview(label("감시 중 화면을 조작하면 중지합니다. Esc 또는 메뉴 막대에서 중지할 수 있습니다. 좌석 선택 결과는 직접 확인하세요.",
                              x: 24, y: 21, width: 932, height: 32, size: 11))
    }

    private func installInputMonitors() {
        let events: NSEvent.EventTypeMask = [.keyDown, .scrollWheel, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        globalEvents = NSEvent.addGlobalMonitorForEvents(matching: events) { [weak self] event in
            self?.handleInput(event)
        }
        localEvents = NSEvent.addLocalMonitorForEvents(matching: events) { [weak self] event in
            self?.handleInput(event)
            return event
        }
    }

    private func handleInput(_ event: NSEvent) {
        guard state == .starting || state == .monitoring else { return }
        stopWork()
        statusItem.button?.title = "좌석감시: 중지"
        report(event.type == .keyDown && event.keyCode == 53
            ? "Esc로 감시를 중지했습니다."
            : "화면 조작을 감지해 중지했습니다. 화면이 바뀌었다면 다시 촬영하세요.")
        // Do not steal focus after every user input; status menu can open the UI.
    }

    private func report(_ text: String) { message.stringValue = text }

    private func permissions(click: Bool) -> Bool {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
            report("시스템 설정에서 SeatWatcher의 화면 기록을 허용한 뒤 앱을 완전히 종료하고 다시 여세요.")
            return false
        }
        if click && !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            report("자동 클릭에는 손쉬운 사용 권한이 필요합니다. 허용 후 앱을 다시 여세요.")
            return false
        }
        return true
    }

    private func setBusy(_ busy: Bool) {
        controls.forEach { $0.isEnabled = !busy }
        preview.isHidden = false
    }

    private func stopWork() {
        generation &+= 1
        state = .idle
        watchdog?.invalidate(); watchdog = nil
        session?.stop(); session = nil
        browser = nil
        setBusy(false)
    }

    private func fail(_ text: String, token: UInt64) {
        guard generation == token else { return }
        stopWork(); statusItem.button?.title = "좌석감시: 중지"
        showWindow(); report(text)
    }

    @objc private func captureScreenshot() {
        guard state == .idle, permissions(click: false) else { return }
        guard let g = CaptureGeometry.mainDisplay() else { report("주 모니터를 찾지 못했습니다."); return }
        generation &+= 1
        let token = generation
        state = .snapshot; setBusy(true)
        window.orderOut(nil); NSApp.hide(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self = self, self.generation == token, self.state == .snapshot else { return }
            let capture = ScreenCaptureSession(geometry: g, sourceRect: nil,
                outputWidth: g.pixelWidth, outputHeight: g.pixelHeight, framesPerSecond: 5,
                onFrame: { [weak self] buffer, _ in
                    guard let image = snapshotImage(buffer) else { return }
                    DispatchQueue.main.async {
                        guard let self = self, self.generation == token, self.state == .snapshot else { return }
                        self.stopWork()
                        self.geometry = g; self.preview.screenshot = image
                        self.preview.region = nil; self.preview.detectedPoint = nil
                        self.statusItem.button?.title = "좌석감시: 대기"
                        self.showWindow()
                        self.report("좌석이 있는 영역을 드래그하세요. 메뉴·범례·아이콘은 제외하고 원 주변에 여백을 남기세요.")
                    }
                }, onFailure: { [weak self] error in self?.fail(error, token: token) })
            self.session = capture
            capture.start { [weak self] result in
                if case .failure(let error) = result { self?.fail(error.localizedDescription, token: token) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, self.generation == token, self.state == .snapshot else { return }
            self.fail("화면 촬영 응답이 없습니다. 화면 기록 권한을 확인하고 다시 시도하세요.", token: token)
        }
    }

    @objc private func startMonitoring() {
        guard state == .idle else { return }
        guard let g = geometry, let image = preview.screenshot, let selected = preview.region else {
            report("먼저 화면 촬영 후 좌석 영역을 드래그하세요."); return
        }
        let region = selected.integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard region.width >= 16, region.height >= 16, region.width * region.height <= 32_000_000 else {
            report("선택 영역의 크기를 조정하세요. 좌석이 있는 영역만 선택하는 것이 좋습니다."); return
        }
        var colors: UInt32 = 0
        if blue.state == .on { colors |= 1 }
        if green.state == .on { colors |= 2 }
        if purple.state == .on { colors |= 4 }
        guard colors != 0 else { report("감지할 색상을 하나 이상 선택하세요."); return }
        let dryRun = testOnly.state == .on
        guard permissions(click: !dryRun) else { return }
        guard let analysis = SeatAnalysis(colors: colors, newOnly: newOnly.state == .on) else {
            report("좌석 변화 추적에 필요한 메모리를 준비하지 못했습니다. 앱을 다시 실행하세요."); return
        }
        guard let current = CaptureGeometry.mainDisplay(), current.displayID == g.displayID,
              current.displayBounds == g.displayBounds, current.pixelWidth == g.pixelWidth,
              current.pixelHeight == g.pixelHeight else {
            report("모니터나 배율이 바뀌었습니다. 화면을 다시 촬영하세요."); return
        }
        generation &+= 1
        let token = generation
        automatic = !dryRun; state = .starting; setBusy(true)
        preview.detectedPoint = nil
        statusItem.button?.title = "좌석감시: 준비"
        report("좌석 감시를 시작합니다. 화면을 조작하면 중지됩니다.")
        window.orderOut(nil); NSApp.hide(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self = self, self.generation == token, self.state == .starting else { return }
            if !dryRun {
                guard let anchor = BrowserAnchor.read() else {
                    self.fail("좌석 페이지를 지원 브라우저의 맨 앞 창에 열어 주세요. 창 정보를 확인하지 못해 클릭 감시를 시작하지 않았습니다.", token: token)
                    return
                }
                let globalRect = CGRect(x: g.displayBounds.minX + region.minX / CGFloat(image.width) * g.displayBounds.width,
                                        y: g.displayBounds.minY + region.minY / CGFloat(image.height) * g.displayBounds.height,
                                        width: region.width / CGFloat(image.width) * g.displayBounds.width,
                                        height: region.height / CGFloat(image.height) * g.displayBounds.height)
                guard anchor.bounds.contains(globalRect) else {
                    self.fail("선택 영역이 브라우저 창 밖에 있습니다. 좌석 화면을 다시 촬영하고 영역을 선택하세요.", token: token); return
                }
                self.browser = anchor
            }
            let source = CGRect(x: region.minX / CGFloat(image.width) * g.displayBounds.width,
                                y: region.minY / CGFloat(image.height) * g.displayBounds.height,
                                width: region.width / CGFloat(image.width) * g.displayBounds.width,
                                height: region.height / CGFloat(image.height) * g.displayBounds.height)
            let capture = ScreenCaptureSession(geometry: g, sourceRect: source,
                outputWidth: Int(region.width), outputHeight: Int(region.height), framesPerSecond: 30,
                onFrame: { [weak self] buffer, receivedAt in
                    let outcome = analysis.process(buffer, receivedAt: receivedAt)
                    if outcome.hit != nil || outcome.error != nil || outcome.reportStatistics {
                        DispatchQueue.main.async {
                            self?.handle(outcome, region: region, geometry: g, dryRun: dryRun, token: token)
                        }
                    }
                }, onFailure: { [weak self] error in self?.fail(error, token: token) })
            self.session = capture
            capture.start { [weak self] result in
                guard let self = self, self.generation == token else { return }
                switch result {
                case .failure(let error): self.fail(error.localizedDescription, token: token)
                case .success:
                    self.state = .monitoring
                    self.statusItem.button?.title = dryRun ? "좌석감시: 테스트" : "좌석감시: 실행 중"
                    self.startWatchdog(g, token: token)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
            guard let self = self, self.generation == token, self.state == .starting else { return }
            self.fail("캡처 시작 응답이 없습니다. 화면 기록 권한을 확인하세요.", token: token)
        }
    }

    private func startWatchdog(_ g: CaptureGeometry, token: UInt64) {
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self = self, self.generation == token else { return }
            guard let current = CaptureGeometry.mainDisplay(), current.displayID == g.displayID,
                  current.displayBounds == g.displayBounds, current.pixelWidth == g.pixelWidth,
                  current.pixelHeight == g.pixelHeight else {
                self.fail("모니터 또는 화면 배율이 바뀌어 중지했습니다. 다시 촬영하세요.", token: token); return
            }
            if self.automatic && self.browser?.isUnchanged() != true {
                self.fail("브라우저 창·탭·위치가 바뀌어 자동 클릭을 중지했습니다.", token: token); return
            }
            if let capture = self.session,
               ProcessInfo.processInfo.systemUptime - capture.lastCallbackTime > 10 {
                self.fail("화면 캡처 응답이 끊겨 중지했습니다. 화면 기록 권한과 화면 상태를 확인하세요.", token: token)
            }
        }
        watchdog = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func handle(_ outcome: AnalysisResult, region: CGRect, geometry g: CaptureGeometry,
                        dryRun: Bool, token: UInt64) {
        guard generation == token, state == .starting || state == .monitoring else { return }
        if let error = outcome.error { fail(error, token: token); return }
        if outcome.reportStatistics {
            statistics.stringValue = String(format: "영역 처리 %.1fms · 후보 %d개 · 30회/초 요청 · 처리 시간은 화면 캡처 지연을 포함하지 않습니다.",
                                             outcome.processingMilliseconds, outcome.candidateCount)
        }
        guard let hit = outcome.hit, state == .monitoring else { return }
        // A queued result is not current enough to click after a busy main loop.
        guard ProcessInfo.processInfo.systemUptime - outcome.receivedAt <= 0.20 else { return }
        let pixel = CGPoint(x: region.minX + CGFloat(hit.x), y: region.minY + CGFloat(hit.y))
        let point = CGPoint(x: g.displayBounds.minX + pixel.x / CGFloat(g.pixelWidth) * g.displayBounds.width,
                            y: g.displayBounds.minY + pixel.y / CGFloat(g.pixelHeight) * g.displayBounds.height)
        let color = hit.kind == 1 ? "파란색" : (hit.kind == 2 ? "초록색" : "보라색")
        if !dryRun {
            guard AXIsProcessTrusted(), browser?.isUnchanged() == true,
                  browser?.bounds.contains(point) == true, NSEvent.pressedMouseButtons == 0,
                  NSEvent.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty else {
                fail("클릭 직전 화면 또는 입력 상태가 달라져 클릭하지 않았습니다.", token: token); return
            }
        }
        stopWork()
        preview.detectedPoint = pixel
        if dryRun {
            statusItem.button?.title = "좌석감시: 테스트 완료"
            NSSound.beep(); showWindow()
            report("테스트 감지: \(color) 좌석 (\(Int(pixel.x)), \(Int(pixel.y))). 클릭하지 않았습니다. 빨간 표시는 감지 위치이며 배경은 촬영 당시 화면입니다.")
        } else if performClick(point) {
            statusItem.button?.title = "좌석감시: 클릭 완료"
            NSSound.beep()
            report("\(color) 좌석 중심에 클릭 1회를 보냈습니다. 브라우저에서 실제 좌석 선택 결과를 확인하세요.")
        } else {
            statusItem.button?.title = "좌석감시: 클릭 실패"
            showWindow(); report("클릭 이벤트를 만들지 못했습니다. 실제 좌석을 직접 확인하세요.")
        }
    }

    private func performClick(_ point: CGPoint) -> Bool {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
                                 mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,
                               mouseCursorPosition: point, mouseButton: .left) else { return false }
        down.setIntegerValueField(.mouseEventClickState, value: 1)
        up.setIntegerValueField(.mouseEventClickState, value: 1)
        CGWarpMouseCursorPosition(point)
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        return true
    }

    @objc private func stopAndShow() {
        stopWork(); statusItem.button?.title = "좌석감시: 중지"
        showWindow(); report("감시가 중지되었습니다. 다시 시작하면 새 화면 상태를 기준으로 감시합니다.")
    }
    private func showWindow() {
        NSApp.unhide(nil); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    @objc private func quit() { stopWork(); NSApp.terminate(nil) }
    func applicationWillTerminate(_ notification: Notification) {
        session?.stop()
        if let globalEvents = globalEvents { NSEvent.removeMonitor(globalEvents) }
        if let localEvents = localEvents { NSEvent.removeMonitor(localEvents) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

let app = NSApplication.shared
let controller = AppController()
app.delegate = controller
app.run()
