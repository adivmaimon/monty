// The menu bar monocle, drawn with AppKit rather than shipped as the core's PNG so the
// needs-you dot can be orchid and the failing dot rose (a template image is one colour).
// Same design and geometry as src/icon.ts, in its 18-unit glyph space: the lens only (the
// app icon's chain and eyelet turn to noise at 18pt), a solid rim, progress as an inner
// arc, a glass highlight when there is no progress, a tick when done.

import AppKit

enum Monocle {
    static let orchid = NSColor(srgbRed: 0xf0 / 255, green: 0x8b / 255, blue: 0xd8 / 255, alpha: 1)
    static let rose = NSColor(srgbRed: 0xfb / 255, green: 0x71 / 255, blue: 0x85 / 255, alpha: 1)

    // src/icon.ts, unit for unit.
    static let lens = NSPoint(x: 9, y: 9)
    static let lensR: CGFloat = 6.3
    static let rimW: CGFloat = 1.7
    static let sheenR: CGFloat = 3.9
    static let sheenW: CGFloat = 1.25
    static let progR: CGFloat = 3.6
    static let progW: CGFloat = 1.9
    static let badge = NSPoint(x: 15, y: 3.1)
    static let badgeR: CGFloat = 2.2
    /// The gap cut out of the rim around the dot, so the dot reads as separate.
    static let knockoutR: CGFloat = 3.2

    /// Not a template image, so the drawing handler picks the ink itself. It runs at draw
    /// time inside the status button's appearance, so the ink follows a light or dark
    /// menu bar (which can differ from the system appearance, depending on the wallpaper).
    static func image(pct: Double, badge kind: String) -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            // Full-opacity ink always: a faded rim read as greyed out beside the system icons.
            // Not labelColor, which is 85% opaque; solid black or white by the menu bar's look.
            let dark = NSAppearance.currentDrawing().bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let ink: NSColor = dark ? .white : .black
            let dotted = kind == "attention" || kind == "failing"
            let done = kind == "done"
            let inProgress = !done && pct > 0 && pct < 1

            NSGraphicsContext.saveGraphicsState()
            if dotted {
                // Everything but the dot's surroundings: an even-odd clip with a hole, since
                // this draws straight into the menu bar and a "clear" fill would punch through it.
                let clip = NSBezierPath(rect: NSRect(x: 0, y: 0, width: 18, height: 18))
                clip.appendOval(in: NSRect(x: badge.x - knockoutR, y: badge.y - knockoutR, width: knockoutR * 2, height: knockoutR * 2))
                clip.windingRule = .evenOdd
                clip.addClip()
            }
            ink.setStroke()

            let rim = NSBezierPath(ovalIn: NSRect(x: lens.x - lensR, y: lens.y - lensR, width: lensR * 2, height: lensR * 2))
            rim.lineWidth = rimW
            rim.stroke()

            if inProgress {
                // Clockwise from 12 o'clock. Flipped coordinates: increasing angle is clockwise on screen.
                let arc = NSBezierPath()
                arc.appendArc(withCenter: lens, radius: progR, startAngle: -90, endAngle: -90 + 360 * pct, clockwise: false)
                arc.lineWidth = progW
                arc.stroke()
            } else if !done {
                // Glass highlight, upper left: 0.72 to 0.9 of a turn from 12 o'clock, as in icon.ts.
                let sheen = NSBezierPath()
                sheen.appendArc(withCenter: lens, radius: sheenR, startAngle: -90 + 360 * 0.72, endAngle: -90 + 360 * 0.9, clockwise: false)
                sheen.lineWidth = sheenW
                sheen.stroke()
            }

            if done {
                let tick = NSBezierPath()
                tick.move(to: NSPoint(x: 6.2, y: 9.2))
                tick.line(to: NSPoint(x: 8.2, y: 11.2))
                tick.line(to: NSPoint(x: 11.9, y: 7.2))
                tick.lineWidth = 1.4
                tick.lineCapStyle = .round
                tick.lineJoinStyle = .round
                tick.stroke()
            }
            NSGraphicsContext.restoreGraphicsState()

            if dotted {
                (kind == "attention" ? orchid : rose).setFill()
                NSBezierPath(ovalIn: NSRect(x: badge.x - badgeR, y: badge.y - badgeR, width: badgeR * 2, height: badgeR * 2)).fill()
            }
            return true
        }
        img.isTemplate = false
        return img
    }
}
