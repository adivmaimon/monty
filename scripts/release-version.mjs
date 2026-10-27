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
  else if (!new RegExp(`^## ${next.replace(/\./g, '\\.')}$`, 'm').test(text)) {
    // No Unreleased heading. Lines added since the last release usually went under an
    // older version's heading (the top one has no Unreleased above it after a release),
    // so move those here. Failing that, the commit subjects are better than nothing.
    const notes = addedLines(text);
    for (const line of notes) text = text.replace(`${line}\n`, '');
    if (!notes.length) notes.push(...commitNotes());
    if (!notes.length) notes.push('- No user-facing changes.');
    text = text.replace(/^# Changelog\n/, `# Changelog\n\n## ${next}\n\n${notes.join('\n')}\n`);
  }
  fs.writeFileSync(log, text);
}

function addedLines(text) {
  let before = '';
  try {
    before = execFileSync('git', ['show', `${tag(last)}:vscode/CHANGELOG.md`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const old = new Set(before.split('\n'));
  return text.split('\n').filter((l) => l.startsWith('- ') && !old.has(l));
}

function commitNotes() {
  let out = '';
  try {
    out = execFileSync('git', ['log', '--no-merges', '--format=%s', `${tag(last)}..HEAD`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter((s) => s && !/^Monty \d/.test(s) && !/^(chore|docs|test|ci|refactor)\b/.test(s))
    .map((s) => s.replace(/^\w+(\([^)]*\))?!?:\s*/, ''))
    .map((s) => `- ${s[0].toUpperCase()}${s.slice(1)}.`);
}

function tag(v) {
  return `v${v.replace(/^v/, '')}`;
}
console.log(next);
