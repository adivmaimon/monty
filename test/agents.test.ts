// Adapters for tools other than Claude Code. Records are built here in each tool's own
// layout, from the shapes in the tools' source code, with made-up content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../src/config.js';
import { mapTool, opencodeAdapter, resetOpencodeCache } from '../src/agents/opencode.js';
import { readTrace } from '../src/agents/files.js';

const require = createRequire(import.meta.url);
const T0 = Date.parse('2026-10-23T10:00:00Z');
const scratch = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `monty-${name}-`));

function snapshotsFrom(dataDir: string, nowMs: number) {
  resetOpencodeCache();
  const cfg = loadConfig({ MONTY_OPENCODE_DIR: dataDir, MONTY_LIVE_HOURS: '1000000' });
  return opencodeAdapter.live(cfg, nowMs).map((k) => {
    const src = opencodeAdapter.open(k, cfg);
    src.poll();
    return src.snapshot(nowMs);
  });
}

// One turn: a prompt, a read, an edit, a passing test run, tokens, then a final answer.
function v1Records(repo: string, opts: { running?: boolean } = {}) {
  const ses = { id: 'ses_01', version: '1.1.25', projectID: 'p1', directory: repo, title: 'Fix pager bound', time: { created: T0, updated: T0 + 9000 } };
  const user = { id: 'msg_01', sessionID: 'ses_01', role: 'user', agent: 'build', time: { created: T0 } };
  const asst = {
    id: 'msg_02', sessionID: 'ses_01', role: 'assistant', mode: 'build', agent: 'build', parentID: 'msg_01', modelID: 'claude-sonnet-4-5', providerID: 'anthropic',
    path: { cwd: repo, root: repo }, cost: 0.01, tokens: { input: 800, output: 240, reasoning: 0, cache: { read: 15000, write: 1200 } },
    time: opts.running ? { created: T0 + 1000 } : { created: T0 + 1000, completed: T0 + 9000 }, finish: opts.running ? undefined : 'stop',
  };
  const parts = {
    msg_01: [{ id: 'prt_01', type: 'text', text: 'Fix the off-by-one in pager.ts' }],
    msg_02: [
      { id: 'prt_02', type: 'step-start' },
      { id: 'prt_03', type: 'tool', callID: 'c1', tool: 'read', state: { status: 'completed', input: { filePath: `${repo}/src/pager.ts` }, output: 'x', title: 'src/pager.ts', metadata: {}, time: { start: T0 + 1100, end: T0 + 1200 } } },
      { id: 'prt_04', type: 'tool', callID: 'c2', tool: 'edit', state: { status: 'completed', input: { filePath: `${repo}/src/pager.ts`, oldString: 'i <= n', newString: 'i < n' }, output: '', title: '', metadata: {}, time: { start: T0 + 2000, end: T0 + 2100 } } },
      opts.running
        ? { id: 'prt_05', type: 'tool', callID: 'c3', tool: 'bash', state: { status: 'running', input: { command: 'npm test', description: 'Run tests' }, time: { start: T0 + 3000 } } }
        : { id: 'prt_05', type: 'tool', callID: 'c3', tool: 'bash', state: { status: 'completed', input: { command: 'npm test', description: 'Run tests' }, output: 'Tests: 12 passed', title: 'Run tests', metadata: { exit: 0 }, time: { start: T0 + 3000, end: T0 + 8000 } } },
      { id: 'prt_06', type: 'step-finish', reason: 'tool-calls', cost: 0.01, tokens: { input: 800, output: 240, reasoning: 0, cache: { read: 15000, write: 1200 } } },
      { id: 'prt_07', type: 'text', text: 'Fixed the bound; tests pass.' },
    ],
  } as Record<string, object[]>;
  const todos = [{ id: '1', content: 'Fix bound', status: 'completed', priority: 'high' }, { id: '2', content: 'Run tests', status: 'in_progress', priority: 'medium' }, { id: '3', content: 'Dropped idea', status: 'cancelled', priority: 'low' }];
  return { ses, messages: [user, asst], parts, todos };
}

function writeJsonStore(dataDir: string, r: ReturnType<typeof v1Records>) {
  const st = path.join(dataDir, 'storage');
  const put = (rel: string, v: unknown) => {
    fs.mkdirSync(path.dirname(path.join(st, rel)), { recursive: true });
    fs.writeFileSync(path.join(st, rel), JSON.stringify(v, null, 2));
  };
  put(`session/p1/${r.ses.id}.json`, r.ses);
  for (const m of r.messages) put(`message/${r.ses.id}/${m.id}.json`, m);
  for (const [mid, ps] of Object.entries(r.parts)) for (const p of ps as { id: string }[]) put(`part/${mid}/${p.id}.json`, { ...p, sessionID: r.ses.id, messageID: mid });
  put(`todo/${r.ses.id}.json`, r.todos);
}

test('opencode JSON storage (<= 1.1): one turn reads like any session', () => {
  const dir = scratch('oc-json');
  const repo = path.join(dir, 'pager');
  writeJsonStore(dir, v1Records(repo));
  const [s] = snapshotsFrom(dir, T0 + 10_000);
  assert.ok(s);
  assert.equal(s.agent, 'opencode');
  assert.equal(s.title, 'Fix pager bound');
  assert.equal(s.cwd, repo);
  assert.equal(s.repo, 'pager');
  assert.equal(s.state, 'your_turn');
  assert.equal(s.stateReason, 'opencode has finished and awaits your reply');
  assert.equal(s.model, 'claude-sonnet-4-5');
  assert.deepEqual(s.touched.map((f) => [f.path, f.reads, f.edits]), [['src/pager.ts', 1, 1]]);
  assert.equal(s.lastTest?.ok, true);
  assert.equal(s.lastEdit?.file, 'src/pager.ts');
  assert.deepEqual(s.context, { tokens: 17000, window: 200000, pct: 9 });
  assert.deepEqual(s.todos, [{ text: 'Fix bound', status: 'completed' }, { text: 'Run tests', status: 'in_progress' }]);
  assert.ok(s.activity.some((a) => a.kind === 'prompt' && a.text === 'You: Fix the off-by-one in pager.ts'));
});

test('opencode: a tool still running reads as working, and never opens auth.json', () => {
  const dir = scratch('oc-run');
  writeJsonStore(dir, v1Records(path.join(dir, 'pager'), { running: true }));
  fs.writeFileSync(path.join(dir, 'auth.json'), '{"anthropic":{"type":"api","key":"never-read"}}');
  const opened: string[] = [];
  readTrace.onRead = (f) => opened.push(f);
  try {
    const [s] = snapshotsFrom(dir, T0 + 4000);
    assert.equal(s?.state, 'working');
    assert.match(s?.stateReason ?? '', /Run tests/);
  } finally {
    readTrace.onRead = undefined;
  }
  assert.ok(opened.length > 0);
  assert.ok(!opened.some((f) => f.endsWith('auth.json')), 'auth.json was read');
});

const hasSqlite = (() => {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

test('opencode database, 1.2 - 1.19 tables (session, message, part, todo)', { skip: !hasSqlite && 'no node:sqlite' }, () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = scratch('oc-db1');
  const repo = path.join(dir, 'pager');
  const r = v1Records(repo);
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(`create table session (id text primary key, project_id text, parent_id text, slug text, directory text, title text, version text, share_url text, summary_additions int, summary_deletions int, summary_files int, summary_diffs text, revert text, permission text, time_created int, time_updated int, time_compacting int, time_archived int);
           create table message (id text primary key, session_id text, time_created int, time_updated int, data text);
           create table part (id text primary key, message_id text, session_id text, time_created int, time_updated int, data text);
           create table todo (session_id text, content text, status text, priority text, position int, time_created int, time_updated int);`);
  db.prepare('insert into session (id, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?)').run(r.ses.id, repo, r.ses.title, '1.2.0', T0, T0 + 9000);
  for (const m of r.messages) {
    const { id, sessionID, ...data } = m as Record<string, unknown>;
    void sessionID;
    db.prepare('insert into message values (?, ?, ?, ?, ?)').run(id, r.ses.id, T0, T0 + 9000, JSON.stringify(data));
  }
  for (const [mid, ps] of Object.entries(r.parts)) for (const p of ps as { id: string }[]) {
    const { id, ...data } = p;
    db.prepare('insert into part values (?, ?, ?, ?, ?, ?)').run(id, mid, r.ses.id, T0, T0 + 9000, JSON.stringify(data));
  }
  r.todos.forEach((t, i) => db.prepare('insert into todo values (?, ?, ?, ?, ?, ?, ?)').run(r.ses.id, t.content, t.status, t.priority, i, T0, T0));
  db.close();
  const [s] = snapshotsFrom(dir, T0 + 10_000);
  assert.equal(s?.state, 'your_turn');
  assert.equal(s?.title, 'Fix pager bound');
  assert.deepEqual(s?.touched.map((f) => f.path), ['src/pager.ts']);
  assert.equal(s?.lastTest?.ok, true);
  assert.equal(s?.todos.length, 2);
});

test('opencode database, 2.x tables (session_v2, session_message with idle rows)', { skip: !hasSqlite && 'no node:sqlite' }, () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = scratch('oc-db2');
  const repo = path.join(dir, 'pager');
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(`create table session_v2 (id text primary key, directory text, title text, agent text, model text, parent_id text, cost real, tokens_input int, tokens_output int, tokens_reasoning int, tokens_cache_read int, tokens_cache_write int, time_created int, time_updated int, time_idle int, idle_outcome text, time_archived int);
           create table session_message (id text primary key, session_id text, type text, seq int, time_created int, time_updated int, data text);`);
  db.prepare('insert into session_v2 (id, directory, title, time_created, time_updated) values (?, ?, ?, ?, ?)').run('ses_v2', repo, 'Add pagination', T0, T0 + 9000);
  const row = (id: string, type: string, seq: number, data: object) => db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)').run(id, 'ses_v2', type, seq, T0 + seq, T0 + seq, JSON.stringify(data));
  row('m1', 'user', 1, { content: [{ type: 'text', text: 'Add pagination to the list' }], time: { created: T0 } });
  row('m2', 'assistant', 2, {
    model: { id: 'gpt-5', providerID: 'openai' },
    content: [
      { type: 'text', text: 'On it.' },
      { type: 'tool', id: 't1', name: 'edit', state: { status: 'completed', input: { path: 'src/list.ts', oldString: 'a', newString: 'b\nc' }, content: [{ type: 'text', text: 'ok' }] }, time: { created: T0 + 2000 } },
      { type: 'tool', id: 't2', name: 'shell', state: { status: 'running', input: { command: 'npm test' } }, time: { created: T0 + 3000 } },
    ],
    tokens: { input: 500, output: 100, reasoning: 20, cache: { read: 9000, write: 0 } },
    time: { created: T0 + 1000 },
  });
  db.close();
  const [s] = snapshotsFrom(dir, T0 + 4000);
  assert.equal(s?.state, 'working');
  assert.deepEqual(s?.touched.map((f) => [f.path, f.edits]), [['src/list.ts', 1]], 'relative 2.x paths resolve against the session folder');
  assert.equal(s?.context.tokens, 9500);
  // An idle row ends the turn.
  const db2 = new DatabaseSync(path.join(dir, 'opencode.db'));
  db2.prepare('insert into session_message values (?, ?, ?, ?, ?, ?, ?)').run('m3', 'ses_v2', 'idle', 3, T0 + 5000, T0 + 5000, JSON.stringify({ outcome: 'succeeded', time: { created: T0 + 5000 } }));
  db2.close();
  const [s2] = snapshotsFrom(dir, T0 + 6000);
  assert.equal(s2?.state, 'your_turn');
});

test('opencode tool names map onto the ones Monty describes', () => {
  assert.deepEqual(mapTool('bash', { command: 'ls', description: 'List' }, '/r'), { name: 'Bash', input: { command: 'ls', description: 'List' } });
  assert.deepEqual(mapTool('shell', { command: 'ls' }, '/r'), { name: 'Bash', input: { command: 'ls', description: undefined } });
  assert.equal(mapTool('read', { path: 'a.ts' }, '/r').input.file_path, path.join('/r', 'a.ts'));
  assert.equal(mapTool('edit', { filePath: '/r/b.ts', oldString: 'x', newString: 'y' }, '/r').input.new_string, 'y');
  assert.equal(mapTool('apply_patch', { patchText: '*** Begin Patch\n*** Update File: src/c.ts\n@@\n-a\n+b\n*** End Patch' }, '/r').input.file_path, path.join('/r', 'src/c.ts'));
  assert.equal(mapTool('question', { questions: [] }, '/r').name, 'AskUserQuestion');
  assert.equal(mapTool('subagent', { description: 'Look around' }, '/r').name, 'Agent');
  assert.equal(mapTool('some_mcp_tool', {}, '/r').name, 'some_mcp_tool');
});

// ---------- Copilot Chat ----------

import { applyEntry, copilotAdapter } from '../src/agents/copilot.js';

const fileUri = (p: string) => ({ $mid: 1, scheme: 'file', path: p, fsPath: p });

/** A workspaceStorage folder with one chat log, written the way VS Code 1.109+ appends it. */
function copilotStore(repo: string, entries: object[]) {
  const user = scratch('copilot');
  const ws = path.join(user, 'workspaceStorage', 'abc123');
  fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: `file://${repo}` }));
  const file = path.join(ws, 'chatSessions', 'chat-1.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const cfg = loadConfig({ MONTY_EDITOR_DIRS: user, MONTY_LIVE_HOURS: '1000000' });
  return { cfg, file };
}

function copilotTurn(repo: string, state: number) {
  return [
    { kind: 0, v: { version: 3, sessionId: 'chat-1', creationDate: T0, requests: [] } },
    { kind: 2, k: ['requests'], v: [{ requestId: 'req-1', timestamp: T0 + 100, modelId: 'copilot/gpt-5', message: { text: 'Fix the bound in pager.ts' }, response: [], modelState: { value: 0 } }] },
    { kind: 2, k: ['requests', 0, 'response'], v: [
      { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: 't1', invocationMessage: { value: `Reading [](file://${repo}/src/pager.ts)` }, isConfirmed: { type: 1 }, isComplete: true, startedAt: T0 + 200, completedAt: T0 + 300 },
      { kind: 'toolInvocationSerialized', toolId: 'copilot_replaceString', toolCallId: 't2', invocationMessage: { value: 'Editing' }, summary: { kind: 'edit', resources: [{ uri: fileUri(`${repo}/src/pager.ts`) }] }, isComplete: true, startedAt: T0 + 400, completedAt: T0 + 500 },
      { kind: 'toolInvocationSerialized', toolId: 'run_in_terminal', toolCallId: 't3', invocationMessage: { value: 'Running `npm test`' }, isComplete: true, startedAt: T0 + 600,
        ...(state === 4 ? {} : { completedAt: T0 + 900 }),
        toolSpecificData: { kind: 'terminal', commandLine: { original: 'npm test' }, terminalCommandOutput: { text: '# pass 12\n# fail 0' }, terminalCommandState: { exitCode: 0 } } },
    ] },
    { kind: 1, k: ['requests', 0, 'completionTokens'], v: 420 },
    { kind: 1, k: ['requests', 0, 'contextUsage'], v: { currentTokens: 30000, tokenLimit: 128000 } },
    { kind: 1, k: ['requests', 0, 'modelState'], v: { value: state, ...(state === 1 ? { completedAt: T0 + 1000 } : {}) } },
  ];
}

test('Copilot Chat log: a finished agent turn reads like any session', () => {
  const repo = '/work/pager';
  const { cfg, file } = copilotStore(repo, copilotTurn(repo, 1));
  assert.deepEqual(copilotAdapter.live(cfg, Date.now()), [file]);
  const src = copilotAdapter.open(file, cfg);
  src.poll();
  const s = src.snapshot(T0 + 2000);
  assert.equal(s.agent, 'copilot-chat');
  assert.equal(s.cwd, repo);
  assert.equal(s.repo, 'pager');
  assert.equal(s.title, 'Fix the bound in pager.ts');
  assert.equal(s.model, 'gpt-5');
  assert.equal(s.state, 'your_turn');
  assert.equal(s.stateReason, 'Copilot has finished and awaits your reply');
  assert.deepEqual(s.touched.map((f) => [f.path, f.reads, f.edits]), [['src/pager.ts', 1, 1]]);
  assert.equal(s.lastTest?.ok, true);
  assert.equal(s.context.tokens, 30000);
});

test('Copilot Chat log: waiting to confirm a command reads as needing you', () => {
  const repo = '/work/pager';
  const { cfg, file } = copilotStore(repo, copilotTurn(repo, 4));
  const src = copilotAdapter.open(file, cfg);
  src.poll();
  const s = src.snapshot(T0 + 2000);
  assert.equal(s.state, 'needs_input');
  assert.match(s.stateReason, /Copilot awaits/);
});

test('Copilot Chat log: appends are read incrementally, and a compacted rewrite starts over', () => {
  const repo = '/work/pager';
  const entries = copilotTurn(repo, 0);
  const { cfg, file } = copilotStore(repo, entries.slice(0, 2));
  const src = copilotAdapter.open(file, cfg);
  src.poll();
  assert.equal(src.snapshot(T0 + 200).state, 'working');
  fs.appendFileSync(file, entries.slice(2).map((e) => JSON.stringify(e)).join('\n') + '\n{"kind":1,"k":["requests",0,"modelState"],"v":{"val');
  assert.equal(src.poll(), true);
  assert.equal(src.snapshot(T0 + 2000).touched.length, 1);
  // VS Code compacts: one kind 0 line holding the whole session, finished.
  const root: { v?: any } = {};
  for (const e of copilotTurn(repo, 1)) applyEntry(root, e);
  fs.writeFileSync(file, JSON.stringify({ kind: 0, v: root.v }) + '\n');
  src.poll();
  assert.equal(src.snapshot(T0 + 2000).state, 'your_turn');
});

test('Copilot mutation log replay: set, push with truncate, delete', () => {
  const root: { v?: any } = {};
  applyEntry(root, { kind: 0, v: { a: [1, 2, 3] } });
  applyEntry(root, { kind: 2, k: ['a'], v: [9], i: 1 });
  applyEntry(root, { kind: 1, k: ['b', 'c'], v: 'x' });
  applyEntry(root, { kind: 3, k: ['b', 'c'] });
  applyEntry(root, { kind: 1, k: [], v: 'ignored' });
  assert.deepEqual(root.v, { a: [1, 9], b: { c: undefined } });
});

// ---------- Codex CLI ----------

import { codexAdapter, execResult, mapCall } from '../src/agents/codex.js';

const tid = '0199a1b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b';
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (s: number, payload: object) => ({ timestamp: at(s), type: 'event_msg', payload });
const item = (s: number, payload: object) => ({ timestamp: at(s), type: 'response_item', payload });

/** One turn as 0.164 writes it (paginated), or as 0.150 did (legacy: user_message events, no item_completed). */
function codexTurn(repo: string, mode: 'paginated' | 'legacy', opts: { open?: boolean } = {}) {
  const prompt = 'Fix the off-by-one in src/range.ts';
  const lines: object[] = [
    { timestamp: at(0), type: 'session_meta', payload: { id: tid, cwd: repo, cli_version: '0.164.0', source: 'cli', history_mode: mode === 'paginated' ? 'paginated' : undefined, git: { branch: 'main' }, base_instructions: { text: 'You are Codex' } } },
    ev(0, { type: 'task_started', turn_id: 't1', model_context_window: 258400 }),
    { timestamp: at(0), type: 'turn_context', payload: { turn_id: 't1', cwd: repo, approval_policy: 'on-request', model: 'gpt-5.5-codex' } },
    item(0, { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${repo}</cwd>\n</environment_context>` }] }),
    item(0, { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }),
    mode === 'paginated'
      ? ev(0, { type: 'item_completed', turn_id: 't1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: prompt }] } })
      : ev(0, { type: 'user_message', message: prompt }),
    item(3, { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'sed -n 1,40p src/range.ts' }), call_id: 'call_a' }),
    item(3, { type: 'function_call_output', call_id: 'call_a', output: 'Chunk ID: 1\nWall time: 0.04 seconds\nProcess exited with code 0\nOutput:\nexport function range' }),
    ev(3, { type: 'token_count', info: { last_token_usage: { input_tokens: 9800, cached_input_tokens: 0, output_tokens: 120, total_tokens: 9920 }, model_context_window: 258400 } }),
    item(4, { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Fix the bound', status: 'completed' }, { step: 'Run tests', status: 'in_progress' }] }), call_id: 'call_p' }),
    item(4, { type: 'function_call_output', call_id: 'call_p', output: 'Plan updated' }),
    item(7, { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/range.ts\n@@\n-  i <= b\n+  i < b\n*** End Patch\n', call_id: 'call_b' }),
    item(7, { type: 'custom_tool_call_output', call_id: 'call_b', output: 'Success. Updated the following files:\nM src/range.ts\n' }),
    item(9, { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }), call_id: 'call_c' }),
  ];
  if (opts.open) return lines;
  lines.push(
    item(14, { type: 'function_call_output', call_id: 'call_c', output: 'Chunk ID: 2\nWall time: 5.8 seconds\nProcess exited with code 0\nOutput:\n# pass 12\n# fail 0' }),
    item(16, { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Fixed.' }] }),
    ev(16, { type: 'token_count', info: { last_token_usage: { input_tokens: 41000, cached_input_tokens: 29000, output_tokens: 90, total_tokens: 41090 }, model_context_window: 258400 } }),
    ev(16, { type: 'task_complete', turn_id: 't1', last_agent_message: 'Fixed.' }),
  );
  return lines;
}

function codexSnapshot(lines: object[], nowMs: number) {
  const home = scratch('codex');
  const day = path.join(home, 'sessions', '2026', '10', '23');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-10-23T10-00-00-${tid}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const time = new Date(nowMs);
  fs.utimesSync(file, time, time);
  const cfg = loadConfig({ MONTY_CODEX_DIR: home });
  const keys = codexAdapter.live(cfg, nowMs);
  assert.deepEqual(keys, [file]);
  const src = codexAdapter.open(file, cfg);
  src.poll();
  return src.snapshot(nowMs);
}

for (const mode of ['paginated', 'legacy'] as const) {
  test(`Codex rollout (${mode}): one turn reads like any session`, () => {
    const repo = '/work/range';
    const s = codexSnapshot(codexTurn(repo, mode), T0 + 20_000);
    assert.equal(s.agent, 'codex');
    assert.equal(s.id, tid);
    assert.equal(s.cwd, repo);
    assert.equal(s.branch, 'main');
    assert.equal(s.model, 'gpt-5.5-codex');
    assert.equal(s.title, 'Fix the off-by-one in src/range.ts');
    assert.equal(s.state, 'your_turn');
    assert.equal(s.stateReason, 'Codex has finished and awaits your reply');
    assert.ok(s.touched.some((f) => f.path === 'src/range.ts' && f.edits === 1));
    assert.equal(s.lastTest?.ok, true);
    assert.deepEqual(s.context, { tokens: 41090, window: 258400, pct: 16 });
    assert.deepEqual(s.todos, [{ text: 'Fix the bound', status: 'completed' }, { text: 'Run tests', status: 'in_progress' }]);
    assert.equal(s.activity.filter((a) => a.kind === 'prompt').length, 1, 'injected context is not a prompt');
  });
}

test('Codex: a command with no output yet is working, then a guess at approval once quiet', () => {
  const lines = codexTurn('/work/range', 'paginated', { open: true });
  const s = codexSnapshot(lines, T0 + 10_000);
  assert.equal(s.state, 'working');
  const later = codexSnapshot(lines, T0 + 60_000);
  assert.equal(later.state, 'needs_input');
  assert.match(later.stateReason, /[Pp]robably/);
});

test('Codex output formats: unified exec, old shell, 0.50 JSON; argv shell scripts', () => {
  assert.deepEqual(execResult('Chunk ID: 1\nWall time: 1 seconds\nProcess exited with code 2\nOutput:\nboom'), { text: 'boom', exit: 2 });
  assert.equal(execResult('Exit code: 1\nWall time: 0.5 seconds\nOutput:\nx').exit, 1);
  assert.equal(execResult(JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } })).exit, 0);
  assert.equal(execResult('Process running with session ID 3').exit, undefined);
  assert.deepEqual(mapCall('shell', { command: ['bash', '-lc', 'npm test'] }, '/r').input, { command: 'npm test' });
  assert.deepEqual(mapCall('apply_patch', { input: '*** Add File: a.ts\n*** Delete File: b.ts\n' }, '/r').files, ['/r/a.ts', '/r/b.ts']);
});

// ---------- Cline and Roo ----------

import { checklist, clineAdapter, rooAdapter } from '../src/agents/cline.js';

const say = (s: number, sayKind: string, text?: unknown, extra: object = {}) => ({ ts: T0 + s * 1000, type: 'say', say: sayKind, text: typeof text === 'string' || text === undefined ? text : JSON.stringify(text), ...extra });
const ask = (s: number, askKind: string, text?: unknown, extra: object = {}) => ({ ts: T0 + s * 1000, type: 'ask', ask: askKind, text: typeof text === 'string' || text === undefined ? text : JSON.stringify(text), ...extra });

/** The report's legacy Cline task: read, edit (approved), npm test, done. */
function clineMessages(end: 'done' | 'approve' | 'streaming') {
  const msgs: object[] = [
    say(0, 'task', 'Add a --verbose flag to the CLI'),
    say(0.1, 'api_req_started', { tokensIn: 12, tokensOut: 180, cacheWrites: 9100, cacheReads: 0, cost: 0.03 }),
    say(3, 'text', "I'll look at the CLI entry first.", { partial: false }),
    say(3.5, 'tool', { tool: 'readFile', path: 'src/cli.ts', operationIsLocatedInWorkspace: true }),
    say(4, 'api_req_started', { tokensIn: 40, tokensOut: 260, cacheWrites: 1500, cacheReads: 9100, cost: 0.01 }),
    ask(8, 'tool', { tool: 'editedExistingFile', path: 'src/cli.ts', diff: '------- SEARCH\nconst args = parse()\n=======\nconst args = parse({ verbose: true })\n+++++++ REPLACE' }, { partial: false }),
  ];
  if (end === 'approve') return msgs;
  msgs.push(
    say(15, 'checkpoint_created', undefined, { lastCheckpointHash: 'a1b2c3' }),
    say(15.5, 'api_req_started', { tokensIn: 30, tokensOut: 90, cacheWrites: 800, cacheReads: 10600, cost: 0.006 }),
    say(17, 'command', 'npm test'),
    ask(19, 'command_output', '\n> tsc && node --test\n# pass 14\n# fail 0'),
  );
  if (end === 'streaming') return [...msgs, say(20, 'api_req_started', { request: '...' })];
  return [...msgs,
    say(20, 'api_req_started', { tokensIn: 25, tokensOut: 70, cacheWrites: 400, cacheReads: 11400, cost: 0.005 }),
    say(22, 'completion_result', 'Added --verbose to src/cli.ts; tests pass.', { partial: false }),
    ask(22.1, 'completion_result', ''),
  ];
}

function legacyTask(flavor: 'cline' | 'roo', msgs: object[], repo: string, nowMs: number) {
  const user = scratch(flavor);
  const ext = flavor === 'cline' ? 'saoudrizwan.claude-dev' : 'rooveterinaryinc.roo-cline';
  const id = flavor === 'cline' ? '1761200000000' : '0199a1b2-0000-7000-8000-000000000001';
  const dir = path.join(user, 'globalStorage', ext, 'tasks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ui_messages.json'), JSON.stringify(msgs));
  if (flavor === 'cline') {
    fs.mkdirSync(path.join(user, 'globalStorage', ext, 'state'), { recursive: true });
    fs.writeFileSync(path.join(user, 'globalStorage', ext, 'state', 'taskHistory.json'), JSON.stringify([{ id, ts: T0, task: 'x', cwdOnTaskInitialization: repo }]));
    fs.writeFileSync(path.join(dir, 'task_metadata.json'), JSON.stringify({ files_in_context: [], model_usage: [{ ts: T0, model_id: 'claude-sonnet-4-5', model_provider_id: 'anthropic', mode: 'act' }] }));
    fs.writeFileSync(path.join(dir, `focus_chain_taskid_${id}.md`), '# Focus\n- [x] Add the flag\n- [ ] Run tests\n');
  } else {
    fs.writeFileSync(path.join(dir, 'history_item.json'), JSON.stringify({ id, workspace: repo }));
  }
  const cfg = loadConfig({ MONTY_EDITOR_DIRS: user, MONTY_CLINE_DIR: path.join(user, 'none'), MONTY_LIVE_HOURS: '1000000' });
  const a = flavor === 'cline' ? clineAdapter : rooAdapter;
  const [key] = a.live(cfg, Date.now());
  assert.ok(key, 'task listed');
  const src = a.open(key, cfg);
  src.poll();
  return src.snapshot(nowMs);
}

test('Cline task (legacy build): one task reads like any session', () => {
  const repo = '/work/cli';
  const s = legacyTask('cline', clineMessages('done'), repo, T0 + 30_000);
  assert.equal(s.agent, 'cline');
  assert.equal(s.cwd, repo);
  assert.equal(s.title, 'Add a --verbose flag to the CLI');
  assert.equal(s.model, 'claude-sonnet-4-5');
  assert.equal(s.state, 'your_turn');
  assert.equal(s.stateReason, 'Cline has finished and awaits your reply');
  assert.deepEqual(s.touched.map((f) => [f.path, f.reads, f.edits]), [['src/cli.ts', 1, 1]]);
  assert.equal(s.lastTest?.ok, true);
  assert.equal(s.lastEdit?.file, 'src/cli.ts');
  assert.equal(s.context.tokens, 25 + 70 + 400 + 11400);
  assert.deepEqual(s.todos, [{ text: 'Add the flag', status: 'completed' }, { text: 'Run tests', status: 'in_progress' }]);
});

test('Cline: an edit waiting for approval needs you; a request in flight is working', () => {
  const s = legacyTask('cline', clineMessages('approve'), '/work/cli', T0 + 9000);
  assert.equal(s.state, 'needs_input');
  assert.equal(s.stateReason, 'Cline awaits your approval on a step');
  const busy = legacyTask('cline', clineMessages('streaming'), '/work/cli', T0 + 21_000);
  assert.equal(busy.state, 'working');
  assert.equal(busy.lastTest?.ok, true);
});

test('Roo task: asks are answered at once, so an open one only counts after a few seconds', () => {
  const repo = '/work/cli';
  const msgs = [
    say(0, 'text', '<user_message>Add a --verbose flag</user_message>'),
    say(0.1, 'api_req_started', { apiProtocol: 'anthropic', tokensIn: 9200, tokensOut: 180, cacheWrites: 9000, cacheReads: 0, cost: 0.03 }),
    ask(1, 'tool', { tool: 'readFile', batchFiles: [{ path: 'src/cli.ts' }, { path: 'src/args.ts' }] }, { isAnswered: true }),
    say(2, 'api_req_started', { apiProtocol: 'anthropic', tokensIn: 9500, tokensOut: 200, cacheWrites: 300, cacheReads: 9100, cost: 0.01 }),
    ask(3, 'tool', { tool: 'appliedDiff', path: 'src/cli.ts', diff: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE', diffStats: { added: 1, removed: 1 } }),
  ];
  const early = legacyTask('roo', msgs, repo, T0 + 4000);
  assert.equal(early.agent, 'roo');
  assert.equal(early.cwd, repo);
  assert.equal(early.title, 'Add a --verbose flag');
  assert.equal(early.state, 'working');
  assert.deepEqual(early.touched.map((f) => f.path).sort(), ['src/args.ts', 'src/cli.ts']);
  assert.equal(early.context.tokens, 9700, "Roo's tokensIn already counts the cache");
  const late = legacyTask('roo', msgs, repo, T0 + 10_000);
  assert.equal(late.state, 'needs_input');
  assert.match(late.stateReason, /probably/);
  const asked = legacyTask('roo', [...msgs.slice(0, 2), ask(1, 'followup', '{"question":"Which file?"}')], repo, T0 + 10_000);
  assert.equal(asked.stateReason, 'Roo has a question for you');
});

test('Cline SDK session (~/.cline/data/sessions): tool calls, results and status', () => {
  const data = scratch('cline-sdk');
  const id = '1761200000000_ab12c';
  const dir = path.join(data, 'sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const repo = '/work/cli';
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ version: 1, session_id: id, status: 'running', provider: 'anthropic', model: 'claude-sonnet-4-5', cwd: repo, workspace_root: repo, started_at: new Date(T0).toISOString(), messages_path: `${id}.messages.json` }));
  const messages = [
    { role: 'user', ts: T0, content: 'Add a --verbose flag' },
    { role: 'assistant', ts: T0 + 1000, content: [{ type: 'tool_use', id: 'tu1', name: 'read_files', input: { files: [{ path: 'src/cli.ts' }] } }], metrics: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 9000, cacheWriteTokens: 0 } },
    { role: 'user', ts: T0 + 1500, content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'export ...' }] },
    { role: 'assistant', ts: T0 + 3000, content: [{ type: 'tool_use', id: 'tu2', name: 'editor', input: { path: 'src/cli.ts', old_text: 'a', new_text: 'b' } }, { type: 'tool_use', id: 'tu3', name: 'run_commands', input: { commands: ['npm test'] } }] },
    { role: 'user', ts: T0 + 6000, content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }, { type: 'tool_result', tool_use_id: 'tu3', content: '# pass 3\n# fail 0' }] },
    { role: 'assistant', ts: T0 + 7000, content: [{ type: 'text', text: 'Done.' }] },
  ];
  fs.writeFileSync(path.join(dir, `${id}.messages.json`), JSON.stringify({ version: 1, sessionId: id, agent: 'lead', messages }));
  const cfg = loadConfig({ MONTY_CLINE_DIR: data, MONTY_EDITOR_DIRS: path.join(data, 'none'), MONTY_LIVE_HOURS: '1000000' });
  const [key] = clineAdapter.live(cfg, Date.now());
  assert.equal(key, dir);
  const src = clineAdapter.open(key!, cfg);
  src.poll();
  const s = src.snapshot(T0 + 8000);
  assert.equal(s.agent, 'cline');
  assert.equal(s.cwd, repo);
  assert.equal(s.title, 'Add a --verbose flag');
  assert.equal(s.state, 'your_turn');
  assert.deepEqual(s.touched.map((f) => [f.path, f.reads, f.edits]), [['src/cli.ts', 1, 1]]);
  assert.equal(s.lastTest?.ok, true);
});

test('Cline checklists: done, next, rest', () => {
  assert.deepEqual(checklist('- [x] a\n- [ ] b\n* [ ] c\nnot a task'), [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }]);
});
