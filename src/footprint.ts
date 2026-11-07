// A spec's footprint: which files its docs name, which files changed since it was written,
// and the repo drawn as areas so both can be placed. Served on demand by /api/footprint
// (never on the 1s/10s polls) and cached briefly.
//
// Reads: the spec's own markdown, the repo's file list (`git ls-files`, else a capped walk),
// read-only git history and status, `.caddis/map/graph.json` when present, and the edited
// files of live sessions working on the spec. Works on any repo; Caddis's map only makes
// the areas match the codebase map. Everything here is read-only and degrades to less.
//
// The area grouping and "changed since" parts are exported for other views (plan history).

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Project, Session } from './types.js';

export type FootprintState = 'changed' | 'planned' | 'outside';

export interface FootprintFile {
  /** Repo-relative, forward slashes. */
  path: string;
  state: FootprintState;
  /** Where the spec names it: "Phase 2", "Changes", "tasks.md". Empty for outside files. */
  where: string[];
  /** Exists in the repo now. A planned file that does not exist is still to be created. */
  exists: boolean;
  /** Created since the spec was (git add, or untracked). */
  added?: boolean;
  /** What says it changed. */
  via: ('git' | 'worktree' | 'session')[];
}

export interface FootprintArea {
  name: string;
  /** Every file in the area, marked or not. */
  total: number;
  /** Files the spec names or that changed, always shown. */
  marked: FootprintFile[];
  /** A sample of the other files, unlabelled cells. */
  plain: string[];
  /** Plain files not in the sample. */
  more: number;
}

export interface Footprint {
  file: string;
  name: string;
  /** "plan" for Caddis / .claude plans, "spec" for spec frameworks: the copy says which. */
  kind: 'plan' | 'spec';
  repoPath: string;
  /** Start of the change window, ISO. */
  since?: string;
  /** commit: the first commit adding a doc; file-created/-modified: the doc's own timestamps (untracked or ignored plans). */
  sinceBasis: 'commit' | 'file-created' | 'file-modified' | 'none';
  /** End of the window for finished specs; open specs run to now. */
  until?: string;
  git: boolean;
  areaBasis: 'caddis' | 'folders';
  /** Live sessions whose edits were counted. */
  sessions: number;
  counts: { named: number; namedChanged: number; outside: number };
  files: number;
  areas: FootprintArea[];
  generatedAt: string;
}

// ---------- names in the spec ----------

// The same shape web/md.js links in code spans (FILE_REF), lines suffix allowed.
const FILE_REF = /^\/?([\w@.\-()[\]~+]+\/)*[\w@.\-()[\]+]+\.[a-zA-Z0-9]{1,6}(:\d+([,-]\d+)*)?$/;
// Paths in prose need a slash; no brackets, so "(see src/x.ts)" stops at the path.
const BARE = /(?<![\w/.:@~-])(\/?(?:[\w@.+-]+\/)+[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,6})(?::\d+(?:[,-]\d+)*)?(?![\w/])/g;
const PHASE = /^phase\s+(\d+(?:\.\d+)?)/i;

/**
 * Paths written in a markdown doc, each with the phases or sections it appears under.
 * Code spans may be bare names (`state.ts`); prose paths need a slash. Fenced blocks are
 * skipped: commands and trees there name build output and examples, not the work.
 */
export function namedRefs(text: string, docName = ''): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (raw: string, where: string) => {
    const p = raw.replace(/:\d+([,-]\d+)*$/, '').replace(/^\.\//, '');
    if (!p || p.startsWith('~') || /(^|\/)\.\.\.(\/|$)/.test(p) || /^\d+(\.\d+)+$/.test(p)) return;
    if (!out.has(p)) out.set(p, new Set());
    if (where) out.get(p)!.add(where);
  };
  // A heading that names a phase holds until a heading at its level or above.
  let phase: { label: string; level: number } | null = null;
  let section = '';
  let fence = false;
  for (const line of text.split('\n')) {
    try {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        continue;
      }
      if (fence) continue;
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        const level = h[1]!.length;
        const title = h[2]!.replace(/[`*_]/g, '').trim();
        if (phase && level <= phase.level) phase = null;
        const ph = PHASE.exec(title);
        if (ph) phase = { label: `Phase ${ph[1]}`, level };
        if (level >= 2) section = title.replace(/\s+[-:]\s+.*$/, '').slice(0, 40);
        continue;
      }
      const where = phase?.label || section || docName;
      // Code spans first, then the prose around them (URLs removed so their paths do not count).
      let rest = line.replace(/``\s?(.+?)\s?``|`([^`]+)`/g, (_, dbl, one) => {
        const c = String(dbl ?? one).trim();
        if (FILE_REF.test(c)) add(c, where);
        return ' ';
      });
      rest = rest.replace(/\]\(([^)\s]+)\)/g, (_, u: string) => {
        if (!/^(https?:|#|mailto:|vscode:)/.test(u)) add(decodeURIComponent(u.split('#')[0] ?? ''), where);
        return '] ';
      });
      rest = rest.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ');
      for (const m of rest.matchAll(BARE)) add(m[1]!, where);
    } catch {
      /* one odd line never costs the rest */
    }
  }
  return out;
}

/**
 * Maps names from the spec to repo files: the exact path, else the one file ending in it
 * (`auth/session.ts` for src/auth/session.ts), else a bare name only one file has. A path
 * with a slash that matches nothing is kept as not created yet when its top folder exists
 * and no longer name already covers it; anything else (a bare name, an example path, a
 * path relative to somewhere else) is dropped rather than drawn as work to do.
 */
export function resolveNamed(refs: Map<string, Set<string>>, files: string[], opts: { repoPath?: string; docDir?: string } = {}): Map<string, { where: string[]; exists: boolean }> {
  const set = new Set(files);
  const bySuffix = (p: string) => files.filter((f) => f.endsWith('/' + p));
  const topDirs = new Set(files.filter((f) => f.includes('/')).map((f) => f.slice(0, f.indexOf('/'))));
  const allRefs = [...refs.keys()];
  const out = new Map<string, { where: string[]; exists: boolean }>();
  const put = (p: string, where: Set<string>, exists: boolean) => {
    const prev = out.get(p);
    out.set(p, { where: [...new Set([...(prev?.where ?? []), ...where])], exists });
  };
  for (const [raw, where] of refs) {
    let p = raw;
    if (opts.repoPath && p.startsWith(opts.repoPath + '/')) p = p.slice(opts.repoPath.length + 1);
    else if (p.startsWith('/')) p = p.slice(1); // Spec Kit writes repo paths as /specs/...
    if (set.has(p)) { put(p, where, true); continue; }
    // A link relative to the doc's folder.
    if (opts.docDir && opts.repoPath) {
      const rel = path.posix.normalize(path.posix.join(path.relative(opts.repoPath, opts.docDir).split(path.sep).join('/'), raw));
      if (set.has(rel)) { put(rel, where, true); continue; }
    }
    const hits = bySuffix(p);
    if (hits.length === 1) { put(hits[0]!, where, true); continue; }
    if (hits.length > 1 || !p.includes('/') || p.startsWith('..')) continue;
    if (!topDirs.has(p.slice(0, p.indexOf('/'))) || allRefs.some((r) => r !== raw && r.endsWith('/' + p))) continue;
    put(p, where, false);
  }
  return out;
}

// ---------- areas ----------

// Twelve boxes still read at a glance in a side-by-side layout; more turn into confetti.
const MAX_AREAS = 12;
// A folder holding over half the repo says little as one box ("src"): split it once.
const SPLIT_SHARE = 0.5;
// Below this a repo is small enough that one level of folders is the clearer picture.
const SPLIT_MIN_FILES = 60;
const TOP = 'top level';
const OTHER = 'other';

/**
 * Groups files into areas: the Caddis map's area for a file when there is one (else the
 * deepest map area containing it), otherwise its top-level folder, with a dominant folder
 * split one level down. At most MAX_AREAS, the smallest merged into "other".
 */
export function areasFor(files: string[], graph?: Map<string, string>): Map<string, string[]> {
  const top = (f: string) => (f.includes('/') ? f.slice(0, f.indexOf('/')) : TOP);
  let areaOf: (f: string) => string;
  if (graph && graph.size) {
    const names = [...new Set(graph.values())].sort((a, b) => b.length - a.length);
    areaOf = (f) => graph.get(f) ?? names.find((n) => f.startsWith(n + '/')) ?? top(f);
  } else areaOf = top;
  let groups = new Map<string, string[]>();
  for (const f of files) {
    const a = areaOf(f);
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a)!.push(f);
  }
  if (!graph?.size && files.length > SPLIT_MIN_FILES) {
    const next = new Map<string, string[]>();
    for (const [a, fs_] of groups) {
      const split = a !== TOP && fs_.length > files.length * SPLIT_SHARE && fs_.some((f) => f.split('/').length > 2);
      for (const f of fs_) {
        const parts = f.split('/');
        const k = split && parts.length > 2 ? `${a}/${parts[1]}` : a;
        if (!next.has(k)) next.set(k, []);
        next.get(k)!.push(f);
      }
    }
    groups = next;
  }
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (sorted.length <= MAX_AREAS) return new Map(sorted);
  const keep = sorted.slice(0, MAX_AREAS - 1);
  const rest = sorted.slice(MAX_AREAS - 1).flatMap(([, f]) => f);
  return new Map([...keep, [OTHER, rest]]);
}

// Unlabelled cells per area: enough to show the area's size and texture, few enough that
// a repo with thousands of files stays readable. The rest become "+N files".
export const PLAIN_CELLS = 48;

export interface FootprintInput {
  files: string[];
  named: Map<string, { where: string[]; exists: boolean }>;
  changed: Map<string, { added?: boolean; via: FootprintFile['via'] }>;
  /** The spec's own docs, repo-relative: never counted as work. */
  own: Set<string>;
  graph?: Map<string, string>;
}

/** Joins names and changes into areas. Pure, so the view's rules are testable. */
export function buildFootprint(input: FootprintInput): Pick<Footprint, 'areas' | 'counts' | 'files' | 'areaBasis'> {
  const marked = new Map<string, FootprintFile>();
  for (const [p, n] of input.named) {
    if (input.own.has(p)) continue;
    const c = input.changed.get(p);
    marked.set(p, { path: p, state: c ? 'changed' : 'planned', where: n.where, exists: n.exists || !!c, added: c?.added, via: c?.via ?? [] });
  }
  for (const [p, c] of input.changed) {
    if (input.own.has(p) || marked.has(p)) continue;
    marked.set(p, { path: p, state: 'outside', where: [], exists: true, added: c.added, via: c.via });
  }
  // Planned files not created yet still need a place to sit.
  const all = [...new Set([...input.files, ...marked.keys()])].filter((f) => !input.own.has(f));
  const groups = areasFor(all, input.graph);
  const ORDER: Record<FootprintState, number> = { changed: 0, planned: 1, outside: 2 };
  const areas: FootprintArea[] = [...groups].map(([name, files]) => {
    const m = files.filter((f) => marked.has(f)).map((f) => marked.get(f)!).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.path.localeCompare(b.path));
    const plain = files.filter((f) => !marked.has(f)).sort();
    return { name, total: files.length, marked: m, plain: plain.slice(0, PLAIN_CELLS), more: Math.max(0, plain.length - PLAIN_CELLS) };
  });
  const list = [...marked.values()];
  return {
    areas,
    files: all.length,
    areaBasis: input.graph?.size ? 'caddis' : 'folders',
    counts: { named: list.filter((f) => f.state !== 'outside').length, namedChanged: list.filter((f) => f.state === 'changed').length, outside: list.filter((f) => f.state === 'outside').length },
  };
}

// ---------- git (read-only) ----------

// Asked when someone opens the view: a slow or huge repo shows less rather than hanging the request.
const GIT_TIMEOUT_MS = 5000;
// ls-files on a large monorepo is a few MB; past this the call fails and the walk takes over.
const GIT_MAX_BYTES = 64 * 1024 * 1024;
// Plenty for one spec's lifetime; a window wider than this is noise anyway.
const MAX_COMMITS = 2000;

/** Runs a read-only git command; null when git is missing, the folder is not a repo, or it times out. */
export function git(repo: string, args: string[], opts: { input?: string; ok?: number[] } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let out = '';
    let size = 0;
    let child: ReturnType<typeof spawn>;
    try {
      // Read-only: GIT_OPTIONAL_LOCKS=0 keeps `git status` from refreshing (writing) the index.
      child = spawn('git', ['-C', repo, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, GIT_TIMEOUT_MS);
    child.on('error', () => finish(null));
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      size += d.length;
      if (size > GIT_MAX_BYTES) {
        child.kill();
        return finish(null);
      }
      out += d;
    });
    child.on('close', (code) => finish((opts.ok ?? [0]).includes(code ?? -1) ? out : null));
    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.input ?? '');
  });
}

/** The repo folder's path inside its git repo ("" at the top, "app/" for a subfolder), or null when not in git. */
async function gitPrefix(repo: string): Promise<string | null> {
  const out = await git(repo, ['rev-parse', '--show-prefix']);
  return out === null ? null : out.trim();
}

// Without git: folders that are build output, dependencies or tool state, never the work.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__', 'Pods', 'DerivedData']);
// A walk is the fallback for folders outside git; a cap keeps a stray home folder cheap.
const WALK_MAX = 20_000;

function walk(repo: string): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length && out.length < WALK_MAX) {
    const rel = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(path.join(repo, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

/** Every file in the repo, repo-relative: tracked and untracked-not-ignored from git, else a capped walk. */
export async function repoFiles(repo: string): Promise<{ files: string[]; git: boolean }> {
  const out = await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (out === null) return { files: walk(repo), git: false };
  return { files: [...new Set(out.split('\0').filter(Boolean))], git: true };
}

/**
 * Files changed in a window: commits (with --relative, so paths are under the repo folder)
 * and, for open work, the working tree (uncommitted and untracked). Empty without git.
 */
function modifiedBefore(file: string, since: string): boolean {
  try {
    return fs.statSync(file).mtimeMs < Date.parse(since);
  } catch {
    return false;
  }
}

export async function changedSince(repo: string, since: string | undefined, opts: { until?: string; worktree?: boolean } = {}): Promise<Map<string, { added?: boolean; via: FootprintFile['via'] }>> {
  const out = new Map<string, { added?: boolean; via: FootprintFile['via'] }>();
  const note = (p: string, via: 'git' | 'worktree', added: boolean) => {
    const prev = out.get(p) ?? { via: [] };
    if (!prev.via.includes(via)) prev.via.push(via);
    if (added) prev.added = true;
    out.set(p, prev);
  };
  const prefix = await gitPrefix(repo);
  if (prefix === null) return out;
  if (since) {
    const args = ['log', '--relative', '--no-renames', '--name-status', '--format=', `-n${MAX_COMMITS}`, `--since=${since}`];
    if (opts.until) args.push(`--until=${opts.until}`);
    const log = await git(repo, [...args, '--', '.']);
    for (const line of (log ?? '').split('\n')) {
      const m = /^([AMDTCRU])\d*\t(.+)$/.exec(line);
      if (m && m[1] !== 'D') note(m[2]!, 'git', m[1] === 'A');
    }
  }
  if (opts.worktree) {
    const st = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
    const parts = (st ?? '').split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]!;
      if (e.length < 4) continue;
      const xy = e.slice(0, 2);
      // Porcelain paths are from the top of the git repo; keep the ones under this folder.
      const full = e.slice(3);
      if (/[RC]/.test(xy)) i++; // the next entry is the old name
      if (xy.includes('D') || !full.startsWith(prefix)) continue;
      const rel = full.slice(prefix.length);
      // Uncommitted work last touched before the spec was written is not the spec's: an
      // untracked folder of notes that predates it, say. Unreadable files are kept.
      if (since && modifiedBefore(path.join(repo, rel), since)) continue;
      note(rel, 'worktree', xy === '??' || xy.includes('A'));
    }
  }
  return out;
}

/**
 * When the spec was created: the first commit adding any of its docs, else (untracked or
 * ignored, as Caddis plans usually are) the earliest birth time of its files, else modified time.
 */
export async function specCreated(repo: string, docs: string[]): Promise<{ at?: string; basis: Footprint['sinceBasis'] }> {
  const rel = docs.map((d) => path.relative(repo, d)).filter((d) => d && !d.startsWith('..'));
  if (rel.length) {
    const out = await git(repo, ['log', '--diff-filter=A', '--format=%cI', '--', ...rel]);
    const first = (out ?? '').trim().split('\n').filter(Boolean).pop();
    if (first) return { at: first, basis: 'commit' };
  }
  let born = Infinity;
  let mod = Infinity;
  for (const d of docs) {
    try {
      const st = fs.statSync(d);
      if (st.birthtimeMs > 0) born = Math.min(born, st.birthtimeMs);
      mod = Math.min(mod, st.mtimeMs);
    } catch {
      /* gone: skip */
    }
  }
  if (born < Infinity) return { at: new Date(born).toISOString(), basis: 'file-created' };
  if (mod < Infinity) return { at: new Date(mod).toISOString(), basis: 'file-modified' };
  return { basis: 'none' };
}

/** When a finished spec stopped: its docs' last commit, else their last modified time. */
async function specEnded(repo: string, docs: string[]): Promise<string | undefined> {
  const rel = docs.map((d) => path.relative(repo, d)).filter((d) => d && !d.startsWith('..'));
  const out = rel.length ? await git(repo, ['log', '-1', '--format=%cI', '--', ...rel]) : null;
  if (out && out.trim()) return out.trim();
  let last = 0;
  for (const d of docs) {
    try {
      last = Math.max(last, fs.statSync(d).mtimeMs);
    } catch {
      /* skip */
    }
  }
  return last ? new Date(last).toISOString() : undefined;
}

/** Caddis map areas (`.caddis/map/graph.json` files[path].area), when the repo has a map. */
export function caddisAreas(repo: string): Map<string, string> | undefined {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(repo, '.caddis', 'map', 'graph.json'), 'utf8')) as { files?: Record<string, { area?: unknown }> };
    const m = new Map<string, string>();
    for (const [f, v] of Object.entries(g.files ?? {})) if (v && typeof v.area === 'string' && v.area) m.set(f, v.area);
    return m.size ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Files edited by live sessions working on this spec: its matched plan, or it read or edited one of the spec's docs. */
export function sessionChanges(project: Project, sessions: Session[]): { files: Map<string, { via: FootprintFile['via'] }>; count: number } {
  const docs = new Set([project.file, ...(project.docs ?? [])]);
  const files = new Map<string, { via: FootprintFile['via'] }>();
  let count = 0;
  for (const s of sessions) {
    try {
      if (!s.cwd || (s.repoPath && s.repoPath !== project.repoPath)) continue;
      if (!s.repoPath && !(s.cwd === project.repoPath || s.cwd.startsWith(project.repoPath + path.sep))) continue;
      const near = (s.plan && docs.has(s.plan.file)) || (s.recentDocs ?? []).some((d) => docs.has(d)) || s.touched.some((t) => docs.has(path.resolve(s.cwd, t.path)));
      if (!near) continue;
      count++;
      for (const t of s.touched) {
        if (!t.edits) continue;
        const rel = path.relative(project.repoPath, path.resolve(s.cwd, t.path));
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        files.set(rel.split(path.sep).join('/'), { via: ['session'] });
      }
    } catch {
      /* a session of an unexpected shape adds nothing */
    }
  }
  return { files, count };
}

// ---------- the whole thing ----------

const OPEN: Project['status'][] = ['active', 'pending', 'parked'];

/** Reads and joins everything for one spec. Never throws: each source degrades to empty. */
export async function computeFootprint(project: Project, sessions: Session[]): Promise<Footprint> {
  const repo = project.repoPath;
  const docs = [...new Set([project.file, ...(project.docs ?? [])])];
  const own = new Set(docs.map((d) => path.relative(repo, d).split(path.sep).join('/')));
  const { files, git: inGit } = await repoFiles(repo);
  const refs = new Map<string, Set<string>>();
  for (const d of docs) {
    let text = '';
    try {
      text = fs.readFileSync(d, 'utf8');
    } catch {
      continue;
    }
    const named = resolveNamed(namedRefs(text, path.basename(d)), files, { repoPath: repo, docDir: path.dirname(d) });
    for (const [p, n] of named) {
      if (!refs.has(p)) refs.set(p, new Set());
      n.where.forEach((w) => refs.get(p)!.add(w));
      if (n.exists) refs.get(p)!.add('\u0000exists');
    }
  }
  let named = new Map([...refs].map(([p, w]) => [p, { where: [...w].filter((x) => x !== '\u0000exists'), exists: w.has('\u0000exists') }] as const));
  // A plan with a Changes section lists its work there and under its phases; paths only in
  // other sections (context, briefs it cites, reference files) are reading, not work, and
  // would inflate "planned files".
  const listed = [...named].filter(([, n]) => n.where.some((w) => /^(changes|phase \d+)$/i.test(w)));
  if (listed.some(([, n]) => n.where.some((w) => /^changes$/i.test(w)))) named = new Map(listed);
  // A named path git ignores (build output, a log) is not work still to do.
  const missing = [...named].filter(([, n]) => !n.exists).map(([p]) => p);
  if (inGit && missing.length) {
    const ignored = await git(repo, ['check-ignore', '--stdin'], { input: missing.join('\n') + '\n', ok: [0, 1] });
    if (ignored === null) named = new Map([...named].filter(([, n]) => n.exists));
    else for (const p of ignored.split('\n').filter(Boolean)) named.delete(p);
  } else if (!inGit) {
    named = new Map([...named].filter(([p, n]) => n.exists || !p.split('/').some((seg) => SKIP_DIRS.has(seg) || seg.startsWith('.'))));
  }
  const open = OPEN.includes(project.status);
  const created = await specCreated(repo, docs);
  const until = open ? undefined : await specEnded(repo, docs);
  const changed = inGit ? await changedSince(repo, created.at, { until, worktree: open }) : new Map<string, { added?: boolean; via: FootprintFile['via'] }>();
  const live = open ? sessionChanges(project, sessions) : { files: new Map<string, { via: FootprintFile['via'] }>(), count: 0 };
  for (const [p, v] of live.files) {
    const prev = changed.get(p);
    if (prev) prev.via.push('session');
    else changed.set(p, { via: v.via, added: !files.includes(p) || undefined });
  }
  const graph = caddisAreas(repo);
  const built = buildFootprint({ files, named, changed, own, graph });
  return {
    file: project.file,
    name: project.name,
    kind: project.source === 'caddis' || project.source === 'claude-projects' ? 'plan' : 'spec',
    repoPath: repo,
    since: created.at,
    sinceBasis: created.basis,
    until,
    git: inGit,
    sessions: live.count,
    generatedAt: new Date().toISOString(),
    ...built,
  };
}

// The view refreshes while open; plans change on agent time (minutes), so a few seconds of
// staleness is invisible and keeps git from running on every re-render.
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: Promise<Footprint> }>();

/** computeFootprint, cached per spec for CACHE_MS, one computation in flight per spec. */
export function footprint(project: Project, sessions: Session[], nowMs = Date.now()): Promise<Footprint> {
  for (const [k, v] of cache) if (nowMs - v.at > CACHE_MS) cache.delete(k);
  const hit = cache.get(project.file);
  if (hit) return hit.value;
  const value = computeFootprint(project, sessions);
  cache.set(project.file, { at: nowMs, value });
  value.catch(() => cache.delete(project.file));
  return value;
}

/** The project a doc belongs to (its main file or one of its docs), so the route serves known specs only. */
export function projectForDoc(projects: Project[], file: string): Project | undefined {
  const f = path.resolve(file);
  return projects.find((p) => p.file === f) ?? projects.find((p) => p.docs?.includes(f));
}
