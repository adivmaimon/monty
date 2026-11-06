import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webviewPage } from './webview';

// The real page, so a script or stylesheet added to web/index.html is checked too.
const page = fs.readFileSync(path.resolve(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
const out = webviewPage(page, { uri: (f) => 'vscode-resource:/media/web/' + f, nonce: 'N0NCE', cspSource: 'vscode-resource:', config: { mode: 'roadmap', repo: '/r' } });

test('every script carries the nonce and loads from the webview, roadmap.js included', () => {
  const scripts = out.match(/<script\b[^>]*>/g) ?? [];
  assert.ok(scripts.length >= 4);
  for (const s of scripts) assert.match(s, /nonce="N0NCE"/);
  assert.match(out, /src="vscode-resource:\/media\/web\/roadmap\.js"/);
  assert.doesNotMatch(out, /src="(?!vscode-resource:)/);
});

test('stylesheets load from the webview; window.MONTY comes right before app.js', () => {
  assert.match(out, /href="vscode-resource:\/media\/web\/roadmap\.css"/);
  assert.doesNotMatch(out, /href="(?!vscode-resource:)[\w./-]+\.css"/);
  assert.match(out, /window\.MONTY = \{"mode":"roadmap"[^<]*<\/script><script nonce="N0NCE" src="vscode-resource:\/media\/web\/app\.js">/);
  assert.match(out, /Content-Security-Policy/);
  assert.doesNotMatch(out, /rel="icon"/);
});
