// Holds the live picture: polls session logs and rescans project folders, and
// tells subscribers when anything they would see has changed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.js';
import { claudeAdapter } from './agents/claude.js';
import { opencodeAdapter } from './agents/opencode.js';
import { copilotAdapter } from './agents/copilot.js';
import { codexAdapter } from './agents/codex.js';
import { clineAdapter, rooAdapter } from './agents/cline.js';
import type { AgentAdapter, SessionSource } from './agents/types.js';
import { listRepos, scanRepo } from './projects.js';
import { hasSetup, readSetup } from './setup.js';
import type { MontyState, Project, RepoSetup, Session, SessionPlan } from './types.js';

const SESSION_POLL_MS = 1000;
const DISCOVER_MS = 5000;
const PROJECT_SCAN_MS = 10_000;
const MAX_SESSIONS = 8;

const STATE_ORDER: Record<Session['state'], number> = { needs_input: 0, working: 1, your_turn: 2, done: 3, idle: 4 };

/** Every tool Monty reads sessions from. */
export const ADAPTERS: AgentAdapter[] = [claudeAdapter, opencodeAdapter, codexAdapter, clineAdapter, rooAdapter, copilotAdapter];

export class MontyStore {
  /** Live sessions, keyed "<tool>:<key>". */
  private trackers = new Map<string, SessionSource>();
  /**
   * Adapters switched off after throwing: the tool's format changed under us. The others
   * keep running, and the core logs it once (CLAUDE.md: degrade, don't crash).
   */
  private broken = new Set<string>();
  private projects: Project[] = [];
  private setups: RepoSetup[] = [];
  /**
   * Repos the surfaces have asked about (a VS Code window polls with ?repo=<workspace>),
   * with when they last asked. These are scanned as well as the configured roots, so
   * Monty works on whatever is open without being told where projects live.
   */
  private registered = new Map<string, number>();
  private listeners = new Set<(s: MontyState) => void>();
  private lastJson = '';
  private timers: NodeJS.Timeout[] = [];

  constructor(private cfg: Config, private adapters: AgentAdapter[] = ADAPTERS) {}

  start(): void {
    this.discover();
    this.rescanProjects();
    this.tick();
    this.timers.push(setInterval(() => this.tick(), SESSION_POLL_MS));
    this.timers.push(setInterval(() => this.discover(), DISCOVER_MS));
    this.timers.push(setInterval(() => this.rescanProjects(), PROJECT_SCAN_MS));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
  }

  subscribe(fn: (s: MontyState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Finds sessions active recently, from every adapter. Older ones are dropped from memory. */
  discover(nowMs = Date.now()): void {
    const seen = new Set<string>();
    for (const a of this.adapters) {
      if (this.broken.has(a.tool) || !this.cfg.agents.has(a.tool)) continue;
      try {
        for (const key of a.live(this.cfg, nowMs)) {
          const k = `${a.tool}:${key}`;
          seen.add(k);
          if (!this.trackers.has(k)) this.trackers.set(k, a.open(key, this.cfg));
        }
      } catch (e) {
        this.disable(a.tool, e);
      }
    }
    for (const k of this.trackers.keys()) if (!seen.has(k)) this.trackers.delete(k);
  }

  private disable(tool: string, e: unknown): void {
    if (this.broken.has(tool)) return;
    this.broken.add(tool);
    console.error(`monty: stopped reading ${tool} sessions: ${(e as Error)?.message ?? e}`);
    for (const k of this.trackers.keys()) if (k.startsWith(`${tool}:`)) this.trackers.delete(k);
  }

  /** Runs one source's call; a source that throws is dropped with its adapter. */
  private guard<T>(key: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      this.disable(key.slice(0, key.indexOf(':')), e);
      return undefined;
    }
  }

  /**
   * Adds a repo asked about by a surface. Only a folder that looks like a project (has
   * .git or .claude) counts, so a stray ?repo= cannot make Monty scan an arbitrary folder.
   * Returns whether it is new, in which case it is scanned straight away.
   */
  addRepo(repo: string, nowMs = Date.now()): boolean {
    const r = path.resolve(repo);
    const known = this.registered.has(r);
    if (!known && !looksLikeRepo(r)) return false;
    this.registered.set(r, nowMs);
    if (!known) this.rescanProjects(nowMs);
    return !known;
  }

  /** Every repo to scan: children of the configured roots, plus registered repos still in use. */
  repos(nowMs = Date.now()): string[] {
    // A closed window's repo drops out after the same window that lists sessions.
    for (const [r, at] of this.registered) if (nowMs - at > this.cfg.liveMs) this.registered.delete(r);
    return [...new Set([...listRepos(this.cfg.projectRoots), ...this.registered.keys()])].sort();
  }

  rescanProjects(nowMs = Date.now()): void {
    const repos = this.repos(nowMs);
    this.projects = repos.flatMap((r) => scanRepo(r));
    // Setup files change about as often as plans, so they ride the same 10s scan.
    this.setups = repos.map(readSetup).filter(hasSetup);
    this.emitIfChanged();
  }

  tick(): void {
    for (const [k, t] of [...this.trackers]) this.guard(k, () => t.poll());
    this.emitIfChanged();
  }

  state(nowMs = Date.now()): MontyState {
    const sessions = [...this.trackers]
      .map(([k, t]) => this.guard(k, () => t.snapshot(nowMs)))
      .filter((s): s is Session => !!s)
      .map((s) => withPlan(withRepo(s, this.cfg.projectRoots, [...this.registered.keys()]), this.projects))
      .filter((s) => s.lastEventAt)
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''))
      .slice(0, MAX_SESSIONS);
    return { generatedAt: new Date(nowMs).toISOString(), sessions, projects: this.projects, setups: this.setups, roots: this.cfg.projectRoots };
  }

  private emitIfChanged(): void {
    const s = this.state();
    // generatedAt changes every tick; compare without it.
    const json = JSON.stringify({ ...s, generatedAt: '' });
    if (json === this.lastJson) return;
    this.lastJson = json;
    for (const fn of this.listeners) fn(s);
  }
}

function looksLikeRepo(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude')));
  } catch {
    return false;
  }
}

/** Is this file inside a configured root or a registered repo? (/api/doc serves nothing else.) */
export function isUnderKnown(file: string, roots: string[], repos: string[]): boolean {
  const f = path.resolve(file);
  return [...roots, ...repos].some((r) => f.startsWith(path.resolve(r) + path.sep));
}

/**
 * Only what belongs to one repo: its sessions (cwd at or under it), plans and setup.
 * A workspace opened on a subfolder still matches the repo that contains it.
 */
export function scopeState(state: MontyState, repo: string | null | undefined): MontyState {
  if (!repo) return state;
  const r = path.resolve(repo);
  const under = (a: string, b: string) => a === b || a.startsWith(b + path.sep);
  return {
    ...state,
    scope: r,
    sessions: state.sessions.filter((s) => s.cwd && (under(s.cwd, r) || under(r, s.cwd))),
    projects: state.projects.filter((p) => under(p.repoPath, r) || under(r, p.repoPath)),
    setups: state.setups?.filter((x) => under(x.repoPath, r) || under(r, x.repoPath)),
  };
}

/**
 * Attaches the repo's active plan when the session has no todo list of its own.
 * The plan the session read, edited or named in a command most recently wins, then one its title names ("/execute
 * project-x"), then the repo's only active plan. With several active plans and no sign of
 * which one, there is no plan: picking the newest put a plan the session wasn't working
 * on beside the others, and it read as two versions of the same work.
 * Plans with only a Status line (no phases or tasks) give no progress, so are skipped.
 */
export function withPlan(s: Session, projects: Project[]): Session {
  if (s.progress.total || !s.repoPath) return s;
  // A plan the session went near counts even while its Status line still says Pending:
  // agents start work before anyone updates that line.
  const open = projects.filter((p) => (p.status === 'active' || p.status === 'pending') && p.repoPath === s.repoPath && p.progress.basis !== 'status' && p.progress.total > 0);
  if (!open.length) return s;
  const byFile = new Map(open.map((p) => [p.file, p]));
  // Whole words only: a plan called "web.md" must not match "Fix the webhook".
  const words = new Set(s.title.toLowerCase().split(/[\s/,]+/).map((w) => w.replace(/\.md$/, '')));
  const active = open.filter((p) => p.status === 'active');
  let pick: Project | undefined;
  let match: SessionPlan['match'] = 'only';
  // The plan it went near last: a long session works through several.
  const recent = (s.recentDocs ?? s.touched.map((f) => path.resolve(s.cwd, f.path))).find((f) => byFile.has(f));
  if (recent) [pick, match] = [byFile.get(recent), 'touched'];
  else if ((pick = open.find((p) => words.has(path.basename(p.file, '.md').toLowerCase())))) match = 'named';
  else if (active.length === 1) [pick, match] = [active[0], 'only'];
  if (!pick) return s;
  const { done, total } = pick.progress;
  const basis = pick.progress.basis as SessionPlan['basis'];
  // Every phase marked done but the plan not yet moved to completed/: say so, not "Phase 7 of 7".
  const label = basis === 'phases' ? (done >= total ? `All ${total} phases done` : `Phase ${done + 1} of ${total}`) : `${done}/${total} tasks`;
  return { ...s, plan: { name: pick.name, file: pick.file, done, total, basis, label, match } };
}

/** Names a session after the repo it is in, not the subfolder it was started from. */
export function withRepo(s: Session, roots: string[], repos: string[] = []): Session {
  // A registered repo is the most specific answer: a session in Notes/app/python belongs to Notes.
  const home = repos.filter((r) => s.cwd === r || s.cwd.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  if (home) return { ...s, repo: path.basename(home), repoPath: home };
  for (const root of roots) {
    const r = path.resolve(root);
    if (s.cwd.startsWith(r + path.sep)) {
      const name = s.cwd.slice(r.length + 1).split(path.sep)[0];
      if (name) return { ...s, repo: name, repoPath: path.join(r, name) };
    }
  }
  return { ...s, repoPath: s.cwd || undefined };
}
