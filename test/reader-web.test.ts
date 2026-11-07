// web/reader-modes.js is browser code with no build step; load it with md.js into a bare
// context, as md.test.ts does, and check section detection, the "None" fold, and that Brief
// and Full draw a Caddis plan, a legacy plan, a Spec Kit tasks.md and an OpenSpec change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseClaudeProject, scanRepo } from '../src/projects.js';
import { openQuestions, phaseDetails, riskLevel } from '../src/reader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ctx: { window: any } = { window: {} };
vm.createContext(ctx);
for (const f of ['md.js', 'reader-modes.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', f), 'utf8'), ctx);
const R = ctx.window.MontyReader;
// Values from the vm's realm: compare as plain data.
const P = (x: unknown) => JSON.parse(JSON.stringify(x));
const FIX = path.join(ROOT, 'test', 'fixtures');
const read = (rel: string) => fs.readFileSync(path.join(FIX, rel), 'utf8');

test('section kinds from headings', () => {
  const kinds = ['Changes', 'Files changed', 'Phases', '**Phases**', 'Tests', 'Testing', 'Open Questions', 'Open questions (2)', 'Goal', 'Risk', 'Context', 'Verification', 'What Changes', 'Phase 1: Setup']
    .map((t) => R.sectionKind(t));
  assert.deepEqual(P(kinds), ['changes', 'changes', 'phases', 'phases', 'tests', 'tests', 'questions', 'questions', 'goal', 'risk', null, null, null, null]);
});

test('"None", "N/A" and "Skipped: ..." sections fold; anything with content does not', () => {
  assert.deepEqual(P(R.emptyValue('None touched.')), { value: 'none', reason: '' });
  assert.deepEqual(P(R.emptyValue('N/A')), { value: 'n/a', reason: '' });
  assert.deepEqual(P(R.emptyValue('Skipped: caddis.md has no Experiments set.')), { value: 'skipped', reason: 'caddis.md has no Experiments set' });
  assert.deepEqual(P(R.emptyValue('**None.** Nothing to migrate.')), { value: 'none', reason: 'Nothing to migrate' });
  assert.equal(R.emptyValue('Nonetheless, two migrations.'), null);
  assert.equal(R.emptyValue('None of the adapters change.\n\n- but this list does'), null);
  assert.equal(R.emptyValue('| a | b |\n| --- | --- |\n| None | x |'), null);
  const secs = R.splitSections(read('reader/caddis-plan.md')).sections;
  const folded = R.collapseEmpty(secs);
  const empties = folded.filter((e: any) => e.type === 'empties');
  assert.equal(empties.length, 1);
  assert.deepEqual(P(empties[0].items.map((x: any) => [x.title, x.value])), [['Experiment', 'skipped'], ['Invariants', 'none'], ['Storage & State', 'n/a']]);
  // Folded where the first empty one stood: after Risk, before Changes.
  const order = folded.map((e: any) => (e.type === 'empties' ? '*' : e.s.title));
  assert.deepEqual(P(order.slice(0, 5)), ['Goal', 'Context', 'Risk', '*', 'Changes']);
});

test('sections ignore headings inside code fences; docs without ## split on ###', () => {
  const d = R.splitSections('# T\n\nintro\n\n## A\n\n```\n## not a heading\n```\n\n## B\nb');
  assert.equal(d.title, 'T');
  assert.deepEqual(P(d.sections.map((s: any) => s.title)), ['A', 'B']);
  assert.deepEqual(P(R.splitSections('# T\n\n### x\n1\n### y\n2').sections.map((s: any) => s.title)), ['x', 'y']);
});

test('phases, Changes rows and test files from a Caddis plan', () => {
  const secs = R.splitSections(read('reader/caddis-plan.md')).sections;
  const by = (t: string) => secs.find((s: any) => s.title === t).body;
  const ph = R.splitPhases(by('Phases'));
  assert.deepEqual(P(ph.phases.map((p: any) => [p.n, p.title, p.date, p.marked])), [[1, 'Session fields', '2026-11-03', true], [2, 'Refresh endpoint', '2026-11-05', true], [3, 'Rotation and revocation', '', false], [4, 'Client renewal', '', false]]);
  const rows = R.changesRows(by('Changes'));
  assert.equal(rows.length, 7);
  assert.deepEqual(P(rows[1]), { path: 'src/auth/tokens.ts', note: 'sign, hash, compare', isNew: true });
  assert.equal(rows[0].isNew, false);
  assert.deepEqual(P(R.changesRows('- `src/a.ts` - edit it\n- `src/{b,c}.ts`: New.\n- see `src/d.ts` later').map((r: any) => [r.path, r.isNew])), [['src/a.ts', false], ['src/b.ts', true], ['src/c.ts', true]]);
  assert.deepEqual(P(R.testFiles(by('Tests')).map((t: any) => [t.path, t.note])), [['test/refresh.test.ts', 'rotation and reuse'], ['test/logout.test.ts', 'revoke-all'], ['web/src/api/client.test.ts', 'retry once']]);
});

/** What /api/reader would send for a doc, from the same parsers, minus git. */
function dataFor(text: string, files: any[] = []) {
  return { questions: openQuestions(text), phases: phaseDetails(text), risk: riskLevel(text) ? { level: riskLevel(text) } : undefined, files, tests: [], git: true, since: '2026-11-01T00:00:00Z' };
}
const render = (mode: string, md: string, file: string, project: any, data: any) => R.render({ md, file, project, data, mode, state: { sessions: [] } });

test('Brief on a Caddis plan: status, risk, stepper with dates, questions, files', () => {
  const file = '/r/.caddis/projects/active/project-refresh.md';
  const md = read('reader/caddis-plan.md');
  const p = parseClaudeProject(md, { file, repo: 'r', repoPath: '/r', bucket: 'active', source: 'caddis' });
  const files = [
    { path: 'src/auth/session.ts', named: true, exists: true, changed: true, via: ['git'] },
    { path: 'src/auth/tokens.ts', named: true, exists: false, changed: false, via: [] },
    { path: 'config/env.ts', named: false, exists: true, changed: true, via: ['session'] },
  ];
  const data = dataFor(md, files);
  (data.phases[0] as any).commit = { hash: 'a41c9e2ffff', date: '2026-11-03T10:00:00Z', subject: 'feat: fields' };
  const out = render('brief', md, file, p, data);
  assert.equal(out.mode, 'brief');
  assert.match(out.doc, /<h1>Refresh tokens for login<\/h1>/);
  assert.match(out.doc, /risk medium/);
  assert.match(out.doc, /3 Nov · <span title="feat: fields[^"]*">a41c9e2<\/span>/);
  assert.match(out.doc, /rm-step cur[\s\S]*revoke-all returns 204/);
  assert.match(out.doc, /rm-step todo[\s\S]*Client renewal/);
  assert.match(out.doc, /data-rm-answer="Yes"/);
  assert.match(out.doc, /data-rm-answer="24 hours"/);
  assert.match(out.doc, /Answered: Postgres, beside sessions/);
  // Files changed are the Footprint tile's job (web/footprint.js), not Brief's.
  assert.doesNotMatch(out.doc, /planned files changed/);
  assert.match(out.doc, /class="lbl">Phases<\/span>[\s\S]*2 of 4 done/);
  assert.equal(out.side, '');
});

test('Full on a Caddis plan: TOC, file tree, vertical stepper, tests, folded empties, callout', () => {
  const file = '/r/.caddis/projects/active/project-refresh.md';
  const md = read('reader/caddis-plan.md');
  const p = parseClaudeProject(md, { file, repo: 'r', repoPath: '/r', bucket: 'active', source: 'caddis' });
  const out = render('full', md, file, p, dataFor(md, [{ path: 'src/auth/session.ts', named: true, exists: true, changed: true, via: ['git'] }, { path: 'config/env.ts', named: false, exists: true, changed: true, via: ['trailer'] }]));
  assert.equal(out.mode, 'full');
  assert.match(out.side, /data-rm-toc="\d+">Changes</);
  assert.doesNotMatch(out.side, />Invariants</);
  assert.match(out.doc, /class="rm-dir">src\/auth\//);
  assert.match(out.doc, /tokens\.ts <span class="rm-new"/);
  assert.match(out.doc, /class="rm-frow out"[\s\S]*env\.ts[\s\S]*changed, not in plan/);
  assert.match(out.doc, /1 of 7 done/);
  assert.match(out.doc, /<details class="rm-vstep cur"[^>]* open>/);
  assert.match(out.doc, /rm-vstep done[\s\S]*Session fields/);
  assert.match(out.doc, /<code>test\/refresh\.test\.ts<\/code>/);
  assert.match(out.doc, /rm-empties[\s\S]*Experiment<\/span> skipped/);
  assert.match(out.doc, /class="callout callout-warning"/);
  // The goal is in the header, not repeated as a section.
  assert.doesNotMatch(out.side, />Goal</);
});

test('Brief and Full on a legacy .claude/projects plan', () => {
  const file = '/r/.claude/projects/active/project-photo-upload.md';
  const md = read('reader/legacy-plan.md');
  const p = parseClaudeProject(md, { file, repo: 'r', repoPath: '/r', bucket: 'active' });
  const b = render('brief', md, file, p, dataFor(md));
  assert.match(b.doc, /rm-step done[\s\S]*the upload form/);
  assert.match(b.doc, /rm-step cur[\s\S]*resize on the server/);
  assert.match(b.doc, /data-rm-answer="convert to JPEG"/);
  assert.doesNotMatch(b.doc, /risk /);
  assert.doesNotMatch(b.doc, /lbl">Files/); // no file facts: the strip is left out, not drawn empty
  const f = render('full', md, file, p, dataFor(md));
  assert.match(f.doc, /rm-vstep done/);
});

test('Brief and Full on a Spec Kit tasks.md: phases with checklist counts, task count', () => {
  const p = scanRepo(path.join(FIX, 'spec-kit-repo')).find((x) => x.source === 'spec-kit');
  assert.ok(p);
  const md = fs.readFileSync(p.file, 'utf8');
  const data = dataFor(md, [{ path: 'src/api/tags.ts', named: true, exists: true, changed: true, via: ['git'] }, { path: 'src/ui/AlbumView.tsx', named: true, exists: false, changed: false, via: [] }]);
  const b = render('brief', md, p.file, p, data);
  assert.match(b.doc, /spec kit/);
  assert.match(b.doc, /\d+ of 8 tasks/);
  assert.match(b.doc, /rm-step done[\s\S]*Setup \(Shared Infrastructure\)[\s\S]*2 of 2/);
  assert.match(b.doc, /rm-step cur[\s\S]*T005 Add the tag input/);
  assert.doesNotMatch(b.doc, /Open questions/);
  const f = render('full', md, p.file, p, data);
  assert.equal(f.mode, 'full');
  assert.match(f.side, /Phase 1: Setup/);
});

test('Brief and Full on an OpenSpec change; other docs linked; Full for non-plan docs', () => {
  const p = scanRepo(path.join(FIX, 'openspec-repo')).find((x) => x.source === 'openspec' && x.status !== 'completed');
  assert.ok(p);
  const md = fs.readFileSync(p.file, 'utf8');
  const tasks = fs.readFileSync(path.join(path.dirname(p.file), 'tasks.md'), 'utf8');
  const data = { ...dataFor(md), phases: phaseDetails(tasks) };
  const b = render('brief', md, p.file, p, data);
  assert.match(b.doc, /openspec/);
  assert.match(b.doc, /rm-step cur[\s\S]*Add \?tag= to GET \/albums\/:id/);
  assert.match(b.doc, /Also in this change[\s\S]*tasks\.md/);
  const f = render('full', md, p.file, p, data);
  assert.match(f.side, /In this change/);
  // A doc that is no plan: Brief is not offered, Full renders it.
  assert.equal(R.modeFor(false), 'full');
  const skill = R.render({ md: '---\nname: ship\ndescription: Ships it\n---\n\n## Steps\n\n1. Go', file: '/r/.claude/skills/ship/SKILL.md', project: null, mode: 'brief', state: null, docKind: () => 'Skill', frontmatter: (t: string) => ({ data: { name: 'ship', description: 'Ships it' }, body: t.replace(/^---[\s\S]*?---\n/, '') }) });
  assert.equal(skill.mode, 'full');
  assert.match(skill.doc, /Ships it/);
});
