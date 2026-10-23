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
