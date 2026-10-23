// Session log parsing against hand-built fixtures that mirror Claude Code's JSONL.
// The hand-built ones prove the parser's logic; the real (scrubbed) fixture at the end
// pins the format as Claude Code writes it today.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionTracker, DEFAULT_SESSION_OPTIONS } from '../src/session.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures');

function load(name: string): SessionTracker {
  const t = new SessionTracker(path.join(FIX, name), DEFAULT_SESSION_OPTIONS);
  t.feedText(fs.readFileSync(path.join(FIX, name), 'utf8'));
  return t;
}

test('TodoWrite: latest list wins, progress counts completed', () => {
  const s = load('todowrite.jsonl').snapshot(Date.parse('2026-10-23T15:00:55Z'));
  assert.equal(s.todos.length, 3);
  assert.deepEqual(s.progress, { done: 1, total: 3 });
  assert.equal(s.todos[1]?.status, 'in_progress');
});

test('title skips meta and command lines', () => {
  const s = load('todowrite.jsonl').snapshot();
  assert.equal(s.title, 'Execute the photo upload project');
  assert.equal(s.repo, 'Garden');
});

test('activity is plain English with relative paths and line counts', () => {
  const s = load('todowrite.jsonl').snapshot(Date.parse('2026-10-23T15:00:55Z'));
  const edit = s.activity.find((a) => a.kind === 'edit');
  assert.equal(edit?.text, 'Editing constants/Tokens.ts');
  assert.equal(edit?.plus, 2);
  assert.equal(edit?.minus, 1);
  const write = s.activity.find((a) => a.kind === 'write');
  assert.equal(write?.file, 'hooks/usePhotoUpload.ts');
  assert.equal(write?.plus, 4);
});

test('failing test run is recorded', () => {
  const s = load('todowrite.jsonl').snapshot(Date.parse('2026-10-23T15:00:55Z'));
  assert.equal(s.lastTest?.ok, false);
  assert.match(s.lastTest?.summary ?? '', /1 failed/);
});

test('context comes from the main chain, not subagents', () => {
  const s = load('todowrite.jsonl').snapshot(Date.parse('2026-10-23T15:00:55Z'));
  assert.equal(s.context.tokens, 5 + 33000 + 1000);
  assert.equal(s.context.pct, 17);
});

test('mid-turn text with no stop reason reads as working', () => {
  const s = load('todowrite.jsonl').snapshot(Date.parse('2026-10-23T15:00:55Z'));
  assert.equal(s.state, 'working');
});

test('quiet for 15+ minutes reads as idle', () => {
  const s = load('todowrite.jsonl').snapshot(Date.parse('2026-10-23T15:30:00Z'));
  assert.equal(s.state, 'idle');
});

test('TaskCreate / TaskUpdate build the todo list using ids from results', () => {
  const s = load('tasks-ask.jsonl').snapshot(Date.parse('2026-10-23T16:00:09Z'));
  assert.deepEqual(
    s.todos.map((t) => [t.text, t.status]),
    [['Draft config schema', 'completed'], ['Config loader', 'in_progress']],
  );
});

test('unanswered AskUserQuestion means needs_input', () => {
  const s = load('tasks-ask.jsonl').snapshot(Date.parse('2026-10-23T16:00:09Z'));
  assert.equal(s.state, 'needs_input');
  assert.equal(s.title, 'Build the config loader');
});

test('a tool waiting with the log quiet looks like a permission prompt', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', cwd: '/p/Repo', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rm -rf build', description: 'Clean build' } }], stop_reason: 'tool_use' } }));
  assert.equal(t.snapshot(Date.parse('2026-10-23T10:00:03Z')).state, 'working');
  const s = t.snapshot(Date.parse('2026-10-23T10:00:20Z'));
  assert.equal(s.state, 'needs_input');
  assert.match(s.stateReason, /permission/);
});

test('end_turn with all todos complete reads as done; open todos read as your turn', () => {
  const mk = (status: string) => {
    const t = new SessionTracker('/x/abc.jsonl');
    t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'a', name: 'TodoWrite', input: { todos: [{ content: 'x', status }] } }], stop_reason: 'tool_use' } }));
    t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } }));
    t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:02Z', message: { content: [{ type: 'text', text: 'Finished.' }], stop_reason: 'end_turn' } }));
    return t.snapshot(Date.parse('2026-10-23T10:00:10Z')).state;
  };
  assert.equal(mk('completed'), 'done');
  assert.equal(mk('in_progress'), 'your_turn');
});

test('partial lines are held until complete', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  const line = JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:00Z', message: { content: 'hello there' } });
  t.feedText(line.slice(0, 20));
  assert.equal(t.snapshot().title, 'Untitled session');
  t.feedText(line.slice(20) + '\n');
  assert.equal(t.snapshot().title, 'hello there');
});

test('files outside the repo show by name and are not clickable', async () => {
  const { describeTool } = await import('../src/describe.js');
  const inside = describeTool('Write', { file_path: '/p/Repo/src/a.ts', content: 'x' }, '/p/Repo', 't');
  const outside = describeTool('Write', { file_path: '/Users/me/.claude/projects/-p-Repo/memory/MEMORY.md', content: 'x' }, '/p/Repo', 't');
  assert.equal(inside?.file, 'src/a.ts');
  assert.equal(outside?.file, undefined);
  assert.equal(outside?.text, 'Writing MEMORY.md');
});

test('a session past 200k tokens is assumed to have a 1M window', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', message: { model: 'claude-opus-5-5', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 675_000 } } }));
  const s = t.snapshot();
  assert.equal(s.context.window, 1_000_000);
  assert.equal(s.context.pct, 68);
});

test('a tool call with no result is cleared when the turn ends', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sed -n 1p x', description: 'Check outline' } }], stop_reason: 'tool_use' } }));
  t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:05Z', message: { content: [{ type: 'text', text: 'pause when you can' }] } }));
  t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:09Z', message: { content: [{ type: 'text', text: 'Paused.' }], stop_reason: 'end_turn' } }));
  const s = t.snapshot(Date.parse('2026-10-23T10:01:00Z'));
  assert.equal(s.state, 'your_turn');
});

// Real log from Claude Code 2.1.278, scrubbed (test/fixtures/real-2026-10-23.jsonl):
// content and paths replaced, shapes kept. Lines 1-65 are a first turn, 66-106 a later
// turn with Bash, Read, an AskUserQuestion and an end_turn. These pin today's format.
function real(lines?: number): SessionTracker {
  const all = fs.readFileSync(path.join(FIX, 'real-2026-10-23.jsonl'), 'utf8').split('\n').filter(Boolean);
  const t = new SessionTracker('/x/real.jsonl', DEFAULT_SESSION_OPTIONS);
  for (const l of all.slice(0, lines)) t.feedLine(l);
  return t;
}

test('real log: title from ai-title, repo from cwd, finished turn reads as your turn', () => {
  const s = real().snapshot(Date.parse('2026-09-25T11:35:00Z'));
  assert.equal(s.title, 'Redacted session title');
  assert.equal(s.repo, 'Sample');
  assert.equal(s.model, 'claude-opus-5');
  assert.equal(s.state, 'your_turn');
  assert.deepEqual(s.todos, []);
});

test('real log: 1M window comes from the model attachment, not message.model', () => {
  const s = real().snapshot(Date.parse('2026-09-25T11:35:00Z'));
  assert.equal(s.context.tokens, 141125);
  assert.equal(s.context.window, 1_000_000);
  assert.equal(s.context.pct, 14);
});

test('real log: pending AskUserQuestion reads as needs_input', () => {
  const s = real(95).snapshot(Date.parse('2026-09-25T11:33:40Z'));
  assert.equal(s.state, 'needs_input');
  assert.equal(s.stateReason, 'Claude asked you a question');
});

test('real log: in auto mode a quiet Bash is working however long it runs, and says for how long', () => {
  const t = real(73);
  assert.equal(t.snapshot(Date.parse('2026-09-25T11:33:00Z')).state, 'working');
  const later = t.snapshot(Date.parse('2026-09-25T11:40:00Z'));
  assert.equal(later.state, 'working');
  assert.match(later.stateReason, /running 7 min/);
});

test('real log: activity paths are relative to the repo', () => {
  const s = real().snapshot(Date.parse('2026-09-25T11:35:00Z'));
  assert.ok(s.activity.some((a) => a.kind === 'read'));
  assert.ok(s.touched.every((f) => !f.path.startsWith('/')));
});

test('a meta user line mid-turn does not answer a pending tool', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: {} }], stop_reason: 'tool_use' } }));
  t.feedLine(JSON.stringify({ type: 'user', isMeta: true, timestamp: '2026-10-23T10:00:01Z', message: { content: 'skill body' } }));
  assert.equal(t.snapshot(Date.parse('2026-10-23T10:00:05Z')).state, 'needs_input');
});

test('an interrupt ends the turn', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'sleep 99' } }], stop_reason: 'tool_use' } }));
  t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:03Z', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }));
  const s = t.snapshot(Date.parse('2026-10-23T10:00:05Z'));
  assert.equal(s.state, 'your_turn');
  assert.equal(s.stateReason, 'You interrupted');
  assert.equal(s.title, 'Untitled session');
});

test('a pending Agent call counts as a running subagent', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: { description: 'x', prompt: 'y' } }], stop_reason: 'tool_use' } }));
  assert.equal(t.snapshot(Date.parse('2026-10-23T10:00:05Z')).subagentsRunning, 1);
});

test('a session opened with a slash command is titled by the command until ai-title lands', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:00Z', message: { content: '<command-message>execute</command-message>\n<command-name>/execute</command-name>\n<command-args>plan-x phase 1</command-args>' } }));
  t.feedLine(JSON.stringify({ type: 'user', isMeta: true, timestamp: '2026-10-23T10:00:00Z', message: { content: [{ type: 'text', text: 'Base directory for this skill' }] } }));
  assert.equal(t.snapshot().title, '/execute plan-x phase 1');
  t.feedLine(JSON.stringify({ type: 'ai-title', aiTitle: 'Execute plan X', sessionId: 's' }));
  assert.equal(t.snapshot().title, 'Execute plan X');
});

test('node:test summaries: "fail 0" passes, "fail 1" fails', () => {
  const run = (out: string) => {
    const t = new SessionTracker('/x/abc.jsonl');
    t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use' } }));
    t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:05Z', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: out }] } }));
    return t.snapshot().lastTest?.ok;
  };
  assert.equal(run('ℹ tests 39\nℹ pass 39\nℹ fail 0'), true);
  assert.equal(run('ℹ tests 39\nℹ pass 38\nℹ fail 1'), false);
  assert.equal(run('FAIL src/a.test.ts'), false);
});

test('lastEdit: set when an edit inside the repo succeeds, capped, never for failures or outside files', async () => {
  const { SNIPPET_MAX } = await import('../src/describe.js');
  const t = new SessionTracker('/x/abc.jsonl');
  const use = (id: string, name: string, input: object) =>
    t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', cwd: '/p/Repo', message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } }));
  const result = (id: string, is_error = false) =>
    t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error }] } }));

  use('e1', 'Edit', { file_path: '/p/Repo/src/a.ts', old_string: 'a', new_string: 'const b = 2;\n' });
  assert.equal(t.snapshot().lastEdit, undefined, 'not before the result lands');
  result('e1');
  assert.deepEqual(t.snapshot().lastEdit, { id: 'e1', time: '2026-10-23T10:00:01Z', file: 'src/a.ts', snippets: ['const b = 2;\n'] });

  use('e2', 'Edit', { file_path: '/p/Repo/src/c.ts', old_string: 'x', new_string: 'y' });
  result('e2', true);
  assert.equal(t.snapshot().lastEdit?.id, 'e1', 'a failed edit is not followed');

  use('e3', 'Write', { file_path: '/tmp/scratch.md', content: 'z' });
  result('e3');
  assert.equal(t.snapshot().lastEdit?.id, 'e1', 'files outside the repo are not followed');

  use('e4', 'MultiEdit', { file_path: '/p/Repo/big.ts', edits: [{ old_string: 'a', new_string: 'x'.repeat(1500) }, { old_string: 'b', new_string: 'y'.repeat(1500) }] });
  result('e4');
  const e = t.snapshot().lastEdit;
  assert.equal(e?.snippets.length, 2);
  assert.equal(e?.snippets.join('').length, SNIPPET_MAX);
});

test('bashWrites: heredocs carry their text; sed -i and echo > f name the file', async () => {
  const { bashWrites } = await import('../src/describe.js');
  assert.deepEqual(bashWrites("cat > bench/README.md <<'EOF'\n# bench\nline two\nEOF"), [{ dir: undefined, file: 'bench/README.md', text: '# bench\nline two' }]);
  assert.deepEqual(bashWrites('cd app/src && cat <<EOF > a.ts\nx\nEOF\nnpm test'), [{ dir: 'app/src', file: 'a.ts', text: 'x' }]);
  assert.deepEqual(bashWrites("tee -a notes.md <<'X'\nmore\nX"), [{ dir: undefined, file: 'notes.md', text: 'more' }]);
  assert.deepEqual(bashWrites("sed -i '' 's/a/b/' src/x.ts && npm run check"), [{ dir: undefined, file: 'src/x.ts' }]);
  assert.deepEqual(bashWrites('echo hi > out.txt'), [{ dir: undefined, file: 'out.txt' }]);
  assert.deepEqual(bashWrites('npm test 2>&1 > /dev/null; grep -n x a.ts'), []);
  assert.deepEqual(bashWrites('cat a.ts | head'), []);
});

test('follow mode sees files written from Bash, inside the repo only', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  const bash = (id: string, command: string) => {
    t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', cwd: '/p/Repo', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], stop_reason: 'tool_use' } }));
    t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  };
  bash('b1', "cd /p/Repo/bench && cat > cases/chat.toml <<'EOF'\n[case]\nname = 1\nEOF");
  assert.deepEqual(t.snapshot().lastEdit, { id: 'b1', time: '2026-10-23T10:00:01Z', file: 'bench/cases/chat.toml', snippets: ['[case]\nname = 1'] });
  assert.equal(t.snapshot().touched.find((f) => f.path === 'bench/cases/chat.toml')?.edits, 1);
  bash('b2', "cat > /private/tmp/scratch.md <<'EOF'\nx\nEOF");
  assert.equal(t.snapshot().lastEdit?.id, 'b1', 'writes outside the repo are not followed');
  bash('b3', "sed -i '' 's/a/b/' src/x.ts");
  assert.deepEqual(t.snapshot().lastEdit?.snippets, [], 'sed: open the file, nothing to highlight');
});

test('"in use" ends when the user sends another prompt, not on the skill body', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:00Z', message: { content: '<command-name>/learn</command-name>' } }));
  t.feedLine(JSON.stringify({ type: 'user', isMeta: true, timestamp: '2026-10-23T10:00:00Z', message: { content: [{ type: 'text', text: 'Base directory for this skill: ...' }] } }));
  assert.equal(t.snapshot().inUse?.name, 'learn');
  t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T11:00:00Z', message: { content: 'continue' } }));
  assert.equal(t.snapshot().inUse, undefined);
});

test('paths stay relative to where the session started when the shell cds elsewhere', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  const line = (cwd: string, id: string, name: string, input: object) => {
    t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', cwd, message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } }));
    t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:01Z', cwd, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }));
  };
  line('/p/Repo', 'a', 'Edit', { file_path: '/p/Repo/app/python/config.py', old_string: 'a', new_string: 'b' });
  line('/p/Repo/app/python', 'b', 'Edit', { file_path: '/p/Repo/app/python/config.py', old_string: 'b', new_string: 'c' });
  line('/p/Repo/bench', 'c', 'Bash', { command: "cat > harness/files.py <<'EOF'\nx = 1\nEOF" });
  const s = t.snapshot();
  assert.equal(s.cwd, '/p/Repo');
  assert.deepEqual(s.touched.map((f) => [f.path, f.edits]), [['app/python/config.py', 2], ['bench/harness/files.py', 1]]);
  assert.equal(s.lastEdit?.file, 'bench/harness/files.py');
});

test('a verdict line like "CHECK FAILED" counts as a failing run', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  t.feedLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-23T10:00:00Z', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm run check' } }], stop_reason: 'tool_use' } }));
  t.feedLine(JSON.stringify({ type: 'user', timestamp: '2026-10-23T10:00:05Z', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'lint ok\nCHECK FAILED' }] } }));
  assert.equal(t.snapshot().lastTest?.ok, false);
});

test('throughput: each reply counted once, new input and output only, fading over seconds', () => {
  const t = new SessionTracker('/x/abc.jsonl');
  const line = (ts: string, id: string, usage: object) =>
    t.feedLine(JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, content: [{ type: 'text', text: 'x' }], usage, stop_reason: 'tool_use' } }));
  // Streaming writes the same usage on every line of a message: count it once.
  line('2026-10-23T10:00:00Z', 'm1', { input_tokens: 1000, cache_creation_input_tokens: 1500, cache_read_input_tokens: 90000, output_tokens: 1250 });
  line('2026-10-23T10:00:00Z', 'm1', { input_tokens: 1000, cache_creation_input_tokens: 1500, cache_read_input_tokens: 90000, output_tokens: 1250 });
  // The moment it lands: 2,500 in and 1,250 out over a 15s time constant = 10k and 5k per minute.
  assert.deepEqual(t.snapshot(Date.parse('2026-10-23T10:00:00Z')).throughput, { inPerMin: 10000, outPerMin: 5000, level: 0.6 });
  // One time constant later it has fallen to e^-1 of that.
  const later = t.snapshot(Date.parse('2026-10-23T10:00:15Z')).throughput;
  assert.equal(later.inPerMin, Math.round(10000 / Math.E));
  assert.equal(t.snapshot(Date.parse('2026-10-23T10:05:00Z')).throughput.level, 0, 'back to zero when quiet');
});
