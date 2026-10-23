// The dropdown, after the "Menu bar app" mockup board: live sessions with rings and
// expandable todos, active projects with phase segments, a footer. Colours are the
// mockup's and match the web panel's state colours.

import SwiftUI

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB, red: Double(hex >> 16 & 0xff) / 255, green: Double(hex >> 8 & 0xff) / 255, blue: Double(hex & 0xff) / 255, opacity: alpha)
    }
    static let bg = Color(hex: 0x1f2229)
    static let line = Color(hex: 0x343843)
    static let ink = Color(hex: 0xe8eaee)
    static let soft = Color(hex: 0xc9ced6)
    static let muted = Color(hex: 0xb4bac4)
    static let faint = Color(hex: 0x9aa1ad)
    static let accent = Color(hex: 0xe8a26a)
    static let green = Color(hex: 0x3fb950)
    static let blue = Color(hex: 0x6cb6ff)
}

enum StateStyle {
    static func color(_ s: String) -> Color {
        switch s {
        case "needs_input": return Color(hex: 0xf0883e)
        case "working": return .accent
        case "your_turn": return .blue
        case "done": return Color(hex: 0x56d364)
        default: return Color(hex: 0x8b949e)
        }
    }
    static func label(_ s: String) -> String {
        switch s {
        case "needs_input": return "Needs your input"
        case "working": return "Working"
        case "your_turn": return "Your turn"
        case "done": return "Done"
        default: return "Idle"
        }
    }
}

/// The one progress bar, as in the web panel: a segment per phase or task, green done,
/// amber current, grey to do. The menu bar icon keeps its monocle ring; the dropdown does not.
struct SegBar: View {
    var colors: [Color]
    var height: CGFloat = 5
    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(colors.enumerated()), id: \.offset) { _, c in
                RoundedRectangle(cornerRadius: 2).fill(c).frame(height: height)
            }
        }
        .accessibilityHidden(true)
    }

    /// From counts: capped at 12 segments so long task lists stay legible (web panel does the same).
    static func colors(done: Int, total: Int, current: Bool) -> [Color] {
        guard total > 0 else { return [] }
        let n = min(total, 12)
        let on = total <= 12 ? done : Int((Double(done) / Double(total) * Double(n)).rounded())
        return (0..<n).map { $0 < on ? .green : $0 == on && current ? .accent : .line }
    }
}

/// Native-menu hover: a faint highlight and the pointing hand, for things that do something.
/// Rows that do nothing do not get this.
/// The effort speedometer, as in the panel: an arc that fills with tokens per minute right
/// now, the count inside it. Fixed size, so a longer number never moves anything. The core
/// sets `level` (0..1, full scale from real logs) so the menu bar and VS Code agree.
struct Speedo: View {
    var level: Double
    var count: String
    var body: some View {
        let l = max(0, min(1, level))
        let zone: Color = l >= 0.85 ? Color(hex: 0xff7b72) : l >= 0.5 ? .accent : .blue
        ZStack(alignment: .bottom) {
            DialArc(level: 1).stroke(Color.line, style: StrokeStyle(lineWidth: 5, lineCap: .round))
            DialArc(level: l).stroke(zone, style: StrokeStyle(lineWidth: 5, lineCap: .round)).opacity(l > 0.005 ? 1 : 0)
            Text(count).font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(Color.ink)
                .padding(.bottom, 0)
        }
        // Readings arrive every 2s; easing over most of that keeps the arc moving smoothly.
        .animation(.easeOut(duration: 0.9), value: l)
        .accessibilityElement()
        .accessibilityLabel("\(count) tokens per minute")
    }
}

private func dialGeometry(_ rect: CGRect) -> (CGPoint, CGFloat) {
    let r = min(rect.width / 2, rect.height) - 3.5
    return (CGPoint(x: rect.midX, y: rect.maxY - 1), r)
}

struct DialArc: Shape {
    var level: Double
    var animatableData: Double {
        get { level }
        set { level = newValue }
    }
    func path(in rect: CGRect) -> Path {
        let (c, r) = dialGeometry(rect)
        var p = Path()
        p.addArc(center: c, radius: r, startAngle: .degrees(180), endAngle: .degrees(180 + 180 * level), clockwise: false)
        return p
    }
}

func kTok(_ n: Int) -> String {
    n >= 10_000 ? "\(n / 1000)k" : n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
}

struct Hover: ViewModifier {
    var radius: CGFloat = 8
    @State private var on = false
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius).fill(on ? Color.white.opacity(0.07) : .clear))
            .onHover { inside in
                guard inside != on else { return }
                on = inside
                if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }
            // A row can vanish under the pointer (state update): keep the cursor stack balanced.
            .onDisappear { if on { on = false; NSCursor.pop() } }
    }
}

extension View {
    func hoverable(radius: CGFloat = 8) -> some View { modifier(Hover(radius: radius)) }
}

struct Dropdown: View {
    @ObservedObject var store: Store
    @State private var expanded: String?

    /// `expanded`: a session to show opened (only --render-dropdown uses it).
    init(store: Store, expanded: String? = nil) {
        self.store = store
        _expanded = State(initialValue: expanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            sessions
            if !activeProjects.isEmpty {
                Rectangle().fill(Color.line).frame(height: 1).padding(.horizontal, 16)
                projects
            }
            footer
        }
        .frame(width: 420)
        .background(Color.bg)
        .foregroundStyle(Color.ink)
        .font(.system(size: 13))
    }

    private var live: [Session] { store.state?.sessions.filter { $0.state != "idle" } ?? [] }
    /// The tool label shows only when a live session is not Claude Code, as in the panel.
    private var mixedAgents: Bool { live.contains { ($0.agent ?? "claude-code") != "claude-code" } }
    private let agentNames = ["claude-code": "Claude Code", "opencode": "opencode", "codex": "Codex", "cline": "Cline", "roo": "Roo Code", "copilot-chat": "Copilot"]

    private var header: some View {
        HStack(spacing: 10) {
            Text("Monty").font(.system(size: 14, weight: .bold))
            Spacer()
            // Not "running": a session waiting on your turn is live but not running.
            Text(live.count == 1 ? "1 session" : "\(live.count) sessions")
                .font(.system(size: 12)).foregroundStyle(Color.muted)
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 12)
    }

    private func sectionTitle(_ t: String) -> some View {
        Text(t).font(.system(size: 11, weight: .bold)).tracking(0.9).foregroundStyle(Color.faint)
    }

    // MARK: sessions

    private var sessions: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionTitle("LIVE SESSIONS").padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
            if live.isEmpty {
                Text("No Claude Code sessions").foregroundStyle(Color.muted)
                    .padding(.horizontal, 16).padding(.bottom, 12)
            }
            VStack(spacing: 8) {
                ForEach(live) { s in sessionCard(s) }
            }
            .padding(.horizontal, 10).padding(.bottom, 12)
        }
    }

    /// One card per session, as in the panel: repo and state first, then what it is working
    /// on and how far through its plan. Secondary facts (time, context) wait in the expanded part.
    private func sessionCard(_ s: Session) -> some View {
        let open = expanded == s.id
        let prog = s.shownProgress
        let color = StateStyle.color(s.state)
        let line = statusLine(s)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                expanded = open ? nil : s.id
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Text(s.repo).font(.system(size: 13.5, weight: .semibold))
                        if mixedAgents, let a = s.agent {
                            Text(agentNames[a] ?? a).font(.system(size: 11)).foregroundStyle(Color.soft)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .overlay(Capsule().stroke(Color.line))
                        }
                        Spacer(minLength: 8)
                        Text(StateStyle.label(s.state))
                            .font(.system(size: 11, weight: .semibold))
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background(Capsule().fill(color.opacity(0.18)))
                            .foregroundStyle(color)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold)).foregroundStyle(Color.faint)
                            .rotationEffect(.degrees(open ? 180 : 0))
                            .accessibilityHidden(true)
                    }
                    Text(s.title).font(.system(size: 12.5)).foregroundStyle(Color.soft).lineLimit(1).truncationMode(.tail)
                    if let prog {
                        Text(prog.label).font(.system(size: 11.5)).foregroundStyle(Color.muted).padding(.top, 2)
                        SegBar(colors: SegBar.colors(done: prog.done, total: prog.total, current: s.state != "done"))
                    }
                    if let line {
                        Text(line).font(.system(size: 12)).foregroundStyle(s.state == "needs_input" ? color : Color.muted)
                            .lineLimit(2).fixedSize(horizontal: false, vertical: true).padding(.top, 2)
                    }
                }
                .padding(12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "expanded" : "collapsed")

            if open { details(s) }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(hex: 0x262a33)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(s.state == "needs_input" ? color.opacity(0.55) : Color(hex: 0x3a3f4a)))
        .hoverable(radius: 10)
    }

    private func details(_ s: Session) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Rectangle().fill(Color.line).frame(height: 1)
            if let todos = s.todos, !todos.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(todos.enumerated()), id: \.offset) { _, t in todoRow(t) }
                }
            } else if let plan = s.plan {
                Text(plan.name).font(.system(size: 12)).foregroundStyle(Color.soft).lineLimit(2)
            }
            VStack(alignment: .leading, spacing: 5) {
                if let ctx = s.context {
                    HStack { Text("Context"); Spacer(); Text("\(ctx.pct)%") }
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.line)
                            Capsule().fill(ctx.pct >= 75 ? Color(hex: 0xff7b72) : ctx.pct >= 50 ? Color.accent : Color.blue).frame(width: g.size.width * CGFloat(ctx.pct) / 100)
                        }
                    }
                    .frame(height: 4)
                }
                if let t = s.throughput {
                    HStack(alignment: .center) {
                        Text("Tokens/min")
                        Spacer()
                        Speedo(level: t.level, count: kTok(t.inPerMin + t.outPerMin)).frame(width: 56, height: 32)
                    }
                    .padding(.bottom, 4)
                    .padding(.top, 2)
                }
                HStack {
                    if let el = elapsed(s.startedAt) { Text(el == "just now" ? "Started just now" : "Started \(el) ago") }
                    Spacer()
                    if let t = s.lastTest { Text(t.ok ? "Tests passing" : "Tests failing").foregroundStyle(t.ok ? Color.green : Color(hex: 0xff7b72)) }
                }
            }
            .font(.system(size: 11.5)).foregroundStyle(Color.muted)
            HStack(spacing: 8) {
                Button("Open in VS Code") { Opener.open(Links.show(repo: s.repoPath ?? s.cwd)) }.buttonStyle(Pill(filled: true))
                if let plan = s.plan {
                    Button("View plan") { Opener.open(Links.show(repo: s.repoPath ?? s.cwd, doc: plan.file)) }.buttonStyle(Pill(filled: false))
                }
            }
        }
        .padding(.horizontal, 12).padding(.bottom, 12)
    }

    private func todoRow(_ t: Session.Todo) -> some View {
        let done = t.status == "completed", now = t.status == "in_progress"
        return HStack(spacing: 8) {
            Circle()
                .strokeBorder(done ? .clear : now ? Color.accent : Color(hex: 0x5a606c), lineWidth: now ? 2 : 1.5)
                .background(Circle().fill(done ? Color.green : .clear))
                .frame(width: 12, height: 12)
            Text(t.text).strikethrough(done).lineLimit(1)
                .foregroundStyle(done ? Color(hex: 0x8b929e) : now ? Color(hex: 0xf1f3f6) : Color.soft)
        }
        .font(.system(size: 12.5))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(t.text), \(done ? "done" : now ? "in progress" : "to do")")
    }

    /// Only what the state tag does not already say: why it needs you, or what it is doing.
    /// "Your turn" with "Claude finished its turn" under it says the same thing twice.
    private func statusLine(_ s: Session) -> String? {
        if s.state == "needs_input" { return s.stateReason }
        if s.state == "working" { return s.now?.text ?? s.stateReason }
        return nil
    }

    private func elapsed(_ iso: String?) -> String? {
        guard let iso, let d = parseISO(iso) else { return nil }
        let m = Int(Date().timeIntervalSince(d) / 60)
        if m < 1 { return "just now" }
        if m < 60 { return "\(m) min" }
        return "\(m / 60) h \(m % 60) min"
    }

    // MARK: projects

    /// Active plans, less the ones a session card above already shows with its bar.
    private var activeProjects: [Project] {
        let shown = Set(live.compactMap { $0.plan?.file })
        return (store.state?.projects ?? []).filter { $0.status == "active" && !shown.contains($0.file) }.prefix(6).map { $0 }
    }

    /// Plans under their repo's name, so it is clear which belongs to what.
    private var projectGroups: [(repo: String, plans: [Project])] {
        var order: [String] = []
        var by: [String: [Project]] = [:]
        for p in activeProjects {
            if by[p.repo] == nil { order.append(p.repo) }
            by[p.repo, default: []].append(p)
        }
        return order.map { ($0, by[$0] ?? []) }
    }

    private var projects: some View {
        // 10 + 6 inner padding keeps text on the same 16px edge as the section titles,
        // while the hover highlight reaches a little past it, like a native menu row.
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("ACTIVE PROJECTS").padding(.horizontal, 6)
            ForEach(projectGroups, id: \.repo) { group in
                VStack(alignment: .leading, spacing: 0) {
                    Text(group.repo).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Color.faint)
                        .padding(.horizontal, 6).padding(.bottom, 1)
                    ForEach(group.plans) { p in
                        Button { Opener.open(Links.show(repo: p.repoPath, doc: p.file)) } label: {
                            projectRow(p).padding(.horizontal, 6).padding(.vertical, 6).hoverable()
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, 10).padding(.top, 12).padding(.bottom, 10)
    }

    private func projectRow(_ p: Project) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(p.name).font(.system(size: 12.5)).foregroundStyle(Color.ink).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 8)
                if !p.label.isEmpty { Text(p.label).font(.system(size: 11.5)).foregroundStyle(Color.muted) }
            }
            let segs = segments(p)
            if segs.count > 1 { SegBar(colors: segs, height: 4) }
        }
        .contentShape(Rectangle())
    }

    /// Done phases green, the current one orange, the rest grey. Phase list when the
    /// plan has one, else the progress counts (task-based plans, capped at 12 segments).
    private func segments(_ p: Project) -> [Color] {
        if p.progress.basis == "status" { return [] }
        let flags: [Bool]
        if let ph = p.phases, !ph.isEmpty, p.progress.basis == "phases" {
            flags = ph.map(\.done)
        } else {
            return SegBar.colors(done: p.progress.done, total: p.progress.total, current: true)
        }
        let current = flags.firstIndex(of: false)
        return flags.enumerated().map { i, d in d ? .green : i == current ? .accent : .line }
    }

    // MARK: footer

    private var footer: some View {
        HStack(spacing: 8) {
            Button("Notifications: \(store.notify ? "on" : "off")") { store.notify.toggle() }.buttonStyle(Pill(filled: false, bordered: false))
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }.buttonStyle(Pill(filled: false, bordered: false))
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Color(hex: 0x1b1e25))
        .overlay(alignment: .top) { Rectangle().fill(Color.line).frame(height: 1) }
    }
}

struct Pill: ButtonStyle {
    var filled: Bool
    var bordered = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12.5))
            .foregroundStyle(bordered ? Color.ink : Color.soft)
            .padding(.horizontal, 12)
            .frame(minHeight: 30)
            .background(RoundedRectangle(cornerRadius: 8).fill(filled ? Color(hex: 0x2c303a) : .clear))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(bordered ? Color(hex: 0x3a3f4a) : .clear))
            .hoverable()
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Rectangle())
    }
}
private let isoFrac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
private let isoPlain = ISO8601DateFormatter()

func parseISO(_ s: String) -> Date? { isoFrac.date(from: s) ?? isoPlain.date(from: s) }
