// Finds and reads plan/spec documents across the user's project folders.
//
// Adapters, in order of how much the user relies on them:
//   claude-projects  .claude/projects/{active,completed,cancelled,parked}/*.md - the
//                    user's own /project, /execute, /complete convention. Progress is
//                    NOT checkboxes here (almost no file has any): it comes from the
//                    folder, the **Status** line and "Phase N ... DONE" markers in prose.
//   openspec         openspec/changes/<change>/ (proposal.md + tasks.md checkboxes)
//   spec-kit         specs/NNN-feature/tasks.md (- [ ] T001 ... checkboxes)
//   kiro             .kiro/specs/<feature>/tasks.md (nested checkboxes)

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Phase, Project, ProjectSource, ProjectStatus } from './types.js';

const BUCKETS: Record<string, ProjectStatus> = {
  active: 'active',
  completed: 'completed',
  cancelled: 'cancelled',
  parked: 'parked',
  pending: 'pending',
};

const MAX_COMPLETED_PER_REPO = 15;

export function listRepos(roots: string[]): string[] {
  const repos: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_')) repos.push(path.join(root, d.name));
    }
  }
  return repos.sort();
}

export function scanProjects(roots: string[]): Project[] {
  const out: Project[] = [];
  for (const repo of listRepos(roots)) out.push(...scanRepo(repo));
  return out;
}

export function scanRepo(repoPath: string): Project[] {
  return [
    ...scanClaudeProjects(repoPath),
    ...scanOpenSpec(repoPath),
    ...scanCheckboxSpecs(repoPath, 'specs', 'spec-kit'),
    ...scanCheckboxSpecs(repoPath, path.join('.kiro', 'specs'), 'kiro'),
  ].map((p) => ({ ...p, label: p.label ?? progressLabel(p.status, p.phases, p.progress) }));
}

function readDir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function mtime(p: string): Date {
  try {
    return fs.statSync(p).mtime;
  } catch {
    return new Date(0);
  }
}

// ---------- the user's own convention ----------

function scanClaudeProjects(repoPath: string): Project[] {
  const base = path.join(repoPath, '.claude', 'projects');
  const repo = path.basename(repoPath);
  const out: Project[] = [];
  for (const bucketDir of readDir(base)) {
    if (!bucketDir.isDirectory()) continue;
    const bucket = BUCKETS[bucketDir.name.toLowerCase()];
    if (!bucket) continue;
    const dir = path.join(base, bucketDir.name);
    let files = readDir(dir)
      .filter((f) => f.isFile() && f.name.endsWith('.md') && !/\.[a-z]+\.md$/i.test(f.name)) // x.debate.md is a note about a plan, not a plan
      .map((f) => path.join(dir, f.name));
    if (bucket === 'completed' || bucket === 'cancelled') {
      files = files.sort((a, b) => mtime(b).getTime() - mtime(a).getTime()).slice(0, MAX_COMPLETED_PER_REPO);
    }
    for (const file of files) {
      const text = readText(file);
      if (text === null) continue;
      out.push(parseClaudeProject(text, { file, repo, repoPath, bucket }));
    }
  }
  return out;
}

export function parseClaudeProject(
  text: string,
  where: { file: string; repo: string; repoPath: string; bucket: ProjectStatus },
): Project {
  const lines = text.split('\n').map((l) => l.replace(/^\s*>\s?/, ''));
  const statusText = findStatusLine(lines);
  const status = resolveStatus(where.bucket, statusText);
  const phases = findPhases(lines, status === 'completed', statusText);
  const tasks = countCheckboxes(text);
  const progress = progressOf(status, phases, tasks);
  return {
    id: `${where.repo}:${path.basename(where.file, '.md')}`,
    repo: where.repo,
    repoPath: where.repoPath,
    source: 'claude-projects',
    name: findTitle(lines) ?? prettyName(path.basename(where.file, '.md')),
    file: where.file,
    status,
    statusText,
    goal: findSection(lines, 'goal'),
    phases,
    tasks,
    progress,
    label: progressLabel(status, phases, progress),
    updatedAt: mtime(where.file).toISOString(),
  };
}

export function findStatusLine(lines: string[]): string | undefined {
  // **Status:** X  |  **Status**: X  |  Status: X   (first match wins; usually line 3 or the last line)
  // The colon is required: "- Status alerts end with a full stop" is a sentence about alerts.
  for (const l of lines) {
    const m = /^\s*(?:[-*]\s*)?\*{0,2}Status(?:\*{2}\s*:|\s*:\s*\*{0,2})\s*(.+?)\s*$/i.exec(l);
    if (m && m[1] && !/^\|/.test(l)) return m[1].replace(/\*+/g, '').trim();
  }
  return undefined;
}

export function resolveStatus(bucket: ProjectStatus, statusText?: string): ProjectStatus {
  // The folder is authoritative for finished work: /complete moves the file.
  if (bucket === 'completed' || bucket === 'cancelled' || bucket === 'parked') return bucket;
  const s = (statusText ?? '').toLowerCase();
  if (/^(complete|completed|done)\b/.test(s)) return 'completed';
  if (/^cancel/.test(s)) return 'cancelled';
  if (/^park/.test(s)) return 'parked';
  if (/^(pending|planned|not started|draft|proposed)\b/.test(s)) return 'pending';
  return 'active';
}

const PHASE_HEADING = /^#{2,5}\s*(?:✅\s*)?Phase\s+(\d+)\b\s*[-—–:.]?\s*(.*)$/i;
// "- **Phase 2 — the replace engine — DONE.**" - phases written up as bold bullets, or as
// bold paragraphs with the title after the bold: "**Phase 1** — the refund flow."
const PHASE_BULLET = /^(?:[-*]\s+)?\*\*(?:✅\s*)?Phase\s+(\d+)\b\s*[-—–:.]?\s*([^*]*)\*\*(?:\s*[-—–:.]?\s*(.*))?/i;

export function findPhases(lines: string[], allDone: boolean, statusText?: string): Phase[] {
  const phases = new Map<number, Phase>();
  for (const l of lines) {
    const m = PHASE_HEADING.exec(l.trim()) ?? PHASE_BULLET.exec(l.trim());
    if (!m) continue;
    const n = Number(m[1]);
    // First mention wins, unless it was a bare "**Phase 1**" and a later one has the title.
    if (phases.has(n) && phases.get(n)?.title) continue;
    // The title after the bold runs on as prose; its first clause is the name.
    const after = (m[3] ?? '').split(/(?<=\.)\s|[.;:](?:\s|$)/)[0] ?? '';
    const rawTitle = (m[2] || after).replace(/[*_`]/g, '').trim().slice(0, 90);
    // "the split. DONE, commit adb03d": the marker and what follows it are not the title.
    const title = rawTitle.replace(/\s*[-—–.,(]*\s*\b(DONE|COMPLETED?|SHIPPED)\b.*$/, '').replace(/\s*[-—–]\s*(done|complete[d]?)\b.*$/i, '').replace(/[\s:;,(+–—-]+$/, '').trim();
    phases.set(n, { n, title, done: false });
  }
  if (phases.size === 0) return [];
  const body = lines.join('\n');
  const fromStatus = phasesDoneInStatus(statusText);
  for (const p of phases.values()) {
    p.done = allDone || phaseMarkedDone(body, p.n) || fromStatus(p.n);
  }
  return [...phases.values()].sort((a, b) => a.n - b.n);
}

function phaseMarkedDone(body: string, n: number): boolean {
  const patterns = [
    new RegExp(`✅[^\\n]{0,12}Phase\\s+${n}\\b`, 'i'),
    new RegExp(`Phase\\s+${n}\\b[^\\n]{0,90}?(\\bDONE\\b|\\bSHIPPED\\b|✅|\\bCOMPLETE(D)?\\b(?!\\s+when))`),
    new RegExp(`^\\s*[-*]\\s*\\[[xX]\\]\\s*\\**Phase\\s+${n}\\b`, 'm'),
    // Lowercase only as a marker on the phase's own heading: "### Phase 2 - Engine (done)",
    // "## Phase 2: done". Prose like "Phase 3 is done when" must not count.
    new RegExp(`^#{2,5}\\s*Phase\\s+${n}\\b[^\\n]*?(?:[-—–(:]\\s*|\\s)(?:done|complete[d]?|shipped)\\b\\)?\\s*(?:\\(\\d{4}-\\d{2}-\\d{2}\\))?\\s*$`, 'im'),
  ];
  return patterns.some((r) => r.test(body));
}

/**
 * The Status line saying how far it got: "Phase 2 done (2026-10-25)" means 1 and 2 are
 * (phases run in order unless the plan says otherwise); "Phases 1 and 3 done" means those two.
 */
function phasesDoneInStatus(statusText?: string): (n: number) => boolean {
  const m = /^Phases?\s+([\d,\s]+(?:(?:and|&)\s*\d+)?)\s+(?:are\s+|is\s+)?(?:done|complete[d]?|shipped)\b/i.exec(statusText ?? '');
  if (!m?.[1]) return () => false;
  const nums = (m[1].match(/\d+/g) ?? []).map(Number);
  // "Phase 2 done; Phase 1 waits for the owner": a phase the rest of the line names keeps its own state.
  const rest = (statusText ?? '').slice(m[0].length);
  const named = new Set([...rest.matchAll(/Phase\s+(\d+)/gi)].map((x) => Number(x[1])));
  if (nums.length === 1) return (n) => n === nums[0] || (n < (nums[0] as number) && !named.has(n));
  return (n) => nums.includes(n);
}

function findTitle(lines: string[]): string | undefined {
  const h = lines.find((l) => /^#\s+\S/.test(l));
  const t = h?.replace(/^#\s+/, '').replace(/^(Plan|Project|Spec)\s*:\s*/i, '').trim();
  // Some plans use the file slug as the heading ("# project-v1-foundation").
  if (t && /^[a-z0-9]+(-[a-z0-9]+)+$/.test(t)) return prettyName(t);
  return t;
}

export function findSection(lines: string[], name: string): string | undefined {
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s+${name}\\b`, 'i').test(l.trim()));
  if (start < 0) return undefined;
  const para: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(l)) break;
    if (!l.trim()) {
      if (para.length) break;
      continue;
    }
    para.push(l.trim());
  }
  const text = para.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 240 ? text.slice(0, 239) + '…' : text;
}

export function countCheckboxes(text: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const m of text.matchAll(/^\s*[-*]\s*\[([ xX~-])\]/gm)) {
    total++;
    if (m[1] === 'x' || m[1] === 'X') done++;
  }
  return { done, total };
}

function progressOf(status: ProjectStatus, phases: Phase[], tasks: { done: number; total: number }): Project['progress'] {
  if (phases.length) return { done: phases.filter((p) => p.done).length, total: phases.length, basis: 'phases' };
  if (tasks.total) return { ...tasks, basis: 'tasks' };
  const finished = status === 'completed' ? 1 : 0;
  return { done: finished, total: 1, basis: 'status' };
}

/** "Phase 3 of 5": the first phase not done, by its own number, since plans don't always go in order. */
export function progressLabel(status: ProjectStatus, phases: Phase[], progress: Project['progress']): string {
  const { done, total, basis } = progress;
  // A cancelled or parked plan is not on any phase: "Phase 1 of 3" read as work under way.
  if (status === 'cancelled' || status === 'parked') return status;
  if (basis === 'phases') {
    if (status === 'completed') return `${total} phases`;
    const next = phases.find((p) => !p.done);
    return next ? `Phase ${next.n} of ${total}` : `All ${total} phases done`;
  }
  if (basis === 'tasks') return `${done}/${total} tasks`;
  return '';
}

function prettyName(slug: string): string {
  const s = slug.replace(/^project-/, '').replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- OpenSpec ----------

function scanOpenSpec(repoPath: string): Project[] {
  const changes = path.join(repoPath, 'openspec', 'changes');
  const repo = path.basename(repoPath);
  const out: Project[] = [];
  const addChange = (dir: string, archived: boolean) => {
    const proposal = path.join(dir, 'proposal.md');
    const tasksFile = path.join(dir, 'tasks.md');
    const ptext = readText(proposal) ?? '';
    const ttext = readText(tasksFile) ?? '';
    if (!ptext && !ttext) return;
    const tasks = countCheckboxes(ttext);
    const status: ProjectStatus = archived ? 'completed' : tasks.total && tasks.done === tasks.total ? 'completed' : tasks.done > 0 ? 'active' : 'pending';
    const plines = ptext.split('\n');
    const slug = path.basename(dir).replace(/^\d{4}-\d{2}-\d{2}-/, '');
    out.push({
      id: `${repo}:openspec:${path.basename(dir)}`,
      repo,
      repoPath,
      source: 'openspec',
      name: findTitle(plines)?.replace(/^Change\s*:\s*/i, '') ?? prettyName(slug),
      file: ptext ? proposal : tasksFile,
      status,
      goal: findSection(plines, 'why') ?? findSection(plines, 'goal'),
      phases: [],
      tasks,
      progress: tasks.total ? { ...tasks, basis: 'tasks' } : { done: archived ? 1 : 0, total: 1, basis: 'status' },
      updatedAt: mtime(ttext ? tasksFile : proposal).toISOString(),
    });
  };
  for (const d of readDir(changes)) {
    if (!d.isDirectory()) continue;
    if (d.name === 'archive') {
      const archived = readDir(path.join(changes, 'archive'))
        .filter((a) => a.isDirectory())
        .map((a) => a.name)
        .sort()
        .reverse()
        .slice(0, MAX_COMPLETED_PER_REPO);
      for (const a of archived) addChange(path.join(changes, 'archive', a), true);
    } else addChange(path.join(changes, d.name), false);
  }
  return out;
}

// ---------- Spec Kit and Kiro: a folder per feature with a tasks.md of checkboxes ----------

function scanCheckboxSpecs(repoPath: string, relDir: string, source: ProjectSource): Project[] {
  const root = path.join(repoPath, relDir);
  const repo = path.basename(repoPath);
  const out: Project[] = [];
  for (const d of readDir(root)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    const tasksFile = path.join(dir, 'tasks.md');
    const ttext = readText(tasksFile);
    const mainFile = ['spec.md', 'requirements.md', 'design.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (ttext === null && !mainFile) continue;
    const tasks = countCheckboxes(ttext ?? '');
    const mtext = mainFile ? readText(mainFile) ?? '' : '';
    const mlines = mtext.split('\n');
    const status: ProjectStatus = tasks.total && tasks.done === tasks.total ? 'completed' : tasks.done > 0 ? 'active' : 'pending';
    // Spec Kit groups tasks under "## Phase N: Setup" headings; reuse the phase reader.
    const phases = source === 'spec-kit' ? phasesFromCheckboxGroups(ttext ?? '') : [];
    out.push({
      id: `${repo}:${source}:${d.name}`,
      repo,
      repoPath,
      source,
      name: findTitle(mlines)?.replace(/^(Feature Specification|Requirements Document|Feature)\s*:\s*/i, '') ?? prettyName(d.name.replace(/^\d+-/, '')),
      file: ttext !== null ? tasksFile : (mainFile as string),
      status,
      goal: findSection(mlines, 'introduction') ?? findSection(mlines, 'summary'),
      phases,
      tasks,
      progress: tasks.total ? { ...tasks, basis: 'tasks' } : { done: 0, total: 1, basis: 'status' },
      updatedAt: mtime(ttext !== null ? tasksFile : (mainFile as string)).toISOString(),
    });
  }
  return out;
}

/** A phase is done when every checkbox under its heading is ticked. */
export function phasesFromCheckboxGroups(text: string): Phase[] {
  const phases: Phase[] = [];
  let current: (Phase & { boxes: number; ticked: number }) | null = null;
  const flush = () => {
    if (current) phases.push({ n: current.n, title: current.title, done: current.boxes > 0 && current.ticked === current.boxes });
  };
  for (const l of text.split('\n')) {
    const m = PHASE_HEADING.exec(l.trim());
    if (m) {
      flush();
      current = { n: Number(m[1]), title: (m[2] ?? '').trim(), done: false, boxes: 0, ticked: 0 };
      continue;
    }
    const b = /^\s*[-*]\s*\[([ xX])\]/.exec(l);
    if (b && current) {
      current.boxes++;
      if (b[1] !== ' ') current.ticked++;
    }
  }
  flush();
  return phases;
}
