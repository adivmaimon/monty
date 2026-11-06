// web/blocks.js (typed chart and flow blocks) is browser code with no build step: load it,
// with md.js after it as the page does, into a bare context and test the HTML it returns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const ctx: { window: any } = { window: {} };
vm.createContext(ctx);
for (const f of ['blocks.js', 'md.js']) vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), ctx);
const { render, parseYaml } = ctx.window.MontyBlocks;
const md = (src: string): string => {
  const out = ctx.window.MontyMD.render(src, {});
  return out.preamble + out.sections.map((s: { html: string }) => s.html).join('');
};
// Maps from the vm context are not this realm's Map; turn them into plain objects to compare.
const plain = (v: any): any => (Array.isArray(v) ? Array.from(v, plain) : v && typeof v === 'object' && typeof v.entries === 'function' ? Object.fromEntries([...v.entries()].map(([k, x]: [string, any]) => [k, plain(x)])) : v);

const MOCK_CHART = `title: Refresh token lookup, p95 ms
better: lower
threshold: 10
rows:
  - ["sha256 + index", 4.1, winner]
  - ["bcrypt per row", 38.0]
  - ["plain token", 3.9, rejected]
note: Plain is fastest but stores secrets.`;

const MOCK_FLOW = `title: Life of a refresh token
steps:
  - issued: on login
  - active: 30 days
  - rotated: on each /refresh, new one issued
  - revoked: on logout or expiry
branch:
  from: rotated
  if: old token used again
  to: whole family revoked
  tone: danger`;

const SKILL_FLOW = `title: Upload lifecycle
steps:
  queued: file accepted, job created
  scanning: virus scan
  ready: visible to the user
  rejected: user told why
branch:
  - {from: scanning, if: scan fails, to: rejected, tone: bad}`;

test('yaml subset: maps, lists, flow lists with quoted commas, flow maps, comments', () => {
  const doc = plain(parseYaml(`# leading comment
a: plain text # trailing
b:
  c: "quoted: # not a comment"
  d: 'it''s'
list:
- [x, "y, z", 3.0]
- {k: v, n: 2}
- - nested
empty:
`));
  assert.deepEqual(doc, { a: 'plain text', b: { c: 'quoted: # not a comment', d: "it's" }, list: [['x', 'y, z', '3.0'], { k: 'v', n: '2' }, ['nested']], empty: null });
});

test('yaml subset: block scalars and list items that are maps', () => {
  const doc = plain(parseYaml('note: |\n  one\n  two\nfold: >\n  a\n  b\n\n  c\nitems:\n  - name: x\n    detail: y\n  - z'));
  assert.deepEqual(doc, { note: 'one\ntwo', fold: 'a b\nc', items: [{ name: 'x', detail: 'y' }, 'z'] });
});

test('yaml subset: keeps step order for numeric names', () => {
  assert.deepEqual([...parseYaml('2: b\n1: a\n10: c').keys()], ['2', '1', '10']);
});

test('yaml subset: errors name the line', () => {
  assert.throws(() => parseYaml('a: 1\n  b: 2'), /line 2: unexpected indent/);
  assert.throws(() => parseYaml('a: [1, 2'), /line 1: "\[" is not closed/);
  assert.throws(() => parseYaml('a: 1\njust words'), /line 2: expected "key: value"/);
  assert.throws(() => parseYaml('a: "open'), /line 1: a quoted string is not closed/);
  assert.throws(() => parseYaml('a: 1\na: 2'), /line 2: duplicate key "a"/);
});

test('chart: the mock draws bars scaled to the largest value, tags and the threshold', () => {
  const html = render('chart', MOCK_CHART);
  assert.match(html, /^<figure class="tb tb-chart">/);
  assert.match(html, /<span class="tb-title">Refresh token lookup, p95 ms<\/span><span class="tb-sub">lower is better · threshold 10<\/span>/);
  // Rows carry tags, so bars use 78% of the track: 38 is the max.
  assert.match(html, /tb-track" style="grid-row:2"><span class="tb-bar" style="width:78%">/);
  assert.match(html, /width:8.42%"><\/span><span class="tb-tag">winner<\/span>/);
  assert.match(html, /<span class="tb-label tb-rej" style="grid-row:3">plain token<\/span>/);
  assert.match(html, /tb-val mono" style="grid-row:2">38.0</);
  assert.match(html, /<span class="tb-th" style="grid-row:1 \/ span 3"><i style="left:20.53%"><\/i><\/span>/);
  assert.match(html, /<div class="tb-note">Plain is fastest but stores secrets.<\/div>/);
});

test('chart: the skill example, a threshold above every value, and no tags', () => {
  const html = render('chart', 'title: t\nrows:\n  - [a, 5]\n  - [b, 10]\nthreshold: 20');
  assert.match(html, /grid-row:2"><span class="tb-bar" style="width:50%">/);
  assert.match(html, /left:100%/);
  assert.doesNotMatch(html, /tb-sub">.*better/);
  assert.match(render('caddis-chart', MOCK_CHART), /tb-chart/);
});

test('flow: the mock draws steps in order with the branch under its from-step', () => {
  const html = render('flow', MOCK_FLOW);
  const names = [...html.matchAll(/<span class="tb-node">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(names, ['Issued', 'Active', 'Rotated', 'Revoked']);
  assert.match(html, /<div class="tb-step tb-from" style="grid-column:5"><span class="tb-node">Rotated/);
  assert.match(html, /<span class="tb-detail">on each \/refresh, new one issued<\/span>/);
  assert.match(html, /<div class="tb-branch tb-bad" style="grid-column:5 \/ 8;grid-row:2">.*<span class="tb-if">old token used again<\/span><span class="tb-node tb-to">Whole family revoked<\/span>/);
  assert.equal((html.match(/tb-arrow/g) || []).length, 3);
});

test('flow: the skill example reads steps as a map and branch as a list of flow maps', () => {
  const html = render('flow', SKILL_FLOW);
  assert.match(html, /grid-column:3"><span class="tb-node">Scanning/);
  assert.match(html, /tb-branch tb-bad" style="grid-column:3 \/ 8;grid-row:2"/);
  assert.match(render('flow', 'steps:\n  - a\n  - b\nbranch:\n  from: a\n  to: c\n  tone: sideways'), /tb-branch tb-neutral/);
});

test('fallback: a block that does not parse or has the wrong shape shows its source and why', () => {
  const bad = render('chart', 'title: x\nrows: [a, 1');
  assert.match(bad, /^<div class="tb-failed"><p class="tb-reason">This chart got the better of me \(line 2: &quot;\[&quot; is not closed/);
  assert.match(bad, /<pre data-lang="chart"><code>title: x\nrows: \[a, 1<\/code><\/pre><\/div>$/);
  assert.match(render('chart', 'title: x\nrows:\n  - [a, fast]'), /\(row 1: &quot;fast&quot; is not a number\)/);
  assert.match(render('chart', 'rows:\n  - [a, -1]'), /negative values are not drawn/);
  assert.match(render('chart', 'better: faster\nrows:\n  - [a, 1]'), /better should be lower or higher/);
  assert.match(render('chart', 'title: no rows'), /rows should be a list/);
  assert.match(render('flow', 'steps:\n  a: b\nbranch: {from: z, to: y}'), /This flow got the better of me \(branch from &quot;z&quot; is not one of the steps\)/);
  assert.match(render('flow', ''), /expected keys: title, steps/);
});

test('every text slot is escaped: no HTML from the spec reaches the page', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const chartHtml = render('chart', `title: '${evil.replace(/'/g, "''")}'\nnote: '${evil.replace(/'/g, "''")}'\nrows:\n  - ['${evil.replace(/'/g, "''")}', 1]`);
  const flowHtml = render('flow', `title: x\nsteps:\n  - '${evil.replace(/'/g, "''")}': '${evil.replace(/'/g, "''")}'\nbranch: {from: '${evil.replace(/'/g, "''")}', if: '${evil.replace(/'/g, "''")}', to: '${evil.replace(/'/g, "''")}'}`);
  const failHtml = render('flow', `<script>alert(1)</script>`);
  for (const html of [chartHtml, flowHtml, failHtml]) {
    assert.doesNotMatch(html, /<img|<script/);
    assert.doesNotMatch(html, /tb-failed[^]*tb-failed/);
  }
  assert.match(chartHtml, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  assert.match(flowHtml, /tb-from/);
});

test('md.js draws chart and flow fences and leaves other languages alone', () => {
  const html = md('# T\n\n## S\n\n```chart\n' + MOCK_CHART + '\n```\n\n```flow\n' + SKILL_FLOW + '\n```\n\n```yaml\na: 1\n```');
  assert.match(html, /tb-chart/);
  assert.match(html, /tb-flow/);
  assert.match(html, /<pre data-lang="yaml"><code>a: 1<\/code><\/pre>/);
  assert.equal(render('mermaid', 'graph TD'), null);
  assert.equal(render('', 'x'), null);
});
