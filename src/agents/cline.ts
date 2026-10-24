// Cline and Roo Code. Both keep each task in the editor's globalStorage:
//
//   <User>/globalStorage/saoudrizwan.claude-dev/tasks/<taskId>/        Cline (legacy build)
//   <User>/globalStorage/rooveterinaryinc.roo-cline/tasks/<taskId>/    Roo Code
//     ui_messages.json               what the panel shows: [{ts, type:'ask'|'say', ask|say, text, partial}]
//     api_conversation_history.json  the model conversation (only read for the folder, as a fallback)
//     task_metadata.json             models used
//
// Both rewrite ui_messages.json whole (Roo through a rename that leaves it missing for a
// moment), so a task is re-read when the file changes. The folder comes from Cline's
// state/taskHistory.json or Roo's history_item.json.
//
// Cline 4 also ships an SDK build, switched on per machine, that writes nothing there: its
// sessions live in ~/.cline/data/sessions/<id>/ as a manifest (<id>.json) and the model
// messages (<id>.messages.json). Both layouts are read.
//
// Shapes are from Cline's source (legacy-extension branch 4.0.12, and main at 4.1.25,
// Oct 2026) and Roo Code 3.53 (May 2026). Not read: Roo's roo-cline.customStoragePath
// setting (it lives in the editor's settings.json, which Monty does not open).

import * as path from 'node:path';
import type { Config } from '../config.js';
import type { AgentTool, Session, Todo } from '../types.js';
import { DEFAULT_SESSION_OPTIONS, SessionModel } from '../model.js';
import type { AgentAdapter, SessionSource } from './types.js';
import { ChangedJson, list, mtime, patchFiles, readJson, readText } from './files.js';

type Json = Record<string, any>;
type Flavor = 'cline' | 'roo';

const EXTENSION: Record<Flavor, string> = { cline: 'saoudrizwan.claude-dev', roo: 'rooveterinaryinc.roo-cline' };
const NAME: Record<Flavor, string> = { cline: 'Cline', roo: 'Roo' };

/**
 * Roo routes every step through an "ask", even auto-approved ones, and answers those at
 * once; its own panel waits 2 s before treating an ask as really waiting. A little more
 * here covers the write landing late.
 */
const ROO_ASK_SETTLE_MS = 3000;

const parse = (s: unknown): Json => {
  if (typeof s !== 'string') return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {}; // a partial message's JSON is often cut short
  }
};
const iso = (ms: unknown) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined);

/** "------- SEARCH\nold\n=======\nnew\n+++++++ REPLACE" (Cline) or "<<<<<<< SEARCH ... >>>>>>> REPLACE" (Roo): the new text. */
function replaced(diff: unknown): string {
  if (typeof diff !== 'string') return '';
  return [...diff.matchAll(/^=======\n([\s\S]*?)\n(?:\+{7}|>{7}) REPLACE/gm)].map((m) => m[1] ?? '').join('\n');
}

/** "- [x] Fix bound" / "- [ ] Run tests" lines (Cline's focus chain, task_progress) as todos. */
export function checklist(md: string): Todo[] {
  const todos: Todo[] = [];
  for (const m of md.matchAll(/^\s*[-*] \[( |x|X)\] (.+)$/gm)) todos.push({ text: (m[2] ?? '').trim(), status: m[1] === ' ' ? 'pending' : 'completed' });
  const next = todos.find((t) => t.status === 'pending');
  if (next) next.status = 'in_progress';
  return todos;
}

/** A ClineSayTool ({tool, path, diff, content, ...}) as the tools describeTool knows, one per file. */
export function mapSayTool(t: Json, cwd: string): { name: string; input: Json }[] {
  const abs = (p: unknown) => (typeof p === 'string' && p ? path.resolve(cwd || '/', p) : undefined);
  const paths: (string | undefined)[] = Array.isArray(t.batchFiles) && t.batchFiles.length ? t.batchFiles.map((f: Json) => abs(f?.path)) : [abs(t.path)];
  switch (t.tool) {
    case 'readFile':
      return paths.map((p) => ({ name: 'Read', input: { file_path: p } }));
    case 'editedExistingFile':
    case 'appliedDiff':
    case 'fileDeleted': {
      const diffs: Json[] = Array.isArray(t.batchDiffs) && t.batchDiffs.length ? t.batchDiffs : [{ path: t.path, diff: t.diff }];
      return diffs.map((d) => ({ name: 'Edit', input: { file_path: abs(d.path), old_string: '', new_string: replaced(d.diff) } }));
    }
    case 'newFileCreated':
      return [{ name: 'Write', input: { file_path: abs(t.path), content: typeof t.content === 'string' ? t.content : '' } }];
    case 'listFilesTopLevel':
    case 'listFilesRecursive':
    case 'listCodeDefinitionNames':
      return [{ name: 'LS', input: { path: abs(t.path) } }];
    case 'searchFiles':
    case 'codebaseSearch':
      return [{ name: 'Grep', input: { pattern: String(t.regex ?? t.query ?? '') } }];
    case 'webFetch':
      return [{ name: 'WebFetch', input: { url: t.path ?? t.url } }];
    case 'webSearch':
      return [{ name: 'WebSearch', input: { query: t.query ?? t.path } }];
    case 'newTask':
      return [{ name: 'Agent', input: { description: String(t.content ?? 'a subtask').slice(0, 80) } }];
    case 'updateTodoList':
      return [{ name: 'TodoWrite', input: {} }];
    default:
      return [{ name: String(t.tool ?? 'tool'), input: {} }];
  }
}

// Asks that hold the task until the person acts. command_output does not.
const APPROVAL_ASKS = new Set(['tool', 'command', 'use_mcp_server', 'new_task', 'condense', 'use_subagents', 'browser_action_launch', 'summarize_task', 'report_bug']);
const REPLY_ASKS = new Set(['followup', 'plan_mode_respond', 'act_mode_respond']);
const ERROR_ASKS = new Set(['api_req_failed', 'mistake_limit_reached', 'auto_approval_max_req_reached']);

/** Replays a task's ui_messages.json into a fresh model. */
export function replayTask(msgs: Json[], o: { file: string; id: string; cwd: string; flavor: Flavor; model?: string; todos?: Todo[] }, nowMs: number): SessionModel {
  const m = new SessionModel(o.file, o.id, DEFAULT_SESSION_OPTIONS);
  const name = NAME[o.flavor];
  m.agent = o.flavor;
  m.agentName = name;
  // Waiting is read from the asks below, not guessed from a quiet tool.
  m.asksPermission = false;
  m.folder(o.cwd);
  m.repoFallback = name;
  if (o.model) m.model = o.model;
  if (o.todos?.length) m.todos = o.todos;
  let cmd: { id: string; out: string } | undefined;
  let waiting: string | undefined;
  let prompted = false;
  const endCmd = (time: string) => {
    if (cmd) m.toolEnd(cmd.id, { text: cmd.out, isError: false }, time);
    cmd = undefined;
  };
  const prompt = (time: string, text: unknown) => {
    // Cline wraps the task in <task>, Roo in <user_message>, in some versions.
    const t = String(text ?? '').replace(/<\/?(task|user_message|feedback)>/g, '').replace(/\s+/g, ' ').trim();
    m.promptSent();
    prompted = true;
    if (!t) return;
    if (!m.hasTitle('prompt')) m.title('prompt', t.slice(0, 90));
    m.promptActivity(time, t.slice(0, 90));
  };
  msgs.forEach((msg, i) => {
    if (!msg || typeof msg !== 'object') return;
    const time = iso(msg.ts) ?? m.lastEventAt ?? new Date(0).toISOString();
    const at = m.seen(time);
    const last = i === msgs.length - 1;
    const isAsk = msg.type === 'ask';
    const kind = String(isAsk ? msg.ask : msg.say);
    if (kind === 'command_output') {
      if (cmd) cmd.out += `\n${msg.text ?? ''}`;
      return;
    }
    endCmd(time);
    waiting = undefined;
    // Is this ask still open? Answered ones are followed by more messages (Roo also marks them).
    const open = isAsk && last && !msg.partial && !msg.isAnswered;
    const settled = o.flavor === 'cline' || nowMs - at > ROO_ASK_SETTLE_MS;
    const approve = () => {
      if (!open || !settled) return;
      // Legacy Cline writes auto-approved steps as "say", so an open ask is a real wait.
      // Roo asks for everything; one still open after a few seconds is probably a real wait.
      waiting = o.flavor === 'cline' ? `${name} awaits your approval on a step` : `${name} probably awaits your approval on a step`;
    };
    switch (kind) {
      case 'task':
        return prompt(time, msg.text);
      case 'text':
        // Roo has no "task" message: its first text is the prompt.
        if (o.flavor === 'roo' && !prompted) return prompt(time, msg.text);
        if (msg.partial) m.stop(null);
        return;
      case 'user_feedback':
        return prompt(time, msg.text);
      case 'api_req_started': {
        const r = parse(msg.text);
        if (r.cost === undefined && r.cancelReason === undefined) return m.stop(null); // in flight
        if (r.cancelReason === 'user_cancelled') return m.interrupt();
        const tin = Number(r.tokensIn ?? 0);
        const tout = Number(r.tokensOut ?? 0);
        const cw = Number(r.cacheWrites ?? 0);
        const cr = Number(r.cacheReads ?? 0);
        // Cline's tokensIn leaves out the cache; Roo's includes it (consolidateTokenUsage.ts).
        if (o.flavor === 'cline') m.usageFor(String(msg.ts), at, { in: tin + cw, out: tout, context: tin + tout + cw + cr });
        else m.usageFor(String(msg.ts), at, { in: Math.max(0, tin - cr), out: tout, context: tin + tout });
        m.stop('tool_use');
        return;
      }
      case 'condense_context': {
        const n = Number(msg.contextCondense?.newContextTokens ?? 0);
        if (n > 0) m.usageFor('', at, { in: 0, out: 0, context: n });
        return;
      }
      case 'tool': {
        const t = parse(msg.text);
        if (msg.partial && last) return m.stop(null);
        if (t.tool === 'updateTodoList' && Array.isArray(t.todos)) {
          m.todos = t.todos.map((x: Json): Todo => ({ text: String(x?.content ?? x?.text ?? ''), status: x?.status === 'completed' ? 'completed' : x?.status === 'in_progress' ? 'in_progress' : 'pending' })).filter((x: Todo) => x.text);
        }
        mapSayTool(t, m.cwd).forEach((call, j) => {
          const id = `${msg.ts}-${j}`;
          m.toolStart(id, call.name, call.input, at, time);
          if (!open) m.toolEnd(id, { text: '', isError: false }, time);
        });
        return approve();
      }
      case 'command': {
        if (msg.partial && last) return m.stop(null);
        const id = `${msg.ts}`;
        m.toolStart(id, 'Bash', { command: String(msg.text ?? '').replace(/REQ_APP\s*$/, '').trim() }, at, time);
        cmd = { id, out: '' };
        return approve();
      }
      case 'completion_result':
        if (isAsk || !msg.partial) m.stop('end_turn');
        return;
      case 'resume_task':
      case 'resume_completed_task':
        return m.stop('end_turn');
      case 'task_progress':
        if (typeof msg.text === 'string' && checklist(msg.text).length) m.todos = checklist(msg.text);
        return;
      default:
        if (REPLY_ASKS.has(kind)) {
          if (open) waiting = kind === 'followup' ? `${name} has a question for you` : `${name} awaits your reply`;
        } else if (ERROR_ASKS.has(kind)) {
          m.stop('end_turn');
          if (open) waiting = `${name} has hit a snag and awaits you`;
        } else if (APPROVAL_ASKS.has(kind)) {
          approve();
        }
    }
  });
  if (waiting) m.waitingForUser(waiting);
  return m;
}

// ---------- Cline SDK sessions (~/.cline/data/sessions/<id>/) ----------

/** One SDK tool call as the tools describeTool knows, one per file or command. */
export function mapSdkTool(name: string, input: Json, cwd: string): { name: string; input: Json }[] {
  const abs = (p: unknown) => (typeof p === 'string' && p ? path.resolve(cwd || '/', p) : undefined);
  switch (name) {
    case 'read_files':
      return (Array.isArray(input.files) ? input.files : [input]).map((f: Json) => ({ name: 'Read', input: { file_path: abs(f?.path) } }));
    case 'editor':
      return [input.old_text === undefined && input.insert_line === undefined
        ? { name: 'Write', input: { file_path: abs(input.path), content: String(input.new_text ?? '') } }
        : { name: 'Edit', input: { file_path: abs(input.path), old_string: String(input.old_text ?? ''), new_string: String(input.new_text ?? '') } }];
    case 'apply_patch':
      return patchFiles(String(input.input ?? input.patch ?? '')).map((f) => ({ name: 'Edit', input: { file_path: abs(f), old_string: '', new_string: '' } }));
    case 'run_commands':
      return [{ name: 'Bash', input: { command: (Array.isArray(input.commands) ? input.commands : [input.command]).map(String).join(' && ') } }];
    case 'search_codebase':
      return [{ name: 'Grep', input: { pattern: String(input.query ?? input.pattern ?? '') } }];
    case 'fetch_web_content':
      return [{ name: 'WebFetch', input: { url: input.url ?? input.urls?.[0] } }];
    case 'ask_question':
      return [{ name: 'AskUserQuestion', input: {} }];
    default:
      return [{ name, input: {} }];
  }
}

const blocks = (c: unknown): Json[] => (Array.isArray(c) ? c : typeof c === 'string' ? [{ type: 'text', text: c }] : []);
const blockText = (c: unknown): string => blocks(c).map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');

export function replaySdkSession(manifest: Json, data: Json, file: string): SessionModel {
  const m = new SessionModel(file, String(manifest.session_id ?? data.sessionId ?? path.basename(path.dirname(file))), DEFAULT_SESSION_OPTIONS);
  m.agent = 'cline';
  m.agentName = 'Cline';
  m.repoFallback = 'Cline';
  m.folder(String(manifest.workspace_root ?? manifest.cwd ?? ''));
  if (typeof manifest.model === 'string') m.model = manifest.model;
  if (typeof manifest.metadata?.title === 'string' && manifest.metadata.title) m.title('tool', manifest.metadata.title);
  m.seen(typeof manifest.started_at === 'string' ? manifest.started_at : iso(manifest.started_at));
  const msgs: Json[] = Array.isArray(data.messages) ? data.messages : [];
  const ids = new Map<string, string[]>();
  let fallback = Date.parse(m.startedAt ?? '') || 0;
  msgs.forEach((msg, i) => {
    if (!msg || typeof msg !== 'object') return;
    const time = iso(msg.ts) ?? iso(fallback) ?? new Date(0).toISOString();
    const at = m.seen(time);
    fallback = at || fallback;
    if (msg.role === 'user') {
      for (const b of blocks(msg.content)) {
        if (b?.type !== 'tool_result') continue;
        const id = String(b.tool_use_id ?? '');
        for (const sub of ids.get(id) ?? []) m.toolEnd(sub, { text: blockText(b.content), isError: !!b.is_error }, time);
        ids.delete(id);
      }
      const text = blocks(msg.content).filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join(' ').replace(/<\/?(task|user_message)>/g, '').replace(/\s+/g, ' ').trim();
      if (text && !text.startsWith('<')) {
        m.promptSent();
        if (!m.hasTitle('prompt')) m.title('prompt', text.slice(0, 90));
        m.promptActivity(time, text.slice(0, 90));
      }
      m.stop(null);
      return;
    }
    if (msg.role !== 'assistant') return;
    if (typeof msg.modelInfo?.id === 'string') m.model = msg.modelInfo.id;
    const mt = msg.metrics;
    if (mt) {
      const input = Number(mt.inputTokens ?? 0);
      const cw = Number(mt.cacheWriteTokens ?? 0);
      const out = Number(mt.outputTokens ?? 0);
      m.usageFor(`${i}`, at, { in: input + cw, out, context: input + cw + Number(mt.cacheReadTokens ?? 0) + out });
    }
    let tools = 0;
    for (const b of blocks(msg.content)) {
      if (b?.type !== 'tool_use' || !b.id) continue;
      tools++;
      const calls = mapSdkTool(String(b.name ?? ''), b.input && typeof b.input === 'object' ? b.input : {}, m.cwd);
      const subs = calls.map((c, j) => (j ? `${b.id}#${j}` : String(b.id)));
      calls.forEach((c, j) => m.toolStart(subs[j]!, c.name, c.input, at, time));
      ids.set(String(b.id), subs);
    }
    m.stop(tools ? 'tool_use' : 'end_turn');
  });
  const status = String(manifest.status ?? '');
  if (manifest.ended_at || status === 'completed' || status === 'failed') m.stop('end_turn');
  else if (status === 'cancelled') m.interrupt();
  return m;
}

// ---------- sources ----------

/** The folder a legacy task ran in: from the task index, else the first message's environment details. */
function taskFolder(root: string, flavor: Flavor, id: string, dir: string, index: ChangedJson): string {
  if (flavor === 'roo') {
    const h = readJson(path.join(dir, 'history_item.json'));
    if (typeof h?.workspace === 'string' && h.workspace) return h.workspace;
  } else {
    const hist = index.read(path.join(root, 'state', 'taskHistory.json')).value;
    const h = Array.isArray(hist) ? hist.find((x: Json) => x?.id === id) : undefined;
    if (typeof h?.cwdOnTaskInitialization === 'string' && h.cwdOnTaskInitialization) return h.cwdOnTaskInitialization;
  }
  const api = readJson(path.join(dir, 'api_conversation_history.json'));
  const first = Array.isArray(api) ? blockText(api[0]?.content) : '';
  return /# Current (?:Working|Workspace) Directory \(([^)]+)\) Files/.exec(first)?.[1] ?? '';
}

class TaskSource implements SessionSource {
  private msgs: Json[] = [];
  private stamp = 0;
  private cwd?: string;
  private model?: string;
  private todos?: Todo[];
  constructor(private file: string, private root: string, private flavor: Flavor, private index: ChangedJson) {}
  poll(): boolean {
    const t = mtime(this.file);
    // 0: Roo's write briefly moves the file aside. Keep what was read until it is back.
    if (!t || t === this.stamp) return false;
    const v = readJson(this.file);
    if (!Array.isArray(v)) return false;
    this.stamp = t;
    this.msgs = v;
    const dir = path.dirname(this.file);
    const id = path.basename(dir);
    if (this.cwd === undefined) this.cwd = taskFolder(this.root, this.flavor, id, dir, this.index);
    const meta = readJson(path.join(dir, 'task_metadata.json'));
    const usage = Array.isArray(meta?.model_usage) ? meta.model_usage : [];
    this.model = usage.length ? String(usage[usage.length - 1]?.model_id ?? '') || undefined : undefined;
    if (this.flavor === 'cline') {
      const focus = checklist(readText(path.join(dir, `focus_chain_taskid_${id}.md`)));
      this.todos = focus.length ? focus : undefined;
    }
    return true;
  }
  snapshot(nowMs: number): Session {
    if (!this.stamp) this.poll();
    const dir = path.dirname(this.file);
    return replayTask(this.msgs, { file: this.file, id: path.basename(dir), cwd: this.cwd ?? '', flavor: this.flavor, model: this.model, todos: this.todos }, nowMs).snapshot(nowMs);
  }
}

class SdkSource implements SessionSource {
  private stamp = '';
  private manifest: Json = {};
  private data: Json = {};
  constructor(private dir: string) {}
  private files() {
    const id = path.basename(this.dir);
    return { manifest: path.join(this.dir, `${id}.json`), messages: path.join(this.dir, `${id}.messages.json`) };
  }
  poll(): boolean {
    const f = this.files();
    const stamp = `${mtime(f.manifest)}:${mtime(f.messages)}`;
    if (stamp === this.stamp) return false;
    this.stamp = stamp;
    this.manifest = readJson(f.manifest) ?? this.manifest;
    // Written in place, not renamed: a read mid-write fails to parse, so keep the last good one.
    this.data = readJson(f.messages) ?? this.data;
    return true;
  }
  snapshot(nowMs: number): Session {
    if (!this.stamp) this.poll();
    return replaySdkSession(this.manifest, this.data, this.files().messages).snapshot(nowMs);
  }
}

// One index cache per adapter: taskHistory.json can be large and is shared by every task.
const indexes: Record<Flavor, ChangedJson> = { cline: new ChangedJson(), roo: new ChangedJson() };

function legacyTasks(cfg: Config, flavor: Flavor, nowMs: number): string[] {
  const out: string[] = [];
  for (const user of cfg.editorUserDirs) {
    const tasks = path.join(user, 'globalStorage', EXTENSION[flavor], 'tasks');
    for (const id of list(tasks)) {
      if (id.startsWith('.') || id.startsWith('_')) continue; // Roo's _index.json, temp files
      const file = path.join(tasks, id, 'ui_messages.json');
      if (nowMs - mtime(file) <= cfg.liveMs) out.push(file);
    }
  }
  return out;
}

/** The globalStorage root a task file belongs to: .../globalStorage/<extension>. */
const storageRoot = (file: string) => path.dirname(path.dirname(path.dirname(file)));

function adapter(flavor: Flavor): AgentAdapter {
  return {
    tool: flavor as AgentTool,
    live(cfg, nowMs) {
      const out = legacyTasks(cfg, flavor, nowMs);
      if (flavor === 'cline') {
        const sessions = path.join(cfg.clineDir, 'sessions');
        for (const id of list(sessions)) {
          const dir = path.join(sessions, id);
          if (id.includes('.')) continue; // sessions.index.json
          if (nowMs - Math.max(mtime(path.join(dir, `${id}.messages.json`)), mtime(path.join(dir, `${id}.json`))) <= cfg.liveMs) out.push(dir);
        }
      }
      return out;
    },
    open(key) {
      if (key.endsWith('ui_messages.json')) return new TaskSource(key, storageRoot(key), flavor, indexes[flavor]);
      return new SdkSource(key);
    },
  };
}

export const clineAdapter = adapter('cline');
export const rooAdapter = adapter('roo');
