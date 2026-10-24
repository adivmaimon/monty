// The live picture of one agent session, whatever tool it came from. Adapters
// (src/agents/*) read a tool's own logs and feed this model events: a tool call started
// or ended, tokens used, a turn ended. The model turns those into what every surface
// shows: state, activity, files touched, the last test run, context and effort.
//
// Tool names are Claude Code's (Read, Edit, Write, Bash, ...), since describeTool knows
// those. Adapters for other tools map their own names onto them.

import * as os from 'node:os';
import * as path from 'node:path';
import type { Activity, AgentTool, LastEdit, Session, SessionState, Todo, TouchedFile } from './types.js';
import { ASKING_TOOLS, bashWrites, describeTool, editSnippets, isTestCommand, lineCount } from './describe.js';

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
  /** Held until the result says the edit landed, so follow mode never opens a failed one. */
  edit?: { file: string; snippets: string[] };
}

const MAX_ACTIVITY = 60;
// Effort is "right now": logs only record tokens when a reply finishes, so each reply
// is a burst that fades with this time constant. 15s keeps the needle up through a run of
// tool calls (replies land every few seconds) and lets it fall within half a minute of quiet.
// The surfaces animate between readings, so a burst glides up rather than jumping.
const THROUGHPUT_TAU_MS = 15_000;
// Full scale for the speedometer, tokens in + out per minute, as read above. Sampled every
// 2s while sessions were active in 118 real logs: median 6.9k, 75th percentile 12.5k, 90th
// 19.8k, 95th 27.7k. 25k leaves ordinary work in the lower half and pegs only the top 5%.
const GAUGE_FULL_PER_MIN = 25_000;

/** Which title wins when a session has several: the tool's own, the first prompt, a command, a summary. */
export type TitleSource = 'tool' | 'prompt' | 'command' | 'summary';
const TITLE_ORDER: TitleSource[] = ['tool', 'prompt', 'command', 'summary'];
// A headline needs a few words: "yes", "commit", "looks good" are replies, not new work.
const MIN_TITLE_WORDS = 3;
const MIN_TITLE_CHARS = 12;

export class SessionModel {
  readonly opts: SessionOptions;
  file: string;
  id: string;
  /**
   * Where the session started: every path Monty shows is relative to this. Claude Code
   * writes the shell's current folder on each line, so after `cd app/src` later lines say
   * .../app/src; measuring from that gave the same file two names (config.py and
   * app/server/config.py).
   */
  cwd = '';
  /** The shell's folder right now, to resolve relative paths in Bash commands. */
  shellCwd = '';
  branch?: string;
  model?: string;
  startedAt?: string;
  lastEventAt?: string;
  lastEventMs = 0;
  /** The tool asks before running commands; when false, a quiet tool is never a permission guess. */
  asksPermission = true;
  /** The model is known to have a 1M context window. */
  bigContext = false;
  /** The model's context window, when the tool records it (Codex, Copilot). */
  window?: number;
  /** Repo name when there is no cwd (the adapter knows how its tool names folders). */
  repoFallback = '';
  inUse?: Session['inUse'];
  todos: Todo[] = [];
  /** Which tool the session is from, and its name in state reasons ("Claude has a question for you"). */
  agent: AgentTool = 'claude-code';
  agentName = 'Claude';

  private titles: Partial<Record<TitleSource, string>> = {};
  /** Prompts that said something (see promptTitle). */
  private prompts = 0;
  private needsInput?: string;
  private lastStop: string | null = null;
  private pending = new Map<string, Pending>();
  private sidechainPending = new Set<string>();
  private activity: Activity[] = [];
  private touched = new Map<string, TouchedFile>();
  private contextTokens = 0;
  /** Token use per reply, counted once per reply id, recent ones only. */
  private usage: { at: number; in: number; out: number }[] = [];
  private usageSeen = new Set<string>();
  private lastTest?: { ok: boolean; summary: string; time: string };
  private lastEdit?: LastEdit;

  constructor(file: string, id: string, opts: SessionOptions = DEFAULT_SESSION_OPTIONS) {
    this.file = file;
    this.id = id;
    this.opts = opts;
  }

  // ---------- events ----------

  /** Any timestamped record: sets the start and the latest event time. */
  seen(ts: string | undefined): number {
    const ms = ts ? Date.parse(ts) : NaN;
    if (ts && !Number.isNaN(ms)) {
      if (!this.startedAt) this.startedAt = ts;
      if (ms >= this.lastEventMs) {
        this.lastEventMs = ms;
        this.lastEventAt = ts;
      }
    }
    return ms;
  }

  /** The folder a record says the session is in. The first one is the session's root. */
  folder(cwd: string): void {
    if (!cwd) return;
    if (!this.cwd) this.cwd = cwd;
    this.shellCwd = cwd;
  }

  title(source: TitleSource, text: string): void {
    this.titles[source] = text;
  }

  /**
   * A prompt as the headline. The latest one that says something wins: a long session
   * moves on to new work, and its first prompt (or the tool's own title, which Claude
   * Code writes once and never changes) went stale. After the first, "yes", "execute" and
   * other short replies are not new work and leave the headline alone. Returns whether it counted.
   */
  promptTitle(text: string): boolean {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return false;
    // The first prompt is the headline whatever it says: anything beats "Untitled session".
    if (this.titles.prompt && (t.length < MIN_TITLE_CHARS || t.split(' ').length < MIN_TITLE_WORDS)) return false;
    this.titles.prompt = t.slice(0, 90);
    this.prompts++;
    return true;
  }

  hasTitle(source: TitleSource): boolean {
    return !!this.titles[source];
  }

  /** The prompt line in the activity feed. */
  promptActivity(time: string, text: string): void {
    this.pushActivity({ time, kind: 'prompt', text: `You: ${text}` });
  }

  /** Tokens for one reply: new input (not context re-read), output, and the context it filled. */
  usageFor(replyId: string, at: number, u: { in: number; out: number; context: number }): void {
    if (u.context > 0) this.contextTokens = u.context;
    if (replyId && !this.usageSeen.has(replyId)) {
      this.usageSeen.add(replyId);
      this.usage.push({ at, in: u.in, out: u.out });
      const cutoff = at - 10 * THROUGHPUT_TAU_MS; // e^-10: nothing left to count
      while (this.usage.length && (this.usage[0]?.at ?? 0) < cutoff) this.usage.shift();
      if (this.usageSeen.size > 5000) this.usageSeen.clear();
    }
  }

  /** How the latest reply ended: 'end_turn', 'tool_use', or null while it is still streaming. */
  stop(reason: string | null): void {
    this.lastStop = reason;
    this.needsInput = undefined;
    // A finished turn has nothing in flight. Interrupted or queued-over tool calls
    // sometimes never get a result; without this they look stuck forever.
    if (reason === 'end_turn') this.pending.clear();
  }

  /** The person sent a new prompt: it answers anything the agent was waiting on. */
  promptSent(): void {
    this.needsInput = undefined;
    this.pending.clear();
    this.lastStop = null;
  }

  /** The person interrupted (Esc): the turn is over. */
  interrupt(): void {
    this.pending.clear();
    this.lastStop = 'interrupted';
  }

  /** `label` replaces the described activity line, for tools whose own message says it better. */
  toolStart(id: string, name: string, input: Json, at: number, time: string, label?: string): void {
    const described = describeTool(name, input, this.cwd, time);
    const act = described && label ? { ...described, text: label } : described;
    const p: Pending = { name, at, testCommand: name === 'Bash' && isTestCommand(input.command), activity: act };
    const snippets = editSnippets(name, input);
    if (act?.file && snippets.length) p.edit = { file: act.file, snippets };
    if (name === 'Bash' && typeof input.command === 'string') this.bashEdits(p, input.command);
    this.pending.set(id, p);
    if (act) {
      this.pushActivity(act);
      this.touch(act);
    }
  }

  /** A tool call's result. Returns whether the call was known. */
  toolEnd(id: string, result: { text: string; isError: boolean }, time: string): boolean {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (!p) return false;
    if (p.testCommand) {
      // FAIL is case-sensitive (Jest's file marker): node:test prints "ℹ fail 0" on a pass.
      // FAILED/FAILURE in capitals is a verdict line ("CHECK FAILED", pytest's "FAILED tests/x"),
      // not a count; "0 failed" and "fail 0" are passes.
      const text = result.text;
      const failed = result.isError || /\b[1-9]\d* (failed|failing)\b|ℹ fail [1-9]/i.test(text) || /\bFAIL(ED|URE)?\b|✕/.test(text);
      const summary = summariseTest(text, failed);
      this.lastTest = { ok: !failed, summary, time };
      if (p.activity) p.activity.failed = failed;
      this.pushActivity({ time, kind: 'test', text: summary, failed });
    } else if (result.isError && p.activity && p.activity.kind !== 'ask') {
      p.activity.failed = true;
    }
    if (p.edit && !result.isError) this.lastEdit = { id, time, ...p.edit };
    return true;
  }

  /**
   * The tool says outright that it is waiting on the person (Copilot Chat's NeedsInput):
   * no timing guess needed. Cleared by the next stop() or prompt.
   */
  waitingForUser(reason: string): void {
    this.needsInput = reason;
  }

  /** Subagent tool calls, which only count towards "subagents running". */
  subagentToolStart(id: string): void {
    this.sidechainPending.add(id);
  }

  subagentToolEnd(id: string): void {
    this.sidechainPending.delete(id);
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

  // ---------- reading ----------

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

  snapshot(nowMs: number = Date.now()): Session {
    const todos = this.todos;
    const done = todos.filter((t) => t.status === 'completed').length;
    const { state, reason } = this.deriveState(nowMs, todos.length, done);
    // A session past the default window must be running a larger one, so assume 1M
    // rather than show 300%.
    const window = this.window ?? (this.bigContext || this.contextTokens > this.opts.contextWindow ? 1_000_000 : this.opts.contextWindow);
    const agents = [...this.pending.values()].filter((p) => p.name === 'Agent' || p.name === 'Task').length;
    const nowAct = this.activity.find((a) => a.kind !== 'prompt');
    const cwd = this.cwd;
    // The tool's title describes the first task; once there is a later one, the prompt is fresher.
    const order: TitleSource[] = this.prompts > 1 ? ['prompt', 'tool', 'command', 'summary'] : TITLE_ORDER;
    const title = order.map((k) => this.titles[k]).find(Boolean);
    return {
      id: this.id,
      agent: this.agent,
      file: this.file,
      cwd,
      repo: cwd ? path.basename(cwd) : this.repoFallback,
      branch: this.branch,
      model: this.model,
      title: title || 'Untitled session',
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
    if (this.needsInput) return { state: 'needs_input', reason: this.needsInput };
    for (const p of this.pending.values()) {
      if (ASKING_TOOLS.has(p.name)) return { state: 'needs_input', reason: p.name === 'ExitPlanMode' ? 'A plan awaits your approval' : `${this.agentName} has a question for you` };
    }
    if (this.pending.size > 0) {
      const oldest = Math.min(...[...this.pending.values()].map((p) => p.at));
      const first = [...this.pending.values()].find((p) => p.at === oldest);
      // A long-running command also looks like this; the label says "probably". Only for
      // tools and modes that ask before running things.
      const wait = this.opts.permissionMs;
      if (this.asksPermission && nowMs - oldest > wait && quietMs > wait && first && first.name !== 'Task' && first.name !== 'Agent') {
        return { state: 'needs_input', reason: `Probably awaiting your permission: ${first.activity?.text ?? first.name}` };
      }
      const what = first?.activity?.text ?? 'Working';
      // Say how long, so a quiet minute reads as a slow command rather than a stall.
      const ran = nowMs - oldest;
      return { state: 'working', reason: ran >= 60_000 ? `${what} (at it for ${Math.floor(ran / 60_000)} min)` : what };
    }
    if (quietMs > this.opts.idleMs) return { state: 'idle', reason: 'Not a peep for some time' };
    if (this.lastStop === 'end_turn' || this.lastStop === 'stop_sequence') {
      if (total > 0 && done === total) return { state: 'done', reason: 'Every task done. Splendid.' };
      return { state: 'your_turn', reason: `${this.agentName} has finished and awaits your reply` };
    }
    if (this.lastStop === 'interrupted') return { state: 'your_turn', reason: 'You interrupted. Quite right.' };
    if (quietMs > 90_000) return { state: 'your_turn', reason: 'Gone rather quiet' };
    return { state: 'working', reason: 'Thinking, one presumes' };
  }
}

function summariseTest(text: string, failed: boolean): string {
  const line = text.split('\n').reverse().find((l) => /\b(passed|failed|passing|failing)\b/i.test(l));
  const clean = line?.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (clean && clean.length < 90) return `Tests: ${clean.replace(/^Tests?:\s*/i, '')}`;
  return failed ? 'Tests failing' : 'Tests passing';
}
