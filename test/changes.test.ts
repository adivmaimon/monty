// web/reader-changes.js is browser code with no build step; load it into a bare context
// (no document) to test the section diff, as md.test.ts does for md.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'reader-changes.js');
const ctx: { window: any } = { window: {} };
vm.runInNewContext(fs.readFileSync(SRC, 'utf8'), ctx);
const C = ctx.window.MontyChanges;

const PLAN = `# Refresh tokens

**Status**: In progress
**Type**: Project

## Goal

Keep people signed in.

## Risk

**Low.** Small change.

## Phases

### Phase 1 - Session fields - DONE (2026-11-01)

### Phase 2 - Refresh endpoint

### Phase 3 - Client renewal

## Tests

- refresh works
- expiry works
`;

const kinds = (d: any) => [...d.sections].map((s: any) => `${s.title}:${s.kind}`);
const titles = (list: any) => [...list].map((s: any) => s.title);

test('first open: no snapshot, nothing to diff', () => {
  assert.equal(C.diffDoc(null, PLAN), null);
  assert.equal(C.diffDoc(undefined, PLAN), null);
});

test('identical text has no changes', () => {
  const d = C.diffDoc(PLAN, PLAN);
  assert.equal(d.count, 0);
  assert.ok(d.sections.every((s: any) => s.kind === 'same'));
  assert.equal(d.preamble.changed, false);
  assert.equal(d.status, null);
  assert.equal(d.risk, null);
  assert.deepEqual([...d.phasesDone], []);
});

test('blank lines and trailing spaces are not changes', () => {
  const d = C.diffDoc(PLAN, PLAN.replace('Keep people signed in.', 'Keep people signed in.   \n\n'));
  assert.equal(d.count, 0);
});

test('an added section', () => {
  const d = C.diffDoc(PLAN, PLAN + '\n## Open Questions\n\nLifetime when remember me is off?\n');
  assert.deepEqual(kinds(d).slice(-1), ['Open Questions:added']);
  assert.deepEqual([...d.sections.at(-1).added], ['Lifetime when remember me is off?']);
  assert.equal(d.count, 1);
});

test('a removed section, placed after the section it followed', () => {
  const d = C.diffDoc(PLAN, PLAN.replace('## Goal\n\nKeep people signed in.\n\n', ''));
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].title, 'Goal');
  assert.equal(d.removed[0].after, -1, 'Goal was first: it stood at the top');
  const d2 = C.diffDoc(PLAN, PLAN.replace(/## Phases[\s\S]*?## Tests/, '## Tests'));
  assert.equal(d2.removed[0].title, 'Phases');
  assert.equal(d2.sections[d2.removed[0].after].title, 'Risk');
  assert.equal(d2.count, 1);
});

test('an edited section lists only its new lines', () => {
  const d = C.diffDoc(PLAN, PLAN.replace('- expiry works', '- expiry works\n- revoked tokens fail'));
  const t = d.sections.find((s: any) => s.title === 'Tests');
  assert.equal(t.kind, 'edited');
  assert.deepEqual([...t.added], ['- revoked tokens fail']);
  assert.equal(t.removed, 0);
  const d2 = C.diffDoc(PLAN, PLAN.replace('- refresh works\n', ''));
  const t2 = d2.sections.find((s: any) => s.title === 'Tests');
  assert.equal(t2.kind, 'edited');
  assert.deepEqual([...t2.added], []);
  assert.equal(t2.removed, 1);
  assert.equal(d.count, 1);
});

test('reordered sections are not changes', () => {
  const swapped = PLAN.replace(/(## Risk\n\n.*\n\n)(## Phases[\s\S]*?)(## Tests)/, '$2$1$3');
  assert.notEqual(swapped, PLAN);
  const d = C.diffDoc(PLAN, swapped);
  assert.equal(d.count, 0);
  assert.deepEqual(titles(d.sections), ['Goal', 'Phases', 'Risk', 'Tests']);
});

test('a renamed heading with the same body is one renamed section, not removed plus added', () => {
  const d = C.diffDoc(PLAN, PLAN.replace('## Tests', '## Test plan'));
  const t = d.sections.find((s: any) => s.title === 'Test plan');
  assert.equal(t.kind, 'renamed');
  assert.equal(t.from, 'Tests');
  assert.equal(d.removed.length, 0);
  assert.equal(d.count, 1);
});

test('a new heading with a different body is added, the old one removed', () => {
  const d = C.diffDoc(PLAN, PLAN.replace('## Tests\n\n- refresh works\n- expiry works', '## Rollout\n\n- staff first\n- then everyone'));
  assert.equal(d.sections.find((s: any) => s.title === 'Rollout').kind, 'added');
  assert.deepEqual(titles(d.removed), ['Tests']);
  assert.equal(d.count, 2);
});

test('repeated titles pair up in order', () => {
  const a = '## Notes\n\none\n\n## Notes\n\ntwo\n';
  const d = C.diffDoc(a, '## Notes\n\none\n\n## Notes\n\ntwo, edited\n');
  assert.deepEqual(kinds(d), ['Notes:same', 'Notes:edited']);
});

test('status and risk: old and new value', () => {
  const next = PLAN.replace('**Status**: In progress', '**Status**: Blocked').replace('**Low.** Small change.', '**Medium.** 23 files import it.');
  const d = C.diffDoc(PLAN, next);
  assert.deepEqual({ ...d.status }, { from: 'In progress', to: 'Blocked' });
  assert.deepEqual({ ...d.risk }, { from: 'Low', to: 'Medium' });
  assert.equal(d.preamble.changed, true);
  assert.equal(d.sections.find((s: any) => s.title === 'Risk').kind, 'edited');
});

test('risk from a Risk line in the header, and "Low-medium"', () => {
  const d = C.diffDoc('# X\n\n**Risk**: Low\n\n## A\n\nx\n', '# X\n\n**Risk**: Low-medium\n\n## A\n\nx\n');
  assert.deepEqual({ ...d.risk }, { from: 'Low', to: 'Low-medium' });
  assert.equal(C.diffDoc('**Status:** Pending\n', '**Status:** Complete\n').status.to, 'Complete', '"**Status:**" form');
});

test('a phase done since last look', () => {
  const d = C.diffDoc(PLAN, PLAN.replace('### Phase 2 - Refresh endpoint', '### Phase 2 - Refresh endpoint - DONE (2026-11-06)'));
  assert.deepEqual([...d.phasesDone], [2]);
  assert.equal(d.sections.find((s: any) => s.title === 'Phases').kind, 'edited');
  // Phase headings as the sections (no ##): the DONE marker does not make it a rename.
  const h3 = '### Phase 1 - A\n\nx\n\n### Phase 2 - B\n\ny\n';
  const d2 = C.diffDoc(h3, h3.replace('### Phase 2 - B', '### Phase 2 - B - Done'));
  assert.deepEqual(kinds(d2), ['Phase 1 - A:same', 'Phase 2 - B - Done:edited']);
  assert.deepEqual([...d2.phasesDone], [2]);
  assert.deepEqual([...C.diffDoc(h3, h3.replace('### Phase 2 - B', '### Phase 2 - Complete the flow')).phasesDone], [], 'a phase named Complete...');
});

test('a heading inside a code fence is not a section', () => {
  const a = '## Example\n\n```md\n## Not a section\n```\n\n## Real\n\nx\n';
  assert.deepEqual(titles(C.splitDoc(a).sections), ['Example', 'Real']);
  const d = C.diffDoc(a, a.replace('## Not a section', '## Still not one'));
  assert.deepEqual(kinds(d), ['Example:edited', 'Real:same']);
});

test('files with only ### group by ###, as md.js does', () => {
  assert.deepEqual(titles(C.splitDoc('# T\n\n### A\n\n#### a1\n\n### B\n').sections), ['A', 'B']);
  assert.equal(C.splitDoc('# T\n\nintro\n\n## A\n').title, 'T');
});

test('lineDiff: LCS and the long-section fallback agree on what is new', () => {
  assert.deepEqual([...C.lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'y']).added], ['x', 'y']);
  const big = Array.from({ length: 700 }, (_, i) => 'line ' + i);
  const next = [...big.slice(0, 300), 'new one', ...big.slice(301)];
  const d = C.lineDiff(big, next);
  assert.deepEqual([...d.added], ['new one']);
  assert.equal(d.removed, 1);
});
