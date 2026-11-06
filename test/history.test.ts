// Plan history (src/history.ts): the pure parts on strings, then the index on throwaway
// git repos built with `git fast-import` in a temp folder (fast enough for 500 commits).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { attribute, datedWindow, historyFor, namedFiles, parseLog, resetHistoryMemory, specOfPath, trailer, type Commit } from '../src/history.js';
import type { Project } from '../src/types.js';

const DAY = 86_400_000;

test('parseLog: records, trailer, files; junk skipped', () => {
  const RS = '\x1e';
  const US = '\x1f';
  const text = `${RS}${'a'.repeat(40)}${US}1700000000${US}feat(x): one${US}Why.\n\nCaddis-Plan: project-search${US}\n\nsrc/a.ts\nweb/b.js\n`
    + `${RS}not a sha${US}1${US}s${US}${US}\n\nx\n`
    + `${RS}${'b'.repeat(40)}${US}1700000100${US}fix: two${US}${US}\n\nREADME.md\n`;
  const cs = parseLog(text);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[0], { sha: 'a'.repeat(40), t: 1700000000, subject: 'feat(x): one', plan: 'project-search', files: ['src/a.ts', 'web/b.js'] });
  assert.equal(cs[1]?.plan, undefined);
  assert.equal(trailer('x\n\nCaddis-Plan: .caddis/projects/active/project-y.md'), 'project-y', 'a path is reduced to the name');
});

test('specOfPath: each layout, keyed so a move between buckets keeps the spec', () => {
  assert.equal(specOfPath('.caddis/projects/active/project-x.md'), 'plan:project-x');
  assert.equal(specOfPath('.caddis/projects/completed/project-x.md'), 'plan:project-x');
  assert.equal(specOfPath('.claude/projects/parked/project-x.md'), 'plan:project-x');
  assert.equal(specOfPath('.caddis/projects/active/project-x.debate.md'), null);
  assert.equal(specOfPath('.caddis/caddis.md'), null);
  assert.equal(specOfPath('openspec/changes/add-auth/tasks.md'), 'openspec:add-auth');
  assert.equal(specOfPath('openspec/changes/archive/2026-01-02-add-auth/proposal.md'), 'openspec:add-auth');
  assert.equal(specOfPath('specs/001-photos/tasks.md'), 'spec-kit:001-photos');
  assert.equal(specOfPath('.kiro/specs/login/requirements.md'), 'kiro:login');
  assert.equal(specOfPath('src/a.ts'), null);
});

test('namedFiles: code-span paths, line numbers stripped, prose and URLs ignored', () => {
  const md = 'Edit `src/auth/session.ts:41-60` and `web/app.js`. Not `npm test`, not `~/.claude/x.md`, not `README`. ``src/a b.ts`` no.';
  assert.deepEqual(namedFiles(md).sort(), ['src/auth/session.ts', 'web/app.js']);
});

test('datedWindow: from the plan\'s own dates to the last one plus a day; open plans run to now', () => {
  const now = new Date(2026, 10, 6).getTime();
  const birth = new Date(2026, 9, 20).getTime();
  const text = 'Since 2020-01-01. Phase 1 DONE (2026-10-21). Phase 2 DONE (2026-10-23).';
  const w = datedWindow(text, birth, now, false, now) as [number, number];
  assert.equal(w[0], birth, '2020 is far before the file existed, so not its own');
  assert.equal(w[1], new Date(2026, 9, 24).getTime());
  assert.equal(datedWindow(text, birth, now, true, now)?.[1], now);
  assert.equal(datedWindow('no dates', 0, now, false, now), undefined);
});

const c = (sha: string, t: number, files: string[], plan?: string): Commit => ({ sha, t, subject: sha, plan, files });

test('attribute: trailer and spec commits exact, named files inside the span a guess, exact wins', () => {
  const commits = [
    c('e', 600, ['src/a.ts']), // after the span: not counted
    c('d', 500, ['.caddis/projects/completed/project-auth.md']),
    c('c', 400, ['src/a.ts', 'src/z.ts']), // inside the span, names a.ts: a guess
    c('b', 300, ['src/b.ts'], 'project-auth'),
    c('a', 200, ['.caddis/projects/active/project-auth.md', 'src/a.ts'], 'project-auth'),
    c('x', 350, ['lib/q.ts'], 'gone-plan'), // a plan deleted since
  ];
  const { specs, byCommit } = attribute(commits, [{ key: 'plan:project-auth', name: 'Auth', named: ['src/a.ts'] }]);
  assert.deepEqual(byCommit[0], []);
  assert.deepEqual(byCommit[1], [{ spec: 0, via: 'spec' }]);
  assert.deepEqual(byCommit[2], [{ spec: 0, via: 'window' }]);
  assert.deepEqual(byCommit[3], [{ spec: 0, via: 'trailer' }]);
  assert.deepEqual(byCommit[4], [{ spec: 0, via: 'trailer' }], 'one spec once, by its best source');
  assert.equal(specs[byCommit[5]?.[0]?.spec as number]?.name, 'Gone plan');
  // The trailer can drop the project- prefix.
  assert.deepEqual(attribute([c('a', 1, ['x'], 'auth')], [{ key: 'plan:project-auth', name: 'Auth', named: [] }]).byCommit[0], [{ spec: 0, via: 'trailer' }]);
});

test('attribute: a plan git never saw, by the dates in it; sweeps and claimed commits skipped', () => {
  const big = Array.from({ length: 150 }, (_, i) => `f${i}.ts`).concat('src/a.ts');
  const commits = [c('a', 150, ['src/a.ts']), c('b', 160, big), c('t', 170, ['src/a.ts'], 'other'), c('o', 900, ['src/a.ts'])];
  const { byCommit } = attribute(commits, [{ key: 'plan:p', name: 'P', named: ['src/a.ts'], dated: [100_000, 200_000] }]);
  assert.deepEqual(byCommit[0], [{ spec: 0, via: 'dates' }]);
  assert.deepEqual(byCommit[1], [], 'touches 151 files: a sweep');
  assert.equal(byCommit[2]?.some((g) => g.spec === 0), false, 'already claimed by its trailer');
  assert.deepEqual(byCommit[3], []);
});

// ---------- on real git ----------

interface FakeCommit { msg: string; t: number; files: Record<string, string | null> }

function fastImport(dir: string, commits: FakeCommit[], branch = 'main', from?: string): void {
  let s = '';
  commits.forEach((k, i) => {
    const msg = Buffer.from(k.msg);
    s += `commit refs/heads/${branch}\ncommitter T <t@example.com> ${k.t} +0000\ndata ${msg.length}\n${k.msg}\n`;
    if (i === 0 && from) s += `from ${from}\n`;
    for (const [f, body] of Object.entries(k.files)) {
      if (body === null) s += `D ${f}\n`;
      else s += `M 100644 inline ${f}\ndata ${Buffer.byteLength(body)}\n${body}\n`;
    }
    s += '\n';
  });
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: s });
}

function newRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'monty-hist-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}
const tmpCache = () => fs.mkdtempSync(path.join(os.tmpdir(), 'monty-cache-'));

function project(repo: string, rel: string, name: string, status: Project['status']): Project {
  return { id: name, repo: path.basename(repo), repoPath: repo, source: 'caddis', name, file: path.join(repo, rel), status, phases: [], tasks: { done: 0, total: 0 }, progress: { done: 0, total: 1, basis: 'status' }, updatedAt: '' };
}

test('historyFor: trailer and spec sources on a real repo, plan moved to completed', async () => {
  resetHistoryMemory();
  const repo = newRepo();
  const T = 1_760_000_000;
  fastImport(repo, [
    { msg: 'docs: plan', t: T, files: { '.caddis/projects/active/project-auth.md': '# Auth\nTouches `src/auth.ts`.\n', 'src/auth.ts': 'a', 'src/other.ts': 'o' } },
    { msg: 'feat: auth\n\nCaddis-Plan: project-auth', t: T + 100, files: { 'src/auth.ts': 'b', 'web/login.js': 'l' } },
    { msg: 'chore: unrelated', t: T + 200, files: { 'src/other.ts': 'p' } },
    { msg: 'docs: done', t: T + 300, files: { '.caddis/projects/active/project-auth.md': null, '.caddis/projects/completed/project-auth.md': '# Auth\n' } },
  ]);
  const h = await historyFor(repo, [], tmpCache());
  assert.equal(h.commits, 4);
  const auth = h.specs.findIndex((s) => s.name === 'Auth');
  assert.ok(auth >= 0, 'named from the trailer or path');
  assert.equal(h.specs[auth]?.commits, 3);
  assert.deepEqual(h.files['web/login.js']?.map((x) => [x[0], x[2]]), [[auth, 'trailer']]);
  assert.deepEqual(h.files['src/auth.ts']?.map((x) => x[2]), ['trailer'], 'best source kept');
  assert.equal(h.files['src/other.ts']?.length, 1, 'only the plan commit, not the unrelated one');
  assert.ok(h.areas.some((a) => a.name === 'src' && a.files.some(([f]) => f === 'src/other.ts')), 'area lists unchanged files too');
  assert.ok(Object.values(h.commitSpecs).every((xs) => xs.includes(auth)));
});

test('historyFor: a gitignored plan is placed by its dates and named files, and says so', async () => {
  resetHistoryMemory();
  const repo = newRepo();
  const now = Date.now();
  const day = (n: number) => new Date(now - n * DAY);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const noon = (n: number) => { const d = day(n); d.setHours(12, 0, 0, 0); return Math.floor(d.getTime() / 1000); };
  fastImport(repo, [
    { msg: 'before', t: noon(20), files: { 'src/model.ts': '0' } },
    { msg: 'during', t: noon(5), files: { 'src/model.ts': '1', 'README.md': 'r' } },
    { msg: 'after', t: noon(1), files: { 'src/model.ts': '2' } },
  ]);
  const rel = '.caddis/projects/completed/project-split.md';
  fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), `# Split\n\n**Status**: Complete\n\nChange \`src/model.ts\`.\n\n### Phase 1 - x - DONE (${iso(day(6))})\n### Phase 2 - y - DONE (${iso(day(4))})\n`);
  // Untracked and on disk only. Its birth time is now, so the window starts at the earliest date (no earlier than a month back).
  const h = await historyFor(repo, [], tmpCache(), {}, now);
  const split = h.specs.findIndex((s) => s.name === 'Split');
  assert.ok(split >= 0);
  assert.equal(h.specs[split]?.commits, 1);
  assert.deepEqual(h.files['src/model.ts']?.map((x) => x[2]), ['dates']);
  assert.deepEqual(h.specs[split]?.named, ['src/model.ts']);
  assert.equal(h.specs[split]?.file, path.join(repo, rel));
});

test('historyFor: 500 commits in under 3 s, cached on disk, topped up, rebuilt after a rewrite', async () => {
  resetHistoryMemory();
  const repo = newRepo();
  const cache = tmpCache();
  const T = 1_760_000_000;
  fastImport(repo, Array.from({ length: 500 }, (_, i) => ({ msg: `feat: step ${i}${i % 3 ? '' : '\n\nCaddis-Plan: project-p' + (i % 7)}`, t: T + i * 60, files: { [`src/m${i % 40}.ts`]: String(i), [`web/w${i % 13}.js`]: String(i) } })));
  const calls: string[][] = [];
  const trace = (a: string[]) => calls.push(a);
  const t0 = Date.now();
  const h = await historyFor(repo, [], cache, { trace });
  const ms = Date.now() - t0;
  assert.equal(h.commits, 500);
  assert.ok(ms < 3000, `built in ${ms} ms`);
  assert.equal(h.specs.length, 7);
  assert.ok(fs.readdirSync(path.join(cache, 'history')).length === 1, 'one cache file');

  // A fresh process (memory cleared): the disk cache answers, no git log.
  resetHistoryMemory();
  calls.length = 0;
  const again = await historyFor(repo, [], cache, { trace });
  assert.equal(again.commits, 500);
  assert.equal(calls.some((a) => a.includes('log')), false, 'no git log with a cache at HEAD');

  // One more commit: only the new range is read.
  fastImport(repo, [{ msg: 'feat: more\n\nCaddis-Plan: project-new', t: T + 99_999, files: { 'src/new.ts': 'n' } }], 'main', 'refs/heads/main^0');
  resetHistoryMemory();
  calls.length = 0;
  const more = await historyFor(repo, [], cache, { trace });
  assert.equal(more.commits, 501);
  const logs = calls.filter((a) => a.includes('log'));
  assert.equal(logs.length, 1);
  assert.ok(logs[0]?.some((a) => a.includes('..')), 'incremental range');
  assert.ok(more.specs.some((s) => s.name === 'New'));

  // HEAD moves to unrelated history: a full rebuild.
  fastImport(repo, [{ msg: 'root', t: T, files: { 'x.ts': 'x' } }], 'other');
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/other'], { cwd: repo });
  resetHistoryMemory();
  const other = await historyFor(repo, [], cache, { trace });
  assert.equal(other.commits, 1);
  assert.equal(other.specs.length, 0);
});

test('historyFor: open plans are listed with their named files even before any commit', async () => {
  resetHistoryMemory();
  const repo = newRepo();
  fastImport(repo, [{ msg: 'init', t: 1_760_000_000, files: { 'src/a.ts': 'a' } }]);
  const rel = '.caddis/projects/active/project-next.md';
  fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), '# Next\n\nTouches `src/a.ts` and `src/new.ts`.\n');
  const h = await historyFor(repo, [project(repo, rel, 'Next', 'active')], tmpCache());
  const next = h.specs.find((s) => s.name === 'Next');
  assert.deepEqual(next?.named, ['src/a.ts'], 'only files that exist');
  assert.equal(next?.status, 'active');
});

test('historyFor: no repo or no git gives an empty history, never a throw', async () => {
  resetHistoryMemory();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-nogit-'));
  const h = await historyFor(dir, [], tmpCache());
  assert.equal(h.specs.length, 0);
  assert.deepEqual(h.files, {});
  const repo = newRepo();
  fastImport(repo, [{ msg: 'init', t: 1_760_000_000, files: { 'a.ts': 'a' } }]);
  const none = await historyFor(repo, [], tmpCache(), { git: path.join(dir, 'no-such-git') });
  assert.equal(none.commits, 0);
  const empty = await historyFor(newRepo(), [], tmpCache());
  assert.equal(empty.commits, 0, 'a repo with no commits');
});
