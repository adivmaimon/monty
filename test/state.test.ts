import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeState } from '../src/state.js';
import type { MontyState } from '../src/types.js';

const s = (cwd: string) => ({ cwd }) as unknown as MontyState['sessions'][number];
const p = (repoPath: string) => ({ repoPath }) as unknown as MontyState['projects'][number];

test('scope keeps only the open repo', () => {
  const state: MontyState = {
    generatedAt: '',
    roots: [],
    sessions: [s('/P/Shop'), s('/P/Shop/admin'), s('/P/Notes'), s('/P/Shop2')],
    projects: [p('/P/Shop'), p('/P/Notes')],
  };
  const out = scopeState(state, '/P/Shop');
  assert.deepEqual(out.sessions.map((x) => x.cwd), ['/P/Shop', '/P/Shop/admin']);
  assert.deepEqual(out.projects.map((x) => x.repoPath), ['/P/Shop']);
  // A workspace opened on a subfolder still sees its repo's plans.
  assert.equal(scopeState(state, '/P/Notes/app').projects.length, 1);
  assert.equal(scopeState(state, null).sessions.length, 4);
});

// Plan as progress source: current Claude Code writes no todo lists (Phase 1 findings).
import { withPlan, withRepo } from '../src/state.js';
import { summarise } from '../src/bar.js';

const sess = (over: Partial<MontyState['sessions'][number]> = {}) =>
  ({ cwd: '/P/Monty', repoPath: '/P/Monty', title: 'Fix the scan', state: 'working', stateReason: '', progress: { done: 0, total: 0 }, touched: [], todos: [], context: { pct: 0 }, repo: 'Monty', ...over }) as unknown as MontyState['sessions'][number];
const plan = (file: string, done: number, total: number, updatedAt = '2026-10-01', status = 'active', basis = 'phases') =>
  ({ file, repoPath: '/P/Monty', name: file, status, updatedAt, progress: { done, total, basis } }) as unknown as MontyState['projects'][number];

test('the repo\'s only active plan becomes the session\'s progress', () => {
  const s = withPlan(sess(), [plan('/P/Monty/.claude/projects/active/a.md', 1, 4), plan('/P/Monty/.claude/projects/completed/b.md', 3, 3, '2026-10-22', 'completed')]);
  assert.equal(s.plan?.label, 'Phase 2 of 4');
  assert.equal(s.plan?.match, 'only');
});

test('a plan the session touched or names beats the newest', () => {
  const a = plan('/P/Monty/.claude/projects/active/project-a.md', 0, 3, '2026-10-20');
  const b = plan('/P/Monty/.claude/projects/active/project-b.md', 2, 5, '2026-10-01');
  assert.equal(withPlan(sess(), [a, b]).plan?.match, 'newest');
  assert.equal(withPlan(sess(), [a, b]).plan?.file, a.file);
  assert.equal(withPlan(sess({ title: '/execute project-b phase 3' }), [a, b]).plan?.file, b.file);
  const touched = [{ path: '.claude/projects/active/project-b.md', reads: 1, edits: 0, plus: 0, minus: 0 }];
  assert.equal(withPlan(sess({ touched }), [a, b]).plan?.match, 'touched');
});

test('no plan for a status-only plan, another repo, or a session with its own todos', () => {
  assert.equal(withPlan(sess(), [plan('/P/Monty/x.md', 0, 1, '', 'active', 'status')]).plan, undefined);
  assert.equal(withPlan(sess({ repoPath: '/P/Other' }), [plan('/P/Monty/x.md', 1, 4)]).plan, undefined);
  assert.equal(withPlan(sess({ progress: { done: 1, total: 2 } }), [plan('/P/Monty/x.md', 1, 4)]).plan, undefined);
});

test('menu bar shows plan progress in text and ring, but needs-you wins the text', () => {
  const s = withPlan(sess(), [plan('/P/Monty/a.md', 1, 4)]);
  const bar = summarise({ generatedAt: '', roots: [], projects: [], sessions: [s] });
  assert.equal(bar.text, 'Phase 2 of 4');
  assert.equal(bar.pct, 0.25);
  const ask = summarise({ generatedAt: '', roots: [], projects: [], sessions: [{ ...s, state: 'needs_input' }] });
  assert.equal(ask.text, 'needs you');
  assert.equal(ask.pct, 0.25);
});

test('a plan with every phase done says so instead of "Phase N of N"', () => {
  const s = withPlan(sess(), [plan('/P/Monty/a.md', 4, 4)]);
  assert.equal(s.plan?.label, 'All 4 phases done');
});

// Repos registered by the surfaces (?repo=<workspace>), not a configured folder.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { MontyStore, isUnderKnown } from '../src/state.js';
import { loadConfig } from '../src/config.js';

function scratchRepo(name: string, withGit = true): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'monty-'));
  const repo = nodePath.join(dir, name);
  fs.mkdirSync(nodePath.join(repo, '.claude', 'projects', 'active'), { recursive: true });
  if (!withGit) fs.rmSync(nodePath.join(repo, '.claude'), { recursive: true });
  else fs.mkdirSync(nodePath.join(repo, '.git'));
  if (withGit) fs.writeFileSync(nodePath.join(repo, '.claude', 'projects', 'active', 'project-x.md'), '# X\n\n**Status**: In progress\n\n## Phases\n\n### Phase 1 - A - DONE (2026-10-23)\n\n### Phase 2 - B\n');
  return repo;
}

test('no folder configured: a repo asked about is scanned, and expires when no one asks', () => {
  const cfg = loadConfig({ MONTY_CLAUDE_PROJECTS: fs.mkdtempSync(nodePath.join(os.tmpdir(), 'monty-logs-')) });
  assert.deepEqual(cfg.projectRoots, []);
  const store = new MontyStore(cfg);
  const repo = scratchRepo('Alpha');
  assert.equal(store.addRepo(repo, 1000), true);
  assert.equal(store.addRepo(repo, 2000), false, 'already known');
  const s = store.state();
  assert.deepEqual(s.projects.map((p) => [p.repo, p.name, p.progress.done, p.progress.total]), [['Alpha', 'X', 1, 2]]);
  assert.deepEqual(store.repos(2000 + cfg.liveMs - 1), [repo]);
  assert.deepEqual(store.repos(2000 + cfg.liveMs + 1), [], 'a closed window drops out');
});

test('only folders that look like repos can be registered', () => {
  const store = new MontyStore(loadConfig({ MONTY_CLAUDE_PROJECTS: os.tmpdir() }));
  assert.equal(store.addRepo(scratchRepo('Plain', false)), false);
  assert.equal(store.addRepo('/definitely/not/here'), false);
  assert.deepEqual(store.repos(), []);
});

test('/api/doc scope: files under a registered repo or a root, nothing else', () => {
  assert.equal(isUnderKnown('/w/Alpha/docs/a.md', [], ['/w/Alpha']), true);
  assert.equal(isUnderKnown('/w/Alpha2/a.md', [], ['/w/Alpha']), false);
  assert.equal(isUnderKnown('/r/Beta/a.md', ['/r'], []), true);
  assert.equal(isUnderKnown('/etc/a.md', ['/r'], ['/w/Alpha']), false);
});

test('a session in a subfolder of a registered repo belongs to the repo', () => {
  const s = withRepo({ cwd: '/w/Alpha/app/python' } as unknown as MontyState['sessions'][number], [], ['/w/Alpha']);
  assert.equal(s.repo, 'Alpha');
  assert.equal(s.repoPath, '/w/Alpha');
});
