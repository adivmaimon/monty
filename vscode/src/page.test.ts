import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webviewPage } from './page';

// dist/page.test.js -> ../../web/index.html, the page the extension ships (copied to media/web).
const INDEX = path.resolve(__dirname, '..', '..', 'web', 'index.html');

test('webviewPage: every script in the shipped index.html gets the nonce and a webview URI', () => {
  const src = fs.readFileSync(INDEX, 'utf8');
  const out = webviewPage(src, (f) => `wv://media/web/${f}`, 'N0NCE', { mode: 'doc' }, "script-src 'nonce-N0NCE'");
  const scripts = out.match(/<script\b[^>]*>/g) ?? [];
  const srcScripts = (src.match(/<script src=/g) ?? []).length;
  assert.ok(srcScripts >= 3, 'md.js, reader-changes.js, app.js');
  assert.equal(scripts.length, srcScripts + 1, 'plus the window.MONTY one');
  for (const s of scripts) assert.match(s, /nonce="N0NCE"/);
  for (const m of out.matchAll(/<script nonce="N0NCE" src="([^"]+)"/g)) assert.match(m[1]!, /^wv:\/\/media\/web\//);
  const sheets = [...out.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)];
  assert.ok(sheets.length >= 2, 'style.css and reader-changes.css');
  for (const m of sheets) assert.match(m[1]!, /^wv:\/\/media\/web\//);
  assert.match(out, /window\.MONTY = \{"mode":"doc"\};<\/script><script nonce="N0NCE" src="wv:\/\/media\/web\/app\.js">/, 'config set just before app.js');
  assert.match(out, /Content-Security-Policy/);
  assert.doesNotMatch(out, /rel="icon"/);
});

test('webviewPage: a non-local script or stylesheet is dropped, and config cannot close the tag', () => {
  const out = webviewPage('<meta charset="utf-8"><link rel="stylesheet" href="https://x/y.css"><script src="https://x/y.js"></script><script src="app.js"></script>', (f) => 'wv:' + f, 'n', { file: '</script><b>' }, 'c');
  assert.doesNotMatch(out, /https:\/\/x/);
  assert.doesNotMatch(out, /<\/script><b>/);
});
