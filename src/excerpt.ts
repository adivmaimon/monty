// A few lines of a source file, for the reader's hover previews (`src/auth/session.ts:41`).
// This is the only route that reads files other than markdown, so it is deliberately narrow:
// a regular file under a project root or known repo (after resolving symlinks), not a secrets
// or key file, not binary, not huge, and a small window of lines. Everything else is refused
// with a short reason the popover can show. Read-only: nothing here writes.
//
// With Caddis, `.caddis/map/graph.json` in the file's repo also says who imports it.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ExcerptLine { n: number; text: string }

export interface Excerpt {
  status: 'ok' | 'missing' | 'past-end' | 'refused';
  file: string;
  /** first line shown (1-based) */
  start: number;
  lines: ExcerptLine[];
  /** lines in the file, when it was read */
  total: number;
  reason?: string;
  /** Repo-relative files that import this one, from a Caddis map. Absent without one. */
  importedBy?: string[];
}

// About eight lines is what the mock shows: enough to see a definition, small enough to glance at.
export const WINDOW = 8;
// Callers may ask for a little more, never a whole file.
const MAX_WINDOW = 12;
// Source files past 2 MB are generated or bundled; reading them for a glance isn't worth it.
const MAX_BYTES = 2 * 1024 * 1024;
// Minified lines would fill the popover with one line; the start of it is enough.
const MAX_LINE = 400;
// The same sniff git uses: a NUL byte early on means binary.
const SNIFF_BYTES = 8000;
const IMPORTED_BY_MAX = 4;

// Secrets live in these. A preview never shows them, even inside a repo.
const SECRET_NAME = /^(\.env.*|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.htpasswd|credentials.*|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|p12|pfx|keystore|jks|crt|cer|der|gpg|asc|ovpn|kdbx))$/i;
const SECRET_DIR = new Set(['.git', '.ssh', '.aws', '.gnupg', '.docker', '.kube', 'secrets']);

function under(file: string, root: string): boolean {
  return file.startsWith(root + path.sep);
}

function real(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Why a path may not be previewed, or null when its name is fine. Only the part below
 * `root` is checked, so a repo that happens to sit in a folder called "secrets" still works.
 */
export function sensitive(file: string, root = ''): string | null {
  const rel = root && under(file, root) ? file.slice(root.length + 1) : file;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (SECRET_NAME.test(parts[parts.length - 1] ?? '')) return 'secrets and keys are not previewed';
  const dirs = parts.slice(0, -1).map((p) => p.toLowerCase());
  if (dirs.some((p) => SECRET_DIR.has(p))) return 'that folder is not previewed';
  // Agent session logs hold prompts, code and secrets; a home folder registered as a repo
  // must not turn this route into a way to read them. Old-style plans there are markdown.
  for (let i = 0; i < dirs.length - 1; i++) {
    if (dirs[i] === '.claude' && dirs[i + 1] === 'projects' && !/\.mdc?$/i.test(rel)) return 'session logs are not previewed';
    if (dirs[i] === '.codex' && dirs[i + 1] === 'sessions') return 'session logs are not previewed';
  }
  return null;
}

/** The deepest root containing `file`, or undefined. */
function rootOf(file: string, roots: string[]): string | undefined {
  return roots.filter((r) => under(file, r)).sort((a, b) => b.length - a.length)[0];
}

/** realpath of the nearest part of `p` that exists: a missing file behind a symlinked folder resolves through it. */
function realNearest(p: string): string | null {
  for (let dir = p; ; dir = path.dirname(dir)) {
    const r = real(dir);
    if (r) return dir === p ? r : path.join(r, path.relative(dir, p));
    // A dangling symlink could point anywhere: treat it as outside, not as missing.
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) return null;
    } catch {
      /* does not exist: try the folder above */
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Lines of `file` from `line` (1-based; missing or 0 means the top), under one of `roots`.
 * Never throws: every failure is a status with a reason.
 */
export function readExcerpt(file: string, line: number | undefined, roots: string[], size = WINDOW): Excerpt {
  const abs = path.resolve(file || '/');
  const out: Excerpt = { status: 'refused', file: abs, start: 0, lines: [], total: 0 };
  const lexRoots = roots.filter(Boolean).map((r) => path.resolve(r));
  // Invariant: refuse anything outside a known root before touching the disk, so this
  // route cannot be used to find out what exists elsewhere.
  if (!lexRoots.some((r) => under(abs, r))) return { ...out, reason: 'outside the project' };
  const bad = sensitive(abs, rootOf(abs, lexRoots));
  if (bad) return { ...out, reason: bad };
  // Invariant: a symlink inside the repo pointing outside it is outside, whether it is the
  // file or a folder above it, and whether or not the target exists: otherwise "missing"
  // vs "refused" would tell what exists elsewhere. Roots are resolved too (macOS /tmp is
  // /private/tmp), and the real target's own name is checked again.
  const realRoots = lexRoots.map(real).filter((r): r is string => !!r);
  const resolved = realNearest(abs);
  const realRoot = resolved ? rootOf(resolved, realRoots) : undefined;
  if (!resolved || !realRoot) return { ...out, reason: 'outside the project' };
  const bad2 = sensitive(resolved, realRoot);
  if (bad2) return { ...out, reason: bad2 };
  const target = real(abs);
  if (!target) return { ...out, status: 'missing', reason: 'not found' };
  let st: fs.Stats;
  try {
    st = fs.statSync(target);
  } catch {
    return { ...out, status: 'missing', reason: 'not found' };
  }
  if (!st.isFile()) return { ...out, reason: 'not a file' };
  if (st.size > MAX_BYTES) return { ...out, reason: 'too large to preview' };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(target);
  } catch {
    return { ...out, status: 'missing', reason: 'could not be read' };
  }
  if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { ...out, reason: 'binary file' };
  const all = buf.toString('utf8').replace(/\r\n?/g, '\n').split('\n');
  // A trailing newline is not a line of its own.
  if (all.length > 1 && all[all.length - 1] === '') all.pop();
  const total = all.length;
  const n = Math.min(Math.max(1, Math.floor(size) || WINDOW), MAX_WINDOW);
  const start = line && Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;
  const importedBy = importers(target, realRoots);
  const base = { file: abs, total, ...(importedBy ? { importedBy } : {}) };
  if (start > total) return { ...base, status: 'past-end', start, lines: [], reason: `line ${start} is past the end (${total} lines)` };
  const lines = all.slice(start - 1, start - 1 + n).map((text, i) => ({ n: start + i, text: text.length > MAX_LINE ? text.slice(0, MAX_LINE) + '…' : text }));
  return { ...base, status: 'ok', start, lines };
}

// ---------- Caddis map ----------

interface Graph { files?: Record<string, { imports?: unknown }> }
// One parse per graph file until it changes; repos are few and the map is rewritten rarely.
const graphs = new Map<string, { mtimeMs: number; importers: Map<string, string[]> }>();

function loadGraph(file: string): Map<string, string[]> | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = graphs.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.importers;
  const importers = new Map<string, string[]>();
  try {
    const g = JSON.parse(fs.readFileSync(file, 'utf8')) as Graph;
    for (const [from, info] of Object.entries(g.files ?? {})) {
      if (!Array.isArray(info?.imports)) continue;
      for (const to of info.imports) {
        if (typeof to !== 'string') continue;
        const list = importers.get(to) ?? [];
        list.push(from);
        importers.set(to, list);
      }
    }
  } catch {
    // A map in a shape we don't know shows nothing extra.
    return null;
  }
  graphs.set(file, { mtimeMs: st.mtimeMs, importers });
  return importers;
}

/** Who imports `target`, from the nearest `.caddis/map/graph.json` between it and its root. */
function importers(target: string, roots: string[]): string[] | undefined {
  const root = rootOf(target, roots);
  if (!root) return undefined;
  for (let dir = path.dirname(target); dir === root || under(dir, root); dir = path.dirname(dir)) {
    const map = loadGraph(path.join(dir, '.caddis', 'map', 'graph.json'));
    if (map) {
      const rel = path.relative(dir, target).split(path.sep).join('/');
      const list = map.get(rel);
      return list && list.length ? list.slice(0, IMPORTED_BY_MAX) : undefined;
    }
    if (dir === root) break;
  }
  return undefined;
}
