// Reads one Claude Code session log (~/.claude/projects/<dir>/<sessionId>.jsonl)
// incrementally and feeds the session model (src/model.ts).
//
// The log format is NOT a published API. Everything here is defensive: unknown
// lines are skipped, missing fields are tolerated, and a shape change degrades the
// panel rather than crashing it. Formats handled:
//   - todo lists from TodoWrite (todos[]) and from TaskCreate / TaskUpdate
//   - token usage from assistant message.usage
//   - tool_use / tool_result pairs, to know what is running and what is waiting
// Subagent lines (isSidechain) count towards "subagents running" only; their todos
// and usage belong to the subagent, not the session the user is watching. Since
// Claude Code 2.1.2xx subagents log to <sessionId>/subagents/*.jsonl instead, so a
// pending Agent/Task call in the main chain is what shows them now.
//
// Checked against 118 real logs (Claude Code 2.1.278-2.1.309, Oct 2026): no TodoWrite
// or TaskCreate calls at all, so live sessions there have no todo list to show.
//
// Claude-only, and kept here: slash commands and the skill in use, ai-title, the
// permission mode, and the model attachment that says "[1m]".

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session, Todo, TodoStatus } from '../types.js';
import { DEFAULT_SESSION_OPTIONS, SessionModel, type SessionOptions } from '../model.js';
import type { AgentAdapter } from './types.js';

type Json = Record<string, any>;

interface Task {
  id: string;
  text: string;
  status: TodoStatus;
}

export class SessionTracker {
  readonly file: string;
  readonly opts: SessionOptions;
  private offset = 0;
  private partial = '';
  private m: SessionModel;

  /** From the "model" attachment; unlike message.model it says "[1m]" for 1M-context models. */
  private modelId?: string;
  private todoWriteList: Todo[] | null = null;
  private tasks: Task[] = [];
  /** TaskCreate calls waiting for their result, which carries the task's id ("Task #3 created"). */
  private taskCreates = new Map<string, string>();

  constructor(file: string, opts: SessionOptions = DEFAULT_SESSION_OPTIONS) {
    this.file = file;
    this.opts = opts;
    this.m = new SessionModel(file, path.basename(file, '.jsonl'), opts);
    this.m.repoFallback = guessRepoFromDir(file);
  }

  get id(): string {
    return this.m.id;
  }

  get cwd(): string {
    return this.m.cwd;
  }

  get lastEventMs(): number {
    return this.m.lastEventMs;
  }

  /** Reads whatever has been appended since the last call. Returns true if anything changed. */
  poll(): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return false;
    }
    if (stat.size < this.offset) {
      // Rewritten or truncated: start over.
      this.offset = 0;
      this.partial = '';
    }
    if (stat.size === this.offset) return false;
    const fd = fs.openSync(this.file, 'r');
    try {
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      this.offset = stat.size;
      this.feedText(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  feedText(text: string): void {
    const chunk = this.partial + text;
    const lines = chunk.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.feedLine(line);
  }

  feedLine(line: string): void {
    if (!line.trim()) return;
    let e: Json;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const m = this.m;
    const ts = typeof e.timestamp === 'string' ? e.timestamp : undefined;
    const ms = m.seen(ts);
    if (typeof e.cwd === 'string' && e.cwd) m.folder(e.cwd);
    if (typeof e.gitBranch === 'string' && e.gitBranch) m.branch = e.gitBranch;
    if (typeof e.sessionId === 'string' && e.sessionId) m.id = e.sessionId;

    // Newer Claude Code says who started each turn. "sdk" is a program (`claude -p`, the Agent
    // SDK): a benchmark spawning runs, not someone at a keyboard. Such runs never stop for a
    // permission prompt either: a tool they may not use fails at once.
    if (e.type === 'user' && e.turnOrigin === 'sdk') {
      m.scripted = true;
      m.asksPermission = false;
    }
    if (typeof e.permissionMode === 'string') {
      // Auto and bypassPermissions decide on their own, so a quiet tool is never a prompt.
      // The mode comes from the last prompt line, so a mid-turn switch lags a turn.
      m.asksPermission = !m.scripted && e.permissionMode !== 'auto' && e.permissionMode !== 'bypassPermissions';
    }

    if (e.type === 'summary' && typeof e.summary === 'string') {
      m.title('summary', e.summary);
      return;
    }
    // Claude Code's own session title, rewritten as the session goes; latest wins.
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string') {
      m.title('tool', e.aiTitle);
      return;
    }
    // A background job that finished mid-turn reports as a queued notification, not a prompt.
    if (e.type === 'attachment' && e.attachment?.type === 'queued_command' && typeof e.attachment.prompt === 'string') {
      this.noteJobDone(e.attachment.prompt);
      return;
    }
    if (e.type === 'attachment' && e.attachment?.type === 'model' && typeof e.attachment.identity?.modelId === 'string') {
      this.modelId = e.attachment.identity.modelId;
      return;
    }
    const msg: Json | undefined = e.message;
    if (!msg) return;
    const at = Number.isNaN(ms) ? m.lastEventMs : ms;
    const time = ts ?? m.lastEventAt ?? new Date(0).toISOString();

    if (e.isSidechain) {
      // Only used to show that subagents are busy.
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c?.type === 'tool_use' && typeof c.id === 'string') m.subagentToolStart(c.id);
        if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') m.subagentToolEnd(c.tool_use_id);
      }
      return;
    }
    if (e.type === 'assistant') this.feedAssistant(msg, at, time);
    else if (e.type === 'user') this.feedUser(e, msg, time);
  }

  private feedAssistant(msg: Json, at: number, time: string): void {
    const m = this.m;
    if (typeof msg.model === 'string' && !msg.model.startsWith('<')) m.model = msg.model;
    const u = msg.usage;
    if (u && typeof u === 'object') {
      m.usageFor(typeof msg.id === 'string' ? msg.id : '', at, {
        // Cache reads are the existing context re-read every turn, not new work.
        in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        out: u.output_tokens ?? 0,
        context: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      });
    }
    // Streaming writes one line per content block (up to 9 per message in real logs).
    // Real lines all carry the message's stop_reason; null is kept for older versions.
    m.stop(msg.stop_reason !== undefined && msg.stop_reason !== null ? String(msg.stop_reason) : null);
    for (const c of Array.isArray(msg.content) ? msg.content : []) {
      if (c?.type !== 'tool_use') continue;
      const name = String(c.name ?? '');
      const input: Json = c.input && typeof c.input === 'object' ? c.input : {};
      const id = String(c.id ?? `${name}-${at}`);
      this.applyTodos(name, input);
      if (name === 'Skill' && typeof input.skill === 'string' && input.skill) m.inUse = { kind: 'skill', name: input.skill, time };
      if (name === 'TaskCreate') this.taskCreates.set(id, String(input.subject ?? input.description ?? 'Task'));
      m.toolStart(id, name, input, at, time);
    }
  }

  /**
   * "<command-name>/execute</command-name>": the slash command the user just ran. Any
   * other prompt from the user ("continue") ends it: "in use" means this turn's skill,
   * not one run hours ago in the same session. Meta lines (the skill's own body) do not.
   */
  private noteCommand(text: string, time: string, e: Json): void {
    const cmd = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text);
    if (cmd?.[1]) this.m.inUse = { kind: 'command', name: cmd[1], time };
    else if (!e.isMeta && isHumanText(text)) this.m.inUse = undefined;
  }

  private feedUser(e: Json, msg: Json, time: string): void {
    const content = msg.content;
    if (typeof content === 'string') {
      if (this.interrupted(content)) return;
      this.noteJobDone(content);
      this.noteCommand(content, time, e);
      this.takeTitle(content, e);
      // Meta lines (skill bodies, reminders) arrive mid-turn and answer nothing.
      if (e.isMeta) return;
      this.m.promptSent(typeof e.turnOrigin === 'string' ? e.turnOrigin === 'human' : isHumanText(content) || content.includes('<command-name>'));
      return;
    }
    if (!Array.isArray(content)) return;
    // VS Code and pasted images send the prompt as blocks, not a string: still a prompt,
    // and it answers whatever was waiting. Missing this left the turn's start unknown.
    if (!e.isMeta && !content.some((c: Json) => c?.type === 'tool_result') && content.some((c: Json) => c?.type === 'text' && typeof c.text === 'string' && isHumanText(c.text))) {
      // turnOrigin, when the log has it, says outright whether a person sent this.
      this.m.promptSent(typeof e.turnOrigin === 'string' ? e.turnOrigin === 'human' : true);
    }
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string' && !this.interrupted(c.text)) {
        this.noteCommand(c.text, time, e);
        this.takeTitle(c.text, e);
      }
      if (c?.type !== 'tool_result') continue;
      const id = String(c.tool_use_id ?? '');
      const text = resultText(c.content);
      const known = this.m.toolEnd(id, { text, isError: c.is_error === true }, time);
      const subject = this.taskCreates.get(id);
      this.taskCreates.delete(id);
      if (known && subject !== undefined) {
        const n = /#(\w+)/.exec(text);
        this.tasks.push({ id: n?.[1] ?? String(this.tasks.length + 1), text: subject, status: 'pending' });
      }
    }
  }

  private noteJobDone(text: string): void {
    // Only a final status ends a job: a monitor also sends notifications for each event it sees.
    if (!/<status>(completed|killed|failed|stopped)/.test(text)) return;
    const id = /<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
    if (id) this.m.jobDone(id.trim());
  }

  /** "[Request interrupted by user]" (Esc) ends the turn with no end_turn line. */
  private interrupted(text: string): boolean {
    if (!text.startsWith('[Request interrupted by user')) return false;
    this.m.interrupt();
    return true;
  }

  private takeTitle(text: string, e: Json): void {
    const m = this.m;
    if (e.isMeta || e.isCompactSummary) return;
    const t = text.trim();
    // A session opened with a slash command has no plain prompt, and its ai-title can
    // take a while to appear; "/execute plan-name" beats "Untitled session" meanwhile.
    const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
    if (cmd && !m.hasTitle('command') && !m.hasTitle('prompt')) {
      const args = /<command-args>([^<]*)<\/command-args>/.exec(t)?.[1]?.trim();
      m.title('command', `${cmd[1]}${args ? ` ${args}` : ''}`.slice(0, 90));
    }
    if (!t || t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('This session is being continued')) return;
    m.promptTitle(t);
    m.promptActivity(e.timestamp ?? '', t.replace(/\s+/g, ' ').slice(0, 90));
  }

  private applyTodos(name: string, input: Json): void {
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      this.todoWriteList = input.todos.map((t: Json) => ({
        text: String(t.content ?? t.activeForm ?? ''),
        status: normaliseStatus(t.status),
      }));
    } else if (name === 'TaskUpdate') {
      const id = String(input.taskId ?? input.id ?? '');
      const idx = this.tasks.findIndex((t) => t.id === id);
      const task = this.tasks[idx];
      if (!task) return;
      if (input.status === 'deleted') this.tasks.splice(idx, 1);
      else {
        if (input.status) task.status = normaliseStatus(input.status);
        if (typeof input.subject === 'string') task.text = input.subject;
      }
    }
  }

  todos(): Todo[] {
    // Whichever mechanism the session used. TodoWrite replaces the whole list each call.
    if (this.tasks.length) return this.tasks.map(({ text, status }) => ({ text, status }));
    return this.todoWriteList ?? [];
  }

  snapshot(nowMs: number = Date.now()): Session {
    const m = this.m;
    m.todos = this.todos();
    // message.model never says "1m" in real logs ("claude-opus-5"); the model attachment
    // does ("claude-opus-5[1m]").
    m.bigContext = /1m/i.test(m.model ?? '') || /\[1m\]/i.test(this.modelId ?? '');
    return m.snapshot(nowMs);
  }
}

/** A prompt the user typed, as opposed to a tag line (<command-…>, <local-command-…>) or a caveat. */
function isHumanText(text: string): boolean {
  const t = text.trim();
  // A prompt that opens with pasted text is still the person's.
  return !!t && (!t.startsWith('<') || t.startsWith('<pasted_content')) && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted');
}

function normaliseStatus(s: unknown): TodoStatus {
  const v = String(s ?? '').toLowerCase();
  if (v === 'completed' || v === 'done' || v === 'complete') return 'completed';
  if (v === 'in_progress' || v === 'in-progress' || v === 'active') return 'in_progress';
  return 'pending';
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/** ~/.claude/projects/-Users-me-Desktop-Projects-Garden/x.jsonl -> "Garden" (best effort). */
function guessRepoFromDir(file: string): string {
  const dir = path.basename(path.dirname(file));
  const parts = dir.split('-').filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** Claude Code: one JSONL log per session under ~/.claude/projects/<dir>/. */
export const claudeAdapter: AgentAdapter = {
  tool: 'claude-code',
  live(cfg, nowMs) {
    const out: string[] = [];
    for (const dir of readdir(cfg.claudeProjectsDir)) {
      const full = path.join(cfg.claudeProjectsDir, dir);
      for (const f of readdir(full)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(full, f);
        try {
          if (nowMs - fs.statSync(file).mtimeMs <= cfg.liveMs) out.push(file);
        } catch {
          /* gone since the listing */
        }
      }
    }
    return out;
  },
  open(file, cfg) {
    return new SessionTracker(file, { ...DEFAULT_SESSION_OPTIONS, contextWindow: cfg.contextWindow });
  },
};

function readdir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}
