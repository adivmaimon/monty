// Footprint: names in a spec, area grouping, and the whole thing against a real (temporary)
// git repo and the Spec Kit fixture without git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { areasFor, buildFootprint, computeFootprint, namedRefs, PLAIN_CELLS, projectForDoc, resolveNamed } from '../src/footprint.js';
import { scanRepo } from '../src/projects.js';
import type { Project, Session } from '../src/types.js';

const where = (m: Map<string, Set<string>>, p: string) => [...(m.get(p) ?? [])];

test('names: code spans, prose paths and links, by phase or section', () => {
  const md = [
    '# Refresh tokens',
    '## Changes',
    '| `src/auth/session.ts` | edit |',
    '| `state.ts` | bare name |',
    '### Phase 1 - Store',
    'Touch src/db/0042_refresh.sql and (see src/auth/tokens.ts).',
    '#### Notes',
    'Still phase one: `routes/refresh.ts:12-20`.',
    '### Phase 2 - Routes',
    'Link: [logout](../../src/routes/logout.ts). Docs at https://example.com/a/b.html.',
    '```',
    'node dist/src/cli.js',
    '```',
    '## Tests',
    'Version 1.2.3 and `npm test` are not paths.',
  ].join('\n');
  const m = namedRefs(md);
  assert.deepEqual(where(m, 'src/auth/session.ts'), ['Changes']);
  assert.deepEqual(where(m, 'state.ts'), ['Changes']);
  assert.deepEqual(where(m, 'src/db/0042_refresh.sql'), ['Phase 1']);
  assert.deepEqual(where(m, 'src/auth/tokens.ts'), ['Phase 1']);
  assert.deepEqual(where(m, 'routes/refresh.ts'), ['Phase 1']);
  assert.ok(m.has('../../src/routes/logout.ts'));
  assert.ok(!m.has('dist/src/cli.js'), 'fenced blocks are skipped');
  assert.ok(![...m.keys()].some((k) => k.includes('example.com')), 'URLs are not paths');
  assert.ok(!m.has('1.2.3'));
});

test('names: Spec Kit phases hold through sub-headings', () => {
  const md = '## Phase 3: User Story 1\n### Implementation for User Story 1\n- [ ] T004 Add it in src/api/tags.ts\n## Phase 4: Polish\n- [ ] T008 Document in docs/tags.md\n';
  const m = namedRefs(md);
  assert.deepEqual(where(m, 'src/api/tags.ts'), ['Phase 3']);
  assert.deepEqual(where(m, 'docs/tags.md'), ['Phase 4']);
});

test('resolve: exact, unique suffix, unique bare name, missing kept, ambiguous dropped', () => {
  const files = ['src/auth/session.ts', 'src/state.ts', 'web/state.ts', 'src/routes/logout.ts', 'README.md'];
  const refs = new Map([
    ['src/auth/session.ts', new Set(['Phase 1'])],
    ['auth/session.ts', new Set(['Phase 2'])],
    ['state.ts', new Set(['x'])],
    ['README.md', new Set(['y'])],
    ['src/auth/revoke.ts', new Set(['Phase 3'])],
    ['lonely.ts', new Set(['z'])],
    ['/specs/001/plan.md', new Set<string>()],
  ]);
  const r = resolveNamed(refs, files);
  assert.deepEqual(r.get('src/auth/session.ts'), { where: ['Phase 1', 'Phase 2'], exists: true });
  assert.ok(!r.has('state.ts') && !r.has('src/state.ts'), 'two files share the name');
  assert.equal(r.get('README.md')?.exists, true);
  assert.deepEqual(r.get('src/auth/revoke.ts'), { where: ['Phase 3'], exists: false });
  assert.ok(!r.has('lonely.ts'), 'a bare name that matches nothing is not a plan');
  assert.ok(!r.has('specs/001/plan.md'), 'no specs folder: not a file to create here');
  const covered = resolveNamed(new Map([['src/auth/revoke.ts', new Set<string>()], ['auth/revoke.ts', new Set<string>()]]), files);
  assert.deepEqual([...covered.keys()], ['src/auth/revoke.ts'], 'a shorter name for the same new file is not a second file');
  const linked = resolveNamed(new Map([['../../src/routes/logout.ts', new Set<string>()]]), files, { repoPath: '/r', docDir: '/r/docs/plans' });
  assert.equal(linked.get('src/routes/logout.ts')?.exists, true);
});

test('areas: top folders, a dominant folder split, cap, Caddis map wins', () => {
  assert.deepEqual([...areasFor(['src/a.ts', 'web/b.js', 'README.md']).keys()].sort(), ['src', 'top level', 'web']);
  const big = [...Array.from({ length: 50 }, (_, i) => `src/auth/f${i}.ts`), ...Array.from({ length: 30 }, (_, i) => `src/db/f${i}.ts`), 'src/index.ts', ...Array.from({ length: 10 }, (_, i) => `web/f${i}.js`)];
  const split = areasFor(big);
  assert.deepEqual([...split.keys()], ['src/auth', 'src/db', 'web', 'src']);
  const many = Array.from({ length: 20 }, (_, i) => `d${i}/x.ts`);
  const capped = areasFor(many);
  assert.equal(capped.size, 12);
  assert.equal(capped.get('other')?.length, 9);
  const graph = new Map([['src/a.ts', 'core'], ['src/agents/b.ts', 'src/agents']]);
  const g = areasFor(['src/a.ts', 'src/agents/b.ts', 'src/agents/new.ts', 'docs/x.md'], graph);
  assert.deepEqual(g.get('src/agents'), ['src/agents/b.ts', 'src/agents/new.ts']);
  assert.deepEqual(g.get('core'), ['src/a.ts']);
  assert.deepEqual(g.get('docs'), ['docs/x.md']);
});

test('thousands of files: plain cells capped per area, marked always shown', () => {
  const files = Array.from({ length: 3000 }, (_, i) => `pkg${i % 4}/m${i}.ts`);
  const fp = buildFootprint({ files, own: new Set(), named: new Map([['pkg0/m0.ts', { where: ['Phase 1'], exists: true }]]), changed: new Map([['pkg1/m1.ts', { via: ['git'] }]]) });
  assert.equal(fp.areas.length, 4);
  for (const a of fp.areas) {
    assert.ok(a.plain.length <= PLAIN_CELLS);
    assert.equal(a.plain.length + a.more + a.marked.length, a.total);
  }
  assert.deepEqual(fp.counts, { named: 1, namedChanged: 0, outside: 1 });
});

const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
function write(root: string, rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
function commit(root: string, msg: string, date?: string) {
  const env = { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
  execFileSync('git', [...GIT, 'add', '-A'], { cwd: root, env });
  execFileSync('git', [...GIT, 'commit', '-q', '-m', msg], { cwd: root, env });
}

test('a plan in a git repo: changed, planned, outside, own file excluded', { skip: !hasGit() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-fp-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    write(root, '.gitignore', 'dist/\n');
    write(root, 'src/auth/session.ts', 'a\n');
    write(root, 'src/routes/logout.ts', 'b\n');
    write(root, 'src/config/env.ts', 'c\n');
    write(root, 'README.md', 'r\n');
    commit(root, 'base', '2026-01-01T10:00:00Z');
    const plan = 'plans/project-refresh.md';
    write(root, plan, ['# Refresh tokens', '**Status**: In progress', '## Changes', '- `auth/session.ts`', '### Phase 1 - Routes', '- src/routes/logout.ts', '- src/auth/revoke.ts (new)', '- `dist/out.js`', '## Context', '- `src/config/env.ts` is only cited here'].join('\n'));
    commit(root, 'plan', '2026-01-02T10:00:00Z');
    write(root, 'src/auth/session.ts', 'a2\n');
    write(root, 'src/config/env.ts', 'c2\n');
    commit(root, 'work', '2026-01-03T10:00:00Z');
    write(root, 'src/new.ts', 'untracked\n');
    // Untracked notes that predate the plan are not its work.
    write(root, 'notes/old.md', 'n\n');
    fs.utimesSync(path.join(root, 'notes/old.md'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const project = { file: path.join(root, plan), repoPath: root, name: 'Refresh tokens', source: 'caddis', status: 'active' } as unknown as Project;
    const fp = await computeFootprint(project, []);
    const all = new Map(fp.areas.flatMap((a) => a.marked).map((f) => [f.path, f]));
    assert.equal(fp.git, true);
    assert.equal(fp.kind, 'plan');
    assert.equal(fp.sinceBasis, 'commit');
    assert.equal(all.get('src/auth/session.ts')?.state, 'changed');
    assert.deepEqual(all.get('src/auth/session.ts')?.where, ['Changes']);
    assert.equal(all.get('src/routes/logout.ts')?.state, 'planned');
    assert.equal(all.get('src/auth/revoke.ts')?.state, 'planned');
    assert.equal(all.get('src/auth/revoke.ts')?.exists, false);
    assert.equal(all.get('src/config/env.ts')?.state, 'outside');
    assert.equal(all.get('src/new.ts')?.state, 'outside');
    assert.equal(all.get('src/new.ts')?.added, true);
    assert.ok(!all.has(plan), 'the plan itself is not work');
    assert.ok(!all.has('dist/out.js'), 'ignored output is not planned');
    assert.ok(!all.has('README.md'), 'changed before the plan');
    assert.ok(!all.has('notes/old.md'), 'untracked but older than the plan');
    // Cited only in Context: not planned work, so its change counts as outside.
    assert.deepEqual(fp.counts, { named: 3, namedChanged: 1, outside: 2 });

    // Finished: the window ends at the plan's last commit, and the working tree is not counted.
    const done = await computeFootprint({ ...project, status: 'completed' }, []);
    const d = new Map(done.areas.flatMap((a) => a.marked).map((f) => [f.path, f]));
    assert.ok(d.has('src/new.ts') === false);
    assert.ok(done.until);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a Spec Kit spec without git: files from the walk, changes from its session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-fp-sk-'));
  try {
    fs.cpSync(path.resolve('test/fixtures/spec-kit-repo'), root, { recursive: true });
    write(root, 'src/api/tags.ts', 'x\n');
    write(root, 'src/models/tag.ts', 'x\n');
    write(root, 'src/other.ts', 'x\n');
    write(root, 'node_modules/dep/index.js', 'x\n');
    const [project] = scanRepo(root).filter((p) => p.source === 'spec-kit');
    assert.ok(project);
    const session = { cwd: root, repoPath: root, plan: { file: project.file }, touched: [{ path: 'src/api/tags.ts', edits: 1 }, { path: 'src/other.ts', edits: 2 }, { path: 'README.md', edits: 0 }] } as unknown as Session;
    const fp = await computeFootprint(project, [session]);
    const all = new Map(fp.areas.flatMap((a) => a.marked).map((f) => [f.path, f]));
    assert.equal(fp.git, false);
    assert.equal(fp.kind, 'spec');
    assert.equal(fp.sessions, 1);
    assert.equal(all.get('src/api/tags.ts')?.state, 'changed');
    assert.deepEqual(all.get('src/api/tags.ts')?.where, ['Phase 3']);
    assert.equal(all.get('src/models/tag.ts')?.state, 'planned');
    assert.equal(all.get('src/ui/PhotoView.tsx')?.exists, false);
    assert.equal(all.get('src/other.ts')?.state, 'outside');
    assert.ok(![...all.keys()].some((k) => k.startsWith('specs/')), 'the spec docs are not work');
    assert.ok(!fp.areas.some((a) => a.plain.some((f) => f.startsWith('node_modules'))));
    assert.equal(projectForDoc([project], path.join(root, 'specs/001-photo-tags/plan.md')), project);
    assert.equal(projectForDoc([project], path.join(root, 'src/api/tags.ts')), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('not a repo, missing files: degrades to an empty footprint', async () => {
  const fp = await computeFootprint({ file: '/nonexistent/x/plan.md', repoPath: '/nonexistent/x', name: 'x', source: 'caddis', status: 'active' } as unknown as Project, []);
  assert.equal(fp.files, 0);
  assert.deepEqual(fp.counts, { named: 0, namedChanged: 0, outside: 0 });
});
