// Holds the live picture: polls session logs and rescans project folders, and
// tells subscribers when anything they would see has changed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from './config.js';
import { DEFAULT_SESSION_OPTIONS, SessionTracker } from './session.js';
import { listRepos, scanRepo } from './projects.js';
import { hasSetup, readSetup } from './setup.js';
import type { MontyState, Project, RepoSetup, Session, SessionPlan } from './types.js';

const SESSION_POLL_MS = 1000;
const DISCOVER_MS = 5000;
const PROJECT_SCAN_MS = 10_000;
const MAX_SESSIONS = 8;

const STATE_ORDER: Record<Session['state'], number> = { needs_input: 0, working: 1, your_turn: 2, done: 3, idle: 4 };

export class MontyStore {
  private trackers = new Map<string, SessionTracker>();
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

  constructor(private cfg: Config) {}

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

  /** Finds session logs written to recently. Older ones are dropped from memory. */
  discover(nowMs = Date.now()): void {
    const seen = new Set<string>();
    for (const dir of safeReaddir(this.cfg.claudeProjectsDir)) {
      const full = path.join(this.cfg.claudeProjectsDir, dir);
      for (const f of safeReaddir(full)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(full, f);
        let m: number;
        try {
          m = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (nowMs - m > this.cfg.liveMs) continue;
        seen.add(file);
        if (!this.trackers.has(file)) {
          this.trackers.set(file, new SessionTracker(file, { ...DEFAULT_SESSION_OPTIONS, contextWindow: this.cfg.contextWindow }));
        }
      }
    }
    for (const file of this.trackers.keys()) if (!seen.has(file)) this.trackers.delete(file);
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
    for (const t of this.trackers.values()) t.poll();
    this.emitIfChanged();
  }

  state(nowMs = Date.now()): MontyState {
    const sessions = [...this.trackers.values()]
      .map((t) => withPlan(withRepo(t.snapshot(nowMs), this.cfg.projectRoots, [...this.registered.keys()]), this.projects))
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

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
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
 * A plan the session read or edited wins, then one its title names ("/execute
 * project-x"), then the repo's only active plan, then the most recently changed.
 * Plans with only a Status line (no phases or tasks) give no progress, so are skipped.
 */
export function withPlan(s: Session, projects: Project[]): Session {
  if (s.progress.total || !s.repoPath) return s;
  const candidates = projects.filter((p) => p.status === 'active' && p.repoPath === s.repoPath && p.progress.basis !== 'status' && p.progress.total > 0);
  if (!candidates.length) return s;
  const touched = new Set(s.touched.map((f) => path.resolve(s.cwd, f.path)));
  // Whole words only: a plan called "web.md" must not match "Fix the webhook".
  const words = new Set(s.title.toLowerCase().split(/[\s/,]+/).map((w) => w.replace(/\.md$/, '')));
  let pick: Project | undefined;
  let match: SessionPlan['match'];
  if ((pick = candidates.find((p) => touched.has(p.file)))) match = 'touched';
  else if ((pick = candidates.find((p) => words.has(path.basename(p.file, '.md').toLowerCase())))) match = 'named';
  else if (candidates.length === 1) [pick, match] = [candidates[0], 'only'];
  else [pick, match] = [[...candidates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0], 'newest'];
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
