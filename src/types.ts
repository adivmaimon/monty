// Shared shapes for everything Monty serves. The web panel, the menu bar and the
// VS Code extension all read these, so a change here is a change to every surface.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  text: string;
  status: TodoStatus;
}

export type ActivityKind =
  | 'read' | 'edit' | 'write' | 'run' | 'test' | 'search' | 'web'
  | 'agent' | 'ask' | 'plan' | 'tool' | 'prompt';

export interface Activity {
  time: string; // ISO timestamp from the log line
  kind: ActivityKind;
  text: string; // plain English, e.g. "Editing src/auth/session.ts"
  file?: string; // path relative to the session's cwd when inside it
  plus?: number;
  minus?: number;
  failed?: boolean;
}

/**
 * working     - tools are running or Claude is mid-turn
 * needs_input - Claude asked a question, wants plan approval, or a tool has been
 *               waiting long enough that it is probably a permission prompt
 * your_turn   - Claude ended its turn with work still open
 * done        - Claude ended its turn and every todo is complete
 * idle        - nothing has happened for a while
 */
export type SessionState = 'working' | 'needs_input' | 'your_turn' | 'done' | 'idle';

export interface TouchedFile {
  path: string;
  reads: number;
  edits: number;
  plus: number;
  minus: number;
}

/** The coding tool a session came from. */
export type AgentTool = 'claude-code' | 'opencode' | 'codex' | 'cline' | 'roo' | 'copilot-chat';

export interface Session {
  id: string;
  agent: AgentTool;
  file: string;
  cwd: string;
  /** Repo folder name. A session started in a subfolder (Notes/app/python) belongs to Notes. */
  repo: string;
  /** The repo's folder, when the session is under a project root. */
  repoPath?: string;
  branch?: string;
  model?: string;
  title: string;
  startedAt?: string;
  lastEventAt?: string;
  state: SessionState;
  stateReason: string;
  todos: Todo[];
  progress: { done: number; total: number };
  /**
   * The repo's active plan, the progress source when the session has no todo list
   * (current Claude Code has no todo tools). `match` says how it was picked.
   */
  plan?: SessionPlan;
  now?: Activity;
  activity: Activity[]; // newest first
  context: { tokens: number; window: number; pct: number };
  touched: TouchedFile[];
  /** Markdown files the session went near (read, wrote, named in a command), absolute, most recent first. */
  recentDocs?: string[];
  lastTest?: { ok: boolean; summary: string; time: string };
  /** The turn that just ended with a reply, while the session waits on you: how long it ran, when it ended. */
  lastTurn?: { ms: number; endedAt: string };
  /** Started by a program, not typed by a person (see MontyState.scripted). */
  scripted?: boolean;
  /** The most recent edit that succeeded, for VS Code's follow mode. */
  lastEdit?: LastEdit;
  /** The skill or slash command most recently invoked: a Skill tool call, or a <command-name> line. */
  inUse?: { kind: 'skill' | 'command'; name: string; time: string };
  subagentsRunning: number;
  /**
   * Effort: tokens per minute over the last few minutes, for the speedometer. `in` is new
   * input (fresh prompt and cache writes, not cache reads, which are context re-read),
   * `out` is generated. `level` 0..1 is where the needle sits; 1 is pegged.
   */
  throughput: { inPerMin: number; outPerMin: number; level: number };
}

export interface LastEdit {
  /** The tool call's id: follow mode acts once per edit. */
  id: string;
  time: string;
  /** Relative to the session's cwd. Edits outside the repo are never followed. */
  file: string;
  /**
   * The new text, to find and highlight in the file: one entry per change (MultiEdit
   * has several), capped at SNIPPET_MAX characters in total so whole files never ship.
   */
  snippets: string[];
}

export interface SessionPlan {
  name: string;
  file: string;
  done: number;
  total: number;
  basis: 'phases' | 'tasks';
  /** "Phase 2 of 4" or "3/8 tasks" */
  label: string;
  /** touched: the session read or edited the plan; named: the title names it; only: the repo's one active plan; newest: most recently changed of several */
  match: 'touched' | 'named' | 'only';
}

export type ProjectStatus = 'active' | 'pending' | 'parked' | 'completed' | 'cancelled';
export type ProjectSource = 'claude-projects' | 'openspec' | 'spec-kit' | 'kiro';

export interface Phase {
  n: number;
  title: string;
  done: boolean;
}

export interface Project {
  id: string;
  repo: string;
  repoPath: string;
  source: ProjectSource;
  name: string;
  file: string; // absolute path to the main doc
  status: ProjectStatus;
  statusText?: string; // the raw Status line, when there is one
  goal?: string;
  phases: Phase[];
  tasks: { done: number; total: number };
  /** what the progress bar should show, and where the numbers came from */
  progress: { done: number; total: number; basis: 'phases' | 'tasks' | 'status' };
  /** Every markdown file in the change or feature folder (spec frameworks split one piece of work across several). */
  docs?: string[];
  /** "Phase 3 of 5", "4/9 tasks": every surface shows this rather than working it out. */

  label?: string;
  updatedAt: string;
}

/** An AI coding tool whose config a repo carries. */
export type SetupTool = 'Claude Code' | 'Cursor' | 'Codex' | 'Copilot' | 'Gemini' | 'Windsurf' | 'Cline' | 'Continue';

/** An instructions file the tool reads on every request (CLAUDE.md, AGENTS.md, a Cursor rule...). */
export interface SetupInstructions {
  tool: SetupTool;
  file: string; // absolute
  label: string; // repo-relative, for display
  /** Cursor rules and Copilot instructions say when they apply. */
  description?: string;
  globs?: string;
  alwaysApply?: boolean;
}

export interface SetupSkill {
  tool: SetupTool;
  kind: 'skill' | 'command' | 'agent' | 'prompt';
  name: string;
  description?: string;
  file: string; // absolute
}

/** One line pulled out of an instructions file: a bullet under "Rules", or a Never/Always/Must line. */
export interface SetupRule {
  text: string;
  file: string; // absolute
  label: string; // "CLAUDE.md:42"
  heading?: string;
}

export interface SetupGuardrails {
  allow: string[];
  deny: string[];
  hooks: { event: string; matcher?: string; command: string }[];
  mcp: { name: string; detail: string; file: string }[];
}

export interface RepoSetup {
  repo: string;
  repoPath: string;
  tools: SetupTool[];
  instructions: SetupInstructions[];
  skills: SetupSkill[];
  rules: SetupRule[];
  guardrails: SetupGuardrails;
}

export interface MontyState {
  generatedAt: string;
  sessions: Session[];
  projects: Project[];
  /** Each repo's AI tool setup (src/setup.ts). Only repos that carry any. */
  setups?: RepoSetup[];
  roots: string[];
  /** Set when the state is filtered to one repo (a VS Code workspace). */
  scope?: string;
  /**
   * Sessions a program started (Claude Code SDK / `claude -p`, e.g. a benchmark spawning
   * dozens of runs). Nobody is watching them, so the ones at work are counted here, not listed or notified.
   */
  scripted?: { repo: string; cwd: string; state: SessionState }[];
}
