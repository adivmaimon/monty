// Hover previews read source files, so the path rules are what matters most here:
// nothing outside a root, no symlink escape, no secrets, no binaries, a small window.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readExcerpt, sensitive } from '../src/excerpt.js';

let tmp = '';
let repo = '';
let outside = '';

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monty-excerpt-'));
  repo = path.join(tmp, 'Shop');
  outside = path.join(tmp, 'Shop2'); // a sibling whose name starts with the repo's
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  fs.writeFileSync(path.join(repo, 'src', 'long.js'), 'x'.repeat(1000) + '\n');
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=secret\n');
  fs.writeFileSync(path.join(repo, 'server.key'), 'KEY\n');
  fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  fs.writeFileSync(path.join(outside, 'secret.ts'), 'outside\n');
  fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(repo, 'src', 'link.ts'));
  fs.symlinkSync(path.join(repo, '.env'), path.join(repo, 'src', 'env.ts'));
  fs.symlinkSync(outside, path.join(repo, 'ext')); // a folder link out of the repo
  fs.symlinkSync(path.join(outside, 'gone.ts'), path.join(repo, 'src', 'dangling.ts'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a window of lines from the referenced line', () => {
  const ex = readExcerpt(path.join(repo, 'src/a.ts'), 5, [repo]);
  assert.equal(ex.status, 'ok');
  assert.equal(ex.start, 5);
  assert.equal(ex.total, 20);
  assert.deepEqual(ex.lines.map((l) => l.n), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(ex.lines[0]?.text, 'line 5');
});

test('no line starts at the top; the window stops at the end; it is capped', () => {
  assert.equal(readExcerpt(path.join(repo, 'src/a.ts'), undefined, [repo]).start, 1);
  assert.deepEqual(readExcerpt(path.join(repo, 'src/a.ts'), 18, [repo]).lines.map((l) => l.n), [18, 19, 20]);
  assert.equal(readExcerpt(path.join(repo, 'src/a.ts'), 1, [repo], 500).lines.length, 12);
});

test('past the end and missing files say so', () => {
  const past = readExcerpt(path.join(repo, 'src/a.ts'), 21, [repo]);
  assert.equal(past.status, 'past-end');
  assert.match(past.reason ?? '', /past the end \(20 lines\)/);
  assert.equal(readExcerpt(path.join(repo, 'src/nope.ts'), 1, [repo]).status, 'missing');
});

test('long lines are cut', () => {
  const t = readExcerpt(path.join(repo, 'src/long.js'), 1, [repo]).lines[0]?.text ?? '';
  assert.equal(t.length, 401);
  assert.ok(t.endsWith('…'));
});

test('outside every root is refused before the disk is checked', () => {
  // Existing and missing files outside give the same answer: no probing.
  const a = readExcerpt(path.join(outside, 'secret.ts'), 1, [repo]);
  const b = readExcerpt(path.join(outside, 'nothing.ts'), 1, [repo]);
  assert.equal(a.status, 'refused');
  assert.equal(b.status, 'refused');
  assert.equal(a.reason, b.reason);
  assert.equal(readExcerpt(path.join(repo, 'src', '..', '..', 'Shop2', 'secret.ts'), 1, [repo]).status, 'refused');
  assert.equal(readExcerpt(`${repo}/../Shop2/secret.ts`, 1, [repo]).status, 'refused');
  assert.equal(readExcerpt('/etc/passwd', 1, [repo]).status, 'refused');
  assert.equal(readExcerpt('', 1, [repo]).status, 'refused');
  assert.equal(readExcerpt(repo, 1, [repo]).status, 'refused'); // the root itself is not a file under it
  assert.equal(readExcerpt(path.join(repo, 'src/a.ts'), 1, []).status, 'refused');
});

test('a symlink out of the repo is refused, and one onto a secret too', () => {
  const ex = readExcerpt(path.join(repo, 'src', 'link.ts'), 1, [repo]);
  assert.equal(ex.status, 'refused');
  assert.equal(ex.lines.length, 0);
  assert.equal(readExcerpt(path.join(repo, 'src', 'env.ts'), 1, [repo]).status, 'refused');
  // Through a linked folder, existing and missing files outside answer alike: no probing.
  assert.equal(readExcerpt(path.join(repo, 'ext', 'secret.ts'), 1, [repo]).status, 'refused');
  assert.equal(readExcerpt(path.join(repo, 'ext', 'nothing.ts'), 1, [repo]).status, 'refused');
  assert.equal(readExcerpt(path.join(repo, 'src', 'dangling.ts'), 1, [repo]).status, 'refused');
  // A missing file in a real folder of the repo is just missing.
  assert.equal(readExcerpt(path.join(repo, 'src', 'deep', 'nope.ts'), 1, [repo]).status, 'missing');
});

test('secrets, keys, git internals, folders and binaries are refused', () => {
  for (const f of ['.env', 'server.key', 'logo.png', 'src']) {
    const ex = readExcerpt(path.join(repo, f), 1, [repo]);
    assert.equal(ex.status, 'refused', f);
    assert.equal(ex.lines.length, 0, f);
  }
  assert.ok(sensitive('/P/Shop/.env.local'));
  assert.ok(sensitive('/P/Shop/.git/config'));
  assert.ok(sensitive('/P/Shop/deploy/id_ed25519'));
  assert.ok(sensitive('/P/Shop/certs/site.pem'));
  for (const f of ['.envrc', '.env-local', '.env_prod', 'credentials-dev.json', 'id_rsa_work']) assert.ok(sensitive('/P/Shop/' + f), f);
  // Session logs under a home folder registered as a repo; old-style plans there are fine.
  assert.ok(sensitive('/Users/me/.claude/projects/-Users-me-Shop/abc.jsonl', '/Users/me'));
  assert.ok(sensitive('/Users/me/.codex/sessions/2026/11/06/rollout.jsonl', '/Users/me'));
  assert.equal(sensitive('/P/Shop/.claude/projects/active/plan.md', '/P/Shop'), null);
  // Only the part below the root counts.
  assert.equal(sensitive('/work/secrets/Shop/src/a.ts', '/work/secrets/Shop'), null);
  assert.ok(sensitive('/work/Shop/secrets/a.ts', '/work/Shop'));
  assert.equal(sensitive('/P/Shop/src/environment.ts'), null);
  assert.equal(sensitive('/P/Shop/src/keyboard.ts'), null);
});

test('with a Caddis map, who imports the file', () => {
  const dir = path.join(repo, '.caddis', 'map');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'graph.json'), JSON.stringify({ files: { 'src/b.ts': { imports: ['src/a.ts'] }, 'src/c.ts': { imports: ['src/a.ts', 7] }, 'src/d.ts': { imports: 'bad' } } }));
  assert.deepEqual(readExcerpt(path.join(repo, 'src/a.ts'), 1, [tmp]).importedBy, ['src/b.ts', 'src/c.ts']);
  assert.equal(readExcerpt(path.join(repo, 'src/long.js'), 1, [repo]).importedBy, undefined);
  // A map in a shape we don't know shows nothing extra, and nothing breaks.
  fs.writeFileSync(path.join(dir, 'graph.json'), '{not json');
  const ex = readExcerpt(path.join(repo, 'src/a.ts'), 1, [repo]);
  assert.equal(ex.status, 'ok');
  assert.equal(ex.importedBy, undefined);
  fs.rmSync(path.join(repo, '.caddis'), { recursive: true });
});
