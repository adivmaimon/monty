// What the reader's Brief and Full modes need beyond the Project every surface gets:
// the Risk level, open questions with their defaults, per-phase detail (DONE date, gate,
// checklist items), the files a spec names, and which of those changed since the spec was
// written. Served by /api/reader for one plan at a time, on demand.
//
// Works on any spec: headings, checkboxes and paths written in the text. Caddis plans give
// more (a Risk section, Open Questions with defaults, gates, `Caddis-Plan:` commit trailers)
// and the result is more exact, never required.
//
// Read-only: git runs as `git log` / `git status` with a timeout and an output cap. No git,
// not a repo, or a slow repo just leaves the git facts out (CLAUDE.md: degrade, don't crash).

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Project, Session } from './types.js';

export interface ReaderQuestion {
  index: number;
  /** The question itself, up to its question mark when it has one. */
  text: string;
  /** The rest of the first line: context the plan gives with the question. */
  detail?: string;
  /** The recommended answer the plan gives, offered as a one-click answer. */
  default?: string;
  answer?: { text: string; line: string; undoable: boolean };
  /** Where the item sits in the file, 0-based lines, end exclusive (trailing blanks excluded). */
  start: number;
  end: number;
  form: 'bullet' | 'heading' | 'para';
  /** Column the bullet's text starts at, so a decision nests under it. */
  indent: number;
}

export interface ReaderPhase {
  n: number;
  title: string;
  /** From a "DONE (YYYY-MM-DD)" marker. */
  date?: string;
  gate?: string;
  items: { text: string; done: boolean }[];
}

export interface ReaderFile {
  path: string; // repo-relative
  /** The spec names it; otherwise it was changed for the spec without being named. */
  named: boolean;
  exists: boolean;
  changed: boolean;
  isNew?: boolean;
  via: ('git' | 'uncommitted' | 'session' | 'trailer')[];
}

export interface ReaderCommit { hash: string; date: string; subject: string }

export interface ReaderData {
  file: string;
  risk?: { level: string };
  questions: ReaderQuestion[];
  /** The doc the questions are in (a spec folder's design.md, say), absolute. */
  questionsFile?: string;
  phases: (ReaderPhase & { commit?: ReaderCommit })[];
  files: ReaderFile[];
  tests: { path: string; exists: boolean }[];
  /** When the spec was written: the window "changed" is measured over. */
  since?: string;
  /** Whether git answered; without it, "changed" is only what Monty's sessions saw. */
  git: boolean;
}

// ---------- parsing ----------

const HEADING = /^(#{1,6})\s+(.*)$/;

/** The raw lines of the first section whose heading matches, without the heading; [start, end) in `lines`. */
export function sectionRange(lines: string[], name: RegExp): { start: number; end: number; level: number } | null {
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (/^\s*```/.test(l)) fence = !fence;
    if (fence) continue;
    const h = HEADING.exec(l.trim());
    if (!h || (h[1] as string).length < 2 || !name.test((h[2] as string).replace(/[*_`]/g, '').trim())) continue;
    const level = (h[1] as string).length;
    let end = lines.length;
    let f2 = false;
    for (let j = i + 1; j < lines.length; j++) {
      const lj = lines[j] as string;
      if (/^\s*```/.test(lj)) f2 = !f2;
      if (f2) continue;
      const hj = HEADING.exec(lj.trim());
      if (hj && (hj[1] as string).length <= level) {
        end = j;
        break;
      }
    }
    return { start: i + 1, end, level };
  }
  return null;
}

export function sectionText(text: string, name: RegExp): string | undefined {
  const lines = text.split('\n');
  const r = sectionRange(lines, name);
  return r ? lines.slice(r.start, r.end).join('\n') : undefined;
}

/** "**Medium.** A new route..." -> medium. Only a stated level counts; the template's "Low / Medium / High" line does not. */
export function riskLevel(text: string): string | undefined {
  const body = sectionText(text, /^risks?$/i);
  if (!body) return undefined;
  const first = body.split('\n').map((l) => l.trim()).find((l) => l && !/^#/.test(l));
  if (!first) return undefined;
  const t = first.replace(/^[-*>]\s+/, '').replace(/[*_`]/g, '').trim();
  const m = /^(?:risk(?:\s+level)?\s*[:-]?\s*)?(low|medium|high|critical)(?:\s*(?:-|to|\/)\s*(low|medium|high|critical))?\b(?!\s*\/)/i.exec(t);
  if (!m) return undefined;
  return (m[2] ? `${m[1]}-${m[2]}` : (m[1] as string)).toLowerCase();
}

/** A decision written by review or by Monty: "(owner, 2026-11-06)", "(agent, 2026-11-06)". */
const DECISION = /\((?:owner|agent)\b[^()]*?,\s*\d{4}-\d{2}-\d{2}\)/i;
/** The exact line Monty writes, which is the only kind Undo removes. */
export const MONTY_DECISION = /^\s*(?:[-*]\s+)?Decided: .+ \(owner, \d{4}-\d{2}-\d{2}\)\s*$/;
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function plain(s: string): string {
  return s.replace(/\*\*|__/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

function defaultIn(text: string): string | undefined {
  const pats = [
    /(?:\*\*)?(?:recommended\s+)?default(?:\*\*)?\s*(?:answer)?\s*[:：](?:\*\*)?\s*(.+)$/im,
    /(?:\*\*)?recommend(?:ed|ation)?(?:\*\*)?\s*[:：](?:\*\*)?\s*(.+)$/im,
    /\(default:?\s*([^)]+)\)/i,
  ];
  for (const p of pats) {
    const m = p.exec(text);
    const v = m?.[1] ? plain(m[1]).replace(/\s*\.$/, '') : '';
    if (v) return v;
  }
  return undefined;
}

function questionParts(first: string): { text: string; detail?: string } {
  const t = plain(first);
  const q = t.indexOf('?');
  if (q > 0 && q < t.length - 1) return { text: t.slice(0, q + 1), detail: t.slice(q + 1).trim() || undefined };
  return { text: t };
}

/** Each open question in "## Open Questions": bullets, `###` items, or paragraphs that ask something. */
export function openQuestions(text: string): ReaderQuestion[] {
  const lines = text.split('\n');
  const r = sectionRange(lines, /^open\s+questions?\b/i);
  if (!r) return [];
  const items: { start: number; end: number; form: ReaderQuestion['form']; indent: number; first: string }[] = [];
  const body = lines.slice(r.start, r.end);
  const subHeads = body.some((l) => /^#{3,6}\s+\S/.test(l.trim()));
  if (subHeads) {
    for (let i = r.start; i < r.end; i++) {
      const h = /^#{3,6}\s+(.*)$/.exec((lines[i] as string).trim());
      if (h) items.push({ start: i, end: i + 1, form: 'heading', indent: 0, first: h[1] as string });
      else if (items.length) (items[items.length - 1] as (typeof items)[number]).end = i + 1;
    }
  } else {
    // The shallowest bullets are the questions; deeper ones and continuation lines belong to them.
    const indents = body.map((l) => BULLET.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => (m[1] as string).length);
    const top = indents.length ? Math.min(...indents) : -1;
    let fence = false;
    let closed = false; // a blank line then an unindented line that is not a bullet: the list is over
    for (let i = r.start; i < r.end; i++) {
      const l = lines[i] as string;
      if (/^\s*```/.test(l)) fence = !fence;
      const m = fence ? null : BULLET.exec(l);
      const afterBlank = i > r.start && !(lines[i - 1] as string).trim();
      if (m && (m[1] as string).length === top) {
        closed = false;
        items.push({ start: i, end: i + 1, form: 'bullet', indent: l.length - (m[3] as string).length, first: m[3] as string });
      } else if (top < 0 && !fence && l.trim() && (i === r.start || afterBlank)) {
        items.push({ start: i, end: i + 1, form: 'para', indent: 0, first: l.trim() });
      } else if (items.length && (l.trim() || fence)) {
        if (top >= 0 && afterBlank && !fence && /^\S/.test(l) && !m) closed = true;
        if (!closed) (items[items.length - 1] as (typeof items)[number]).end = i + 1;
      }
    }
  }
  const out: ReaderQuestion[] = [];
  for (const it of items) {
    const own = lines.slice(it.start, it.end);
    // Trailing blanks are not part of the item.
    let end = it.end;
    while (end > it.start + 1 && !(lines[end - 1] as string).trim()) end--;
    const whole = own.join('\n');
    if (it.form === 'para' && !whole.includes('?')) continue;
    if (/^(none|n\/a|nothing)\b/i.test(plain(it.first))) continue;
    const decided = own.find((l, k) => (k > 0 || it.form !== 'heading') && DECISION.test(l));
    const parts = questionParts(it.first);
    const rest = own.filter((l) => l !== decided).join('\n');
    const q: ReaderQuestion = { index: out.length, text: parts.text, start: it.start, end, form: it.form, indent: it.indent };
    // The default shows as the answer button, so the detail stops where the plan states it.
    const detail = parts.detail?.replace(/\s*\(?\b(?:recommended\s+)?(?:default|recommend(?:ed|ation)?)\s*(?:answer)?\s*[:：].*$/i, '').trim();
    if (detail) q.detail = detail;
    const def = defaultIn(rest);
    if (def) q.default = def;
    if (decided) {
      const m = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:decided|decision|answer(?:ed)?)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.*?)\s*\((?:owner|agent)\b/i.exec(decided);
      const said = m?.[1] ? plain(m[1]) : plain(decided.replace(BULLET, '$3').replace(DECISION, '')).replace(/^.*\?\s*/, '');
      q.answer = { text: said || 'decided', line: decided, undoable: MONTY_DECISION.test(decided) };
    }
    out.push(q);
  }
  return out;
}

const PHASE_HEADING = /^(#{2,5})\s*(?:✅\s*)?Phase\s+(\d+)\b\s*[-—–:.]?\s*(.*)$/i;
const NUMBERED_SECTION = /^(#{2,3})\s+(\d+)\.\s+(.*)$/;
const KIRO_TOP = /^[-*]\s*\[([ xX~-])\]\*?\s*(\d+)\.?\s+(.*)$/;
const CHECKBOX = /^\s*[-*]\s*\[([ xX~-])\]\s*(.*)$/;

function itemText(s: string): string {
  // Spec Kit's [P] (parallel) and [US1] (story) markers are bookkeeping, not the task.
  const t = plain(s.replace(/\[(?:P|US\d+)\]\s*/g, ''));
  return t.length > 120 ? t.slice(0, 119) + '…' : t;
}

function phaseTitle(raw: string): string {
  return plain(raw)
    .replace(/\s*[-—–.,(]*\s*\b(DONE|COMPLETED?|SHIPPED)\b.*$/, '')
    .replace(/\s*[-—–]\s*(done|complete[d]?)\b.*$/i, '')
    .replace(/[\s:;,(+–—-]+$/, '')
    .trim();
}

/**
 * Per-phase detail, from whichever shape the doc uses: "### Phase N - name" headings
 * (Caddis, legacy plans, Spec Kit's "## Phase 1: Setup"), OpenSpec's "## 1. Name", or
 * Kiro's top-level numbered tasks. Done-ness is not decided here: the Project's phases
 * (folder, Status line, markers) stay the authority.
 */
export function phaseDetails(text: string): ReaderPhase[] {
  const lines = text.split('\n');
  for (const heading of [PHASE_HEADING, NUMBERED_SECTION]) {
    const out: ReaderPhase[] = [];
    let cur: (ReaderPhase & { level: number; body: string[] }) | null = null;
    const flush = () => {
      if (!cur) return;
      const { level: _l, body, ...p } = cur;
      const gi = body.findIndex((l) => /^\s*(?:[-*]\s+)?(?:\*\*)?Gate(?:\*\*)?\s*:?(?:\*\*)?\s*:?/.test(l) && /gate\b[^a-z]/i.test(l));
      if (gi >= 0) {
        const para = [body[gi] as string];
        for (const l of body.slice(gi + 1)) {
          if (!l.trim() || HEADING.test(l.trim()) || CHECKBOX.test(l)) break;
          para.push(l);
        }
        const g = plain(para.join(' ').replace(/^\s*(?:[-*]\s+)?(?:\*\*)?Gate(?:\*\*)?\s*:?(?:\*\*)?\s*:?\s*/i, ''));
        if (g) p.gate = g.length > 400 ? g.slice(0, 399) + '…' : g;
      }
      out.push(p);
      cur = null;
    };
    let fence = false;
    for (const l of lines) {
      if (/^\s*```/.test(l)) fence = !fence;
      if (fence) {
        cur?.body.push(l);
        continue;
      }
      const t = l.trim();
      const m = heading.exec(t);
      const h = HEADING.exec(t);
      if (m) {
        flush();
        const raw = m[3] as string;
        const date = /\b(?:DONE|COMPLETED?|SHIPPED)\b[^\n]*?(\d{4}-\d{2}-\d{2})/i.exec(raw)?.[1];
        cur = { n: Number(m[2]), title: phaseTitle(raw), items: [], level: (m[1] as string).length, body: [] };
        if (date) cur.date = date;
        continue;
      }
      if (cur && h && (h[1] as string).length <= cur.level) flush();
      if (!cur) continue;
      cur.body.push(l);
      const b = CHECKBOX.exec(l);
      if (b) cur.items.push({ text: itemText(b[2] as string), done: b[1] === 'x' || b[1] === 'X' });
    }
    flush();
    if (out.length) return out;
  }
  // Kiro: "- [ ] 2. Build auth" with indented sub-tasks.
  const out: ReaderPhase[] = [];
  for (const l of lines) {
    const m = KIRO_TOP.exec(l);
    if (m) {
      out.push({ n: Number(m[2]), title: itemText(m[3] as string), items: [] });
      continue;
    }
    const b = CHECKBOX.exec(l);
    const cur = out[out.length - 1];
    if (b && cur && /^\s+/.test(l)) cur.items.push({ text: itemText((b[2] as string).replace(/^\d+(\.\d+)+\.?\s+/, '')), done: b[1] === 'x' || b[1] === 'X' });
  }
  return out;
}

const PATHLIKE = /^(?:[\w@+-][\w@.+-]*\/)+[\w@+()[\]-][\w@.+()[\]-]*\.[A-Za-z0-9]{1,6}$/;
const ROOTFILE = /^[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,6}$/;
const SKIP = /^(?:node_modules|\.git|\.caddis|\.claude\/projects)\//;

function expandBraces(p: string): string[] {
  const m = /^(.*)\{([^{}]+)\}(.*)$/.exec(p);
  if (!m) return [p];
  return (m[2] as string).split(',').map((x) => `${m[1]}${x.trim()}${m[3]}`);
}

/**
 * Repo paths written in a spec: in code spans (`src/x.ts:41`), or bare in prose and task
 * lines ("T010 Add the route in src/routes/export.ts"). A name with no folder counts only
 * in a code span (`README.md`), as `root` candidates the caller checks exist.
 */
export function namedPaths(text: string, repoPath: string): { path: string; root: boolean }[] {
  const out = new Map<string, boolean>();
  const add = (raw: string, ticked: boolean) => {
    let p = raw.trim().replace(/^\.\//, '').replace(/:\d+([,-]\d+)*$/, '').replace(/[.,;:)]+$/, '');
    if (!p || /[*<>\s]|:\/\//.test(p) || /^https?:/.test(p)) return;
    if (p.startsWith('/')) {
      if (!p.startsWith(repoPath + '/')) return;
      p = p.slice(repoPath.length + 1);
    }
    if (p.startsWith('~') || p.startsWith('../')) return;
    for (const x of expandBraces(p)) {
      if (SKIP.test(x)) continue;
      if (PATHLIKE.test(x)) out.set(x, false);
      else if (ticked && ROOTFILE.test(x) && !out.has(x)) out.set(x, true);
    }
  };
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const rest = line.replace(/``\s?(.+?)\s?``|`([^`]+)`/g, (_, a, b) => {
      add((a ?? b) as string, true);
      return ' ';
    });
    for (const m of rest.matchAll(/(?:^|[\s(["'])((?:[\w@.+-]+\/)+[\w@.+()[\]{},-]+\.[A-Za-z0-9]{1,6}(?::\d+[\d,-]*)?)/g)) add(m[1] as string, false);
    if (out.size >= 120) break;
  }
  return [...out].map(([p, root]) => ({ path: p, root }));
}

const TEST_FILE = /(?:\.(?:test|spec)\.[A-Za-z0-9]+$)|(?:^|\/)(?:tests?|__tests__|spec)\//;

// ---------- git ----------

/** A repo's git answers in under a second; anything slower is not worth holding the reader for. */
const GIT_TIMEOUT_MS = 3000;
/** 400 commits with their file lists fit in a few hundred KB; 8 MB covers a monorepo's without letting one run away. */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** Commits looked at since the spec was written: enough for any one plan, bounded for a busy repo. */
const GIT_MAX_COMMITS = 400;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // --no-optional-locks: plain `git status` refreshes .git/index and takes index.lock to do
      // it, a write to the user's repo that can make their own commit fail (Invariant 3).
      execFile('git', ['--no-optional-locks', '-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch {
      resolve(null);
    }
  });
}

interface GitCommit extends ReaderCommit { plans: string[]; files: { status: string; path: string }[] }

/** Parses `git log --name-status --format=%x1e%H%x1f%cI%x1f%s%x1f%B`. */
export function parseGitLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const chunk of out.split('\x1e')) {
    const f = chunk.split('\x1f');
    if (f.length < 4) continue;
    const [hash, date, subject, rest] = f as [string, string, string, string];
    const plans = [...rest.matchAll(/^Caddis-Plan:\s*(\S+)\s*$/gm)].map((m) => m[1] as string);
    const files: GitCommit['files'] = [];
    for (const l of rest.split('\n')) {
      const m = /^([AMDT])\t(.+)$/.exec(l);
      if (m) files.push({ status: m[1] as string, path: m[2] as string });
    }
    commits.push({ hash: hash.trim(), date: date.trim(), subject: subject.trim(), plans, files });
  }
  return commits;
}

/** `git status --porcelain=v1 -z`: path -> X/Y code ("??" untracked). */
export function parseGitStatus(out: string): Map<string, string> {
  const m = new Map<string, string>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i] as string;
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    m.set(e.slice(3), code);
    if (code[0] === 'R' || code[0] === 'C') i++; // the source path follows a rename
  }
  return m;
}

/**
 * Pairs phases with the plan's trailer commits by DONE date: on each day, the last k
 * commits go to the k phases marked done that day, in order. A guess (trailers name the
 * plan, not the phase), and the reader's tooltip says so.
 */
export function matchPhaseCommits(phases: ReaderPhase[], commits: ReaderCommit[]): Map<number, ReaderCommit> {
  const out = new Map<number, ReaderCommit>();
  const byDay = new Map<string, ReaderCommit[]>();
  for (const c of [...commits].sort((a, b) => a.date.localeCompare(b.date))) {
    const d = c.date.slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), c]);
  }
  const days = new Map<string, ReaderPhase[]>();
  for (const p of phases) if (p.date) days.set(p.date, [...(days.get(p.date) ?? []), p]);
  for (const [d, ps] of days) {
    const cs = byDay.get(d) ?? [];
    const sorted = [...ps].sort((a, b) => a.n - b.n);
    for (let i = 1; i <= Math.min(sorted.length, cs.length); i++) out.set((sorted[sorted.length - i] as ReaderPhase).n, cs[cs.length - i] as ReaderCommit);
  }
  return out;
}

// ---------- assembling ----------

function readText(f: string): string {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
}

/** The doc that holds the phases: the plan itself, or a spec folder's tasks.md. */
function phaseDoc(p: Project): string {
  if (p.source === 'openspec') return path.join(path.dirname(p.file), 'tasks.md');
  return p.file;
}

/** When the spec was written: git's first commit of it, else the file's birth time. */
async function writtenAt(p: Project): Promise<number | undefined> {
  const docs = [p.file, ...(p.docs ?? [])];
  const out = await git(p.repoPath, ['log', '--diff-filter=A', '--format=%cI', '--', ...docs.map((d) => path.relative(p.repoPath, d))]);
  const dates = (out ?? '').split('\n').map((l) => Date.parse(l.trim())).filter((n) => !Number.isNaN(n));
  if (dates.length) return Math.min(...dates);
  const born = docs.map((d) => { try { return fs.statSync(d).birthtimeMs; } catch { return 0; } }).filter((n) => n > 0);
  return born.length ? Math.min(...born) : undefined;
}

const CACHE_MS = 5000; // the reader refetches on every change of the doc; git need not run each time
const cache = new Map<string, { at: number; data: Promise<ReaderData> }>();

export function readerData(p: Project, sessions: Session[], nowMs = Date.now()): Promise<ReaderData> {
  const key = p.file;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.data;
  const data = build(p, sessions).catch(() => ({ file: p.file, questions: [], phases: [], files: [], tests: [], git: false }) as ReaderData);
  cache.set(key, { at: nowMs, data });
  // Plans nobody has looked at for a minute are dropped, so the cache holds only what is open.
  for (const [k, v] of cache) if (nowMs - v.at > 60_000) cache.delete(k);
  return data;
}

async function build(p: Project, sessions: Session[]): Promise<ReaderData> {
  const repo = p.repoPath;
  const main = readText(p.file);
  const docs = [...new Set([p.file, ...(p.docs ?? [])])];
  const texts = new Map(docs.map((d) => [d, d === p.file ? main : readText(d)]));
  const data: ReaderData = { file: p.file, questions: [], phases: [], files: [], tests: [], git: false };

  const level = riskLevel(main);
  if (level) data.risk = { level };
  for (const d of docs) {
    const qs = openQuestions(texts.get(d) ?? '');
    if (qs.length) {
      data.questions = qs;
      data.questionsFile = d;
      break;
    }
  }
  const pdoc = phaseDoc(p);
  const details = phaseDetails(texts.get(pdoc) ?? readText(pdoc));

  // Where the spec names its files: the Changes table when it has one (Caddis), else its
  // tasks, else everything in the spec folder.
  const changes = sectionText(main, /^(changes|files( changed)?|file changes)$/i);
  const tasksText = p.file.endsWith('tasks.md') ? main : texts.get(path.join(path.dirname(p.file), 'tasks.md'));
  let named = changes ? namedPaths(changes, repo) : [];
  if (!named.length && tasksText) named = namedPaths(tasksText, repo);
  if (!named.length) named = docs.flatMap((d) => namedPaths(texts.get(d) ?? '', repo));
  const exists = (rel: string) => fs.existsSync(path.join(repo, rel));
  const namedSet = new Set(named.filter((n) => !n.root || exists(n.path)).map((n) => n.path).slice(0, 80));
  const testsBody = sectionText(main, /^(tests?|testing)$/i);
  if (testsBody) data.tests = namedPaths(testsBody, repo).filter((t) => TEST_FILE.test(t.path)).slice(0, 30).map((t) => ({ path: t.path, exists: exists(t.path) }));

  const since = await writtenAt(p);
  if (since) data.since = new Date(since).toISOString();
  const until = p.status === 'completed' || p.status === 'cancelled' ? Date.parse(p.updatedAt) : undefined;
  const planName = path.basename(p.file, '.md');

  const files = new Map<string, ReaderFile>();
  const touch = (rel: string, via: ReaderFile['via'][number], isNew = false) => {
    const isNamed = namedSet.has(rel);
    // Only files the spec names, or ones changed for it (trailer, matched session), are listed.
    if (!isNamed && via !== 'trailer' && via !== 'session') return;
    if (docs.some((d) => path.relative(repo, d) === rel) || SKIP.test(rel)) return;
    const f = files.get(rel) ?? { path: rel, named: isNamed, exists: exists(rel), changed: false, via: [] };
    f.changed = true;
    if (isNew) f.isNew = true;
    if (!f.via.includes(via)) f.via.push(via);
    files.set(rel, f);
  };

  const top = (await git(repo, ['rev-parse', '--show-toplevel']))?.trim();
  if (top) {
    data.git = true;
    // Paths in git output are relative to the top level; the repo may be a subfolder of it.
    // Compared as real paths: /var is /private/var on macOS, and git answers with the real one.
    let real = repo;
    try {
      real = fs.realpathSync(repo);
    } catch {
      /* keep it as given */
    }
    const prefix = path.relative(top, real);
    if (prefix.startsWith('..')) data.git = false;
    const rel = (g: string) => (prefix ? (g.startsWith(prefix + '/') ? g.slice(prefix.length + 1) : null) : g);
    const args = ['log', `-n${GIT_MAX_COMMITS}`, '--no-renames', '--name-status', '--format=%x1e%H%x1f%cI%x1f%s%x1f%B'];
    // A minute's slack: work committed together with the plan's first version counts.
    // A day past a finished plan's last change: closing commits land after the move to completed/.
    if (since) args.push(`--since=${new Date(since - 60_000).toISOString()}`);
    if (until) args.push(`--until=${new Date(until + 86_400_000).toISOString()}`);
    const commits = parseGitLog((await git(repo, [...args, '--', '.'])) ?? '');
    const mine: ReaderCommit[] = [];
    for (const c of commits) {
      const trailer = c.plans.includes(planName);
      if (trailer) mine.push({ hash: c.hash, date: c.date, subject: c.subject });
      // Without a known start, only trailer commits say anything about this spec.
      if (!since && !trailer) continue;
      for (const f of c.files) {
        const r = rel(f.path);
        if (r) touch(r, trailer && !namedSet.has(r) ? 'trailer' : 'git', f.status === 'A');
      }
    }
    if (!until) {
      const st = parseGitStatus((await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])) ?? '');
      for (const [g, code] of st) {
        const r = rel(g);
        if (r) touch(r, 'uncommitted', code === '??' || code[0] === 'A');
      }
    }
    const byN = matchPhaseCommits(details, mine);
    data.phases = details.map((d) => (byN.has(d.n) ? { ...d, commit: byN.get(d.n) } : d));
  } else data.phases = details;

  // Monty's own sessions: edits to named files count as changed; a session working on this
  // plan also brings the files it edited that the plan does not name.
  if (!until) {
    for (const s of sessions) {
      if (s.repoPath !== repo || !s.cwd) continue;
      if (since && s.lastEventAt && Date.parse(s.lastEventAt) < since) continue;
      const onPlan = s.plan?.file === p.file;
      for (const t of s.touched) {
        if (!t.edits) continue;
        const r = path.relative(repo, path.resolve(s.cwd, t.path));
        if (r.startsWith('..') || path.isAbsolute(r)) continue;
        if (namedSet.has(r) || onPlan) touch(r, 'session');
      }
    }
  }
  for (const n of namedSet) if (!files.has(n)) files.set(n, { path: n, named: true, exists: exists(n), changed: false, via: [] });
  data.files = [...files.values()].slice(0, 120);
  return data;
}

/** What /api/reader and /api/answer accept: a file under a project root or registered repo that belongs to a known plan or spec. */
export function knownPlanFile(file: string, projects: Project[], under: (f: string) => boolean): Project | undefined {
  const f = path.resolve(file);
  return under(f) ? projectFor(projects, f) : undefined;
}

/** The project a doc belongs to: its main file, or any file in its spec folder. */
export function projectFor(projects: Project[], file: string): Project | undefined {
  return projects.find((x) => x.file === file) ?? projects.find((x) => x.docs?.includes(file));
}
