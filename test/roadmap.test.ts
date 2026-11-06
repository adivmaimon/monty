// web/roadmap.js: which cards show, how they are laid out, loops, and chain highlighting.
// Browser code with no build step, loaded into a bare context like md.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { scanRepo } from '../src/projects.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ctx: { window: any } = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'web', 'roadmap.js'), 'utf8'), ctx);
const RM = ctx.window.MontyRoadmap;
// Arrays made inside the vm context are another realm's: compare their plain copies.
const eq = (a: unknown, b: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

type P = { id: string; status: string; dependsOn?: string[]; statusText?: string; updatedAt: string; name: string };
const p = (id: string, status: string, deps: string[] = [], date = '2026-10-01'): P => ({ id, name: id.toUpperCase(), status, dependsOn: deps, statusText: status === 'completed' ? `Complete (${date})` : undefined, updatedAt: date + 'T00:00:00Z' });

test('Done keeps the five most recent and any linked to open work; cancelled stays off', () => {
  const done = Array.from({ length: 8 }, (_, i) => p('d' + i, 'completed', [], `2026-10-${String(10 + i).padStart(2, '0')}`));
  const cards = RM.pick([...done, p('a', 'active', ['d0']), p('x', 'cancelled'), p('n', 'pending', ['a', 'ghost'])]);
  const ids = cards.map((c: { id: string }) => c.id).sort();
  eq(ids, ['a', 'd0', 'd3', 'd4', 'd5', 'd6', 'd7', 'n']);
  // A link to something not on the board is dropped, not drawn to nowhere.
  eq(cards.find((c: { id: string }) => c.id === 'n').deps, ['a']);
});

test('columns, lanes by depth inside a column, parked last in Next', () => {
  const cards = RM.pick([p('s', 'completed'), p('r', 'active', ['s']), p('g', 'pending', ['r']), p('a', 'pending', ['g']), p('b', 'parked')]);
  const L = RM.layout(cards);
  const n = (id: string) => L.nodes.get(id);
  eq(L.cols.map((c: { label: string }) => c.label), ['Done', 'Active', 'Next']);
  assert.ok(n('s').x < n('r').x && n('r').x < n('g').x);
  // a needs g, both in Next: a sits a lane to the right.
  assert.ok(n('a').x > n('g').x);
  assert.equal(n('b').lane, n('g').lane);
  assert.ok(n('b').row > n('g').row);
  assert.equal(L.edges.length, 3);
  assert.equal(L.cycles.length, 0);
  // Forward lines are right angles: every segment horizontal or vertical.
  for (const e of L.edges) for (let i = 1; i < e.points.length; i++) {
    const [[x1, y1], [x2, y2]] = [e.points[i - 1], e.points[i]];
    assert.ok(x1 === x2 || y1 === y2);
  }
});

test('Done is one lane and draws no line between two finished plans', () => {
  const L = RM.layout(RM.pick([p('a', 'completed'), p('b', 'completed', ['a']), p('c', 'completed', ['b']), p('x', 'active', ['c'])]));
  eq([...new Set(['a', 'b', 'c'].map((id) => L.nodes.get(id).lane))], [0]);
  eq(L.edges.map((e: { from: string; to: string }) => e.from + '>' + e.to), ['c>x']);
});

test('ordering follows neighbours: a card sits level with what it needs', () => {
  const cards = RM.pick([p('k', 'completed', [], '2026-10-01'), p('s', 'completed', [], '2026-10-20'), p('l', 'active', ['k']), p('r', 'active', ['s'])]);
  const L = RM.layout(cards);
  assert.equal(L.nodes.get('l').row, L.nodes.get('k').row);
  assert.equal(L.nodes.get('r').row, L.nodes.get('s').row);
});

test('loops finish, are flagged, and are still drawn', () => {
  const two = RM.layout(RM.pick([p('e', 'pending', ['i']), p('i', 'pending', ['e'])]));
  eq(two.cycles.map((g: string[]) => [...g].sort()), [['e', 'i']]);
  assert.equal(two.edges.length, 2);
  assert.ok(two.edges.every((e: { cycle: boolean }) => e.cycle));
  // A three-loop with a tail hanging off it, across columns.
  const three = RM.layout(RM.pick([p('a', 'active', ['c']), p('b', 'pending', ['a']), p('c', 'pending', ['b']), p('t', 'pending', ['c'])]));
  eq(three.cycles.map((g: string[]) => [...g].sort()), [['a', 'b', 'c']]);
  assert.equal(three.edges.length, 4);
  assert.equal(three.edges.find((e: { to: string }) => e.to === 't').cycle, false);
  // A self-reference never reaches the board.
  eq(RM.pick([p('s', 'active', ['s'])])[0].deps, []);
});

test('chain: the card, everything it needs and everything it unblocks, nothing beside', () => {
  const cards = RM.pick([p('s', 'completed'), p('k', 'completed'), p('r', 'active', ['s']), p('l', 'active', ['k']), p('g', 'pending', ['r']), p('a', 'pending', ['r', 'l'])]);
  eq([...RM.chain('r', cards)].sort(), ['a', 'g', 'r', 's']);
  eq([...RM.chain('k', cards)].sort(), ['a', 'k', 'l']);
  const loop = RM.pick([p('e', 'pending', ['i']), p('i', 'pending', ['e']), p('z', 'pending')]);
  eq([...RM.chain('e', loop)].sort(), ['e', 'i']);
});

test('both fixture repos lay out: Caddis plans with a loop, Spec Kit specs linked by name and path', () => {
  const caddis = RM.layout(RM.pick(scanRepo(path.join(ROOT, 'test', 'fixtures', 'roadmap-caddis'))));
  assert.equal(caddis.nodes.size, 9);
  assert.equal(caddis.cycles.length, 1);
  assert.equal(caddis.edges.length, 7);
  const kit = RM.layout(RM.pick(scanRepo(path.join(ROOT, 'test', 'fixtures', 'roadmap-spec-kit'))));
  assert.equal(kit.nodes.size, 4);
  assert.equal(kit.edges.length, 3);
  assert.equal(RM.worth([]), false);
  // No two cards share a spot.
  for (const L of [caddis, kit]) {
    const spots = [...L.nodes.values()].map((n: { x: number; y: number }) => n.x + ',' + n.y);
    assert.equal(new Set(spots).size, spots.length);
  }
});
