// Plan history for the editor, without vscode: which plan is active, how each explorer
// file relates to it, what the CodeLens at the top of a file says, and git blame parsing.
// historyView.ts turns these into VS Code decorations, lenses and the status bar item.
// The data is the core's GET /api/history (src/history.ts, RepoHistory).

export type Via = 'trailer' | 'spec' | 'window' | 'dates';

export interface HistorySpec {
  name: string;
  file?: string;
  status?: string;
  label?: string;
  named: string[];
  commits: number;
  last?: string;
}

export interface History {
  repo: string;
  specs: HistorySpec[];
  files: Record<string, [number, string, Via][]>;
  commitSpecs: Record<string, number[]>;
}

export interface LiteState {
  sessions: { state: string; cwd: string; plan?: { file?: string; name: string; label: string }; touched?: { path: string; edits: number }[] }[];
  projects: { file: string; name: string; status?: string; label?: string }[];
}

export interface ActiveSpec {
  name: string;
  file: string;
  /** "Phase 3 of 4", from the session's plan or the plan itself. */
  label?: string;
  /** Index into History.specs, when the history knows it. */
  index: number;
  /** Repo-relative files the live session on this plan edited (not yet committed, often). */
  sessionEdits: string[];
}

/** Plain path helpers that work on both slash styles, so this file needs no node:path. */
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
export function relTo(root: string, file: string): string | undefined {
  const r = norm(root);
  const f = norm(file);
  return f.startsWith(r + '/') ? f.slice(r.length + 1) : undefined;
}

/**
 * The plan this repo is working on: the live session's plan, else the repo's only active
 * plan. With several active and no session pointing at one, none: picking one would be a
 * guess dressed as a fact (the core's withPlan makes the same call).
 */
export function activeSpec(state: LiteState | null, history: History | null): ActiveSpec | undefined {
  if (!state) return undefined;
  const live = state.sessions.find((s) => s.state !== 'idle' && s.plan?.file);
  let file = live?.plan?.file;
  let label = live?.plan?.label;
  let name = live?.plan?.name;
  if (!file) {
    const active = state.projects.filter((p) => p.status === 'active');
    if (active.length !== 1) return undefined;
    const p = active[0] as LiteState['projects'][number];
    [file, label, name] = [p.file, p.label, p.name];
  }
  const index = history ? history.specs.findIndex((s) => s.file === file) : -1;
  const sessionEdits: string[] = [];
  if (live && history) {
    for (const t of live.touched ?? []) {
      if (!t.edits || t.path.startsWith('/')) continue;
      const rel = relTo(history.repo, `${norm(live.cwd)}/${t.path}`);
      if (rel) sessionEdits.push(rel);
    }
  }
  return { name: name ?? file, file, label, index, sessionEdits };
}

export type Mark = 'changed' | 'named' | 'outside';

/**
 * Explorer marks for the active plan: changed (by its commits or its live session, and
 * named in it or it names nothing), named but not changed yet, and changed outside what it names.
 */
export function explorerMarks(active: ActiveSpec | undefined, history: History | null): Map<string, Mark> {
  const out = new Map<string, Mark>();
  if (!active || !history) return out;
  const spec = active.index >= 0 ? history.specs[active.index] : undefined;
  const named = new Set(spec?.named ?? []);
  const changed = new Set(active.sessionEdits);
  if (active.index >= 0) for (const [f, xs] of Object.entries(history.files)) if (xs.some((x) => x[0] === active.index)) changed.add(f);
  // The plan's own file changes with every phase; marking it says nothing.
  const own = relTo(history.repo, active.file);
  for (const f of changed) if (f !== own) out.set(f, !named.size || named.has(f) ? 'changed' : 'outside');
  for (const f of named) if (!out.has(f)) out.set(f, 'named');
  return out;
}

export interface LensEntry {
  name: string;
  file?: string;
  /** ISO time of the plan's latest change to this file; undefined for the live session's edits. */
  when?: string;
  active: boolean;
  guess: boolean;
}

export interface FileLens {
  title: string;
  entries: LensEntry[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Refresh tokens · Phase 2 of 4 · 3 earlier plans", or "2 plans changed this file", or nothing. */
export function fileLens(rel: string, active: ActiveSpec | undefined, history: History | null): FileLens | undefined {
  if (!history) return undefined;
  const xs = history.files[rel] ?? [];
  const mine = active ? xs.find((x) => x[0] === active.index) : undefined;
  const activeHere = !!active && (!!mine || active.sessionEdits.includes(rel));
  const entries: LensEntry[] = [];
  if (activeHere && active) entries.push({ name: active.name, file: active.file, when: mine?.[1], active: true, guess: !!mine && (mine[2] === 'window' || mine[2] === 'dates') });
  for (const [i, when, via] of xs) {
    if (active && i === active.index) continue;
    const s = history.specs[i];
    if (s) entries.push({ name: s.name, file: s.file, when, active: false, guess: via === 'window' || via === 'dates' });
  }
  const earlier = entries.length - (activeHere ? 1 : 0);
  if (activeHere && active) {
    const parts = [active.name, active.label, earlier ? plural(earlier, 'earlier plan', 'earlier plans') : ''].filter(Boolean);
    return { title: parts.join(' · '), entries };
  }
  if (!earlier) return undefined;
  return { title: `${plural(earlier, 'plan', 'plans')} changed this file`, entries };
}

export interface BlameBlock {
  sha: string;
  /** 1-based, inclusive, in the current file. */
  start: number;
  end: number;
}

/** `git blame --porcelain` to runs of consecutive lines from the same commit. */
export function blameBlocks(porcelain: string): BlameBlock[] {
  const out: BlameBlock[] = [];
  let pending: { sha: string; line: number } | null = null;
  for (const l of porcelain.split('\n')) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(l);
    if (h) {
      pending = { sha: h[1] as string, line: Number(h[2]) };
      continue;
    }
    if (!l.startsWith('\t') || !pending) continue;
    const last = out[out.length - 1];
    if (last && last.sha === pending.sha && last.end === pending.line - 1) last.end = pending.line;
    else out.push({ sha: pending.sha, start: pending.line, end: pending.line });
    pending = null;
  }
  return out;
}

/** The plans a blamed commit belongs to, by the short sha the core serves. */
export function blameSpecs(sha: string, history: History | null): HistorySpec[] {
  if (!history || /^0+$/.test(sha)) return [];
  return (history.commitSpecs[sha.slice(0, 12)] ?? []).map((i) => history.specs[i]).filter((s): s is HistorySpec => !!s);
}
