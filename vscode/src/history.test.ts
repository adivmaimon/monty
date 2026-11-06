import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { activeSpec, blameBlocks, blameSpecs, explorerMarks, fileLens, relTo, type History, type LiteState } from './history';

const history: History = {
  repo: '/r',
  specs: [
    { name: 'Refresh tokens', file: '/r/.caddis/projects/active/project-refresh.md', status: 'active', named: ['src/auth/session.ts', 'src/auth/revoke.ts'], commits: 3 },
    { name: 'Session store', file: '/r/.caddis/projects/completed/project-store.md', status: 'completed', named: [], commits: 2 },
    { name: 'Gone', named: [], commits: 1 },
  ],
  files: {
    'src/auth/session.ts': [[0, '2026-11-05T10:00:00Z', 'trailer'], [1, '2026-10-28T10:00:00Z', 'spec'], [2, '2026-10-02T10:00:00Z', 'dates']],
    'src/config/env.ts': [[0, '2026-11-04T10:00:00Z', 'trailer']],
    'src/db/x.ts': [[1, '2026-10-20T10:00:00Z', 'window']],
    '.caddis/projects/active/project-refresh.md': [[0, '2026-11-05T10:00:00Z', 'spec']],
  },
  commitSpecs: { abcdef123456: [0, 1] },
};

const state = (over: Partial<LiteState> = {}): LiteState => ({
  sessions: [],
  projects: [
    { file: '/r/.caddis/projects/active/project-refresh.md', name: 'Refresh tokens', status: 'active', label: 'Phase 3 of 4' },
    { file: '/r/.caddis/projects/completed/project-store.md', name: 'Session store', status: 'completed' },
  ],
  ...over,
});

test('activeSpec: the session\'s plan, else the only active plan, else none', () => {
  const s = state({ sessions: [{ state: 'working', cwd: '/r/src', plan: { file: '/r/.caddis/projects/completed/project-store.md', name: 'Session store', label: '2 of 2 phases done' }, touched: [{ path: 'auth/x.ts', edits: 1 }, { path: 'auth/y.ts', edits: 0 }] }] });
  const a = activeSpec(s, history);
  assert.equal(a?.name, 'Session store');
  assert.equal(a?.index, 1);
  assert.deepEqual(a?.sessionEdits, ['src/auth/x.ts'], 'edits only, relative to the repo');
  assert.equal(activeSpec(state(), history)?.label, 'Phase 3 of 4');
  const two = state({ projects: [...state().projects, { file: '/r/p2.md', name: 'Other', status: 'active' }] });
  assert.equal(activeSpec(two, history), undefined, 'two active and no session: no guess');
  assert.equal(activeSpec(null, history), undefined);
});

test('explorerMarks: changed and named, named only, changed outside; the plan file itself unmarked', () => {
  const marks = explorerMarks(activeSpec(state(), history), history);
  assert.equal(marks.get('src/auth/session.ts'), 'changed');
  assert.equal(marks.get('src/auth/revoke.ts'), 'named');
  assert.equal(marks.get('src/config/env.ts'), 'outside');
  assert.equal(marks.has('src/db/x.ts'), false);
  assert.equal(marks.has('.caddis/projects/active/project-refresh.md'), false);
  assert.equal(explorerMarks(undefined, history).size, 0);
});

test('fileLens: active plan, its phase and earlier plans; earlier only; nothing', () => {
  const a = activeSpec(state(), history);
  const l = fileLens('src/auth/session.ts', a, history);
  assert.equal(l?.title, 'Refresh tokens · Phase 3 of 4 · 2 earlier plans');
  assert.deepEqual(l?.entries.map((e) => [e.name, e.active, e.guess]), [['Refresh tokens', true, false], ['Session store', false, false], ['Gone', false, true]]);
  assert.equal(fileLens('src/db/x.ts', a, history)?.title, '1 plan changed this file');
  assert.equal(fileLens('src/none.ts', a, history), undefined);
  assert.equal(fileLens('src/auth/session.ts', a, null), undefined);
});

test('relTo: inside, outside, Windows slashes', () => {
  assert.equal(relTo('/r', '/r/a/b.ts'), 'a/b.ts');
  assert.equal(relTo('/r', '/rx/a.ts'), undefined);
  assert.equal(relTo('C:\\r', 'C:\\r\\a\\b.ts'), 'a/b.ts');
});

test('blameBlocks: porcelain to runs of lines per commit', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const out = [
    `${A} 1 10 2`, 'author X', 'summary s', 'filename f', '\tline10',
    `${A} 2 11`, '\tline11',
    `${B} 5 12 1`, 'author Y', 'filename f', '\tline12',
    `${A} 3 13 1`, '\tline13',
  ].join('\n');
  assert.deepEqual(blameBlocks(out), [{ sha: A, start: 10, end: 11 }, { sha: B, start: 12, end: 12 }, { sha: A, start: 13, end: 13 }]);
  assert.deepEqual(blameSpecs('abcdef1234567890', history).map((s) => s.name), ['Refresh tokens', 'Session store']);
  assert.deepEqual(blameSpecs('0'.repeat(40), history), [], 'not committed yet');
});
