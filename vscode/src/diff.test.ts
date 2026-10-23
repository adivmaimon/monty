import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { changedLineRange, hunkRanges } from './diff';

test('changedLineRange: the block between unchanged lines', () => {
  assert.deepEqual(changedLineRange('a\nb\nc\nd', 'a\nB\nC\nd'), [1, 2]);
  assert.deepEqual(changedLineRange('a\nb', 'a\nb\nc\nd'), [2, 3], 'appended');
  assert.deepEqual(changedLineRange('x\na', 'a'), [0, 0], 'deleted first line marks where it was');
  assert.deepEqual(changedLineRange('a\nb\nc', 'a\nc'), [1, 1], 'deletion in the middle');
  assert.equal(changedLineRange('same', 'same'), null);
});

test('hunkRanges: new-side lines from git diff -U0', () => {
  const out = 'diff --git a/x b/x\n@@ -3,0 +4,2 @@\n+a\n+b\n@@ -10 +12 @@\n-x\n+y\n@@ -20,3 +21,0 @@\n';
  assert.deepEqual(hunkRanges(out), [[3, 4], [11, 11], [20, 20]]);
});
