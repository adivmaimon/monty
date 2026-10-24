// The version a release gets, set in every file that carries it. Run by the release
// workflow, so nobody bumps versions by hand:
//
//   node scripts/release-version.mjs <last released version> <patch|minor|major> [--write]
//
// If package.json is already ahead of the last release (bumped by hand, or a release run
// that pushed its bump and then failed), that version is used as it is. Otherwise the last
// release is bumped. With --write, both package.json files (and their lockfiles) get the
// version and the changelog's "## Unreleased" heading becomes "## <version>".
// Prints the version.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [last = '0.0.0', level = 'patch', write] = process.argv.slice(2);

const parse = (v) => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
const cmp = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
function bump(v, how) {
  const [major, minor, patch] = parse(v);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const current = JSON.parse(fs.readFileSync(path.join(root, 'vscode', 'package.json'), 'utf8')).version;
const next = cmp(current, last) > 0 ? current : bump(last, level);

if (write === '--write') {
  for (const dir of [root, path.join(root, 'vscode')]) {
    if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version === next) continue;
    execFileSync('npm', ['version', next, '--no-git-tag-version', '--allow-same-version'], { cwd: dir, stdio: 'ignore' });
  }
  const log = path.join(root, 'vscode', 'CHANGELOG.md');
  let text = fs.readFileSync(log, 'utf8');
  if (/^## Unreleased$/m.test(text)) text = text.replace(/^## Unreleased$/m, `## ${next}`);
  // No notes written: still give the release its heading, and say there is nothing to add.
  else if (!new RegExp(`^## ${next.replace(/\./g, '\\.')}$`, 'm').test(text)) text = text.replace(/^# Changelog\n/, `# Changelog\n\n## ${next}\n\n- Small fixes.\n`);
  fs.writeFileSync(log, text);
}
console.log(next);
