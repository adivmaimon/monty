// Blast radius against a small hand-built graph (test/fixtures/blast-repo). Expected values
// are worked out by hand from map.py's rules: hubs are the 20 most imported files with 3+
// importers, "through a hub" leaves edited hubs out, and a test reaches what it imports,
// directly or not.
//
//   core <- util <- web/d <- web/e        hub (3 importers) <- a <- test/hub.test
//   core <- hub  <- a, b, web/c           lonely (nothing imports it)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blastFor, changesSection, loadGraph, matchFile, parseGraph, reach, specPaths, withBlast } from '../src/blast.js';
import { scanRepo } from '../src/projects.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');
const REPO = path.join(FIX, 'blast-repo');
const graph = parseGraph(fs.readFileSync(path.join(REPO, '.caddis', 'map', 'graph.json'), 'utf8'));

test('reach: importers, hubs, areas, untested', () => {
  assert.ok(graph);
  const r = reach(graph, ['src/core.ts']);
  assert.deepEqual(r.targets, ['src/core.ts']);
  assert.deepEqual(r.direct, ['src/hub.ts', 'src/util.ts']);
  assert.deepEqual(r.hubs, [{ file: 'src/hub.ts', importers: 3, target: false }]);
  assert.deepEqual(r.reach, ['src/a.ts', 'src/b.ts', 'src/hub.ts', 'src/util.ts', 'test/hub.test.ts', 'web/c.ts', 'web/d.ts', 'web/e.ts']);
  assert.equal(r.via_hubs, 4); // a, b, web/c, and the test through a
  assert.deepEqual(r.by_area, [
    { area: 'src', files: 4, via_hubs: 2 },
    { area: 'web', files: 3, via_hubs: 1 },
    { area: 'test', files: 1, via_hubs: 1 },
  ]);
  // The test imports a, which imports hub: hub is reached, util is not.
  assert.deepEqual(r.untested, ['src/util.ts']);
});

test('reach: an edited hub is not counted as "through a hub"', () => {
  assert.ok(graph);
  const r = reach(graph, ['src/hub.ts']);
  assert.deepEqual(r.hubs, [{ file: 'src/hub.ts', importers: 3, target: true }]);
  assert.equal(r.via_hubs, 0);
  assert.deepEqual(r.untested, ['src/b.ts', 'web/c.ts']);
});

test('reach: paths by suffix, unknown ones reported', () => {
  assert.ok(graph);
  assert.equal(matchFile(graph, 'util.ts').file, 'src/util.ts');
  assert.equal(matchFile(graph, './src/../src/a.ts').file, 'src/a.ts');
  const r = reach(graph, ['d.ts', 'nope/missing.ts']);
  assert.deepEqual(r.targets, ['web/d.ts']);
  assert.deepEqual(r.unknown, ["'nope/missing.ts' is not in the map"]);
});

test('specPaths: backticks, braces, bare names beside a path, bare paths', () => {
  const text = [
    '| `src/agents/opencode.ts`, `codex.ts` | adapters |',
    '| `menubar/App/{Model,Dropdown}.swift` | label |',
    'Also web/app.js:120 and `npm test` and `src/x.ts:4-9`, see https://x.io/a.js',
    '`~/.claude/settings.json` `<file>.ts` `dist/*.js`',
  ].join('\n');
  assert.deepEqual(specPaths(text), [
    'src/agents/opencode.ts', 'src/agents/codex.ts',
    'menubar/App/Model.swift', 'menubar/App/Dropdown.swift',
    'web/app.js', 'src/x.ts',
  ]);
});

test('changesSection: only the Changes section, up to the next heading of its level', () => {
  const text = '# T\n\n## Context\n`a/x.ts`\n\n## Changes\n`a/y.ts`\n### Sub\n`a/z.ts`\n## Phases\n`a/w.ts`';
  assert.equal(changesSection(text), '`a/y.ts`\n### Sub\n`a/z.ts`');
  assert.equal(changesSection('# T\n## Goal\nnothing'), null);
});

test('blastFor: edited files, unimported, new files; Context ignored', () => {
  assert.ok(graph);
  const text = fs.readFileSync(path.join(REPO, '.caddis', 'projects', 'active', 'project-core-change.md'), 'utf8');
  const b = blastFor([text], REPO, graph);
  assert.ok(b);
  assert.deepEqual(b.edited, ['src/core.ts']);
  assert.equal(b.unimported, 1); // src/lonely.ts
  assert.equal(b.newFiles, 1); // src/brandnew.ts
  assert.equal(b.mapCommit, 'abc1234');
  assert.deepEqual(b.importers, [{ file: 'src/hub.ts', area: 'src', hub: true }, { file: 'src/util.ts', area: 'src', hub: false }]);
  assert.equal(b.reach, 8);
  assert.deepEqual(b.untested, ['src/util.ts']);
  // Without a Changes section, every path in the text counts: web/e.ts nothing imports, so no blast.
  assert.equal(blastFor(['Touches `web/e.ts`.'], REPO, graph), undefined);
  assert.equal(blastFor(['Touches `web/d.ts`.'], REPO, graph)?.edited[0], 'web/d.ts');
  // A bare name that only ends like a mapped file does not match it.
  assert.equal(blastFor(['`b.ts`'], REPO, graph), undefined);
});

test('withBlast: open specs only, hidden when nothing is imported', () => {
  const projects = withBlast(scanRepo(REPO), REPO);
  const by = (n: string) => projects.find((p) => p.file.endsWith(n));
  assert.ok(by('project-core-change.md')?.blast);
  assert.equal(by('project-docs-only.md')?.blast, undefined);
  assert.equal(by('project-done.md')?.blast, undefined);
});

test('withBlast: no graph, or a broken one, changes nothing', () => {
  const kiro = path.join(FIX, 'kiro-repo');
  const before = scanRepo(kiro);
  assert.deepEqual(withBlast(before, kiro), before);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-blast-'));
  try {
    fs.cpSync(path.join(REPO, '.caddis'), path.join(tmp, '.caddis'), { recursive: true });
    const g = path.join(tmp, '.caddis', 'map', 'graph.json');
    for (const bad of ['{not json', '[]', '{"files": []}', '{"files": {}}', 'null']) {
      fs.writeFileSync(g, bad);
      assert.equal(loadGraph(tmp), null, bad);
      assert.ok(withBlast(scanRepo(tmp), tmp).every((p) => !p.blast), bad);
    }
    // Bad nodes are skipped, the rest still work.
    fs.writeFileSync(g, JSON.stringify({ files: { 'src/core.ts': { area: 'src', imports: [] }, 'src/x.ts': { imports: ['src/core.ts', 7] }, 'src/y.ts': 'junk' } }));
    const ok = withBlast(scanRepo(tmp), tmp).find((p) => p.file.endsWith('project-core-change.md'));
    assert.deepEqual(ok?.blast?.importers, [{ file: 'src/x.ts', area: '(root)', hub: false }]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
