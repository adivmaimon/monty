import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webviewPage } from './webpage';

// The real page: every script and stylesheet in it must load inside the webview.
const page = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
const out = webviewPage(page, { uri: (f) => `https://wv/${f}`, nonce: 'N0', cspSource: 'https://wv', config: { mode: 'doc', readerMode: 'full', x: '</script>' } });

test('every local script gets the nonce and a webview URI', () => {
  const srcs = [...page.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(srcs.includes('reader-modes.js') && srcs.includes('app.js'));
  for (const s of srcs) assert.ok(out.includes(`<script nonce="N0" src="https://wv/${s}"></script>`), s);
  assert.doesNotMatch(out, /<script src=/);
});

test('window.MONTY is set before app.js, escaped', () => {
  const cfgAt = out.indexOf('window.MONTY = ');
  assert.ok(cfgAt > 0 && cfgAt < out.indexOf('src="https://wv/app.js"'));
  assert.ok(out.indexOf('src="https://wv/reader-modes.js"') < cfgAt, 'reader-modes.js loads before app.js uses it');
  assert.match(out, /"readerMode":"full"/);
  assert.doesNotMatch(out, /"x":"<\/script>"/);
});

test('stylesheets rewritten, CSP added, icon dropped', () => {
  assert.match(out, /href="https:\/\/wv\/style\.css"/);
  assert.match(out, /href="https:\/\/wv\/reader-modes\.css"/);
  assert.match(out, /Content-Security-Policy[^>]*script-src 'nonce-N0'/);
  assert.doesNotMatch(out, /rel="icon"/);
});
