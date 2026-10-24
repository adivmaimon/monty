// Builds a fictional repo and a matching Claude Code session log for screenshots,
// so README images never show anyone's real work.
//
//   node docs/demo/make-demo.mjs <dir>
//   MONTY_CLAUDE_PROJECTS=<dir>/logs MONTY_CODEX_DIR=<dir>/codex MONTY_PROJECTS=<dir> MONTY_PORT=4793 node dist/src/cli.js
//   then poll /api/state?repo=<dir>/acme-api (or open <dir>/acme-api in VS Code)
//
// Two sessions: Claude Code at work in acme-api, and Codex in acme-web, quiet on a
// command that needs approval (so it reads as needing you).
//
// Timestamps are relative to now, so the session reads as live for a few minutes.
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'monty-demo');
const repo = path.join(dir, 'acme-api');
const write = (rel, text) => {
  const f = path.join(repo, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

write('CLAUDE.md', `# acme-api

## Rules

- Never log tokens or session ids.
- Every endpoint has a test before it ships.
- Migrations are additive: never drop a column in the same release.
`);
write('.claude/skills/deploy/SKILL.md', `---
name: deploy
description: Build, tag and deploy the API to staging, then run the smoke tests
---
`);
write('.claude/skills/review/SKILL.md', `---
name: review
description: Review the current diff against CLAUDE.md before committing
---
`);
write('.claude/settings.json', JSON.stringify({ permissions: { deny: ['Bash(git push --force *)'] } }, null, 2));
write('.claude/projects/active/project-refresh-tokens.md', `# Refresh tokens for login

**Status**: In progress

## Goal

Sessions expire after 15 minutes and log people out mid-task. A 30-day refresh token lets the client renew silently.

## Flow

\`\`\`mermaid
sequenceDiagram
  Client->>API: POST /login
  API-->>Client: sid + refresh cookie
  Client->>API: POST /refresh
  API-->>Client: new sid + new refresh token
\`\`\`

## Phases

### Phase 1 - Session fields - DONE (2026-10-20)

Add \`refreshToken\` to \`src/auth/session.ts\`.

### Phase 2 - Refresh endpoint - DONE (2026-10-21)

\`POST /refresh\` in \`src/routes/login.ts\`.

### Phase 3 - Rotation and revocation

Old tokens stop working after one use.

### Phase 4 - Client renewal

The web client renews before expiry.
`);
write('.claude/projects/pending/project-rate-limits.md', `# Rate limits per API key

**Status**: Pending

## Phases

### Phase 1 - Counters

### Phase 2 - Headers

### Phase 3 - Dashboard
`);
for (const f of ['src/auth/session.ts', 'src/routes/login.ts', 'tests/auth.test.ts']) write(f, '// demo\n');

// The session: a few minutes of work on Phase 3, ending mid-edit.
const now = Date.now();
const at = (secAgo) => new Date(now - secAgo * 1000).toISOString();
const base = { cwd: repo, sessionId: 'demo-0001', gitBranch: 'main', version: '2.1.300', isSidechain: false, userType: 'external' };
const lines = [];
let n = 0;
// Auto mode, as most sessions run: a quiet tool reads as working, not as a permission guess.
const user = (t, content) => lines.push({ ...base, type: 'user', timestamp: at(t), ...(typeof content === 'string' ? { permissionMode: 'auto' } : {}), message: { role: 'user', content } });
const tool = (t, name, input, usage) => {
  const id = `toolu_demo_${++n}`;
  lines.push({ ...base, type: 'assistant', timestamp: at(t), message: { id: `msg_demo_${n}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage } });
  return id;
};
const result = (t, id, content) => user(t, [{ type: 'tool_result', tool_use_id: id, content }]);
const u = (inp, out) => ({ input_tokens: 4, cache_creation_input_tokens: inp, cache_read_input_tokens: 48000, output_tokens: out });

lines.push({ type: 'ai-title', aiTitle: 'Rotate refresh tokens on every use', sessionId: base.sessionId });
user(240, 'Carry on with phase 3 of the refresh token plan: rotation and revocation.');
let id = tool(232, 'Read', { file_path: path.join(repo, '.claude/projects/active/project-refresh-tokens.md') }, u(3000, 300));
result(231, id, 'ok');
id = tool(220, 'Read', { file_path: path.join(repo, 'src/auth/session.ts') }, u(2500, 250));
result(219, id, 'ok');
id = tool(180, 'Edit', { file_path: path.join(repo, 'src/auth/session.ts'), old_string: 'a', new_string: 'export async function rotateRefresh(token: string) {\n  const old = await db.sessions.findByRefresh(token);\n  if (!old || old.revoked) throw new AuthError("refresh_expired");\n  await db.sessions.revoke(old.id);\n  return createSession(old.userId);\n}\n' }, u(2000, 1800));
result(178, id, 'ok');
id = tool(140, 'Write', { file_path: path.join(repo, 'tests/auth.test.ts'), content: 'describe("refresh", () => {\n  it("rotates", () => {});\n  it("rejects a revoked token", () => {});\n});\n' }, u(1500, 1400));
result(139, id, 'ok');
id = tool(120, 'Bash', { command: 'npm test', description: 'Run the auth tests' }, u(1200, 200));
result(110, id, 'Tests: 1 failed, 13 passed, 14 total');
id = tool(70, 'Edit', { file_path: path.join(repo, 'src/auth/session.ts'), old_string: 'b', new_string: '  if (!old || old.revoked || old.refreshExpiresAt < new Date()) {\n' }, u(1800, 900));
result(68, id, 'ok');
id = tool(40, 'Bash', { command: 'npm test', description: 'Run the auth tests again' }, u(1400, 300));
result(30, id, 'Tests: 14 passed, 14 total');
tool(5, 'Edit', { file_path: path.join(repo, 'src/routes/login.ts'), old_string: 'c', new_string: 'login.post("/refresh", async (req, res) => {\n' }, u(5200, 2600));

const logDir = path.join(dir, 'logs', repo.replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, 'demo-0001.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
// A Codex session in a second repo: a patch applied, then a migration waiting on approval.
const web = path.join(dir, 'acme-web');
fs.mkdirSync(path.join(web, '.git'), { recursive: true });
fs.mkdirSync(path.join(web, 'src'), { recursive: true });
fs.writeFileSync(path.join(web, 'src', 'checkout.tsx'), '// demo\n');
const tid = '0199d3a1-5b2c-7e40-9a11-2f6c0d8e4b7a';
const day = new Date(now);
const pad = (x) => String(x).padStart(2, '0');
const codexDir = path.join(dir, 'codex', 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
fs.mkdirSync(codexDir, { recursive: true });
const ev = (t, payload) => ({ timestamp: at(t), type: 'event_msg', payload });
const item = (t, payload) => ({ timestamp: at(t), type: 'response_item', payload });
const prompt = 'Show the saved card on the checkout page';
const codex = [
  { timestamp: at(300), type: 'session_meta', payload: { id: tid, cwd: web, cli_version: '0.164.0', source: 'cli', history_mode: 'paginated', git: { branch: 'checkout-cards' } } },
  ev(300, { type: 'task_started', turn_id: 't1', model_context_window: 258400 }),
  { timestamp: at(300), type: 'turn_context', payload: { turn_id: 't1', cwd: web, approval_policy: 'on-request', model: 'gpt-5.5-codex' } },
  ev(300, { type: 'item_completed', turn_id: 't1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: prompt }] } }),
  item(280, { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Read the checkout page', status: 'completed' }, { step: 'Render the saved card', status: 'completed' }, { step: 'Add the cards column', status: 'in_progress' }, { step: 'Run the e2e tests', status: 'pending' }] }), call_id: 'c0' }),
  item(280, { type: 'function_call_output', call_id: 'c0', output: 'Plan updated' }),
  item(260, { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'sed -n 1,80p src/checkout.tsx' }), call_id: 'c1' }),
  item(259, { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: 1\nWall time: 0.02 seconds\nProcess exited with code 0\nOutput:\n...' }),
  item(200, { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/checkout.tsx\n@@\n+  {card && <SavedCard card={card} />}\n*** End Patch\n', call_id: 'c2' }),
  item(199, { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files:\nM src/checkout.tsx\n' }),
  ev(199, { type: 'token_count', info: { last_token_usage: { input_tokens: 61000, cached_input_tokens: 52000, output_tokens: 900, total_tokens: 61900 }, model_context_window: 258400 } }),
  item(60, { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm run db:migrate' }), call_id: 'c3' }),
];
fs.writeFileSync(path.join(codexDir, `rollout-demo-${tid}.jsonl`), codex.map((l) => JSON.stringify(l)).join('\n') + '\n');

console.log(`Demo repos: ${repo}, ${web}\nSession logs: ${path.join(dir, 'logs')}, ${path.join(dir, 'codex')}`);
