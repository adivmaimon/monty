# Monty

Keeps an eye on your coding agent. Monty watches Claude Code sessions and the plans in your repos, and shows progress in VS Code and the Mac menu bar.

**Install:** search "Monty" in the VS Code Extensions view, or see the [extension's page](vscode/README.md) for what it does, privacy and settings.

![Monty's details view](docs/screenshots/details.png)

## How it fits together

One local core, several thin surfaces.

```
~/.claude/projects/*/*.jsonl ──┐
                               ├─> core (Node, src/) ── HTTP/SSE on 127.0.0.1:4747 ──> VS Code extension (vscode/)
plans and config in your repos ┘                                                  ├─> Mac menu bar app (menubar/MontyApp/)
                                                                                  └─> browser panel (web/, for development)
```

- `src/`: the core. Node built-ins only, no runtime dependencies. It reads session logs incrementally (`session.ts`), plans (`projects.ts`) and AI tool config (`setup.ts`), and serves state on localhost only (`server.ts`).
- `web/`: the panel. Plain HTML, CSS and JS with no build step; the same page runs in VS Code webviews and a browser tab.
- `vscode/`: the extension. It bundles the core and starts it with VS Code's own Node.
- `menubar/MontyApp/`: the menu bar app. Swift, built with SwiftPM, with no Xcode project.

## Develop

```
npm install
npm test               # core tests
npm run dev            # build and start the core; browser panel at http://127.0.0.1:4747/?repo=<path>
npm run scan           # print what Monty sees from the current folder

cd vscode && npm install && npm test && npm run package    # builds monty.vsix with the core bundled
code --install-extension vscode/monty.vsix

menubar/MontyApp/build.sh   # local menu bar build (ad-hoc signed)
```

To try it without your own sessions, `node docs/demo/make-demo.mjs /tmp/monty-demo` builds a fictional repo and session log; the script's header says how to point the core at it.

Settings for the core come from environment variables: `MONTY_PORT` (4747), `MONTY_PROJECTS` (folders whose repos are all scanned; by default only repos open in VS Code), `MONTY_CLAUDE_PROJECTS` (session log folder), `MONTY_LIVE_HOURS` (3), `MONTY_CONTEXT_WINDOW` (200000).

## Principles

- **Local only.** The core binds 127.0.0.1 and never sends session content anywhere. Session logs contain code, prompts and secrets.
- **Read-only.** Monty never writes to `~/.claude` or to your repos. The one exception is installing the menu bar app when you click Install.
- **Degrade, don't crash.** Claude Code's log format is not a published API. Unknown lines are skipped, and a format change shows less instead of failing.
- **Guesses say so.** "Probably waiting for permission" is a timing guess and reads as one.

## License

[MIT](LICENSE)
