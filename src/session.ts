// Reads one Claude Code session log (~/.claude/projects/<dir>/<sessionId>.jsonl)
// incrementally and keeps a live picture of it.
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

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Activity, LastEdit, Session, SessionState, Todo, TodoStatus, TouchedFile } from './types.js';
import { ASKING_TOOLS, bashWrites, describeTool, editSnippets, isTestCommand, lineCount, rel } from './describe.js';

type Json = Record<string, any>;

export interface SessionOptions {
  /** Context window assumed when the model id gives no hint. */
  contextWindow: number;
  /** A tool call unanswered this long, with the log quiet, is probably a permission prompt. */
  permissionMs: number;
  /** No log activity for this long means idle. */
  idleMs: number;
}

// From real logs: Bash leaves the log quiet for over 8s on 8.9% of calls, over 15s on
// 5.8%, over 60s on 2.6%. 15s halves the false "permission" guesses from long commands
// for a few seconds' delay on a real prompt. Auto mode gets no guess at all: every one of
// ~1,700 recorded permission decisions there was made without the user, and a minute's
// grace still flagged waits like `until ! pgrep ...; do sleep 10; done` as "needs you"
// (seen 2026-10-23). idleMs: people took up to 5 minutes to answer an
// AskUserQuestion, so 15 minutes of silence is well past "thinking about it".
export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  contextWindow: 200_000,
  permissionMs: 15_000,
  idleMs: 15 * 60_000,
};

interface Pending {
  name: string;
  at: number;
  testCommand: boolean;
  activity: Activity | null;
  taskCreate?: { subject: string };
  /** Held until the result says the edit landed, so follow mode never opens a failed one. */
  edit?: { file: string; snippets: string[] };
}

interface Task {
  id: string;
  text: string;
  status: TodoStatus;
}

const MAX_ACTIVITY = 60;
// Effort is "right now": the log only records tokens when a reply finishes, so each reply
// is a burst that fades with this time constant. 15s keeps the needle up through a run of
// tool calls (replies land every few seconds) and lets it fall within half a minute of quiet.
// The surfaces animate between readings, so a burst glides up rather than jumping.
const THROUGHPUT_TAU_MS = 15_000;
// Full scale for the speedometer, tokens in + out per minute, as read above. Sampled every
// 2s while sessions were active in 118 real logs: median 6.9k, 75th percentile 12.5k, 90th
// 19.8k, 95th 27.7k. 25k leaves ordinary work in the lower half and pegs only the top 5%.
const GAUGE_FULL_PER_MIN = 25_000;

export class SessionTracker {
  readonly file: string;
  readonly opts: SessionOptions;
  private offset = 0;
  private partial = '';

  id: string;
  /**
   * Where the session started: every path Monty shows is relative to this. Claude Code
   * writes the shell's current folder on each line, so after `cd app/src` later lines say
   * .../app/src; measuring from that gave the same file two names (config.py and
   * app/server/config.py).
   */
  cwd = '';
  /** The shell's folder right now, to resolve relative paths in Bash commands. */
  private shellCwd = '';
  branch?: string;
  model?: string;
  title = '';
  startedAt?: string;
  lastEventAt?: string;
  lastEventMs = 0;
  private lastStop: string | null = null;
  private lastStopMs = 0;
  private pending = new Map<string, Pending>();
  private sidechainPending = new Set<string>();
  private todoWriteList: Todo[] | null = null;
  private tasks: Task[] = [];
  private activity: Activity[] = [];
  private touched = new Map<string, TouchedFile>();
  private contextTokens = 0;
  /** Token use per assistant message (counted once: streaming repeats usage on every line), recent ones only. */
  private usage: { at: number; in: number; out: number }[] = [];
  private usageSeen = new Set<string>();
  /** From the "model" attachment; unlike message.model it says "[1m]" for 1M-context models. */
  private modelId?: string;
  private permissionMode?: string;
  private aiTitle = '';
  private inUse?: Session['inUse'];
  private commandTitle = '';
  private lastTest?: { ok: boolean; summary: string; time: string };
  private lastEdit?: LastEdit;
  private summaryTitle = '';

  constructor(file: string, opts: SessionOptions = DEFAULT_SESSION_OPTIONS) {
    this.file = file;
    this.opts = opts;
    this.id = path.basename(file, '.jsonl');
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
    const ts = typeof e.timestamp === 'string' ? e.timestamp : undefined;
    const ms = ts ? Date.parse(ts) : NaN;
    if (ts && !Number.isNaN(ms)) {
      if (!this.startedAt) this.startedAt = ts;
      if (ms >= this.lastEventMs) {
        this.lastEventMs = ms;
        this.lastEventAt = ts;
      }
    }
    if (typeof e.cwd === 'string' && e.cwd) {
      if (!this.cwd) this.cwd = e.cwd;
      this.shellCwd = e.cwd;
    }
    if (typeof e.gitBranch === 'string' && e.gitBranch) this.branch = e.gitBranch;
    if (typeof e.sessionId === 'string' && e.sessionId) this.id = e.sessionId;

    if (typeof e.permissionMode === 'string') this.permissionMode = e.permissionMode;

    if (e.type === 'summary' && typeof e.summary === 'string') {
      this.summaryTitle = e.summary;
      return;
    }
    // Claude Code's own session title, rewritten as the session goes; latest wins.
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string') {
      this.aiTitle = e.aiTitle;
      return;
    }
    if (e.type === 'attachment' && e.attachment?.type === 'model' && typeof e.attachment.identity?.modelId === 'string') {
      this.modelId = e.attachment.identity.modelId;
      return;
    }
    const msg: Json | undefined = e.message;
    if (!msg) return;
    const at = Number.isNaN(ms) ? this.lastEventMs : ms;
    const time = ts ?? this.lastEventAt ?? new Date(0).toISOString();

    if (e.isSidechain) {
      this.feedSidechain(e, msg);
      return;
    }
    if (e.type === 'assistant') this.feedAssistant(msg, at, time);
    else if (e.type === 'user') this.feedUser(e, msg, time);
  }

  private feedSidechain(e: Json, msg: Json): void {
    // Only used to show that subagents are busy.
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const c of content) {
      if (c?.type === 'tool_use' && typeof c.id === 'string') this.sidechainPending.add(c.id);
      if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') this.sidechainPending.delete(c.tool_use_id);
    }
    void e;
  }

  private feedAssistant(msg: Json, at: number, time: string): void {
    if (typeof msg.model === 'string' && !msg.model.startsWith('<')) this.model = msg.model;
    const u = msg.usage;
    if (u && typeof u === 'object') {
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (tokens > 0) this.contextTokens = tokens;
      const key = typeof msg.id === 'string' ? msg.id : '';
      if (key && !this.usageSeen.has(key)) {
        this.usageSeen.add(key);
        this.usage.push({ at, in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0 });
        const cutoff = at - 10 * THROUGHPUT_TAU_MS; // e^-10: nothing left to count
        while (this.usage.length && (this.usage[0]?.at ?? 0) < cutoff) this.usage.shift();
        if (this.usageSeen.size > 5000) this.usageSeen.clear();
      }
    }
    // Streaming writes one line per content block (up to 9 per message in real logs).
    // Real lines all carry the message's stop_reason; null is kept for older versions.
    if (msg.stop_reason !== undefined && msg.stop_reason !== null) {
      this.lastStop = String(msg.stop_reason);
      this.lastStopMs = at;
      // A finished turn has nothing in flight. Interrupted or queued-over tool calls
      // sometimes never get a tool_result line; without this they look stuck forever.
      if (this.lastStop === 'end_turn') this.pending.clear();
    } else {
      this.lastStop = null;
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const c of content) {
      if (c?.type !== 'tool_use') continue;
      const name = String(c.name ?? '');
      const input: Json = c.input && typeof c.input === 'object' ? c.input : {};
      const id = String(c.id ?? `${name}-${at}`);
      this.applyTodos(name, input);
      if (name === 'Skill' && typeof input.skill === 'string' && input.skill) this.inUse = { kind: 'skill', name: input.skill, time };
      const act = describeTool(name, input, this.cwd, time);
      const p: Pending = { name, at, testCommand: name === 'Bash' && isTestCommand(input.command), activity: act };
      if (name === 'TaskCreate') p.taskCreate = { subject: String(input.subject ?? input.description ?? 'Task') };
      const snippets = editSnippets(name, input);
      if (act?.file && snippets.length) p.edit = { file: act.file, snippets };
      if (name === 'Bash' && typeof input.command === 'string') this.bashEdits(p, input.command);
      this.pending.set(id, p);
      if (act) {
        this.pushActivity(act);
        this.touch(act);
      }
    }
  }

  /**
   * Files written from Bash (heredocs, sed -i, echo > f) count as edits too: some
   * sessions change most files that way, and follow mode and the explorer dots would
   * otherwise miss them. Only files inside the repo; the last one is what follow opens.
   */
  private bashEdits(p: Pending, command: string): void {
    for (const w of bashWrites(command)) {
      const home = (d: string) => (d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d);
      const shell = this.shellCwd || this.cwd;
      const base = w.dir ? path.resolve(shell || '/', home(w.dir)) : shell;
      const abs = path.resolve(base || '/', home(w.file));
      if (!this.cwd || !abs.startsWith(this.cwd + path.sep)) continue;
      const file = abs.slice(this.cwd.length + 1);
      const text = w.text ?? '';
      this.touch({ time: '', kind: 'edit', text: '', file, plus: text ? lineCount(text) : 0, minus: 0 });
      p.edit = { file, snippets: editSnippets('Write', { content: text }) };
    }
  }

  /**
   * "<command-name>/execute</command-name>": the slash command the user just ran. Any
   * other prompt from the user ("continue") ends it: "in use" means this turn's skill,
   * not one run hours ago in the same session. Meta lines (the skill's own body) do not.
   */
  private noteCommand(text: string, time: string, e: Json): void {
    const m = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text);
    if (m?.[1]) this.inUse = { kind: 'command', name: m[1], time };
    else if (!e.isMeta && isHumanText(text)) this.inUse = undefined;
  }

  private feedUser(e: Json, msg: Json, time: string): void {
    const content = msg.content;
    if (typeof content === 'string') {
      if (this.interrupted(content)) return;
      this.noteCommand(content, time, e);
      this.takeTitle(content, e);
      // Meta lines (skill bodies, reminders) arrive mid-turn and answer nothing.
      if (e.isMeta) return;
      // A new prompt answers anything Claude was waiting on.
      this.pending.clear();
      this.lastStop = null;
      return;
    }
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string' && !this.interrupted(c.text)) {
        this.noteCommand(c.text, time, e);
        this.takeTitle(c.text, e);
      }
      if (c?.type !== 'tool_result') continue;
      const id = String(c.tool_use_id ?? '');
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (!p) continue;
      const text = resultText(c.content);
      if (p.taskCreate) {
        const m = /#(\w+)/.exec(text);
        this.tasks.push({ id: m?.[1] ?? String(this.tasks.length + 1), text: p.taskCreate.subject, status: 'pending' });
      }
      if (p.testCommand) {
        // FAIL is case-sensitive (Jest's file marker): node:test prints "ℹ fail 0" on a pass.
        // FAILED/FAILURE in capitals is a verdict line ("CHECK FAILED", pytest's "FAILED tests/x"),
        // not a count; "0 failed" and "fail 0" are passes.
        const failed = c.is_error === true || /\b[1-9]\d* (failed|failing)\b|ℹ fail [1-9]/i.test(text) || /\bFAIL(ED|URE)?\b|✕/.test(text);
        const summary = summariseTest(text, failed);
        this.lastTest = { ok: !failed, summary, time };
        if (p.activity) p.activity.failed = failed;
        this.pushActivity({ time, kind: 'test', text: summary, failed });
      } else if (c.is_error === true && p.activity && p.activity.kind !== 'ask') {
        p.activity.failed = true;
      }
      if (p.edit && c.is_error !== true) this.lastEdit = { id, time, ...p.edit };
    }
  }

  /** "[Request interrupted by user]" (Esc) ends the turn with no end_turn line. */
  private interrupted(text: string): boolean {
    if (!text.startsWith('[Request interrupted by user')) return false;
    this.pending.clear();
    this.lastStop = 'interrupted';
    return true;
  }

  private takeTitle(text: string, e: Json): void {
    if (this.title || e.isMeta) return;
    const t = text.trim();
    // A session opened with a slash command has no plain prompt, and its ai-title can
    // take a while to appear; "/execute plan-name" beats "Untitled session" meanwhile.
    const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t);
    if (cmd && !this.commandTitle) {
      const args = /<command-args>([^<]*)<\/command-args>/.exec(t)?.[1]?.trim();
      this.commandTitle = `${cmd[1]}${args ? ` ${args}` : ''}`.slice(0, 90);
    }
    if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return;
    this.title = t.replace(/\s+/g, ' ').slice(0, 90);
    this.pushActivity({ time: e.timestamp ?? '', kind: 'prompt', text: `You: ${this.title}` });
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

  private pushActivity(a: Activity): void {
    this.activity.unshift(a);
    if (this.activity.length > MAX_ACTIVITY) this.activity.length = MAX_ACTIVITY;
  }

  private touch(a: Activity): void {
    if (!a.file) return;
    const t = this.touched.get(a.file) ?? { path: a.file, reads: 0, edits: 0, plus: 0, minus: 0 };
    if (a.kind === 'read') t.reads++;
    if (a.kind === 'edit' || a.kind === 'write') {
      t.edits++;
      t.plus += a.plus ?? 0;
      t.minus += a.minus ?? 0;
    }
    this.touched.set(a.file, t);
  }

  /**
   * Tokens per minute right now: each reply's tokens spread as an exponential decay
   * (tokens / tau · e^(-age / tau)), summed. One reply of N tokens reads N·60/15 per minute
   * the moment it lands and halves about every 10 seconds after.
   */
  private throughput(nowMs: number): Session['throughput'] {
    let rin = 0;
    let rout = 0;
    for (const u of this.usage) {
      const age = nowMs - u.at;
      if (age < 0 || age > 10 * THROUGHPUT_TAU_MS) continue;
      const w = Math.exp(-age / THROUGHPUT_TAU_MS) / THROUGHPUT_TAU_MS;
      rin += u.in * w;
      rout += u.out * w;
    }
    const inPerMin = Math.round(rin * 60_000);
    const outPerMin = Math.round(rout * 60_000);
    // Two decimals: finer steps would change the state every tick for no visible movement.
    return { inPerMin, outPerMin, level: Math.round(Math.min(1, (inPerMin + outPerMin) / GAUGE_FULL_PER_MIN) * 100) / 100 };
  }

  todos(): Todo[] {
    // Whichever mechanism the session used. TodoWrite replaces the whole list each call.
    if (this.tasks.length) return this.tasks.map(({ text, status }) => ({ text, status }));
    return this.todoWriteList ?? [];
  }

  snapshot(nowMs: number = Date.now()): Session {
    const todos = this.todos();
    const done = todos.filter((t) => t.status === 'completed').length;
    const { state, reason } = this.deriveState(nowMs, todos.length, done);
    // message.model never says "1m" in real logs ("claude-opus-5"); the model attachment
    // does ("claude-opus-5[1m]"). A session past the default window must be running a
    // larger one either way, so assume 1M rather than show 300%.
    const big = /1m/i.test(this.model ?? '') || /\[1m\]/i.test(this.modelId ?? '');
    const window = big || this.contextTokens > this.opts.contextWindow ? 1_000_000 : this.opts.contextWindow;
    const agents = [...this.pending.values()].filter((p) => p.name === 'Agent' || p.name === 'Task').length;
    const nowAct = this.activity.find((a) => a.kind !== 'prompt');
    const cwd = this.cwd;
    return {
      id: this.id,
      file: this.file,
      cwd,
      repo: cwd ? path.basename(cwd) : guessRepoFromDir(this.file),
      branch: this.branch,
      model: this.model,
      title: this.aiTitle || this.title || this.commandTitle || this.summaryTitle || 'Untitled session',
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      state,
      stateReason: reason,
      todos,
      progress: { done, total: todos.length },
      now: nowAct,
      activity: this.activity.slice(0, 25),
      context: { tokens: this.contextTokens, window, pct: Math.min(100, Math.round((this.contextTokens / window) * 100)) },
      touched: [...this.touched.values()].sort((a, b) => b.edits - a.edits || b.reads - a.reads).slice(0, 30),
      lastTest: this.lastTest,
      lastEdit: this.lastEdit,
      inUse: this.inUse,
      subagentsRunning: Math.max(agents, this.sidechainPending.size > 0 ? 1 : 0),
      throughput: this.throughput(nowMs),
    };
  }

  private deriveState(nowMs: number, total: number, done: number): { state: SessionState; reason: string } {
    const quietMs = nowMs - this.lastEventMs;
    for (const p of this.pending.values()) {
      if (ASKING_TOOLS.has(p.name)) return { state: 'needs_input', reason: p.name === 'ExitPlanMode' ? 'Plan ready for your approval' : 'Claude asked you a question' };
    }
    if (this.pending.size > 0) {
      const oldest = Math.min(...[...this.pending.values()].map((p) => p.at));
      const first = [...this.pending.values()].find((p) => p.at === oldest);
      // A long-running command also looks like this; the label says "probably". Only in
      // modes where Claude Code asks: auto and bypassPermissions decide on their own.
      // permissionMode comes from the last prompt line, so a mid-turn switch lags a turn.
      const asks = this.permissionMode !== 'auto' && this.permissionMode !== 'bypassPermissions';
      const wait = this.opts.permissionMs;
      if (asks && nowMs - oldest > wait && quietMs > wait && first && first.name !== 'Task' && first.name !== 'Agent') {
        return { state: 'needs_input', reason: `Probably waiting for permission: ${first.activity?.text ?? first.name}` };
      }
      const what = first?.activity?.text ?? 'Working';
      // Say how long, so a quiet minute reads as a slow command rather than a stall.
      const ran = nowMs - oldest;
      return { state: 'working', reason: ran >= 60_000 ? `${what} (running ${Math.floor(ran / 60_000)} min)` : what };
    }
    if (quietMs > this.opts.idleMs) return { state: 'idle', reason: 'No activity for a while' };
    if (this.lastStop === 'end_turn' || this.lastStop === 'stop_sequence') {
      if (total > 0 && done === total) return { state: 'done', reason: 'All tasks complete' };
      return { state: 'your_turn', reason: 'Claude finished its turn' };
    }
    if (this.lastStop === 'interrupted') return { state: 'your_turn', reason: 'You interrupted' };
    if (quietMs > 90_000) return { state: 'your_turn', reason: 'Quiet' };
    return { state: 'working', reason: 'Thinking' };
  }
}

/** A prompt the user typed, as opposed to a tag line (<command-…>, <local-command-…>) or a caveat. */
function isHumanText(text: string): boolean {
  const t = text.trim();
  return !!t && !t.startsWith('<') && !t.startsWith('Caveat:') && !t.startsWith('[Request interrupted');
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

function summariseTest(text: string, failed: boolean): string {
  const line = text.split('\n').reverse().find((l) => /\b(passed|failed|passing|failing)\b/i.test(l));
  const clean = line?.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (clean && clean.length < 90) return `Tests: ${clean.replace(/^Tests?:\s*/i, '')}`;
  return failed ? 'Tests failing' : 'Tests passing';
}

/** ~/.claude/projects/-Users-me-Desktop-Projects-Garden/x.jsonl -> "Garden" (best effort). */
function guessRepoFromDir(file: string): string {
  const dir = path.basename(path.dirname(file));
  const parts = dir.split('-').filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

export { rel };
