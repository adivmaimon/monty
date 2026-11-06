import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_BYTES, MAX_ENTRIES, SeenStore } from './seen';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'monty-seen-'));

test('SeenStore: round trip, and null for a spec never seen', () => {
  const dir = path.join(tmp(), 'seen');
  const s = new SeenStore(dir);
  assert.equal(s.get('/repo/plan.md'), null, 'folder not made yet');
  assert.equal(s.set('/repo/plan.md', '# Plan\n'), true);
  assert.equal(s.get('/repo/plan.md'), '# Plan\n');
  assert.equal(s.get('/repo/other.md'), null);
  s.set('/repo/plan.md', '# Plan v2\n');
  assert.equal(new SeenStore(dir).get('/repo/plan.md'), '# Plan v2\n', 'survives a new store (a restart)');
  assert.equal(fs.readdirSync(dir).length, 1);
});

test('SeenStore: oversized text and bad input are refused', () => {
  const s = new SeenStore(tmp());
  assert.equal(s.set('/r/big.md', 'x'.repeat(MAX_BYTES + 1)), false);
  assert.equal(s.get('/r/big.md'), null);
  assert.equal(s.set('', 'x'), false);
  assert.equal(s.set('/r/a.md', 42 as unknown as string), false);
});

test('SeenStore: a corrupt record reads as null', () => {
  const dir = tmp();
  const s = new SeenStore(dir);
  s.set('/r/a.md', 'ok');
  const [f] = fs.readdirSync(dir);
  fs.writeFileSync(path.join(dir, f!), '{not json');
  assert.equal(s.get('/r/a.md'), null);
});

test('SeenStore: prunes to the newest MAX_ENTRIES', () => {
  const dir = tmp();
  const s = new SeenStore(dir);
  for (let i = 0; i < MAX_ENTRIES; i++) s.set(`/r/${i}.md`, String(i));
  // Age the first one so it is clearly the oldest.
  const old = Date.now() / 1000 - 3600;
  for (const f of fs.readdirSync(dir)) {
    if (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).file === '/r/0.md') fs.utimesSync(path.join(dir, f), old, old);
  }
  s.set('/r/new.md', 'new');
  assert.equal(fs.readdirSync(dir).length, MAX_ENTRIES);
  assert.equal(s.get('/r/0.md'), null, 'oldest went');
  assert.equal(s.get('/r/new.md'), 'new');
});
