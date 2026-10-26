// web/md.js is browser code with no build step; load it into a bare context to test it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'md.js');
const ctx: { window: any } = { window: {} };
vm.runInNewContext(fs.readFileSync(SRC, 'utf8'), ctx);
const render = (md: string): string => {
  const out = ctx.window.MontyMD.render(md, {});
  return out.preamble + out.sections.map((s: { html: string }) => s.html).join('');
};

test('numbered steps separated by blank lines are one list, not many lists of one', () => {
  const html = render('1. one\n\n2. two\n   continued\n\n3. three\n\nAfter.');
  assert.equal((html.match(/<ol/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /two continued/);
  assert.match(html, /<\/ol><p>After\.<\/p>/);
});

test('indented bullets nest under their step as their own list', () => {
  const html = render('1. Append a record:\n   - first\n   - second\n\n2. Move the file.');
  assert.match(html, /^<ol><li>Append a record:<ul><li>first<\/li><li>second<\/li><\/ul><\/li><li>Move the file\.<\/li><\/ol>$/);
});

test('an ordered list that starts later keeps its number', () => {
  assert.match(render('4. four\n5. five'), /^<ol start="4">/);
});

test('checkbox items still render as checkboxes', () => {
  const html = render('- [x] done\n- [ ] open');
  assert.match(html, /<li class="cb">✅/);
  assert.match(html, /<li class="cb">⬜/);
});

test('a table row with no separator under it renders as text instead of hanging', () => {
  assert.match(render('## 4. Tools\n\n| Tool | What it does |'), /<p>\| Tool \| What it does \|<\/p>/);
  assert.match(render('| a | b |\nplain'), /<p>\| a \| b \| plain<\/p>|<p>\| a \| b \|/);
});

test('table cells keep pipes inside code spans and escaped pipes', () => {
  const html = render('| a | b |\n|---|---|\n| `x || y` | p \\| q |');
  assert.match(html, /<td><code>x \|\| y<\/code><\/td><td>p \| q<\/td>/);
});

test('a fenced block indented under a list item stays a code block', () => {
  const html = render('- Step one\n  ```ts\n  const a = 1;\n  ```\n- Step two');
  assert.match(html, /<li>Step one<pre><code>const a = 1;<\/code><\/pre><\/li>/);
});

test('relative links open the doc they point at; __bold__ and links with parens render', () => {
  const out = ctx.window.MontyMD.render('See [y](../active/y.md) and [w](https://e.org/Foo_(bar)) and __bold__.', { docDir: '/r/.claude/projects/completed' });
  const html = out.preamble;
  assert.match(html, /data-doc="\/r\/.claude\/projects\/active\/y.md"/);
  assert.match(html, /href="https:\/\/e.org\/Foo_\(bar\)"/);
  assert.match(html, /<strong>bold<\/strong>/);
});

test('a rule under a paragraph ends it, and an unindented wrapped line stays in its item', () => {
  assert.doesNotMatch(render('Text\n---\nMore'), /---/);
  assert.match(render('- a long item\nthat wraps\n\nAfter'), /<li>a long item that wraps<\/li>/);
});

test('strike, <br> in cells, bold around italics, bracketed link text, #L anchors, ### plans get sections', () => {
  const html = render('| a |\n|---|\n| x<br>y |\n\n~~old~~ **bold *it* more** [p/[id].tsx](p/[id].tsx#L58)');
  assert.match(html, /x<br>y/);
  assert.match(html, /<del>old<\/del>/);
  assert.match(html, /<strong>bold <em>it<\/em> more<\/strong>/);
  const out = ctx.window.MontyMD.render('[p/[id].tsx](p/x.tsx#L58)\n\n### One\n\na\n\n### Two\n\nb', { docDir: '/r' });
  assert.match(out.preamble, /data-open="\/r\/p\/x.tsx" data-line="58"/);
  assert.equal(out.sections.map((s: { title: string }) => s.title).join(','), 'One,Two');
});

test('double-backtick code spans can hold backticks', () => {
  assert.match(render('Fences start with `` ``` `` here.'), /<code>```<\/code>/);
});
