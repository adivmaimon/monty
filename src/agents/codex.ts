// Codex CLI sessions: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl.
// Append-only JSON lines, flushed per line, so they can be tailed like Claude Code's logs.
// Each line is {timestamp, type, payload} (plus `ordinal` in paginated files):
//
//   session_meta   first line: id, cwd, cli_version, git.branch, history_mode
//   turn_context   once per turn: model, cwd, approval_policy
//   response_item  the model's items: function_call / custom_tool_call (apply_patch) and
//                  their *_output, messages (user ones include injected context)
//   event_msg      task_started / task_complete / turn_aborted, token_count, and the
//                  prompt: user_message in legacy files, item_completed UserMessage in
//                  paginated ones (the default since 0.158, Sep 2026)
//
// Shapes are from codex-rs (protocol.rs, models.rs, rollout/policy.rs; main at 0.164,
// Oct 2026), back to the 0.50-era `shell` tool. Approval requests are never written, so
// "waiting for approval" is the same timing guess as Claude Code's.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { Session, Todo, TodoStatus } from '../types.js';
import { DEFAULT_SESSION_OPTIONS, SessionModel } from '../model.js';
import type { AgentAdapter, SessionSource } from './types.js';
import { list, mtime, patchFiles } from './files.js';

type Json = Record<string, any>;

function parseArgs(s: unknown): Json {
  if (s && typeof s === 'object') return s as Json;
  try {
    const v = JSON.parse(String(s ?? ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** A tool output (a string, or [{type:'input_text', text}]) as text. */
function outputText(o: unknown): string {
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return o.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n');
  if (o && typeof o === 'object' && typeof (o as Json).content === 'string') return (o as Json).content;
  return '';
}

/**
 * Exit status from the three output formats: unified exec ("Process exited with code 1"),
 * the older shell ("Exit code: 1"), and 0.50-era JSON ({"output", "metadata":{"exit_code"}}).
 */
export function execResult(raw: unknown): { text: string; exit?: number } {
  const text = outputText(raw);
  const m = /^Process exited with code (-?\d+)/m.exec(text) ?? /^Exit code: (-?\d+)/m.exec(text);
  if (m) return { text: text.replace(/^[\s\S]*?^Output:\n/m, ''), exit: Number(m[1]) };
  if (text.startsWith('{')) {
    const j = parseArgs(text);
    if (typeof j.metadata?.exit_code === 'number') return { text: String(j.output ?? ''), exit: j.metadata.exit_code };
  }
  return { text };
}

/** "Fix the bug" yes; "<environment_context>..." or "# AGENTS.md instructions" no. */
const INJECTED = /^\s*(<[a-z_]+>|# AGENTS\.md instructions)/;

function todoStatus(s: unknown): TodoStatus {
  return s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
}

/** One Codex tool call in the names describeTool knows. */
export function mapCall(name: string, input: Json, cwd: string): { name: string; input: Json; files?: string[] } {
  const abs = (p: unknown) => (typeof p === 'string' && p ? path.resolve(cwd || '/', p) : undefined);
  switch (name) {
    case 'exec_command':
      return { name: 'Bash', input: { command: String(input.cmd ?? '') } };
    case 'shell':
    case 'container.exec':
    case 'local_shell': {
      // Older shell tools take argv, usually ["bash", "-lc", "<script>"]: show the script.
      const argv: string[] = Array.isArray(input.command) ? input.command.map(String) : [String(input.command ?? '')];
      const command = argv.length >= 3 && /^-l?c$/.test(argv[argv.length - 2] ?? '') ? argv[argv.length - 1] : argv.join(' ');
      return { name: 'Bash', input: { command } };
    }
    case 'apply_patch': {
      const files = patchFiles(String(input.input ?? input.patch ?? '')).map((f) => abs(f) ?? f);
      return { name: 'Edit', input: { file_path: files[0], old_string: '', new_string: '' }, files };
    }
    case 'update_plan':
      return { name: 'TodoWrite', input: {} };
    case 'view_image':
      return { name: 'Read', input: { file_path: abs(input.path) } };
    case 'request_user_input':
      return { name: 'AskUserQuestion', input: {} };
    case 'spawn_agent':
      return { name: 'Agent', input: { description: String(input.message ?? input.task ?? 'a subtask').slice(0, 80) } };
    case 'web_search':
      return { name: 'WebSearch', input: { query: input.query } };
    default:
      return { name, input };
  }
}

export class CodexTracker implements SessionSource {
  private offset = 0;
  private partial = '';
  private m: SessionModel;
  /** call id -> the ids its activity lines were started under (a patch has one per file). */
  private calls = new Map<string, { ids: string[]; bash: boolean }>();
  private lineNo = 0;

  constructor(private file: string) {
    this.m = this.fresh();
  }

  private fresh(): SessionModel {
    const id = /([0-9a-f]{8}-[0-9a-f-]{27,})(?:_[^.]*)?\.jsonl$/i.exec(this.file)?.[1] ?? path.basename(this.file, '.jsonl');
    const m = new SessionModel(this.file, id, DEFAULT_SESSION_OPTIONS);
    m.agent = 'codex';
    m.agentName = 'Codex';
    m.repoFallback = 'Codex';
    return m;
  }

  poll(): boolean {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return false;
    }
    if (size < this.offset) {
      // Rewritten (a migration or compression pass): read it again from the top.
      this.offset = 0;
      this.partial = '';
      this.calls.clear();
      this.m = this.fresh();
    }
    if (size === this.offset) return false;
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const lines = (this.partial + buf.toString('utf8')).split('\n');
      this.partial = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.trim()) continue;
        this.lineNo++;
        try {
          this.line(JSON.parse(l));
        } catch {
          /* a shape this version does not know: skip the line */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  snapshot(nowMs: number): Session {
    return this.m.snapshot(nowMs);
  }

  private prompt(time: string, text: string): void {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t || INJECTED.test(t)) return;
    this.m.promptTitle(t);
    this.m.promptActivity(time, t.slice(0, 90));
    this.m.promptSent();
    this.m.stop(null);
  }

  private line(rec: Json): void {
    const m = this.m;
    const time = typeof rec.timestamp === 'string' ? rec.timestamp : m.lastEventAt ?? new Date(0).toISOString();
    const at = m.seen(time);
    const p: Json = rec.payload ?? {};
    switch (rec.type) {
      case 'session_meta':
        if (typeof p.id === 'string') m.id = p.id;
        if (typeof p.cwd === 'string') m.folder(p.cwd);
        if (typeof p.git?.branch === 'string') m.branch = p.git.branch;
        return;
      case 'turn_context':
        if (typeof p.cwd === 'string') m.folder(p.cwd);
        if (typeof p.model === 'string') m.model = p.model;
        // With approvals off, a quiet command is just a slow command.
        m.asksPermission = p.approval_policy !== 'never';
        return;
      case 'response_item':
        return this.item(p, at, time);
      case 'event_msg':
        return this.event(p, at, time);
    }
  }

  private item(p: Json, at: number, time: string): void {
    const m = this.m;
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const callId = String(p.call_id ?? p.id ?? '');
      if (!callId) return;
      const name = p.type === 'local_shell_call' ? 'local_shell' : String(p.name ?? '');
      const input = p.type === 'custom_tool_call' ? { input: p.input } : p.type === 'local_shell_call' ? { command: p.action?.command } : parseArgs(p.arguments);
      if (name === 'update_plan' && Array.isArray(input.plan)) {
        m.todos = input.plan.map((s: Json): Todo => ({ text: String(s?.step ?? ''), status: todoStatus(s?.status) })).filter((t: Todo) => t.text);
      }
      const mapped = mapCall(name, input, m.cwd);
      const files = mapped.files?.length ? mapped.files : [undefined];
      const ids = files.map((f, i) => (i ? `${callId}#${i}` : callId));
      files.forEach((f, i) => m.toolStart(ids[i]!, mapped.name, f ? { ...mapped.input, file_path: f } : mapped.input, at, time));
      this.calls.set(callId, { ids, bash: mapped.name === 'Bash' });
      m.stop('tool_use');
      return;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const callId = String(p.call_id ?? '');
      const call = this.calls.get(callId);
      if (!call) return;
      this.calls.delete(callId);
      const out = call.bash ? execResult(p.output) : { text: outputText(p.output) };
      const failed = (out.exit !== undefined && out.exit !== 0) || (!call.bash && /^(error|apply_patch verification failed|failed)/i.test(out.text));
      for (const id of call.ids) m.toolEnd(id, { text: out.text, isError: failed }, time);
      return;
    }
    if (p.type === 'message' && p.role === 'assistant') m.stop(null);
  }

  private event(p: Json, at: number, time: string): void {
    const m = this.m;
    switch (p.type) {
      case 'task_started':
      case 'turn_started':
        if (typeof p.model_context_window === 'number' && p.model_context_window > 0) m.window = p.model_context_window;
        m.stop(null);
        return;
      case 'user_message':
        return this.prompt(time, String(p.message ?? ''));
      case 'item_completed':
        if (p.item?.type === 'UserMessage' && Array.isArray(p.item.content)) {
          this.prompt(time, p.item.content.map((c: Json) => (typeof c?.text === 'string' ? c.text : '')).join(' '));
        }
        return;
      case 'token_count': {
        const info = p.info;
        if (!info) return;
        if (typeof info.model_context_window === 'number' && info.model_context_window > 0) m.window = info.model_context_window;
        const last = info.last_token_usage ?? {};
        const input = Number(last.input_tokens ?? 0);
        m.usageFor(`${this.lineNo}`, at, {
          // input_tokens includes the cached part; only the rest is new.
          in: Math.max(0, input - Number(last.cached_input_tokens ?? 0)),
          out: Number(last.output_tokens ?? 0),
          context: Number(last.total_tokens ?? input + Number(last.output_tokens ?? 0)),
        });
        return;
      }
      case 'task_complete':
        this.calls.clear();
        m.stop('end_turn');
        return;
      case 'turn_aborted':
        this.calls.clear();
        m.interrupt();
        return;
    }
  }
}

/** Day folders (YYYY/MM/DD) that could hold a session active within liveMs. */
function recentDays(root: string, sinceMs: number): string[] {
  // Folders are named in local time; a day of slack covers time zones and sessions
  // that started the day before and are still running.
  const since = new Date(sinceMs - 86_400_000);
  const floor = since.getFullYear() * 10000 + (since.getMonth() + 1) * 100 + since.getDate();
  const out: string[] = [];
  for (const y of list(root)) {
    if (!/^\d{4}$/.test(y) || Number(y) * 10000 + 1231 < floor) continue;
    for (const mo of list(path.join(root, y))) {
      if (!/^\d{2}$/.test(mo) || Number(y) * 10000 + Number(mo) * 100 + 31 < floor) continue;
      for (const d of list(path.join(root, y, mo))) {
        if (/^\d{2}$/.test(d) && Number(y) * 10000 + Number(mo) * 100 + Number(d) >= floor) out.push(path.join(root, y, mo, d));
      }
    }
  }
  return out;
}

export const codexAdapter: AgentAdapter = {
  tool: 'codex',
  live(cfg: Config, nowMs: number) {
    const out: string[] = [];
    for (const day of recentDays(path.join(cfg.codexDir, 'sessions'), nowMs - cfg.liveMs)) {
      for (const f of list(day)) {
        // .jsonl.zst is a compressed idle session (7+ days old): never live.
        if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
        const file = path.join(day, f);
        if (nowMs - mtime(file) <= cfg.liveMs) out.push(file);
      }
    }
    return out;
  },
  open(file) {
    return new CodexTracker(file);
  },
};
