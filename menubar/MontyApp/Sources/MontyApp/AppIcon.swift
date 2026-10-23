// The app icon, after the mockup's "Monty icon" board: a gold-rimmed monocle on a chain,
// on a dark rounded square. Without it the bundle has no icon and notifications show a
// blank white tile beside their text. build.sh renders it to AppIcon.icns via --iconset.
// Geometry is the board's 100-unit viewBox; small sizes use the board's simplified glyph.

import AppKit

enum AppIcon {
    static let rim = NSColor(srgbRed: 0xe0 / 255, green: 0xa8 / 255, blue: 0x5a / 255, alpha: 1)
    static let tile = NSColor(srgbRed: 0x1f / 255, green: 0x22 / 255, blue: 0x29 / 255, alpha: 1)
    static let edge = NSColor(srgbRed: 0x34 / 255, green: 0x38 / 255, blue: 0x43 / 255, alpha: 1)

    /// Draws into the current context, in a flipped 100x100 space.
    static func draw(small: Bool) {
        // macOS icon grid: the tile is 824 of 1024, centred, leaving room for the system shadow.
        let t = NSAffineTransform()
        t.translateX(by: 8.8, yBy: 8.8)
        t.scaleX(by: 0.824, yBy: 0.824)
        t.concat()

        let square = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: 100, height: 100), xRadius: 22, yRadius: 22)
        tile.setFill()
        square.fill()
        NSGraphicsContext.saveGraphicsState()
        square.addClip()

        let stroke = { (p: NSBezierPath, c: NSColor, w: CGFloat) in
            p.lineWidth = w
            c.setStroke()
            p.stroke()
        }
        let circle = { (x: CGFloat, y: CGFloat, r: CGFloat) in NSBezierPath(ovalIn: NSRect(x: x - r, y: y - r, width: r * 2, height: r * 2)) }

        // The chain: a dotted curve from the eyelet down off the tile.
        let chain = NSBezierPath()
        if small {
            chain.move(to: NSPoint(x: 76, y: 45))
            chain.curve(to: NSPoint(x: 58, y: 88), controlPoint1: NSPoint(x: 82, y: 62), controlPoint2: NSPoint(x: 74, y: 76))
        } else {
            chain.move(to: NSPoint(x: 76, y: 43.5))
            chain.curve(to: NSPoint(x: 62, y: 83), controlPoint1: NSPoint(x: 82, y: 60), controlPoint2: NSPoint(x: 76, y: 74))
            chain.curve(to: NSPoint(x: 28, y: 100), controlPoint1: NSPoint(x: 48, y: 92), controlPoint2: NSPoint(x: 38, y: 94))
        }
        chain.lineCapStyle = .round
        chain.setLineDash(small ? [0.1, 9] : [0.1, 4.4], count: 2, phase: 0)
        stroke(chain, rim, small ? 7 : 3.4)

        if !small {
            NSColor(srgbRed: 0x9f / 255, green: 0xb8 / 255, blue: 0xd1 / 255, alpha: 0.10).setFill()
            circle(42, 40, 25).fill()
        }
        stroke(circle(42, 40, 25), rim, small ? 10 : 6)
        if small {
            rim.setFill()
            circle(73, 40, 4).fill()
        } else {
            let dark = NSColor(white: 0, alpha: 0.35)
            stroke(circle(42, 40, 21.2), dark, 1.4)
            stroke(circle(42, 40, 28.2), dark, 1)
            stroke(circle(72.6, 40, 3.6), rim, 2.4)
            // Glass highlight, upper left of the lens.
            let shine = NSBezierPath()
            shine.move(to: NSPoint(x: 27.5, y: 37))
            shine.curve(to: NSPoint(x: 37, y: 25.5), controlPoint1: NSPoint(x: 28.6, y: 31.6), controlPoint2: NSPoint(x: 32.2, y: 27.4))
            shine.lineCapStyle = .round
            stroke(shine, NSColor(white: 1, alpha: 0.85), 3.4)
            NSColor(white: 1, alpha: 0.6).setFill()
            circle(31, 44.5, 1.7).fill()
        }
        NSGraphicsContext.restoreGraphicsState()

        let border = NSBezierPath(roundedRect: NSRect(x: 0.5, y: 0.5, width: 99, height: 99), xRadius: 21.5, yRadius: 21.5)
        stroke(border, edge, 1)
    }

    /// Writes an .iconset folder (every size iconutil wants) for build.sh to turn into AppIcon.icns.
    static func writeIconset(to dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for pt in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let px = pt * scale
                let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                rep.size = NSSize(width: 100, height: 100)
                NSGraphicsContext.saveGraphicsState()
                let ctx = NSGraphicsContext(bitmapImageRep: rep)!
                NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx.cgContext, flipped: true)
                // Flip so the board's y-down coordinates draw the right way up.
                ctx.cgContext.translateBy(x: 0, y: 100)
                ctx.cgContext.scaleBy(x: 1, y: -1)
                // The detailed glyph turns to mush below 64px; the board has a simpler one for that.
                draw(small: px < 64)
                NSGraphicsContext.restoreGraphicsState()
                let name = scale == 1 ? "icon_\(pt)x\(pt).png" : "icon_\(pt)x\(pt)@2x.png"
                try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
            }
        }
    }
}
