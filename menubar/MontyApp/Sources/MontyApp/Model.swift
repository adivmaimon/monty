// The shapes the core serves (src/types.ts, src/bar.ts), decoded leniently: every
// field the app can live without is optional, so a core change shows less, not nothing.

import Foundation

struct MontyState: Decodable {
    var sessions: [Session]
    var projects: [Project]
}

struct Session: Decodable, Identifiable {
    var id: String
    var cwd: String
    var repo: String
    var repoPath: String?
    var title: String
    var startedAt: String?
    var lastEventAt: String?
    var state: String
    var stateReason: String
    var todos: [Todo]?
    var progress: Count
    var plan: SessionPlan?
    var now: Activity?
    var context: Context?
    var lastTest: TestRun?
    var throughput: Throughput?
    var agent: String?
    var lastTurn: Turn?

    struct Todo: Decodable { var text: String; var status: String }
    struct Count: Decodable { var done: Int; var total: Int }
    struct SessionPlan: Decodable { var name: String; var file: String; var done: Int; var total: Int; var label: String }
    struct Activity: Decodable { var text: String; var file: String? }
    struct Context: Decodable { var pct: Int }
    struct TestRun: Decodable { var ok: Bool; var summary: String; var time: String }
    struct Throughput: Decodable { var inPerMin: Int; var outPerMin: Int; var level: Double }
    struct Turn: Decodable { var ms: Double; var endedAt: String }

    /// The task list when the session has one, else its repo's plan (current Claude Code has no todo tools).
    var shownProgress: (done: Int, total: Int, label: String)? {
        if progress.total > 0 { return (progress.done, progress.total, "\(progress.done) of \(progress.total) tasks") }
        if let p = plan, p.total > 0 { return (p.done, p.total, "\(p.label) · \(p.name)") } // named, so it is not mistaken for another plan listed below
        return nil
    }
}

struct Project: Decodable, Identifiable {
    var id: String
    var repo: String
    var repoPath: String
    var name: String
    var file: String
    var status: String
    var phases: [Phase]?
    var progress: Progress
    /// Worked out by the core (first phase not done, by its own number); older cores leave it out.
    var coreLabel: String?

    enum CodingKeys: String, CodingKey { case id, repo, repoPath, name, file, status, phases, progress, coreLabel = "label" }

    struct Phase: Decodable { var n: Int; var title: String; var done: Bool }
    struct Progress: Decodable { var done: Int; var total: Int; var basis: String }

    var label: String {
        if let coreLabel { return coreLabel }
        switch progress.basis {
        case "phases": return progress.done >= progress.total ? "All \(progress.total) phases done" : "Phase \(progress.done + 1) of \(progress.total)"
        case "tasks": return "\(progress.done)/\(progress.total) tasks"
        default: return ""
        }
    }
}

/// /api/bar: one icon state for the whole Mac, worked out by the core so every surface agrees.
struct Bar: Decodable {
    var pct: Double
    var badge: String // none | attention | failing | done | idle
    var text: String
    var focus: Focus?
    var needsYou: Int
    var working: Int

    struct Focus: Decodable { var repo: String; var title: String; var state: String; var reason: String }
}

enum Links {
    static let port = Int(ProcessInfo.processInfo.environment["MONTY_PORT"] ?? "") ?? 4747
    static var base: String { "http://127.0.0.1:\(port)" }

    /// Through the Monty extension, so it lands in the VS Code window that has the repo open (as the SwiftBar plugin does).
    static func show(repo: String? = nil, doc: String? = nil) -> URL {
        var c = URLComponents(string: "vscode://adivmaimon.monty/show")!
        var q: [URLQueryItem] = []
        if let repo { q.append(URLQueryItem(name: "repo", value: repo)) }
        if let doc { q.append(URLQueryItem(name: "doc", value: doc)) }
        c.queryItems = q.isEmpty ? nil : q
        return c.url!
    }
}
