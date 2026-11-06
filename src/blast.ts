// Blast radius of a spec: what else the files it edits reach, through the import graph.
//
// Reads Caddis's map, `.caddis/map/graph.json`, and nothing else from Caddis. `reach()` and
// `matchFile()` are ports of `reach()` and `match()` in Caddis's map.py (skills/map/scripts),
// with the same output keys as `map.py reach --json`, so Monty and /caddis:review agree.
// Monty never runs map.py (zero runtime dependencies, no child processes): it uses the graph
// as found, and says which commit it was built at.
//
// Without a graph, or with one it cannot read, nothing here produces anything, and the
// view and its entry point stay hidden.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BlastRadius, Project } from './types.js';

export interface GraphNode {
  area: string;
  imports: string[];
}
export interface Graph {
  commit?: string;
  files: Record<string, GraphNode>;
}

/** map.py's TEST_PATH, verbatim: what counts as a test file. */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?)\/|[._-](test|spec)\.[a-z]+$|^test_|\/test_/i;

/** Extensions map.py maps (its LANG table): a path with one of these is source, so may be a new file. */
const SOURCE_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro|py|go|rs|php|rb|java|kt|kts|scala|swift|cs|dart|c|h|cc|cpp|cxx|hpp|hh|m|mm|css|scss|sass|less)$/i;

// Same rule as map.py's hubs (and summary.md's): the 20 most imported files, at least 3 importers each.
const HUB_TOP = 20;
const HUB_FLOOR = 3;

// The state is sent to every surface every few seconds; a spec that edits a hub can have
// hundreds of importers. The view shows a handful and groups the rest by area, so the
// lists are capped and their totals sent beside them.
const MAX_IMPORTERS = 60;
const MAX_UNTESTED = 30;
// A plan file is a few KB; this only stops a stray huge markdown file being scanned every 10s.
const MAX_DOC_BYTES = 256 * 1024;

// ---------- the graph ----------

/** A graph.json, checked node by node: bad nodes are skipped, a bad file gives null. */
export function parseGraph(raw: string): Graph | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const filesIn = (data as { files?: unknown }).files;
  if (!filesIn || typeof filesIn !== 'object' || Array.isArray(filesIn)) return null;
  const files: Record<string, GraphNode> = {};
  for (const [f, n] of Object.entries(filesIn as Record<string, unknown>)) {
    if (!n || typeof n !== 'object') continue;
    const { area, imports } = n as { area?: unknown; imports?: unknown };
    files[f] = {
      area: typeof area === 'string' ? area : '(root)',
      imports: Array.isArray(imports) ? imports.filter((i): i is string => typeof i === 'string') : [],
    };
  }
  if (!Object.keys(files).length) return null;
  const commit = (data as { commit?: unknown }).commit;
  return { commit: typeof commit === 'string' ? commit : undefined, files };
}

interface Index {
  rev: Map<string, Set<string>>;
  hubTop: string[];
  tested: Set<string>;
}

/** What reach() needs that depends only on the graph, so a cached graph computes it once. */
export function indexGraph(g: Graph): Index {
  const rev = new Map<string, Set<string>>();
  for (const [f, n] of Object.entries(g.files)) {
    for (const i of n.imports) {
      let s = rev.get(i);
      if (!s) rev.set(i, (s = new Set()));
      s.add(f);
    }
  }
  const size = (f: string) => rev.get(f)?.size ?? 0;
  const hubTop = [...rev.keys()]
    .sort((a, b) => size(b) - size(a) || cmp(a, b))
    .slice(0, HUB_TOP)
    .filter((f) => size(f) >= HUB_FLOOR);
  const tests = Object.keys(g.files).filter((f) => TEST_PATH.test(f));
  const fwd = new Map(Object.entries(g.files).map(([f, n]) => [f, new Set(n.imports)]));
  const tested = new Set([...closure(tests, fwd), ...tests]);
  return { rev, hubTop, tested };
}

const graphs = new Map<string, { stamp: string; graph: Graph | null; index: Index | null }>();

/** The repo's map, cached by mtime and size. Null when there is none or it cannot be read. */
export function loadGraph(repoPath: string): { graph: Graph; index: Index; stamp: string } | null {
  const file = path.join(repoPath, '.caddis', 'map', 'graph.json');
  let stamp: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    graphs.delete(repoPath);
    return null;
  }
  let hit = graphs.get(repoPath);
  if (!hit || hit.stamp !== stamp) {
    let graph: Graph | null = null;
    try {
      graph = parseGraph(fs.readFileSync(file, 'utf8'));
    } catch {
      graph = null;
    }
    hit = { stamp, graph, index: graph ? indexGraph(graph) : null };
    graphs.set(repoPath, hit);
  }
  return hit.graph && hit.index ? { graph: hit.graph, index: hit.index, stamp } : null;
}

// ---------- map.py's reach, ported ----------

/** Python's default string order (code points), which map.py sorts by. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normPath(p: string): string {
  const n = path.posix.normalize(p.replace(/\\/g, '/'));
  return n === '.' ? '' : n.replace(/\/+$/, '');
}

/** map.py's match(): the one file a path names (exact, then by suffix), or why not. */
export function matchFile(g: Graph, p: string): { file?: string; why?: string } {
  const q = normPath(p);
  if (Object.hasOwn(g.files, q)) return { file: q };
  const all = Object.keys(g.files);
  let hits = all.filter((f) => f.endsWith('/' + q));
  if (!hits.length) hits = all.filter((f) => f.endsWith(q));
  if (hits.length === 1) return { file: hits[0] };
  return { why: `'${q}' ${hits.length ? `matches ${hits.length} files: ${hits.slice(0, 8).join(', ')}` : 'is not in the map'}` };
}

/** Every node reachable from start along edges, start excluded. */
function closure(start: string[], edges: Map<string, Set<string>>): Set<string> {
  const seen = new Set<string>();
  const stack = [...start];
  while (stack.length) {
    for (const y of edges.get(stack.pop() as string) ?? []) {
      if (!seen.has(y)) {
        seen.add(y);
        stack.push(y);
      }
    }
  }
  for (const s of start) seen.delete(s);
  return seen;
}

export interface Reach {
  targets: string[];
  unknown: string[];
  direct: string[];
  hubs: { file: string; importers: number; target: boolean }[];
  reach: string[];
  by_area: { area: string; files: number; via_hubs: number }[];
  via_hubs: number;
  untested: string[];
}

/** Blast radius of changing paths, from graph edges only: `map.py reach --json`. */
export function reach(g: Graph, paths: string[], idx: Index = indexGraph(g)): Reach {
  const { rev } = idx;
  const targets: string[] = [];
  const unknown: string[] = [];
  for (const p of paths) {
    const { file, why } = matchFile(g, p);
    if (why) unknown.push(why);
    else if (file && !targets.includes(file)) targets.push(file);
  }
  const tset = new Set(targets);
  const direct = [...new Set(targets.flatMap((t) => [...(rev.get(t) ?? [])]))].filter((f) => !tset.has(f)).sort(cmp);
  const radius = closure(targets, rev);
  const hubs = idx.hubTop.filter((f) => radius.has(f) || tset.has(f));
  // A reach file goes through a hub when it imports one that is not a target (map.py's comment).
  const via = new Set([...closure(hubs.filter((h) => !tset.has(h)), rev)].filter((f) => radius.has(f)));
  const areas = new Map<string, number>();
  const viaAreas = new Map<string, number>();
  for (const f of radius) {
    const a = g.files[f]?.area ?? '(root)';
    areas.set(a, (areas.get(a) ?? 0) + 1);
    if (via.has(f)) viaAreas.set(a, (viaAreas.get(a) ?? 0) + 1);
  }
  return {
    targets: [...targets].sort(cmp),
    unknown,
    direct,
    hubs: hubs.map((f) => ({ file: f, importers: rev.get(f)?.size ?? 0, target: tset.has(f) })),
    reach: [...radius].sort(cmp),
    by_area: [...areas]
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .map(([area, files]) => ({ area, files, via_hubs: viaAreas.get(area) ?? 0 })),
    via_hubs: via.size,
    untested: direct.filter((f) => !idx.tested.has(f)),
  };
}

// ---------- files a spec edits ----------

const CHANGES_HEADING = /^(#{2,3})\s+(?:\d+\.\s*)?(changes|file changes|files changed|files to change)\b/i;

/** The spec's Changes section(s), or null when it has none. */
export function changesSection(text: string): string | null {
  const lines = text.split('\n');
  const out: string[] = [];
  let level = 0;
  for (const l of lines) {
    const h = /^(#{1,6})\s/.exec(l);
    if (level && h && (h[1] as string).length <= level) level = 0;
    const m = CHANGES_HEADING.exec(l);
    if (m) {
      level = (m[1] as string).length;
      continue;
    }
    if (level) out.push(l);
  }
  return level || out.length ? out.join('\n') : null;
}

/** `{a,b}.ts` -> a.ts, b.ts (one level, which is all plans write). */
function expandBraces(s: string): string[] {
  const m = /^(.*?)\{([^{}]+)\}(.*)$/.exec(s);
  if (!m) return [s];
  return (m[2] as string).split(',').flatMap((part) => expandBraces(`${m[1]}${part.trim()}${m[3]}`));
}

function cleanPath(raw: string): string | null {
  let s = raw.trim().replace(/^["'([]+|["')\]]+$/g, '');
  s = s.replace(/#L\d+.*$/, '').replace(/:\d+(?:[-,]\d+)*$/, '').replace(/[.,;:]+$/, '');
  s = s.replace(/^\.\//, '');
  if (!s || s.includes('://') || /[*<>$~\s]/.test(s) || s.startsWith('/') || s.split('/').includes('..')) return null;
  if (!/^[\w@.+\-/[\]()]+$/.test(s)) return null;
  if (!/\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(s)) return null;
  return s;
}

const BARE_PATH = /(?:^|[\s|(,])((?:[\w@.+-]+\/)+[\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?=$|[\s|),.;:])/g;

/**
 * File paths written in a spec, in order: backticked spans (braces expanded, one per
 * word) and bare paths with a folder in them. A bare name after a path on the same line
 * ("`src/agents/opencode.ts`, `codex.ts`") is taken to sit beside it.
 */
export function specPaths(text: string): string[] {
  return specRefs(text).map((r) => r.path);
}

/** specPaths, with the name as written when it was a bare name joined to the folder before it. */
function specRefs(text: string): { path: string; bare?: string }[] {
  const out: { path: string; bare?: string }[] = [];
  const seen = new Set<string>();
  const add = (p: string, bare?: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push({ path: p, bare });
    }
  };
  for (const line of text.split('\n')) {
    let dir = '';
    const spans = [...line.matchAll(/`([^`\n]+)`/g)].map((m) => ({ at: m.index ?? 0, text: m[1] as string }));
    const rest = line.replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));
    const bare = [...rest.matchAll(BARE_PATH)].map((m) => ({ at: m.index ?? 0, text: m[1] as string }));
    for (const c of [...spans, ...bare].sort((a, b) => a.at - b.at)) {
      for (const word of c.text.split(/\s+/)) {
        for (const x of expandBraces(word)) {
          const p = cleanPath(x);
          if (!p) continue;
          if (p.includes('/')) {
            dir = p.slice(0, p.lastIndexOf('/'));
            add(p);
          } else if (dir) add(`${dir}/${p}`, p);
          else add(p);
        }
      }
    }
  }
  return out;
}

// ---------- per spec ----------

function readDoc(file: string): string {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_DOC_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * matchFile without its last resort (any file whose name ends with the text): from prose,
 * `x.ts` would otherwise match `src/index.ts`. Only whole path segments count here.
 */
function matchWhole(g: Graph, p: string): string | undefined {
  const q = normPath(p);
  if (Object.hasOwn(g.files, q)) return q;
  const hits = Object.keys(g.files).filter((f) => f.endsWith('/' + q));
  return hits.length === 1 ? hits[0] : undefined;
}

/** The blast radius for one spec, or undefined when it edits nothing that something imports. */
export function blastFor(texts: string[], repoPath: string, g: Graph, idx: Index = indexGraph(g)): BlastRadius | undefined {
  const sections = texts.map(changesSection).filter((s): s is string => s !== null);
  const refs = specRefs((sections.length ? sections : texts).join('\n'));
  const found: string[] = [];
  const newFiles = new Set<string>();
  for (const { path: p, bare } of refs) {
    // A bare name joined to the folder before it may sit elsewhere; the name alone may still match.
    const hit = matchWhole(g, p) ?? (bare ? matchWhole(g, bare) : undefined);
    if (hit) found.push(hit);
    else if (!bare && p.includes('/') && SOURCE_EXT.test(p) && !fs.existsSync(path.join(repoPath, p))) newFiles.add(p);
  }
  if (!found.length) return undefined;
  const r = reach(g, found, idx);
  const edited = r.targets.filter((t) => (idx.rev.get(t)?.size ?? 0) > 0);
  if (!edited.length || !r.direct.length) return undefined;
  const hubSet = new Set(r.hubs.map((h) => h.file));
  const area = (f: string) => g.files[f]?.area ?? '(root)';
  const byArea = new Map<string, number>();
  for (const f of r.direct) byArea.set(area(f), (byArea.get(area(f)) ?? 0) + 1);
  return {
    mapCommit: g.commit,
    edited,
    unimported: r.targets.length - edited.length,
    newFiles: newFiles.size,
    importers: r.direct.slice(0, MAX_IMPORTERS).map((f) => ({ file: f, area: area(f), hub: hubSet.has(f) })),
    importersTotal: r.direct.length,
    importersByArea: [...byArea].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([a, files]) => ({ area: a, files })),
    hubs: r.hubs,
    reach: r.reach.length,
    viaHubs: r.via_hubs,
    byArea: r.by_area.map((a) => ({ area: a.area, files: a.files, viaHubs: a.via_hubs })),
    untested: r.untested.slice(0, MAX_UNTESTED),
    untestedTotal: r.untested.length,
  };
}

const OPEN: Project['status'][] = ['active', 'pending'];
const perSpec = new Map<string, { key: string; blast?: BlastRadius }>();

function docStamp(files: string[]): string {
  return files
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${f}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${f}:-`;
      }
    })
    .join('|');
}

/**
 * Adds `blast` to each open spec in one repo, when the repo has a Caddis map. A spec
 * that fails for any reason is left without one (degrade, don't crash).
 */
export function withBlast(projects: Project[], repoPath: string): Project[] {
  const map = loadGraph(repoPath);
  if (!map) return projects;
  return projects.map((p) => {
    if (!OPEN.includes(p.status)) return p;
    try {
      const files = [...new Set([p.file, ...(p.docs ?? [])])].slice(0, 12);
      const key = `${map.stamp}#${docStamp(files)}`;
      let hit = perSpec.get(p.file);
      if (!hit || hit.key !== key) {
        hit = { key, blast: blastFor(files.map(readDoc), repoPath, map.graph, map.index) };
        perSpec.set(p.file, hit);
      }
      return hit.blast ? { ...p, blast: hit.blast } : p;
    } catch {
      return p;
    }
  });
}
