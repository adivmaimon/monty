// Which lines changed, for follow mode's highlight. No vscode import, so it can be
// tested with plain node (`npm test` in vscode/).

/** Changed lines of the new text (0-based, inclusive): everything between the common first and last lines. */
export function changedLineRange(before: string, after: string): [number, number] | null {
  if (before === after) return null;
  const a = before.split('\n');
  const b = after.split('\n');
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let tail = 0;
  while (tail < a.length - top && tail < b.length - top && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const last = b.length - 1 - tail;
  // A pure deletion leaves nothing new: mark the line where text was removed.
  return last < top ? [Math.min(top, b.length - 1), Math.min(top, b.length - 1)] : [top, last];
}

/** Line ranges of the new side of `git diff -U0` hunks (`@@ -a,b +c,d @@`), 0-based and inclusive. */
export function hunkRanges(diff: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]) - 1;
    const count = m[2] === undefined ? 1 : Number(m[2]);
    // count 0 is a pure deletion: mark the line after it.
    ranges.push([Math.max(0, start), Math.max(0, start + Math.max(count, 1) - 1)]);
  }
  return ranges;
}
