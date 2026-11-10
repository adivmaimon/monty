# Changelog

## Unreleased

- Menu bar alerts for a finished turn show Claude's last message instead of your prompt, so you can tell from the banner whether you are needed. Your prompt moves to the subtitle.

## 0.6.0

- Plans per file lists, per folder, the files plans changed with how many, busiest first: a few per folder and the top folders, the rest behind a button. Unchanged files and plan and agent setup files (`.caddis/`, `CLAUDE.md`) stay off.
- Plans and the roadmap read left to right in the order work moves: Pending, Active, Done. The roadmap draws only the short links between neighbouring lanes until you pick a plan, so lines no longer cross over each other.
- The footprint map stays readable on busy repos: folders with the plan's own files come first, and each shows only a few files changed outside the plan, with a button for the rest.
- Specs can draw small charts and flows: write YAML in a `chart` or `flow` fenced block (GitHub shows it as plain YAML) and the readable view draws bars or steps. A block Monty can't read shows its source with one line saying why.
- Hover a file reference in a plan to see the lines it points at, or a link to another plan to see its status, goal and progress. Works from the keyboard too.
- Footprint: a plan or spec's readable view shows where its work lands in the repo. Files it names that changed, files it names still untouched, and files changed outside it, drawn as area boxes; click a file to see its phase and open it. Changes come from git since the spec was created and from live sessions working on it.
- Blast radius: in a repo with a Caddis map, an open plan's header has a tile showing what its changes reach: the files it edits that something imports, their importers with hubs marked, reach by area, and importers no test reaches. Repos without the map look as before.
- Specs show what changed since you last read them: an orchid outline round each changed section, a dot in the section list, new text highlighted, old status and risk struck through, and "done just now" on phases finished since. Step through with previous and next; Mark seen clears them. The last-seen copy stays in Monty's own storage, never in your repo.
- Plans per file: the details view maps the repo's folders, each file shaded by how many plans changed it in the last 30 or 90 days or ever. Click a file for those plans, newest first. Plans are matched to commits by Caddis's `Caddis-Plan:` line, by commits that changed the plan itself, or, marked as a guess, by the dates in the plan and the files it names.
- The active plan in the editor: the explorer marks the files it changed (●), the ones it names but hasn't touched yet (○) and changes outside what it names (◆); a line at the top of a file names the plan changing it and how many earlier plans did, and lists them on click; the status bar shows the plan and its phase.
- `monty.planBlame` (off by default): plan names above each block of code on screen, from git blame.
- Roadmap: every plan in a repo as a card in Done, Active and Next, with lines for what depends on what (from `Depends on`, `Requires` or `Blocked by` lines that link or name another spec). Click a card to light up what it needs and unblocks. Loops are drawn and called out. Opens from the Plans card and a plan's header, in its own tab in VS Code.
- Plans and specs open in Brief: a headline card (title, status, risk, goal), tiles for footprint, roadmap and blast radius, a phase stepper with dates, the current phase's gate or checklist, and open questions as cards.
- Tags, numbers and short lines explain themselves on hover or keyboard focus.
- Roadmap, Footprint map and Blast radius map open in the same full-window sheet: the map's name and what it shows on the left, Close on the right, Esc to close.
- Full shows the whole document with a table of contents that follows your scroll. Changes draw as a file tree, Phases as a stepper, Tests as rows, and "None" or "Skipped" sections fold into one line.
- Answer a plan's open question with one click (its default, or your own words): Monty writes a dated decision under it, and Undo takes it out again. This is the only time Monty writes to a file, and only when you click.
- GitHub callouts (`> [!NOTE]`, `> [!WARNING]` and the rest) render as tinted boxes.
- The reader remembers whether you last chose Brief or Full.

## 0.5.1

- Adding Caddis as an option.
- Real release notes instead of "Small fixes".

## 0.5.0

- "Open in VS Code" from the menu bar brings up the window that already has the repo open instead of opening a new one.
- Notifications play Monty's own short ping.
- Sessions a program started (Claude Code SDK or `claude -p`, such as a benchmark spawning dozens of runs) are no longer listed, never notify, and never guess at permission prompts. One line says how many are at work.

## 0.4.4

- OpenSpec: task sections (`## 1. Storage`) show as phases, a change whose tasks are all ticked says "not archived yet", and a generic `# Proposal` heading no longer becomes the name.
- Kiro and cc-sdd: specs are named after their folder instead of "Requirements Document", top-level tasks show as phases without double-counting their sub-tasks, and `spec.json` gives the stage and what awaits approval.
- Spec Kit: the spec's Status line and original request show in the plan view.
- Opening any file of an OpenSpec change or a Kiro / Spec Kit feature shows its progress, with links to the other files.
- Double-backtick code spans render.

## 0.4.3

- Background waits only count jobs the turn itself started, end at the job's own deadline (a monitor's expiry), and ignore dev servers, so a finished turn no longer reads "working" for an hour.
- No more stale "your move" banners mid-turn: a long silence before Claude's reply stays "working".
- A session closed mid-tool-call goes idle instead of "at it for 169 min"; a finished turn stays "your move" for two hours instead of vanishing after 15 minutes.
- The menu bar icon turns while a session works with no plan progress to show, so working and waiting no longer look the same.
- The menu bar app and the core survive the Mac sleeping instead of quitting on wake.

## 0.4.2

- The menu bar app notifies you when Claude finishes a turn that ran 30 seconds or more, not only when a task list is complete (most sessions have none).
- Notification permission is asked at launch, so the first alert is no longer lost.
- A turn that leaves a background job or monitor running shows "Waiting on a background job" instead of "Your move", with no alert; the alert comes when Claude reports back. Turn length counts from your last prompt, so a quick report after a long job still alerts.
- Prompts sent as blocks (from VS Code, with images or pasted text) and API errors now count, so their turns alert too.
- No more alert for each failing test run mid-turn. A finished alert says if tests were left failing.
- Plans: the Status sentence shows under the title; "Phase 2 done" in a Status line and "(done)" on a heading count; phases written as bold paragraphs are found; "Phase N of M" names the first phase not done.
- Plan view: markdown in section headings renders, table cells keep pipes inside code, code blocks under list items stay code, relative links open the linked doc, `__bold__` works.
- The menu bar dropdown says when macOS is blocking Monty's notifications, with a link to System Settings.
- Plan view: a long Goal stays readable in full and renders its markdown; plans written with `###` sections get collapsible sections; only short `**Key**: value` lines become chips; cancelled and parked plans say so instead of "Phase 1 of 3"; cleaner phase titles; `#L39` links open at the line; `~~strike~~`, `<br>` in tables and bold around italics render.
- When nothing is at work, the menu bar says "your move" or "all done" instead of plan progress, and plans read "0 of 5 phases done" rather than "Phase 1 of 5".

## 0.4.1

- A session's progress bar only follows a plan it has opened or named, or the repo's only active plan. With several active plans Monty no longer guesses the newest.
- The menu bar names the plan beside its progress.
- A session's plan is the one it last read or wrote, including from the shell (`cat plan.md`), even while the plan still says Pending.
- The follow toggle reads "Follow live file edits", without the paragraph under it.

## 0.3.1

- The Marketplace page matches the GitHub README: same introduction and screenshot tour.

## 0.3.0

- Watches more than Claude Code: Codex CLI, opencode, Cline, Roo Code and GitHub Copilot Chat sessions show up too, each labelled when more than one agent is about.
- A violet theme across the panel, the menu bar and the icons, with one colour per state: violet at work, orchid needs you, periwinkle your move.
- Monty now speaks like the monocled butler it is. The facts are unchanged; the manners are new.
- Mermaid diagrams follow the theme.

## 0.2.0

First public release.

- Sidebar and details view for the open repo's Claude Code session: state, plan progress, what it's doing now, activity, files changed, context and an effort gauge.
- Readable view for every `.md`, with phases, collapsible sections, Mermaid diagrams and file links.
- Follow mode: files Claude changes open beside your editor with the changes highlighted.
- Explorer dots on files the session changed or read.
- Project config: instructions files, rules, skills, commands and guardrails for Claude Code, Cursor, Codex, Copilot, Gemini, Windsurf, Cline and Continue.
- Optional Mac menu bar app, signed and notarized, installed from the extension.
