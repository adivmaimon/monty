// Polls the core and decides what to notify about. The app never starts the core:
// Monty runs only while VS Code is open (plan, Phase 2 decision), and these polls
// deliberately do not keep it alive. With VS Code closed the core goes, and then so
// does this app (see quitAfterOffline); the extension launches it again next time.

import AppKit
import UserNotifications

@MainActor
final class Store: ObservableObject {
    @Published private(set) var state: MontyState?
    @Published private(set) var bar: Bar?
    @Published private(set) var online = false
    /// "Done, clears on click": a finished session's tick goes once you have opened the dropdown.
    @Published private(set) var doneSeen: String?
    @Published var notify: Bool {
        didSet { UserDefaults.standard.set(notify, forKey: "notify") }
    }

    // 2s matches the SwiftBar plugin. The core polls logs every 1s, so faster buys nothing.
    private let pollSeconds = 2.0
    // Monty exists only while VS Code is open: the extension launches this app, and the
    // core quits ~20s after the last window closes. 30s without the core means VS Code is
    // gone, while still covering a window reload or the extension starting the core
    // just after launching us (the clock starts at launch).
    private let quitAfterOffline: TimeInterval = 30
    private var lastReachable = Date()
    private var timer: Timer?
    private var notifier = Notifier()

    init() {
        notify = UserDefaults.standard.object(forKey: "notify") as? Bool ?? true
    }

    func start() {
        Task { await poll() }
        timer = Timer.scheduledTimer(withTimeInterval: pollSeconds, repeats: true) { [weak self] _ in
            Task { await self?.poll() }
        }
    }

    /// The key that identifies "this session finished", so a later finish shows the tick again.
    var doneKey: String? {
        guard let s = state?.sessions.first(where: { $0.state != "idle" }), s.state == "done" else { return nil }
        return "\(s.id)@\(s.lastEventAt ?? "")"
    }

    func dropdownOpened() {
        if let k = doneKey { doneSeen = k }
    }

    var badge: String {
        guard online, let bar else { return "idle" }
        if bar.badge == "done", doneKey == doneSeen { return "none" }
        return bar.badge
    }

    private func poll() async {
        async let s: MontyState? = fetch("/api/state")
        async let b: Bar? = fetch("/api/bar")
        let (ns, nb) = await (s, b)
        online = ns != nil
        if online {
            lastReachable = Date()
        } else if Date().timeIntervalSince(lastReachable) > quitAfterOffline {
            NSApp.terminate(nil)
        }
        state = ns
        bar = nb
        if let ns { notifier.update(ns.sessions, enabled: notify) }
    }

    private func fetch<T: Decodable>(_ path: String) async -> T? {
        guard let url = URL(string: Links.base + path) else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1
        do {
            let (data, res) = try await URLSession.shared.data(for: req)
            guard (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
        }
    }
}

/// One notification per state change per session: needs you, or finished after a long turn.
/// The first poll only records where things stand, so launching the app is silent.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private var last: [String: String] = [:]
    private var seeded = false
    private var asked = false
    // A turn this long means you have probably looked away. Shorter ones are replies you
    // watched land; telling you about those as well would teach you to ignore the banner.
    private let finishedAfterMs = 30_000.0

    func update(_ sessions: [Session], enabled: Bool) {
        // Ask up front: asked on the first send, that first banner went out before the answer and was lost.
        if enabled && !asked {
            asked = true
            let c = UNUserNotificationCenter.current()
            c.delegate = self
            c.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        for s in sessions {
            let key = eventKey(s)
            let before = last[s.id]
            last[s.id] = key
            guard seeded, enabled, let key, key != before else { continue }
            send(s, kind: key)
        }
        seeded = true
    }

    /// What, if anything, is worth telling you about this session right now.
    private func eventKey(_ s: Session) -> String? {
        switch s.state {
        case "needs_input": return "needs_input"
        // Most sessions have no task list, so "done" is rare: a long turn ending is the signal.
        case "done", "your_turn":
            if let t = s.lastTurn, t.ms >= finishedAfterMs { return "finished@\(t.endedAt)" }
            return s.state == "done" ? "done" : nil
        // No banner for a failing test run mid-turn: the agent is usually fixing it, and replayed
        // logs had ~200 of them, enough to teach you to ignore Monty. The dropdown still shows it.
        default:
            return nil
        }
    }

    private func send(_ s: Session, kind: String) {
        let c = UNUserNotificationCenter.current()
        let n = UNMutableNotificationContent()
        if kind == "needs_input" {
            n.title = "\(s.repo) requires your attention"
            n.body = s.stateReason
            n.sound = .default
        } else {
            n.title = s.state == "done" ? "\(s.repo): all done" : "\(s.repo): your move"
            // Tests left red at the end of a turn are worth knowing before you switch back.
            let red = s.lastTest.map { $0.ok ? "" : " · \($0.summary)" } ?? ""
            n.body = s.title + red
            n.sound = .default
        }
        n.userInfo = ["repo": s.repoPath ?? s.cwd]
        c.add(UNNotificationRequest(identifier: "\(s.id)-\(kind)", content: n, trigger: nil))
    }

    // Clicking a notification opens the repo's VS Code window.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let repo = response.notification.request.content.userInfo["repo"] as? String
        Task { @MainActor in
            Opener.open(Links.show(repo: repo))
            done()
        }
    }

    // Show banners even though the app is "active" (it always is, as a menu bar app).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }
}
