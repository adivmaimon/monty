// Entry point. An NSStatusItem plus an NSPopover hosting the SwiftUI dropdown, rather
// than SwiftUI's MenuBarExtra, whose label is forced to a template image (no coloured dot).

import AppKit
import Combine
import SwiftUI

@MainActor
enum Opener {
    static var closePopover: (() -> Void)?

    static func open(_ url: URL) {
        closePopover?()
        NSWorkspace.shared.open(url)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let store = Store()
    private var item: NSStatusItem!
    private let popover = NSPopover()
    private var watch: AnyCancellable?

    func applicationDidFinishLaunching(_ note: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.target = self
        item.button?.action = #selector(toggle)
        item.button?.imagePosition = .imageLeading
        item.button?.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)

        popover.behavior = .transient
        popover.animates = false
        popover.appearance = NSAppearance(named: .darkAqua) // the mockup's dropdown is dark
        popover.contentViewController = NSHostingController(rootView: Dropdown(store: store))
        Opener.closePopover = { [weak self] in self?.popover.performClose(nil) }

        // objectWillChange fires before the new values land; redraw on the next turn.
        watch = store.objectWillChange.receive(on: RunLoop.main).sink { [weak self] _ in self?.redraw() }
        redraw()
        store.start()
    }

    private func redraw() {
        guard let b = item.button else { return }
        // No core, no icon: the app only runs alongside VS Code and quits 30s after the
        // core goes, so a "not running" state would only ever flash. Hidden until online.
        item.isVisible = store.online
        guard store.online else {
            popover.performClose(nil)
            return
        }
        let badge = store.badge
        b.image = Monocle.image(pct: store.bar?.pct ?? 0, badge: badge)
        let text = store.bar?.text ?? ""
        b.title = text.isEmpty ? "" : " \(text)"
        b.setAccessibilityLabel(accessibility(badge: badge, text: text))
    }

    private func accessibility(badge: String, text: String) -> String {
        let what = badge == "attention" ? "a session needs you" : badge == "failing" ? "tests failing" : badge == "done" ? "done" : ""
        return "Monty" + [text, what].filter { !$0.isEmpty }.map { ", \($0)" }.joined()
    }

    @objc private func toggle() {
        if popover.isShown {
            popover.performClose(nil)
            return
        }
        guard let b = item.button else { return }
        store.dropdownOpened()
        popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }
}

// Monty --render-dropdown <file.png>: the dropdown as it looks against the running core,
// for checking layout without clicking the menu bar (screen capture needs a permission).
if let i = CommandLine.arguments.firstIndex(of: "--render-dropdown"), i + 1 < CommandLine.arguments.count {
    let out = URL(fileURLWithPath: CommandLine.arguments[i + 1])
    MainActor.assumeIsolated {
        let store = Store()
        store.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            let first = store.state?.sessions.first { $0.state != "idle" }?.id
            let r = ImageRenderer(content: Dropdown(store: store, expanded: first).environment(\.colorScheme, .dark))
            r.scale = 2
            if let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                try? rep.representation(using: .png, properties: [:])?.write(to: out)
            }
            exit(0)
        }
        RunLoop.main.run()
    }
}

// Monty --iconset <dir>: the app icon at every size, for build.sh's iconutil step.
if let i = CommandLine.arguments.firstIndex(of: "--iconset"), i + 1 < CommandLine.arguments.count {
    AppIcon.writeIconset(to: URL(fileURLWithPath: CommandLine.arguments[i + 1]))
    exit(0)
}

// Monty --render <dir>: write each icon state, light and dark, at 144px for eyeballing
// (the counterpart of `npm run icons` for the PNG the SwiftBar plugin uses).
if let i = CommandLine.arguments.firstIndex(of: "--render"), i + 1 < CommandLine.arguments.count {
    let dir = URL(fileURLWithPath: CommandLine.arguments[i + 1])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let states: [(String, Double, String)] = [("working", 0.5, "none"), ("needs", 0.4, "attention"), ("failing", 0.8, "failing"), ("done", 1, "done"), ("idle", 0, "idle")]
    for (look, name) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
        for (label, pct, badge) in states {
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 144, pixelsHigh: 144, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            rep.size = NSSize(width: 18, height: 18) // 8x, the same 144px as `npm run icons`, for side-by-side checks
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            NSAppearance(named: look)!.performAsCurrentDrawingAppearance {
                (name == "light" ? NSColor(white: 0.93, alpha: 1) : NSColor(white: 0.16, alpha: 1)).setFill()
                NSRect(x: 0, y: 0, width: 18, height: 18).fill()
                Monocle.image(pct: pct, badge: badge).draw(in: NSRect(x: 0, y: 0, width: 18, height: 18))
            }
            NSGraphicsContext.restoreGraphicsState()
            try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name)-\(label).png"))
        }
    }
    exit(0)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory) // no Dock icon; LSUIElement in Info.plist does the same for the .app
    app.run()
}
