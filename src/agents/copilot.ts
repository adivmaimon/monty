// Copilot Chat sessions: VS Code's chat panel (ask, edit and agent mode), and the same
// panel in VS Code forks. Read from <User>/workspaceStorage/<id>/chatSessions/:
//
//   <sessionId>.jsonl  VS Code 1.109+: an append-only mutation log of the session object.
//                      {"kind":0,"v":{...}} sets the whole thing, then {"kind":1,"k":path,"v"}
//                      sets, {"kind":2,"k":path,"v":[...],"i"?} pushes (truncating to i
//                      first), {"kind":3,"k":path} deletes. Past 1024 entries VS Code
//                      rewrites the file with one kind 0 line.
//   <sessionId>.json   older VS Code: the whole session, rewritten on save. Pending and
//                      waiting states are written as cancelled there, so it never shows live.
//
// Layout and fields are from VS Code's source (chatSessionStore.ts, objectMutationLog.ts,
// chatSessionOperationLog.ts, chatModel.ts, chatService.ts; main at 1.144, Oct 2026).
// VS Code writes these on its storage flush, about once a minute and on close, so the
// state here can lag the panel by up to a minute or so.
//
// Tool arguments are not stored. Files come from each tool's summary or its message's
// file link; terminal commands from the terminal tool's own data.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import type { Session } from '../types.js';
import { DEFAULT_SESSION_OPTIONS, SessionModel } from '../model.js';
import type { AgentAdapter, SessionSource } from './types.js';
import { list, mtime, readJson } from './files.js';

type Json = Record<string, any>;

// ResponseModelState (chatService.ts): 0 Pending, 1 Complete, 2 Cancelled, 3 Failed, 4 NeedsInput.
const PENDING = 0;
const COMPLETE = 1;
const CANCELLED = 2;
const NEEDS_INPUT = 4;

// ---------- the mutation log ----------

/** Applies one log entry to the session object (objectMutationLog.ts replay rules). */
export function applyEntry(root: { v?: Json }, e: Json): void {
  if (!e || typeof e !== 'object') return;
  if (e.kind === 0) {
    root.v = e.v && typeof e.v === 'object' ? e.v : {};
    return;
  }
  const keys: (string | number)[] = Array.isArray(e.k) ? e.k : [];
  if (!keys.length || !root.v) return;
  let obj: any = root.v;
  for (const k of keys.slice(0, -1)) {
    if (obj[k] === undefined || obj[k] === null || typeof obj[k] !== 'object') obj[k] = typeof k === 'number' ? [] : {};
    obj = obj[k];
  }
  const last = keys[keys.length - 1] as string | number;
  if (e.kind === 1) obj[last] = e.v;
  else if (e.kind === 3) obj[last] = undefined;
  else if (e.kind === 2) {
    if (!Array.isArray(obj[last])) obj[last] = [];
    const arr = obj[last] as unknown[];
    if (typeof e.i === 'number') arr.length = Math.min(arr.length, e.i);
    if (Array.isArray(e.v)) arr.push(...e.v);
  }
}

class LogReader {
  private offset = 0;
  private partial = '';
  private root: { v?: Json } = {};
  constructor(private file: string) {}
  /** Reads what was appended; replays from the top if the file shrank (VS Code compacted it). */
  poll(): boolean {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return false;
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = '';
      this.root = {};
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
        try {
          applyEntry(this.root, JSON.parse(l));
        } catch {
          /* a line cut short or a shape we do not know: skip it */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }
  get session(): Json | undefined {
    return this.root.v;
  }
}

// ---------- Copilot -> Monty ----------

const iso = (ms: unknown) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined);

/** A serialized URI ({scheme, path}) or file:// string to a local path. */
export function uriPath(u: unknown): string | undefined {
  if (typeof u === 'string') {
    if (u.startsWith('file://')) {
      try {
        return fileURLToPath(u.split('#')[0] ?? u);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (u && typeof u === 'object') {
    const o = u as Json;
    if (o.scheme === 'file' && typeof o.path === 'string') return process.platform === 'win32' ? (o.fsPath ?? o.path.replace(/^\//, '')) : o.path;
    if (o.uri) return uriPath(o.uri);
  }
  return undefined;
}

const md = (m: unknown): string => (typeof m === 'string' ? m : m && typeof m === 'object' && typeof (m as Json).value === 'string' ? (m as Json).value : '');

/** "Reading [](file:///Users/me/app/src/a.ts#1-80)" -> the file. */
function fileFromMessage(m: unknown): string | undefined {
  const link = /\]\((file:\/\/[^)\s]+)\)/.exec(md(m));
  return link?.[1] ? uriPath(link[1]) : undefined;
}

/** Plain text of a tool's message, without markdown links: for the activity line. */
function messageText(m: unknown): string {
  return md(m).replace(/\[([^\]]*)\]\((file:\/\/[^)]+)\)/g, (_, t, u) => t || path.basename(uriPath(u) ?? '')).replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

const READ = /^(copilot_readFile|read_file|copilot_readNotebookCellOutput)$/;
const EDIT = /^(copilot_replaceString|copilot_multiReplaceString|copilot_insertEdit|copilot_applyPatch|copilot_editNotebook|replace_string_in_file|multi_replace_string_in_file|insert_edit_into_file|apply_patch|edit_notebook_file)$/;
const CREATE = /^(copilot_createFile|create_file)$/;
const SEARCH = /^(copilot_findFiles|copilot_findTextInFiles|copilot_searchCodebase|copilot_listDirectory|file_search|grep_search|semantic_search|list_dir)$/;

/** One Copilot tool invocation in the names describeTool knows. */
function mapInvocation(p: Json): { name: string; input: Json; label?: string } {
  const id = String(p.toolId ?? '');
  const res = Array.isArray(p.summary?.resources) ? p.summary.resources : [];
  const file = uriPath(res[0]?.uri ?? res[0]) ?? fileFromMessage(p.pastTenseMessage) ?? fileFromMessage(p.invocationMessage);
  const label = messageText(p.pastTenseMessage) || messageText(p.invocationMessage) || undefined;
  if (id === 'run_in_terminal' || p.toolSpecificData?.kind === 'terminal') {
    const tsd = p.toolSpecificData ?? {};
    const command = tsd.commandLine?.toolEdited ?? tsd.commandLine?.userEdited ?? tsd.commandLine?.original ?? tsd.command;
    return { name: 'Bash', input: { command, description: undefined } };
  }
  if (READ.test(id)) return { name: 'Read', input: { file_path: file } };
  if (CREATE.test(id)) return { name: 'Write', input: { file_path: file, content: '' } };
  if (EDIT.test(id)) return { name: 'Edit', input: { file_path: file, old_string: '', new_string: '' } };
  if (SEARCH.test(id)) return { name: 'Grep', input: { pattern: '' }, label };
  if (id === 'manage_todo_list') return { name: 'TodoWrite', input: {} };
  if (id === 'runSubagent') return { name: 'Agent', input: { description: label ?? 'a subtask' } };
  return { name: id || 'tool', input: {}, label };
}

/** Replays one chat session into a fresh model. */
export function replayChat(chat: Json, file: string, folder: string): SessionModel {
  const m = new SessionModel(file, String(chat.sessionId ?? path.basename(file).replace(/\.jsonl?$/, '')), DEFAULT_SESSION_OPTIONS);
  m.agent = 'copilot-chat';
  m.agentName = 'Copilot';
  // Copilot asks for confirmation explicitly (NeedsInput), so no timing guess is needed.
  m.asksPermission = false;
  m.folder(uriPath(chat.workingDirectory) ?? folder);
  m.repoFallback = path.basename(folder) || 'Copilot';
  if (typeof chat.customTitle === 'string' && chat.customTitle) m.title('tool', chat.customTitle);
  m.seen(iso(chat.creationDate));
  for (const r of Array.isArray(chat.requests) ? chat.requests : []) {
    if (!r || typeof r !== 'object') continue;
    const time = iso(r.timestamp) ?? m.lastEventAt ?? new Date(0).toISOString();
    const at = m.seen(time);
    const prompt = typeof r.message?.text === 'string' ? r.message.text.replace(/\s+/g, ' ').trim() : '';
    if (prompt) {
      if (!m.hasTitle('prompt')) m.title('prompt', prompt.slice(0, 90));
      m.promptActivity(time, prompt.slice(0, 90));
    }
    m.promptSent();
    if (typeof r.modelId === 'string') m.model = r.modelId.replace(/^copilot\//, '');
    const parts: Json[] = Array.isArray(r.response) ? r.response : [];
    let tools = 0;
    for (const p of parts) {
      if (p?.kind !== 'toolInvocationSerialized' || !p.toolCallId) continue;
      tools++;
      const { name, input, label } = mapInvocation(p);
      const start = iso(p.startedAt) ?? time;
      m.toolStart(String(p.toolCallId), name, input, Date.parse(start) || at, start, label);
      const done = iso(p.completedAt);
      if (done) {
        m.seen(done);
        const tsd = p.toolSpecificData ?? {};
        const failed = !!p.resultError || ['failed', 'denied'].includes(p.summary?.kind) || (typeof tsd.terminalCommandState?.exitCode === 'number' && tsd.terminalCommandState.exitCode !== 0);
        m.toolEnd(String(p.toolCallId), { text: String(tsd.terminalCommandOutput?.text ?? ''), isError: failed }, done);
      }
    }
    // Edit mode applies edits without tool calls: count those files from the edit groups.
    if (!tools) {
      parts.filter((p) => p?.kind === 'textEditGroup').forEach((p, i) => {
        const f = uriPath(p.uri);
        if (!f) return;
        const id = `${r.requestId ?? 'r'}-edit-${i}`;
        m.toolStart(id, 'Edit', { file_path: f, old_string: '', new_string: '' }, at, time);
        if (p.done) m.toolEnd(id, { text: '', isError: false }, time);
      });
    }
    const ctx = r.contextUsage?.currentTokens;
    if (typeof r.contextUsage?.tokenLimit === 'number' && r.contextUsage.tokenLimit > 0) m.window = r.contextUsage.tokenLimit;
    if (typeof r.completionTokens === 'number' || typeof ctx === 'number') {
      m.usageFor(String(r.requestId ?? ''), at, {
        // promptTokens counts the whole prompt (context included), so new input is unknown here:
        // effort counts generated tokens only, and context comes from contextUsage.
        in: 0,
        out: Number(r.completionTokens ?? 0),
        context: Number(ctx ?? r.promptTokens ?? 0),
      });
    }
    const state = r.modelState?.value;
    const ended = iso(r.modelState?.completedAt);
    if (ended) m.seen(ended);
    if (state === COMPLETE) m.stop('end_turn');
    else if (state === CANCELLED) m.interrupt();
    else if (state === NEEDS_INPUT) {
      m.stop(null);
      m.waitingForUser('Copilot awaits your go-ahead on a step');
    } else if (state === PENDING) m.stop(null);
    else m.stop('end_turn'); // 3 Failed, or a state this version does not know: the turn is over
  }
  return m;
}

// ---------- adapter ----------

/** workspaceStorage/<id>/workspace.json -> the folder the window had open. */
function workspaceFolder(dir: string): string {
  const w = readJson(path.join(dir, 'workspace.json'));
  return uriPath(w?.folder) ?? '';
}

class ChatSource implements SessionSource {
  private log?: LogReader;
  private flat?: Json;
  private flatStamp = 0;
  constructor(private file: string, private folder: string) {
    if (file.endsWith('.jsonl')) this.log = new LogReader(file);
  }
  poll(): boolean {
    if (this.log) return this.log.poll();
    const t = mtime(this.file);
    if (t === this.flatStamp) return false;
    this.flatStamp = t;
    this.flat = readJson(this.file) ?? this.flat;
    return true;
  }
  snapshot(nowMs: number): Session {
    if (!this.log && !this.flat) this.poll();
    const chat = this.log ? this.log.session : this.flat;
    return replayChat(chat ?? {}, this.file, this.folder).snapshot(nowMs);
  }
}

export const copilotAdapter: AgentAdapter = {
  tool: 'copilot-chat',
  live(cfg: Config, nowMs: number) {
    const out: string[] = [];
    for (const user of cfg.editorUserDirs) {
      const dirs = list(path.join(user, 'workspaceStorage')).map((d) => path.join(user, 'workspaceStorage', d));
      dirs.push(path.join(user, 'globalStorage', 'emptyWindowChatSessions'));
      for (const d of dirs) {
        const chats = d.endsWith('emptyWindowChatSessions') ? d : path.join(d, 'chatSessions');
        const files = list(chats);
        for (const f of files) {
          // Prefer the log; the flat file beside it is the pre-1.109 copy.
          if (f.endsWith('.json') && files.includes(f.replace(/\.json$/, '.jsonl'))) continue;
          if (!f.endsWith('.jsonl') && !f.endsWith('.json')) continue;
          const file = path.join(chats, f);
          if (nowMs - mtime(file) <= cfg.liveMs) out.push(file);
        }
      }
    }
    return out;
  },
  open(file) {
    const ws = path.dirname(path.dirname(file));
    return new ChatSource(file, path.basename(path.dirname(file)) === 'chatSessions' ? workspaceFolder(ws) : '');
  },
};
