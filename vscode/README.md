# Monty

**Keeps an eye on Claude Code, so you don't have to.** See what your session is doing right now, how far through its plan it is, and which files it has touched, without reading the transcript. On a Mac, a monocle in the menu bar tells you when a session needs you.

![The details view: session, plan progress, what Claude is doing now, activity and files changed](https://raw.githubusercontent.com/adivmaimon/monty/main/docs/screenshots/details.png)

## What you get

- **A sidebar for the open repo.** The session's state (working, needs you, your turn, done), the plan it's working through as a progress bar, what it's doing right now, context used, and whether the last test run passed.
- **A details view** with everything: activity, files changed, every plan in the repo, and the repo's AI setup (instructions files, the rules in them, skills, commands, guardrails).
- **Plans you can read.** Every `.md` opens in a readable view: collapsible sections, phases with progress, Mermaid diagrams, and file references that open in the editor. It updates live as Claude ticks off phases.
- **Follow mode** (off until you turn it on). Each file Claude changes opens beside your editor with the changed lines highlighted for a moment.
- **Explorer dots** on files the session changed (●) or read (·).
- **A Mac menu bar app** (optional). The monocle's rim fills as the plan progresses, an orange dot means a session needs you, and a notification tells you too. Monty offers to install it the first time you open VS Code on a Mac.

<p>
  <img alt="The sidebar" src="https://raw.githubusercontent.com/adivmaimon/monty/main/docs/screenshots/sidebar.png" width="300">
  <img alt="The menu bar dropdown" src="https://raw.githubusercontent.com/adivmaimon/monty/main/docs/screenshots/menubar.png" width="380">
</p>

![A plan in the readable view](https://raw.githubusercontent.com/adivmaimon/monty/main/docs/screenshots/plan.png)

## Privacy

Monty reads two things on your machine: Claude Code's session logs (`~/.claude/projects`) and the plan and config files in your repos. It runs a small local server on `127.0.0.1:4747` for VS Code and the menu bar app to talk to. Nothing leaves your machine: no telemetry, no accounts, no cloud.

The one network request Monty ever makes is downloading the menu bar app from this repo's GitHub Releases, and only when you click Install. It checks Apple's signature on the download before installing it.

Monty never writes to your repos or to `~/.claude`.

## How progress works

Claude Code doesn't keep a task list Monty can read, so progress comes from your plans. Monty reads plan files in:

- `.claude/projects/{active,completed,parked,cancelled}/*.md`, using `### Phase N` headings and ` - DONE (date)` markers
- [OpenSpec](https://github.com/Fission-AI/OpenSpec) (`openspec/changes/*/tasks.md`)
- [Spec Kit](https://github.com/github/spec-kit) (`specs/*/tasks.md`)
- [Kiro](https://kiro.dev) (`.kiro/specs/*/tasks.md`)

A session's progress bar follows the active plan in its repo.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `monty.projectRoots` | `[]` | Folders whose repos are always watched, e.g. `~/Projects`. Empty: just the repos open in VS Code. |
| `monty.appPath` | `/Applications/Monty.app` | The menu bar app to start with VS Code. Empty never starts it. |
| `monty.port` | `4747` | Port of the local server. |

Commands: **Monty: Open details**, **Monty: Toggle follow mode**, **Open readable view** (on any `.md`).

## Good to know

- **Claude Code's log format isn't a published API.** Monty reads it defensively, but a Claude Code update can change what it can see. If something looks off after an update, please [open an issue](https://github.com/adivmaimon/monty/issues).
- **"Probably waiting for permission"** is a guess from timing, and it says so. In auto mode Monty doesn't guess, because Claude Code doesn't ask there.
- **The menu bar app is macOS only.** Everything else works on macOS, Windows and Linux.

## License

MIT. Source and issues: [github.com/adivmaimon/monty](https://github.com/adivmaimon/monty).
