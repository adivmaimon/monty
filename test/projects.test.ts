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
