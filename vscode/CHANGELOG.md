# Changelog

## Unreleased

- The menu bar app notifies you when Claude finishes a turn that ran 30 seconds or more, not only when a task list is complete (most sessions have none).
- Notification permission is asked at launch, so the first alert is no longer lost.
- When nothing is at work, the menu bar says "your move" or "all done" instead of plan progress, and plans read "0 of 5 phases done" rather than "Phase 1 of 5".

## 0.4.0

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
