// Plan history: which plans changed which files, from git. Serves GET /api/history.
//
// Reads `git log` once per repo, caches the commits in Monty's own cache folder and
// tops them up from the cached head. Commits are tied to plans by, most exact first:
//   trailer  the commit's `Caddis-Plan: <plan file name>` line (Caddis's commit skill)
//   spec     the commit changed the plan's own file (any repo, any spec framework)
//   window   a guess: a commit touching a file the plan names, between its first and last spec commit
//   dates    a guess: the same, between the dates written in the plan, for plans git never saw
//            (gitignored plans, as Caddis repos that keep plans private have)
// Git is optional: no git, not a repo, a timeout, all give an empty history.

import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseClaudeProject } from './projects.js';
import type { HistorySpec, HistoryVia, Project, ProjectStatus, RepoHistory } from './types.js';

export interface Commit {
  sha: string;
  /** Unix seconds, committer time. */
  t: number;
  subject: string;
  /** The Caddis-Plan trailer's value. */
  plan?: string;
  files: string[];
}

interface Index {
  v: number;
  repo: string;
  head: string;
  truncated: boolean;
  commits: Commit[]; // newest first
}

const INDEX_VERSION = 1;
// Enough for a few years of a busy solo repo; the oldest are dropped past this. "All" in
// the view means these. At ~150 bytes a commit the cache stays under a megabyte or so.
export const MAX_COMMITS = 5000;
// The view polls; git is asked at most this often per repo. Commits land minutes apart.
const REFRESH_MS = 10_000;
// A healthy `git log` of 5000 commits takes well under a second; a hung one (network
// filesystem, giant repo) must not hold the request forever.
const GIT_TIMEOUT_MS = 15_000;
// A commit touching more files than this is a sweep (rename, format, vendoring), not one
// plan's work: the guessed sources skip it. Exact sources still count it.
const MAX_GUESS_FILES = 100;
// Folders shown in the repo view list at most this many files each, so a 2000-file
// folder does not swamp the page.
const MAX_AREA_FILES = 80;
const DAY_MS = 86_400_000;
// Dates a plan quotes from well before it existed ("since 2024-05-01") are not its own.
const DATE_SLACK_MS = 30 * DAY_MS;

// ---------- git ----------

export interface GitOptions {
  /** The git binary (tests point it at a missing one). */
  git?: string;
  /** Called with each git command's arguments, for tests to count calls. */
  trace?: (args: string[]) => void;
}

function git(repo: string, args: string[], opts: GitOptions): Promise<string | null> {
  opts.trace?.(args);
  return new Promise((resolve) => {
    try {
      // Read-only commands only. GIT_OPTIONAL_LOCKS=0: nothing refreshes or locks the index.
      execFile(
        opts.git ?? 'git',
        ['-c', 'core.quotepath=off', ...args],
        { cwd: repo, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, windowsHide: true },
        (err, out) => resolve(err ? null : out),
      );
    } catch {
      resolve(null);
    }
  });
}

const RS = '\x1e';
const US = '\x1f';
const LOG_FORMAT = `--format=${RS}%H${US}%ct${US}%s${US}%b${US}`;

/** `git log --name-only` in LOG_FORMAT to commits. A record that does not parse is skipped. */
export function parseLog(text: string): Commit[] {
  const out: Commit[] = [];
  for (const rec of text.split(RS)) {
    try {
      const parts = rec.split(US);
      if (parts.length < 5) continue;
      const [sha, ct, subject, body, rest] = parts as [string, string, string, string, string];
      if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
      const t = Number(ct);
      if (!Number.isFinite(t)) continue;
      const files = rest.split('\n').map((l) => l.trim()).filter(Boolean);
      out.push({ sha, t, subject, plan: trailer(body), files });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** The last Caddis-Plan line in the body (git reads trailers from the last paragraph; be lenient). */
export function trailer(body: string): string | undefined {
  const all = [...body.matchAll(/^Caddis-Plan:[ \t]*(\S[^\r\n]*?)[ \t]*$/gim)];
  const v = all[all.length - 1]?.[1];
  return v ? path.basename(v).replace(/\.md$/i, '') : undefined;
}

// ---------- which spec a path belongs to ----------

const BUCKET = /^(active|completed|cancelled|parked|pending)$/i;

/**
 * The spec a repo-relative path belongs to, by the layouts src/projects.ts reads. The key
 * survives a plan moving between buckets: Caddis and .claude/projects plans are keyed by
 * file name, the frameworks by their change or feature folder.
 */
export function specOfPath(rel: string): string | null {
  const p = rel.split(/[\\/]/);
  if (!/\.md$/i.test(rel)) return null;
  if (p.length === 4 && (p[0] === '.caddis' || p[0] === '.claude') && p[1] === 'projects' && BUCKET.test(p[2] ?? '')) {
    const f = p[3] as string;
    if (/\.[a-z]+\.md$/i.test(f)) return null; // x.debate.md is a note about a plan
    return 'plan:' + f.replace(/\.md$/i, '');
  }
  if (p[0] === 'openspec' && p[1] === 'changes' && p.length >= 4) {
    const name = p[2] === 'archive' ? p[3] : p[2];
    if (!name || (p[2] === 'archive' && p.length < 5)) return null;
    return 'openspec:' + name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  }
  if (p[0] === 'specs' && p.length >= 3) return 'spec-kit:' + p[1];
  if (p[0] === '.kiro' && p[1] === 'specs' && p.length >= 4) return 'kiro:' + p[2];
  return null;
}

// Same shape as web/md.js FILE_REF: a path with a slash and an extension, optional :lines.
const FILE_REF = /^([\w@.\-()[\]~+]+\/)+[\w@.\-()[\]+]+\.[a-zA-Z0-9]{1,6}(:\d+([,-]\d+)*)?$/;

/** Repo-relative files a spec names in code spans (`src/x.ts:41`), without line numbers. */
export function namedFiles(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/``\s?(.+?)\s?``|`([^`\n]+)`/g)) {
    const c = (m[1] ?? m[2] ?? '').trim();
    if (!FILE_REF.test(c) || c.startsWith('~') || c.startsWith('../')) continue;
    out.add(c.replace(/:[\d,-]+$/, '').replace(/^\.\//, ''));
  }
  return [...out];
}

/** From the earliest date in a plan (no earlier than a month before its file was made) to its latest plus a day. */
export function datedWindow(text: string, birthMs: number, mtimeMs: number, open: boolean, nowMs: number): [number, number] | undefined {
  const dates = [...text.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)]
    .map((m) => new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime())
    .filter((t) => Number.isFinite(t) && t <= nowMs + DAY_MS);
  const birth = birthMs > 0 && birthMs <= mtimeMs + 1000 ? birthMs : 0;
  const own = birth ? dates.filter((d) => d >= birth - DATE_SLACK_MS) : dates;
  const starts = [...own, ...(birth ? [birth] : [])];
  if (!starts.length) return undefined;
  const start = Math.min(...starts);
  const latest = own.length ? Math.max(...own) + DAY_MS : 0;
  const end = open ? nowMs : latest > start ? latest : mtimeMs;
  return end > start ? [start, end] : undefined;
}

// ---------- attribution ----------

export interface SpecInput {
  key: string;
  name: string;
  file?: string;
  status?: ProjectStatus;
  label?: string;
  named: string[];
  /** For specs git has no commits for: [startMs, endMs] from the dates in it. */
  dated?: [number, number];
}

export interface Attribution {
  specs: SpecInput[];
  /** Per commit (same order as the input), the spec indexes it belongs to and how. */
  byCommit: { spec: number; via: HistoryVia }[][];
}

/** Ties commits to specs. Pure: the tests drive it without git. */
export function attribute(commits: Commit[], specsIn: SpecInput[]): Attribution {
  const specs = [...specsIn];
  const byKey = new Map(specs.map((s, i) => [s.key, i]));
  const ensure = (key: string, name: string): number => {
    let i = byKey.get(key);
    if (i === undefined) {
      i = specs.push({ key, name, named: [] }) - 1;
      byKey.set(key, i);
    }
    return i;
  };
  // A trailer names the plan file without .md; tolerate "x" for "project-x" and the reverse.
  const planKey = (name: string): string => {
    for (const k of ['plan:' + name, 'plan:project-' + name, 'plan:' + name.replace(/^project-/, '')]) if (byKey.has(k)) return k;
    return 'plan:' + name;
  };
  const byCommit: Attribution['byCommit'] = commits.map(() => []);
  const span = new Map<number, [number, number]>();
  commits.forEach((c, ci) => {
    const got = byCommit[ci] as { spec: number; via: HistoryVia }[];
    const add = (spec: number, via: HistoryVia) => {
      if (got.some((g) => g.spec === spec)) return;
      got.push({ spec, via });
      const s = span.get(spec);
      span.set(spec, s ? [Math.min(s[0], c.t), Math.max(s[1], c.t)] : [c.t, c.t]);
    };
    if (c.plan) add(ensure(planKey(c.plan), prettyName(c.plan)), 'trailer');
    for (const f of c.files) {
      const k = specOfPath(f);
      if (k) add(ensure(k, prettyName(k.slice(k.indexOf(':') + 1))), 'spec');
    }
  });
  // The guesses, only for commits no exact source claimed.
  const guessers = specs
    .map((s, i) => {
      const sp = span.get(i);
      const win: [number, number] | undefined = sp ? [sp[0], sp[1]] : s.dated ? [s.dated[0] / 1000, s.dated[1] / 1000] : undefined;
      return { i, named: new Set(s.named), win, via: (sp ? 'window' : 'dates') as HistoryVia };
    })
    .filter((g) => g.named.size && g.win);
  commits.forEach((c, ci) => {
    const got = byCommit[ci] as { spec: number; via: HistoryVia }[];
    if (got.length || c.files.length > MAX_GUESS_FILES) return;
    for (const g of guessers) {
      const [a, b] = g.win as [number, number];
      if (c.t >= a && c.t <= b && c.files.some((f) => g.named.has(f))) got.push({ spec: g.i, via: g.via });
    }
  });
  return { specs, byCommit };
}

const RANK: Record<HistoryVia, number> = { trailer: 0, spec: 1, window: 2, dates: 3 };

/** The served shape from commits, specs and the current tree. */
export function summarise(repo: string, idx: { head?: string; truncated: boolean; commits: Commit[] }, specsIn: SpecInput[], tree: Map<string, number>, nowMs = Date.now()): RepoHistory {
  const { specs, byCommit } = attribute(idx.commits, specsIn);
  const files = new Map<string, Map<number, [number, HistoryVia]>>();
  const stats = new Map<number, { n: number; first: number; last: number }>();
  const commitSpecs: Record<string, number[]> = {};
  idx.commits.forEach((c, ci) => {
    const got = byCommit[ci] ?? [];
    if (!got.length) return;
    commitSpecs[c.sha.slice(0, 12)] = got.map((g) => g.spec);
    for (const { spec, via } of got) {
      const st = stats.get(spec) ?? { n: 0, first: c.t, last: c.t };
      stats.set(spec, { n: st.n + 1, first: Math.min(st.first, c.t), last: Math.max(st.last, c.t) });
      for (const f of c.files) {
        const m = files.get(f) ?? new Map<number, [number, HistoryVia]>();
        const prev = m.get(spec);
        m.set(spec, [Math.max(prev?.[0] ?? 0, c.t), prev && RANK[prev[1]] <= RANK[via] ? prev[1] : via]);
        files.set(f, m);
      }
    }
  });
  // Served specs: those with commits, and open plans (their named files mark the explorer).
  const keep = specs.map((s, i) => stats.has(i) || s.status === 'active' || s.status === 'pending');
  const newIndex = new Map<number, number>();
  const outSpecs: HistorySpec[] = [];
  specs.forEach((s, i) => {
    if (!keep[i]) return;
    newIndex.set(i, outSpecs.length);
    const st = stats.get(i);
    outSpecs.push({
      name: s.name,
      file: s.file,
      status: s.status,
      label: s.label,
      named: tree.size ? s.named.filter((f) => tree.has(f)) : s.named,
      commits: st?.n ?? 0,
      first: st ? new Date(st.first * 1000).toISOString() : undefined,
      last: st ? new Date(st.last * 1000).toISOString() : undefined,
    });
  });
  const outFiles: RepoHistory['files'] = {};
  for (const [f, m] of files) {
    outFiles[f] = [...m]
      .sort((a, b) => b[1][0] - a[1][0])
      .map(([spec, [t, via]]) => [newIndex.get(spec) as number, new Date(t * 1000).toISOString(), via]);
  }
  for (const [sha, xs] of Object.entries(commitSpecs)) commitSpecs[sha] = xs.map((x) => newIndex.get(x) as number);
  return {
    repo,
    head: idx.head,
    builtAt: new Date(nowMs).toISOString(),
    commits: idx.commits.length,
    truncated: idx.truncated,
    specs: outSpecs,
    files: outFiles,
    areas: areas(tree, new Set(Object.keys(outFiles))),
    commitSpecs,
  };
}

/** "src/agents/claude.ts" lives in area "src/agents"; a file at the top in ".". */
export function areaOf(rel: string): string {
  const parts = rel.split('/');
  parts.pop();
  return parts.slice(0, 2).join('/') || '.';
}

function areas(tree: Map<string, number>, changed: Set<string>): RepoHistory['areas'] {
  const by = new Map<string, [string, number][]>();
  for (const [f, size] of tree) {
    const a = areaOf(f);
    const list = by.get(a) ?? [];
    list.push([f, size]);
    by.set(a, list);
  }
  const out: RepoHistory['areas'] = [];
  for (const [name, list] of by) {
    if (!list.some(([f]) => changed.has(f))) continue;
    // The changed files always make the cut; the rest fill up to the cap.
    const hot = list.filter(([f]) => changed.has(f));
    const cold = list.filter(([f]) => !changed.has(f));
    const shown = [...hot, ...cold.slice(0, Math.max(0, MAX_AREA_FILES - hot.length))].sort((a, b) => a[0].localeCompare(b[0]));
    out.push({ name, files: shown, more: list.length - shown.length });
  }
  // Busiest folders first: the ones most plans went through.
  return out.sort((a, b) => b.files.filter(([f]) => changed.has(f)).length - a.files.filter(([f]) => changed.has(f)).length || a.name.localeCompare(b.name));
}

// ---------- the index: git, cache, incremental ----------

const mem = new Map<string, { idx: Index | null; tree: Map<string, number>; checkedAt: number }>();
const inflight = new Map<string, Promise<{ idx: Index | null; tree: Map<string, number> }>>();

function cacheFile(cacheDir: string, repo: string): string {
  return path.join(cacheDir, 'history', crypto.createHash('sha1').update(repo).digest('hex').slice(0, 16) + '.json');
}

function loadCache(file: string, repo: string): Index | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Index;
    return j && j.v === INDEX_VERSION && j.repo === repo && typeof j.head === 'string' && Array.isArray(j.commits) ? j : null;
  } catch {
    return null; // missing or corrupt: rebuilt and rewritten
  }
}

function saveCache(file: string, idx: Index): void {
  // Monty's own cache folder (Config.cacheDir), never a repo or ~/.claude (invariant 3).
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx));
    fs.renameSync(tmp, file);
  } catch {
    /* a read-only or full disk only costs a rebuild next start */
  }
}

/** The repo's top folder, or null when it is not a git repo (or git is missing). */
export async function gitTop(dir: string, opts: GitOptions = {}): Promise<string | null> {
  const out = await git(dir, ['rev-parse', '--show-toplevel'], opts);
  return out ? path.resolve(out.trim()) : null;
}

async function logCommits(repo: string, range: string[], opts: GitOptions): Promise<Commit[] | null> {
  const out = await git(repo, ['log', LOG_FORMAT, '--name-only', '--no-color', `-n${MAX_COMMITS + 1}`, ...range, '--'], opts);
  return out === null ? null : parseLog(out);
}

async function refresh(repo: string, cacheDir: string, opts: GitOptions): Promise<{ idx: Index | null; tree: Map<string, number> }> {
  const prev = mem.get(repo);
  const head = (await git(repo, ['rev-parse', '--verify', '-q', 'HEAD'], opts))?.trim();
  if (!head) return { idx: null, tree: new Map() }; // not a repo, no commits yet, or no git
  if (prev?.idx?.head === head) return prev;
  const file = cacheFile(cacheDir, repo);
  let idx = prev?.idx ?? loadCache(file, repo);
  if (idx && idx.head !== head) {
    // Fast-forward: only the new commits. Anything else (rebase, reset, checkout of
    // another branch) reads the whole log again.
    const ff = (await git(repo, ['merge-base', '--is-ancestor', idx.head, head], opts)) !== null;
    const fresh = ff ? await logCommits(repo, [`${idx.head}..${head}`], opts) : null;
    if (fresh) {
      const commits = [...fresh, ...idx.commits];
      idx = { ...idx, head, truncated: idx.truncated || commits.length > MAX_COMMITS, commits: commits.slice(0, MAX_COMMITS) };
      saveCache(file, idx);
    } else idx = null;
  }
  if (!idx) {
    const all = await logCommits(repo, [head], opts);
    if (!all) return { idx: null, tree: new Map() };
    idx = { v: INDEX_VERSION, repo, head, truncated: all.length > MAX_COMMITS, commits: all.slice(0, MAX_COMMITS) };
    saveCache(file, idx);
  }
  return { idx, tree: await readTree(repo, head, opts) };
}

/** Files in the commit with their sizes (`git ls-tree -r -l`), for the repo view's boxes. */
async function readTree(repo: string, head: string, opts: GitOptions): Promise<Map<string, number>> {
  const out = await git(repo, ['ls-tree', '-r', '-l', '--full-tree', head], opts);
  const tree = new Map<string, number>();
  for (const line of (out ?? '').split('\n')) {
    // "<mode> blob <sha> <size>\t<path>"
    const m = /^\d+ blob [0-9a-f]+\s+(\d+|-)\t(.+)$/.exec(line);
    if (m) tree.set(m[2] as string, Number(m[1]) || 0);
  }
  return tree;
}

/** The cached index for a repo, refreshed from git at most every REFRESH_MS. */
export async function readIndex(repo: string, cacheDir: string, opts: GitOptions = {}, nowMs = Date.now()): Promise<{ idx: Index | null; tree: Map<string, number> }> {
  const m = mem.get(repo);
  if (m && nowMs - m.checkedAt < REFRESH_MS) return m;
  let p = inflight.get(repo);
  if (!p) {
    p = refresh(repo, cacheDir, opts)
      .catch(() => ({ idx: null, tree: new Map<string, number>() }))
      .then((r) => {
        mem.set(repo, { ...r, checkedAt: Date.now() });
        inflight.delete(repo);
        return r;
      });
    inflight.set(repo, p);
  }
  return p;
}

/** Forget in-memory indexes (tests). */
export function resetHistoryMemory(): void {
  mem.clear();
  inflight.clear();
}

// ---------- specs on disk ----------

const PLAN_DIRS = [['.caddis', 'projects'], ['.claude', 'projects']];

/** Every plan the repo has now: the store's projects, plus plans past its completed cap (src/projects.ts keeps 15). */
export function specsOnDisk(repo: string, projects: Project[], nowMs = Date.now()): SpecInput[] {
  const out = new Map<string, SpecInput>();
  const add = (p: Pick<Project, 'file' | 'name' | 'status' | 'label'>) => {
    const key = specOfPath(path.relative(repo, p.file).split(path.sep).join('/'));
    if (!key || out.has(key)) return;
    let text = '';
    let st: fs.Stats | undefined;
    try {
      text = fs.readFileSync(p.file, 'utf8');
      st = fs.statSync(p.file);
    } catch {
      /* gone since the scan */
    }
    const open = p.status === 'active' || p.status === 'pending';
    out.set(key, {
      key,
      name: p.name,
      file: p.file,
      status: p.status,
      label: p.label,
      named: namedFiles(text),
      dated: st ? datedWindow(text, st.birthtimeMs, st.mtimeMs, open, nowMs) : undefined,
    });
  };
  for (const p of projects) add(p);
  for (const dir of PLAN_DIRS) {
    const base = path.join(repo, ...dir);
    let buckets: fs.Dirent[] = [];
    try {
      buckets = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const b of buckets) {
      if (!b.isDirectory() || !BUCKET.test(b.name)) continue;
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(base, b.name)).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(base, b.name, f);
        if (out.has(specOfPath([...dir, b.name, f].join('/')) ?? '')) continue;
        try {
          const p = parseClaudeProject(fs.readFileSync(file, 'utf8'), { file, repo: path.basename(repo), repoPath: repo, bucket: b.name.toLowerCase() as ProjectStatus });
          add(p);
        } catch {
          /* unreadable plan: skipped */
        }
      }
    }
  }
  return [...out.values()];
}

/** Nothing to show: the view hides. */
export function emptyHistory(repo: string, nowMs = Date.now()): RepoHistory {
  return { repo, builtAt: new Date(nowMs).toISOString(), commits: 0, truncated: false, specs: [], files: {}, areas: [], commitSpecs: {} };
}

/** GET /api/history: the whole answer for one repo. Never throws. */
export async function historyFor(dir: string, projects: Project[], cacheDir: string, opts: GitOptions = {}, nowMs = Date.now()): Promise<RepoHistory> {
  const empty = emptyHistory(dir, nowMs);
  try {
    const repo = (await gitTop(dir, opts)) ?? null;
    if (!repo) return empty;
    const { idx, tree } = await readIndex(repo, cacheDir, opts, nowMs);
    if (!idx) return { ...empty, repo };
    const mine = projects.filter((p) => p.file.startsWith(repo + path.sep));
    return summarise(repo, idx, specsOnDisk(repo, mine, nowMs), tree, nowMs);
  } catch {
    return empty;
  }
}

function prettyName(slug: string): string {
  const s = slug.replace(/^project-/, '').replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
