# Changelog

## 0.4.4

- Small fixes.

## 0.4.3

- Small fixes.

## 0.4.2

- The menu bar app notifies you when Claude finishes a turn that ran 30 seconds or more, not only when a task list is complete (most sessions have none).
- Notification permission is asked at launch, so the first alert is no longer lost.
- A turn that leaves a background job or monitor running shows "Waiting on a background job" instead of "Your move", with no alert; the alert comes when Claude reports back. Turn length counts from your last prompt, so a quick report after a long job still alerts.
- Prompts sent as blocks (from VS Code, with images or pasted text) and API errors now count, so their turns alert too.
- No more alert for each failing test run mid-turn. A finished alert says if tests were left failing.
- Plans: the Status sentence shows under the title; "Phase 2 done" in a Status line and "(done)" on a heading count; phases written as bold paragraphs are found; "Phase N of M" names the first phase not done.
- Plan view: markdown in section headings renders, table cells keep pipes inside code, code blocks under list items stay code, relative links open the linked doc, `__bold__` works.
- The menu bar dropdown says when macOS is blocking Monty's notifications, with a link to System Settings.
- Background waits only count jobs the turn itself started, end at the job's own deadline (a monitor's expiry), and ignore dev servers, so a finished turn no longer reads "working" for an hour.
- No more stale "your move" banners mid-turn: a long silence before Claude's reply stays "working".
- A session closed mid-tool-call goes idle instead of "at it for 169 min"; a finished turn stays "your move" for two hours instead of vanishing after 15 minutes.
- The menu bar icon turns while a session works with no plan progress to show, so working and waiting no longer look the same.
- The menu bar app and the core survive the Mac sleeping instead of quitting on wake.
- OpenSpec: task sections (`## 1. Storage`) show as phases, a change whose tasks are all ticked says "not archived yet", and a generic `# Proposal` heading no longer becomes the name.
- Kiro and cc-sdd: specs are named after their folder instead of "Requirements Document", top-level tasks show as phases without double-counting their sub-tasks, and `spec.json` gives the stage and what awaits approval.
- Spec Kit: the spec's Status line and original request show in the plan view.
- Opening any file of an OpenSpec change or a Kiro / Spec Kit feature shows its progress, with links to the other files.
- Double-backtick code spans render.
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
