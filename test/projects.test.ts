// Project and spec parsing. Strings mirror the shapes found in real plan files
// on 23 Oct 2026: **Status** lines written ~15 ways, phases as headings, and
// "Phase N ... DONE" markers in prose rather than checkboxes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countCheckboxes, findPhases, findStatusLine, parseClaudeProject, phasesFromCheckboxGroups, resolveStatus } from '../src/projects.js';

const where = { file: '/p/Garden/.claude/projects/active/project-photo-upload.md', repo: 'Garden', repoPath: '/p/Garden', bucket: 'active' as const };

test('status line variants', () => {
  for (const [line, want] of [
    ['**Status:** Complete', 'Complete'],
    ['**Status**: Complete (2026-09-23)', 'Complete (2026-09-23)'],
    ['**Status:** Complete - device verification outstanding', 'Complete - device verification outstanding'],
    ['Status: Pending', 'Pending'],
    ['**Status**: In progress', 'In progress'],
  ]) assert.equal(findStatusLine(['# T', '', line as string]), want);
});

test('folder wins for finished work; Status line refines active', () => {
  assert.equal(resolveStatus('completed', 'Pending'), 'completed');
  assert.equal(resolveStatus('active', 'Pending'), 'pending');
  assert.equal(resolveStatus('active', 'In progress'), 'active');
  assert.equal(resolveStatus('active', 'Complete (2026-10-10)'), 'completed');
  assert.equal(resolveStatus('active', undefined), 'active');
});

test('phases from headings, done from prose markers', () => {
  const lines = [
    '## Phases',
    '### Phase 1 - backend and plan lookup',
    '### Phase 2 - admin saving and modelling',
    '### Phase 3 - frontend',
    '',
    '- **Phase 1 DONE & verified (2026-07-18):** routes moved',
    '> ### ✅ Phase 2 - DONE (shipped 2026-05-31)'.replace(/^>\s?/, ''),
  ];
  const p = findPhases(lines, false);
  assert.deepEqual(p.map((x) => [x.n, x.done]), [[1, true], [2, true], [3, false]]);
  assert.equal(p[0]?.title, 'backend and plan lookup');
});

test('"complete when" does not mark a phase done', () => {
  const p = findPhases(['### Phase 1 - Parser', 'Phase 1 is complete when the parser passes.'], false);
  assert.equal(p[0]?.done, false);
});

test('phases written as bold bullets', () => {
  const p = findPhases(['- **Phase 1 — code wording — DONE.** text', '- **Phase 2 — the replace engine.** text'], false);
  assert.deepEqual(p.map((x) => [x.n, x.done]), [[1, true], [2, false]]);
});

test('a project in completed/ has every phase done', () => {
  const p = findPhases(['### Phase 1 - a', '### Phase 2 - b'], true);
  assert.ok(p.every((x) => x.done));
});

test('parse a whole plan: title, goal, progress basis', () => {
  const md = [
    '# Photo upload: three named shots, each with a countdown',
    '',
    '**Status**: Active',
    '',
    '## Goal',
    '',
    'Every upload takes three photographs,',
    'each of a named view.',
    '',
    '## Phases',
    '### Phase 1 - hook',
    '### Phase 2 - screens',
    '',
    '- **Phase 1 - hook - DONE.**',
  ].join('\n');
  const p = parseClaudeProject(md, where);
  assert.equal(p.name, 'Photo upload: three named shots, each with a countdown');
  assert.equal(p.goal, 'Every upload takes three photographs, each of a named view.');
  assert.equal(p.status, 'active');
  assert.deepEqual(p.progress, { done: 1, total: 2, basis: 'phases' });
});

test('slug headings are prettified', () => {
  const p = parseClaudeProject('# project-v1-foundation\n\n**Status**: Pending\n', where);
  assert.equal(p.name, 'V1 foundation');
  assert.equal(p.status, 'pending');
});

test('checkboxes: OpenSpec, Spec Kit, Kiro styles', () => {
  const md = '## 1. Setup\n- [x] 1.1 Create table\n- [ ] 1.2 Add index\n- [X] T001 [P] [US1] Model in src/a.ts\n  - [ ] 2.1 nested\n- [-] in progress kiro\n';
  assert.deepEqual(countCheckboxes(md), { done: 2, total: 5 });
});

test('Spec Kit phases are done when all their tasks are ticked', () => {
  const md = '## Phase 1: Setup\n- [x] T001 a\n- [x] T002 b\n## Phase 2: Foundational\n- [x] T003 c\n- [ ] T004 d\n';
  assert.deepEqual(phasesFromCheckboxGroups(md).map((p) => [p.n, p.done]), [[1, true], [2, false]]);
});

test('a Status line saying "Phase 2 done" counts phases 1 and 2; prose "is done when" counts nothing', () => {
  const md = '# X\n\n**Status**: Phase 2 done (2026-10-25)\n\n## Phase 1 - A\n\nPhase 3 is done when the gate passes.\n\n## Phase 2 - B\n\n## Phase 3 - C\n\n## Phase 4 - D\n';
  const p = parseClaudeProject(md, where);
  assert.deepEqual(p.phases.map((ph) => ph.done), [true, true, false, false]);
  assert.equal(p.label, 'Phase 3 of 4');
});

test('"### Phase 2 - Engine (done)" in lowercase marks the phase', () => {
  const phases = findPhases(['## Phase 1 - Setup', '### Phase 2 - Engine (done)'], false);
  assert.deepEqual(phases.map((p) => p.done), [false, true]);
});

test('phases written as bold paragraphs are found, with the title after the bold', () => {
  const phases = findPhases(['**Phase 1** — the refund flow. Then more prose.', '', '**Phase 2** — admin credits'], false);
  assert.deepEqual(phases.map((p) => [p.n, p.title]), [[1, 'the refund flow'], [2, 'admin credits']]);
});

test('the label names the first phase not done, by its own number', () => {
  const md = '# X\n\n## Phase 0 - Spike - DONE\n\n## Phase 1 - A\n\n## Phase 2 - B - DONE\n';
  assert.equal(parseClaudeProject(md, where).label, 'Phase 1 of 3');
});

test('a bullet that starts with "Status" but has no colon is not the Status line', () => {
  assert.equal(findStatusLine(['- Status alerts end with a full stop.', '**Status:** Active']), 'Active');
});

test('"Phase 2 done; Phase 1 waits for the owner" leaves Phase 1 open', () => {
  const md = '# X\n\n**Status**: Phase 2 done (2026-10-24); Phase 1 waits for the owner\n\n## Phase 1 - A\n\n## Phase 2 - B\n\n## Phase 3 - C\n';
  const p = parseClaudeProject(md, where);
  assert.deepEqual(p.phases.map((ph) => ph.done), [false, true, false]);
  assert.equal(p.label, 'Phase 1 of 3');
});

test('phase titles: "**Phase 1.** text", a bare first mention, and "DONE, commit x" trimmed; cancelled plans say so', () => {
  const phases = findPhases(['**Phase 1.** the stack fills. DONE, commit adb03d', '**Phase 2**', 'later:', '**Phase 2**: Extend the alerts'], false);
  assert.deepEqual(phases.map((p) => p.title), ['the stack fills', 'Extend the alerts']);
  const p = parseClaudeProject('# X\n\n## Phase 1 - A\n\n## Phase 2 - B\n', { ...where, bucket: 'cancelled' });
  assert.equal(p.label, 'cancelled');
});
