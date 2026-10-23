import AppKit

final class PreviewView: NSView {
    var screenshot: CGImage? { didSet { needsDisplay = true } }
    var region: CGRect? { didSet { needsDisplay = true } }
    var detectedPoint: CGPoint? { didSet { needsDisplay = true } }
    var onRegionChange: ((CGRect?) -> Void)?
    private var dragOrigin: CGPoint?

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.12, alpha: 1).setFill()
        bounds.fill()
        guard let cg = screenshot else {
            let text = "브라우저에 좌석 화면을 띄우고 ‘화면 촬영’을 누르세요."
            (text as NSString).draw(at: CGPoint(x: 35, y: bounds.midY), withAttributes: [
                .foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 15)])
            return
        }
        let frame = imageFrame(cg)
        NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
            .draw(in: frame, from: .zero, operation: .copy, fraction: 1)
        let sx = frame.width / CGFloat(cg.width), sy = frame.height / CGFloat(cg.height)
        if let r = region {
            let box = CGRect(x: frame.minX + r.minX * sx,
                             y: frame.maxY - r.maxY * sy,
                             width: r.width * sx, height: r.height * sy)
            NSColor.systemYellow.setStroke()
            let path = NSBezierPath(rect: box); path.lineWidth = 2; path.stroke()
        }
        if let point = detectedPoint {
            let p = CGPoint(x: frame.minX + point.x * sx, y: frame.maxY - point.y * sy)
            NSColor.systemRed.setStroke()
            let path = NSBezierPath(ovalIn: CGRect(x: p.x - 9, y: p.y - 9, width: 18, height: 18))
            path.move(to: CGPoint(x: p.x - 15, y: p.y)); path.line(to: CGPoint(x: p.x + 15, y: p.y))
            path.move(to: CGPoint(x: p.x, y: p.y - 15)); path.line(to: CGPoint(x: p.x, y: p.y + 15))
            path.lineWidth = 2; path.stroke()
        }
    }

    private func imageFrame(_ image: CGImage) -> CGRect {
        let scale = min(bounds.width / CGFloat(image.width), bounds.height / CGFloat(image.height))
        let size = CGSize(width: CGFloat(image.width) * scale, height: CGFloat(image.height) * scale)
        return CGRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2,
                      width: size.width, height: size.height)
    }

    private func pixel(_ event: NSEvent, clamped: Bool = false) -> CGPoint? {
        guard let image = screenshot else { return nil }
        let local = convert(event.locationInWindow, from: nil), frame = imageFrame(image)
        guard clamped || frame.contains(local) else { return nil }
        return CGPoint(x: min(CGFloat(image.width - 1), max(0, (local.x - frame.minX) / frame.width * CGFloat(image.width))),
                       y: min(CGFloat(image.height - 1), max(0, (frame.maxY - local.y) / frame.height * CGFloat(image.height))))
    }

    override func mouseDown(with event: NSEvent) {
        guard let point = pixel(event) else { return }
        dragOrigin = point; region = nil; detectedPoint = nil
    }
    override func mouseDragged(with event: NSEvent) {
        guard let first = dragOrigin, let last = pixel(event, clamped: true) else { return }
        region = CGRect(x: min(first.x, last.x), y: min(first.y, last.y),
                        width: abs(first.x - last.x), height: abs(first.y - last.y))
    }
    override func mouseUp(with event: NSEvent) {
        guard let first = dragOrigin, let last = pixel(event, clamped: true) else { return }
        dragOrigin = nil
        let r = CGRect(x: min(first.x, last.x), y: min(first.y, last.y),
                       width: abs(first.x - last.x), height: abs(first.y - last.y)).integral
        region = r.width >= 16 && r.height >= 16 ? r : nil
        onRegionChange?(region)
    }
}
