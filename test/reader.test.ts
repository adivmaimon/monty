// What the reader's Brief and Full modes add for a plan (src/reader.ts), and the one write
// Monty makes: answering an open question (src/answers.ts). Plans here are invented, in the
// shapes Caddis, the older .claude/projects convention, Spec Kit, OpenSpec and Kiro write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { knownPlanFile, matchPhaseCommits, namedPaths, openQuestions, parseGitLog, parseGitStatus, phaseDetails, readerData, riskLevel } from '../src/reader.js';
import { answerQuestion, applyAnswer, refuseRequest, undoAnswer } from '../src/answers.js';
import type { Project } from '../src/types.js';
import { isUnderKnown } from '../src/state.js';

test('only a known plan under a project root may be read for the reader or answered', () => {
  const p = { file: '/p/Garden/.caddis/projects/active/project-x.md', docs: ['/p/Garden/specs/1/design.md'] } as Project;
  const under = (f: string) => isUnderKnown(f, ['/p'], []);
  assert.equal(knownPlanFile('/p/Garden/.caddis/projects/active/project-x.md', [p], under), p);
  assert.equal(knownPlanFile('/p/Garden/specs/1/design.md', [p], under), p);
  assert.equal(knownPlanFile('/p/Garden/README.md', [p], under), undefined);
  assert.equal(knownPlanFile('/p/Garden/../../etc/x.md', [p], under), undefined);
  assert.equal(knownPlanFile(p.file, [p], () => false), undefined);
});

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');
const read = (rel: string) => fs.readFileSync(path.join(FIX, rel), 'utf8');
const caddis = read('reader/caddis-plan.md');
const legacy = read('reader/legacy-plan.md');

test('risk level is the first word of the Risk section, only when stated', () => {
  assert.equal(riskLevel(caddis), 'medium');
  assert.equal(riskLevel('# X\n\n## Risk\n\n**Medium-high.** Four formats.'), 'medium-high');
  assert.equal(riskLevel('# X\n\n## Risk\n\nLow / Medium / High and why.'), undefined);
  assert.equal(riskLevel('# X\n\n## Risk\n\nThe auth middleware runs everywhere.'), undefined);
  assert.equal(riskLevel(legacy), undefined);
});

test('open questions: bullets with defaults, a recommendation, an answered one', () => {
  const qs = openQuestions(caddis);
  assert.equal(qs.length, 3);
  assert.equal(qs[0]?.text, 'Should revoke-all also end the current session?');
  assert.equal(qs[0]?.default, 'Yes');
  assert.equal(qs[1]?.text, 'Refresh lifetime when "remember me" is off?');
  assert.equal(qs[1]?.default, '24 hours');
  assert.equal(qs[1]?.detail, 'The plan uses 30 days everywhere.');
  assert.equal(qs[0]?.detail, undefined);
  assert.equal(qs[2]?.default, undefined);
  assert.equal(qs[2]?.answer?.text, 'Postgres, beside sessions');
  assert.equal(qs[2]?.answer?.undoable, true);
});

test('open questions as ### headings; "None" is not a question', () => {
  const qs = openQuestions(legacy);
  assert.deepEqual(qs.map((q) => [q.text, q.default, q.form]), [
    ['Should HEIC be converted?', 'convert to JPEG', 'heading'],
    ['Max size?', undefined, 'heading'],
  ]);
  assert.deepEqual(openQuestions('# X\n\n## Open Questions\n\nNone.\n'), []);
  assert.deepEqual(openQuestions('# X\n\n## Open Questions\n\n- None\n'), []);
  // A review decision written by the owner in prose counts as an answer, but only Monty's own line can be undone.
  const q = openQuestions('# X\n\n## Open Questions\n\n- Tool label always? Yes, shown whenever any session is not Claude Code (owner, 2026-10-23).\n')[0];
  assert.ok(q?.answer);
  assert.equal(q?.answer?.undoable, false);
});

test('phase details from Caddis headings: DONE date, gate, checklist', () => {
  const ph = phaseDetails(caddis);
  assert.deepEqual(ph.map((p) => [p.n, p.title, p.date]), [
    [1, 'Session fields', '2026-11-03'],
    [2, 'Refresh endpoint', '2026-11-05'],
    [3, 'Rotation and revocation', undefined],
    [4, 'Client renewal', undefined],
  ]);
  assert.equal(ph[0]?.gate, 'npm test passes.');
  assert.deepEqual(ph[2]?.items, [
    { text: 'new token on rotate', done: true },
    { text: 'reuse revokes family', done: true },
    { text: 'revoke-all returns 204', done: false },
  ]);
  assert.equal(ph[2]?.gate, undefined);
});

test('phase details from a legacy plan, Spec Kit, OpenSpec and Kiro', () => {
  assert.deepEqual(phaseDetails(legacy).map((p) => p.title), ['the upload form', 'resize on the server']);
  const sk = phaseDetails(read('spec-kit-repo/specs/001-photo-tags/tasks.md'));
  assert.equal(sk.length, 5);
  assert.equal(sk[0]?.title, 'Setup (Shared Infrastructure)');
  // Sub-headings inside a phase ("### Implementation for User Story 1") stay in it; [US1] and [P] are dropped.
  assert.deepEqual(sk[2]?.items, [
    { text: 'T004 Add POST /photos/:id/tags in src/api/tags.ts', done: true },
    { text: 'T005 Add the tag input to src/ui/PhotoView.tsx', done: false },
  ]);
  const os1 = phaseDetails(read('openspec-repo/openspec/changes/add-tags/tasks.md'));
  assert.deepEqual(os1.map((p) => [p.n, p.title, p.items.length]), [[1, 'Storage', 2], [2, 'API', 2], [3, 'Verification', 1]]);
  const kiro = phaseDetails('- [ ] 1. Build auth\n  - [x] 1.1 Login form\n  - [ ] 1.2 Session\n- [ ] 2. Polish\n');
  assert.deepEqual(kiro.map((p) => [p.n, p.title, p.items.map((i) => i.text)]), [[1, 'Build auth', ['Login form', 'Session']], [2, 'Polish', []]]);
});

test('named paths: code spans, bare task paths, braces; not URLs, dirs or placeholders', () => {
  const got = namedPaths([
    '| `src/auth/session.ts:41` | x |',
    '- [ ] T010 Add the route in src/routes/export.ts.',
    'See https://example.com/a/b.html and `src/agents/` and `src/agents/<tool>.ts`.',
    '`menubar/App/{Model,Dropdown}.swift`, `README.md`, `/repo/web/app.js`, `/elsewhere/x.ts`',
    '```',
    'not/this.ts',
    '```',
  ].join('\n'), '/repo');
  assert.deepEqual(got, [
    { path: 'src/auth/session.ts', root: false },
    { path: 'src/routes/export.ts', root: false },
    { path: 'menubar/App/Model.swift', root: false },
    { path: 'menubar/App/Dropdown.swift', root: false },
    { path: 'README.md', root: true },
    { path: 'web/app.js', root: false },
  ]);
});

test('git output parsing and phase commits matched by DONE date', () => {
  const log = '\x1eaaa\x1f2026-11-03T10:00:00+02:00\x1ffeat: one\x1ffeat: one\n\nCaddis-Plan: project-x\n\nM\tsrc/a.ts\nA\tsrc/b.ts\n'
    + '\x1ebbb\x1f2026-11-05T09:00:00+02:00\x1ffix: two\x1ffix: two\n\nM\tsrc/c.ts\n';
  const cs = parseGitLog(log);
  assert.deepEqual(cs.map((c) => [c.hash, c.plans, c.files.map((f) => f.status + f.path)]), [['aaa', ['project-x'], ['Msrc/a.ts', 'Asrc/b.ts']], ['bbb', [], ['Msrc/c.ts']]]);
  const st = parseGitStatus(' M src/a.ts\0?? src/new.ts\0R  src/to.ts\0src/from.ts\0');
  assert.deepEqual([...st], [['src/a.ts', ' M'], ['src/new.ts', '??'], ['src/to.ts', 'R ']]);
  const m = matchPhaseCommits(
    [{ n: 1, title: '', date: '2026-11-03', items: [] }, { n: 2, title: '', date: '2026-11-03', items: [] }, { n: 3, title: '', items: [] }],
    [{ hash: 'c1', date: '2026-11-03T09:00:00Z', subject: '' }, { hash: 'c2', date: '2026-11-03T10:00:00Z', subject: '' }, { hash: 'c3', date: '2026-11-03T11:00:00Z', subject: '' }],
  );
  assert.deepEqual([...m].map(([n, c]) => [n, c.hash]), [[2, 'c3'], [1, 'c2']]);
});

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('readerData: changed, not yet, changed for the plan outside it, and phase commits', { skip: !hasGit && 'git not installed' }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-reader-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-03T10:00:00', GIT_COMMITTER_DATE: '2026-11-03T10:00:00' } });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  const plan = path.join(repo, 'plans', 'project-x.md');
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, '# X\n\n## Changes\n\n| File | Change |\n| --- | --- |\n| `src/a.ts` | edit |\n| `src/b.ts` | New |\n\n## Phases\n\n### Phase 1 - one - DONE (2026-11-03)\n\n### Phase 2 - two\n');
  g('add', '.');
  g('commit', '-q', '-m', 'docs: plan');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'a');
  fs.writeFileSync(path.join(repo, 'src', 'env.ts'), 'e');
  g('add', '.');
  g('commit', '-q', '-m', 'feat: a', '-m', 'Caddis-Plan: project-x');
  const p = { id: 'r:x', repo: 'r', repoPath: repo, source: 'caddis', name: 'X', file: plan, status: 'active', phases: [], tasks: { done: 0, total: 0 }, progress: { done: 0, total: 1, basis: 'status' }, updatedAt: new Date().toISOString() } as Project;
  const d = await readerData(p, [], Date.now() + 1e6);
  assert.equal(d.git, true);
  const by = new Map(d.files.map((f) => [f.path, f]));
  assert.equal(by.get('src/a.ts')?.changed, true);
  assert.equal(by.get('src/b.ts')?.changed, false);
  assert.equal(by.get('src/b.ts')?.exists, false);
  assert.equal(by.get('src/env.ts')?.named, false);
  assert.deepEqual(by.get('src/env.ts')?.via, ['trailer']);
  assert.equal(d.phases[0]?.commit?.subject, 'feat: a');
  assert.equal(d.phases[1]?.commit, undefined);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('answering writes one decision line under the question, and undo takes exactly it out', () => {
  const r = answerQuestion(caddis, 0, 'Should revoke-all also end the current session?', 'Yes', '2026-11-06');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.line, '  - Decided: Yes (owner, 2026-11-06)');
  assert.match(r.text, /end the current session\? Default: Yes\n {2}- Decided: Yes \(owner, 2026-11-06\)\n- Refresh lifetime/);
  assert.equal(openQuestions(r.text)[0]?.answer?.text, 'Yes');
  const u = undoAnswer(r.text, r.line);
  assert.ok(u.ok);
  if (u.ok) assert.equal(u.text, caddis);
  // A heading question gets a paragraph, and loses its blank line again on undo.
  const h = answerQuestion(legacy, 1, 'Max size?', '20 MB', '2026-11-06');
  assert.ok(h.ok);
  if (!h.ok) return;
  assert.match(h.text, /### Max size\?\n\nDecided: 20 MB \(owner, 2026-11-06\)\n\n## Notes/);
  const hu = undoAnswer(h.text, h.line);
  assert.ok(hu.ok);
  if (hu.ok) assert.equal(hu.text, legacy);
});

test('answering refuses a moved question, an answered one, and lines Monty did not write', () => {
  assert.equal(answerQuestion(caddis, 0, 'Something else?', 'Yes', '2026-11-06').ok, false);
  assert.equal(answerQuestion(caddis, 2, 'Which store holds the families?', 'Redis', '2026-11-06').ok, false);
  assert.equal(answerQuestion(caddis, 0, 'Should revoke-all also end the current session?', '   ', '2026-11-06').ok, false);
  assert.equal(undoAnswer(caddis, '## Goal').ok, false);
  const multi = answerQuestion(caddis, 0, 'Should revoke-all also end the current session?', 'Yes\n## Injected', '2026-11-06');
  assert.ok(multi.ok && !multi.text.includes('\n## Injected'));
});

test('/api/answer guards: other sites, non-JSON, files that are not a known plan', () => {
  assert.equal(refuseRequest({ origin: 'https://evil.example', 'content-type': 'application/json' }, 4747), 'Not from this panel');
  assert.equal(refuseRequest({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, 4747), 'Not from this panel');
  assert.equal(refuseRequest({ origin: 'http://127.0.0.1:4747', 'content-type': 'text/plain' }, 4747), 'JSON only');
  assert.equal(refuseRequest({ origin: 'http://127.0.0.1:4747', 'content-type': 'application/json' }, 4747), null);
  assert.equal(refuseRequest({ 'content-type': 'application/json' }, 4747), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-answer-'));
  const f = path.join(dir, 'plan.md');
  fs.writeFileSync(f, caddis);
  const body = { file: f, index: 0, question: 'Should revoke-all also end the current session?', answer: 'Yes' };
  assert.equal(applyAnswer(body, () => false).ok, false);
  assert.equal(fs.readFileSync(f, 'utf8'), caddis);
  assert.equal(applyAnswer({ ...body, file: path.join(dir, 'x.txt') }, () => true).ok, false);
  const r = applyAnswer(body, () => true, '2026-11-06');
  assert.ok(r.ok);
  assert.match(fs.readFileSync(f, 'utf8'), /Decided: Yes \(owner, 2026-11-06\)/);
  if (r.ok) assert.ok(applyAnswer({ file: f, undo: r.line }, () => true).ok);
  assert.equal(fs.readFileSync(f, 'utf8'), caddis);
  fs.rmSync(dir, { recursive: true, force: true });
});
