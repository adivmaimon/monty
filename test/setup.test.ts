// AI tool setup detection against fixture repos in test/fixtures/setup, one per tool.
// The fixtures hold placeholder text only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSetup, rulesIn, frontmatter, MAX_RULES } from '../src/setup.js';
import { SessionTracker } from '../src/session.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'setup');
const repo = (name: string) => readSetup(path.join(FIX, name));

test('Claude Code: CLAUDE.md, skills, commands, agents, settings and MCP', () => {
  const s = repo('claude');
  assert.deepEqual(s.tools, ['Claude Code']);
  assert.deepEqual(s.instructions.map((i) => i.label), ['CLAUDE.md']);
  const by = Object.fromEntries(s.skills.map((k) => [`${k.kind}:${k.name}`, k.description]));
  assert.equal(by['skill:execute'], 'Execute an active plan phase by phase');
  assert.equal(by['skill:commit'], 'Commit the working tree with a conventional message', 'folded description');
  assert.equal(by['command:review'], 'Review the current diff');
  assert.equal(by['command:git:push'], 'Push the branch', 'nested command, description from its first line');
  assert.equal(by['agent:tester'], 'Runs the test suite');
  assert.deepEqual(s.guardrails.deny, ['Bash(rm -rf *)', 'Read(.env)']);
  assert.deepEqual(s.guardrails.allow, ['Bash(npm test)']);
  assert.deepEqual(s.guardrails.hooks, [{ event: 'PostToolUse', matcher: 'Edit|Write', command: 'npx prettier --write' }]);
  assert.deepEqual(s.guardrails.mcp.map((m) => [m.name, m.detail]), [['docs', 'npx docs-mcp'], ['web', 'https://example.invalid/mcp']]);
  assert.ok(!JSON.stringify(s).includes('placeholder-not-a-secret'), 'MCP env values never leave the file');
});

test('rules: bullets under a Rules heading and Never/Always lines, not code or prose', () => {
  const s = repo('claude');
  assert.deepEqual(s.rules.map((r) => r.text), [
    'Zero runtime dependencies. Node built-ins only.',
    'Local only: bind to 127.0.0.1.',
    "Never write to the user's home folder.",
  ]);
  assert.equal(s.rules[0]?.label, 'CLAUDE.md:7');
  assert.equal(s.rules[0]?.heading, 'Rules');
});

test('Cursor: .cursorrules and .mdc rules with description, globs, alwaysApply', () => {
  const s = repo('cursor');
  assert.deepEqual(s.tools, ['Cursor']);
  const mdc = s.instructions.find((i) => i.label.endsWith('react.mdc'));
  assert.equal(mdc?.description, 'React component conventions');
  assert.equal(mdc?.globs, 'src/**/*.tsx');
  assert.equal(mdc?.alwaysApply, false);
  assert.deepEqual(s.rules.map((r) => r.text), ['Always use tabs.', 'Components are function components.']);
});

test('Codex: AGENTS.md and its constraints', () => {
  const s = repo('codex');
  assert.deepEqual(s.tools, ['Codex']);
  assert.deepEqual(s.rules.map((r) => r.text), ['Must run the linter before finishing.']);
});

test('Copilot: instructions, applyTo, prompts', () => {
  const s = repo('copilot');
  assert.deepEqual(s.tools, ['Copilot']);
  assert.equal(s.instructions.find((i) => i.label.includes('tests.instructions'))?.globs, '**/*.test.ts');
  assert.deepEqual(s.skills.map((k) => [k.kind, k.name, k.description]), [['prompt', 'release', 'Draft release notes']]);
  assert.deepEqual(s.rules.map((r) => r.text), ['Do not use default exports.', 'Never mock the database.']);
});

test('Gemini, Windsurf, Cline (folder form) and Continue', () => {
  const s = repo('others');
  assert.deepEqual(s.tools, ['Gemini', 'Windsurf', 'Cline', 'Continue']);
  assert.equal(s.instructions.length, 5);
});

test('a repo with none of these has no setup', () => {
  assert.deepEqual(repo('none').tools, []);
  assert.deepEqual(repo('does-not-exist').tools, []);
});

test('rules are capped, deduplicated, and line numbers count frontmatter', () => {
  const md = '---\na: b\n---\n## Rules\n' + Array.from({ length: 20 }, (_, i) => `- rule number ${i}`).join('\n') + '\n- rule number 1';
  const found = rulesIn(md);
  assert.equal(found[0]?.line, 5);
  assert.equal(found.length, 21);
  assert.equal(MAX_RULES, 10);
  assert.deepEqual(frontmatter('no fences').data, {});
});

test('session: skill or command in use, from Skill calls and <command-name> lines', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:00Z', message: { content: '<command-message>execute</command-message>\n<command-name>/execute</command-name>' } }));
  assert.deepEqual(t.snapshot().inUse, { kind: 'command', name: 'execute', time: '2026-10-23T10:00:00Z' });
  t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:05Z', message: { content: [{ type: 'tool_use', id: 's', name: 'Skill', input: { skill: 'commit' } }], stop_reason: 'tool_use' } }));
  assert.deepEqual(t.snapshot().inUse, { kind: 'skill', name: 'commit', time: '2026-10-23T10:00:05Z' });
});

test('a rule that wraps onto the next line in the file is read whole', () => {
  const md = '## Rules\n\n- Never claim a check that did not run. If the checker is\n  unavailable, say so.\n- Short one here.\nNever skip the\nlinter either.\n';
  assert.deepEqual(rulesIn(md).map((r) => [r.text, r.line]), [
    ['Never claim a check that did not run. If the checker is unavailable, say so.', 3],
    ['Short one here.', 5],
    ['Never skip the linter either.', 6],
  ]);
});
