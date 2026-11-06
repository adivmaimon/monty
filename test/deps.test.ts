// Dependencies between specs and open questions (src/deps.ts). Line shapes mirror real
// Caddis plans ("**Depends on:** project-dc-04-page-shell.md, ... ") and the forms other
// repos write ("Requires [Albums](../002-albums/spec.md)", "Blocked by: Albums").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyRefs, linkSpecs, openQuestions } from '../src/deps.js';
import { scanRepo } from '../src/projects.js';
import type { Project } from '../src/types.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

test('Caddis Depends on line: file names, None, a trailing note', () => {
  assert.deepEqual(dependencyRefs('# T\n\n**Depends on:** project-a.md, project-b.md\n').items, ['project-a.md', 'project-b.md']);
  assert.deepEqual(dependencyRefs('**Depends on:** None\n').items, []);
  assert.deepEqual(dependencyRefs('- **Depends on:** project-dc-22-page-system.md, for `PageIndex`\n').items, ['PageIndex', 'project-dc-22-page-system.md', 'for']);
});

test('a wrapped Depends on line runs on to the end of its paragraph', () => {
  const r = dependencyRefs('**Depends on**: `completed/project-a.md`, `completed/project-b.md`,\n`completed/project-c.md` (the harness)\n**Type**: Project\n- **Requires** nothing here\n');
  assert.deepEqual(r.items, ['completed/project-a.md', 'completed/project-b.md', 'completed/project-c.md', 'nothing here']);
});

test('Requires and Blocked by, with links, code spans and "and"', () => {
  const r = dependencyRefs('**Requires**: [Photo tags](../001-photo-tags/spec.md)\nBlocked by: Albums and Search\n');
  assert.deepEqual(r.links, ['../001-photo-tags/spec.md']);
  assert.deepEqual(r.items, ['Photo tags', 'Albums', 'Search']);
});

test('lines in code fences and prose that merely mentions the words are not dependency lines', () => {
  const r = dependencyRefs('```\n**Depends on:** project-x.md\n```\nThis plan depends on nothing.\n');
  assert.deepEqual(r, { links: [], items: [] });
});

test('open questions: unanswered bullets and NEEDS CLARIFICATION markers count, answered ones do not', () => {
  const md = [
    '## Open Questions',
    '- Default to 3? Recommended: 3.',
    '  - a sub-point is detail, not another question',
    '- Hash tokens? Yes (owner, 2026-11-02).',
    '- ~~Old question~~',
    '- Decided: keep it.',
    '',
    '## Summary',
    '- not a question',
    'FR-001 [NEEDS CLARIFICATION: who sees it?]',
  ].join('\n');
  assert.equal(openQuestions(md), 2);
  assert.equal(openQuestions('## Open Questions\n\nNone: nothing left.\n'), 0);
  assert.equal(openQuestions('## Open Questions\n\n- None\n'), 0);
  assert.equal(openQuestions('# No section\n'), 0);
});

const proj = (id: string, name: string, file: string, source: Project['source'] = 'caddis'): Project => ({
  id: 'R:' + id, repo: 'R', repoPath: '/r', source, name, file, status: 'active', phases: [], tasks: { done: 0, total: 0 },
  progress: { done: 0, total: 1, basis: 'status' }, updatedAt: '2026-11-01T00:00:00.000Z',
});

test('refs resolve by slug, name and path; self-references and unknown names are dropped', () => {
  const files: Record<string, string> = {
    '/r/.caddis/projects/active/project-a.md': '**Depends on:** project-b.md, project-a.md, Mystery thing\n',
    '/r/.caddis/projects/active/project-b.md': 'Requires the C plan\n',
    '/r/.caddis/projects/active/project-c.md': 'Blocked by [b](./project-b.md)\n',
  };
  const ps = [proj('a', 'A', '/r/.caddis/projects/active/project-a.md'), proj('b', 'B', '/r/.caddis/projects/active/project-b.md'), proj('c', 'C', '/r/.caddis/projects/active/project-c.md')];
  const out = linkSpecs(ps, (f) => files[f] ?? '');
  assert.deepEqual(out.map((p) => p.dependsOn), [['R:b'], ['R:c'], ['R:b']]);
});

test('a file that cannot be read gives no links and no throw', () => {
  const ps = [proj('a', 'A', '/r/a.md')];
  const out = linkSpecs(ps, () => {
    throw new Error('EACCES');
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]?.dependsOn, undefined);
});

test('Caddis fixture repo: Depends on lines become ids, fences ignored, questions counted', () => {
  const ps = scanRepo(path.join(FIX, 'roadmap-caddis'));
  const by = (slug: string) => ps.find((p) => p.id === 'roadmap-caddis:' + slug) as Project;
  assert.deepEqual(by('project-refresh-tokens').dependsOn, ['roadmap-caddis:project-session-store']);
  assert.deepEqual(by('project-rate-limits').dependsOn, ['roadmap-caddis:project-api-keys']);
  assert.deepEqual(by('project-audit-log').dependsOn?.sort(), ['roadmap-caddis:project-rate-limits', 'roadmap-caddis:project-refresh-tokens']);
  assert.deepEqual(by('project-exports').dependsOn, ['roadmap-caddis:project-imports']);
  assert.deepEqual(by('project-imports').dependsOn, ['roadmap-caddis:project-exports']);
  assert.equal(by('project-billing-v2').dependsOn, undefined);
  assert.equal(by('project-billing-v2').status, 'parked');
  assert.equal(by('project-refresh-tokens').questions, 1);
  assert.equal(by('project-session-store').dependsOn, undefined);
});

test('Spec Kit fixture repo: links, names and numbers resolve to the feature folder', () => {
  const ps = scanRepo(path.join(FIX, 'roadmap-spec-kit'));
  const by = (d: string) => ps.find((p) => p.id === 'roadmap-spec-kit:spec-kit:' + d) as Project;
  assert.equal(by('001-photo-tags').status, 'completed');
  assert.deepEqual(by('002-albums').dependsOn, ['roadmap-spec-kit:spec-kit:001-photo-tags']);
  assert.deepEqual(by('003-sharing').dependsOn, ['roadmap-spec-kit:spec-kit:002-albums']);
  assert.deepEqual(by('004-search').dependsOn, ['roadmap-spec-kit:spec-kit:001-photo-tags']);
  assert.equal(by('003-sharing').questions, 1);
  assert.equal(by('001-photo-tags').dependsOn, undefined);
});
