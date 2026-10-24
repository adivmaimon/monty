// opencode sessions (github.com/sst/opencode). Three storage generations, all read here:
//
//   up to 1.1.x  JSON files under <data>/storage/: session/<projectID>/<sessionID>.json,
//                message/<sessionID>/<messageID>.json, part/<messageID>/<partID>.json,
//                todo/<sessionID>.json
//   1.2 - 1.19   <data>/opencode.db (SQLite, WAL): tables session, message, part, todo,
//                where message.data and part.data hold the same JSON as the files
//   2.x          the same db with session_v2 and session_message (a redesigned message model)
//
// Layout and fields are from opencode's source (message-v2.ts, session.sql.ts,
// session-message.ts; read at v1.1.25, v1.2.0, v1.19.4, v2.0.0 and main 2.1.4, Oct 2026).
// The format is not a published API, so everything is tolerant: a record that does not
// parse is skipped, and an unknown generation shows nothing rather than failing.
//
// The database is opened read-only, and only these paths are ever opened: never
// auth.json or any other file in opencode's folder. SQLite comes from node:sqlite (built
// into Node 22.5+, so VS Code's own Node); without it, only the JSON generation is read.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { Config } from '../config.js';
import type { Session, Todo, TodoStatus } from '../types.js';
import { DEFAULT_SESSION_OPTIONS, SessionModel } from '../model.js';
import type { AgentAdapter, SessionSource } from './types.js';
import { list, mtime, patchFiles, readJson } from './files.js';

type Json = Record<string, any>;

/** One session as the three generations all reduce to. */
export interface OcSession {
  id: string;
  directory: string;
  title: string;
  created: number;
  updated: number;
  messages: { info: Json; parts: Json[] }[];
  todos: Json[];
  /** 2.x: the turn ended (an idle row came after the newest message). */
  idle?: boolean;
}

// ---------- the three stores ----------

interface Store {
  /** Ids of sessions updated within the window. */
  live(sinceMs: number): string[];
  /** Something cheap that changes whenever the session does. */
  stamp(id: string): string;
  load(id: string): OcSession | undefined;
}

const require = createRequire(import.meta.url);
let sqliteMod: any;
function sqlite(): any {
  if (sqliteMod === undefined) {
    try {
      sqliteMod = require('node:sqlite');
    } catch {
      sqliteMod = null; // Node without node:sqlite: the database generations are skipped
    }
  }
  return sqliteMod;
}

class JsonStore implements Store {
  constructor(private root: string) {}
  private sessionFile(id: string): string | undefined {
    for (const project of list(path.join(this.root, 'session'))) {
      const f = path.join(this.root, 'session', project, `${id}.json`);
      if (fs.existsSync(f)) return f;
    }
    return undefined;
  }
  live(sinceMs: number): string[] {
    const out: string[] = [];
    for (const project of list(path.join(this.root, 'session'))) {
      for (const f of list(path.join(this.root, 'session', project))) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        // The session file is rewritten as it goes; its message folder is newer while it streams.
        const t = Math.max(mtime(path.join(this.root, 'session', project, f)), mtime(path.join(this.root, 'message', id)));
        if (t >= sinceMs) out.push(id);
      }
    }
    return out;
  }
  stamp(id: string): string {
    const msgDir = path.join(this.root, 'message', id);
    const msgs = list(msgDir).sort();
    const last = msgs[msgs.length - 1];
    const partDir = last ? path.join(this.root, 'part', last.replace(/\.json$/, '')) : '';
    return [mtime(this.sessionFile(id) ?? ''), msgs.length, mtime(msgDir), last ? mtime(path.join(msgDir, last)) : 0, partDir ? mtime(partDir) : 0, ...list(partDir).map((p) => mtime(path.join(partDir, p)))].join(':');
  }
  load(id: string): OcSession | undefined {
    const file = this.sessionFile(id);
    const s = file ? readJson(file) : undefined;
    if (!s || typeof s !== 'object') return undefined;
    // Ids sort by time, so file names give the order.
    const messages = list(path.join(this.root, 'message', id)).filter((f) => f.endsWith('.json')).sort().map((f) => {
      const info = readJson(path.join(this.root, 'message', id, f)) ?? {};
      const pdir = path.join(this.root, 'part', f.slice(0, -5));
      const parts = list(pdir).filter((p) => p.endsWith('.json')).sort().map((p) => readJson(path.join(pdir, p))).filter(Boolean);
      return { info, parts };
    });
    const todos = readJson(path.join(this.root, 'todo', `${id}.json`));
    return { id, directory: String(s.directory ?? ''), title: String(s.title ?? ''), created: s.time?.created ?? 0, updated: s.time?.updated ?? 0, messages, todos: Array.isArray(todos) ? todos : [] };
  }
}

class DbStore implements Store {
  private db: any;
  private v2: boolean;
  constructor(file: string) {
    const { DatabaseSync } = sqlite();
    this.db = new DatabaseSync(file, { readOnly: true });
    const tables = new Set(this.all("select name from sqlite_master where type = 'table'").map((r) => String(r.name)));
    // 2.x keeps the old tables too (and imports from them), so prefer the new ones once they hold rows.
    this.v2 = tables.has('session_v2') && tables.has('session_message') && Number(this.one('select count(*) as n from session_v2')?.n ?? 0) > 0;
  }
  private all(sql: string, ...args: unknown[]): Json[] {
    return this.db.prepare(sql).all(...args) as Json[];
  }
  private one(sql: string, ...args: unknown[]): Json | undefined {
    return this.db.prepare(sql).get(...args) as Json | undefined;
  }
  live(sinceMs: number): string[] {
    const table = this.v2 ? 'session_v2' : 'session';
    return this.all(`select id from ${table} where time_updated >= ? and time_archived is null`, sinceMs).map((r) => String(r.id));
  }
  stamp(id: string): string {
    if (this.v2) {
      const r = this.one('select max(time_updated) as t, count(*) as n from session_message where session_id = ?', id);
      return `${r?.t ?? 0}:${r?.n ?? 0}`;
    }
    const m = this.one('select max(time_updated) as t, count(*) as n from message where session_id = ?', id);
    const p = this.one('select max(time_updated) as t, count(*) as n from part where session_id = ?', id);
    return `${m?.t ?? 0}:${m?.n ?? 0}:${p?.t ?? 0}:${p?.n ?? 0}`;
  }
  load(id: string): OcSession | undefined {
    return this.v2 ? this.loadV2(id) : this.loadV1(id);
  }
  private loadV1(id: string): OcSession | undefined {
    const s = this.one('select id, directory, title, time_created, time_updated from session where id = ?', id);
    if (!s) return undefined;
    const parts = new Map<string, Json[]>();
    for (const r of this.all('select id, message_id, data from part where session_id = ? order by id', id)) {
      const data = parse(r.data);
      if (!data) continue;
      const list = parts.get(String(r.message_id)) ?? [];
      list.push({ ...data, id: r.id });
      parts.set(String(r.message_id), list);
    }
    const messages = this.all('select id, data from message where session_id = ? order by id', id).map((r) => ({ info: { ...(parse(r.data) ?? {}), id: r.id }, parts: parts.get(String(r.id)) ?? [] }));
    const todos = this.all('select content, status from todo where session_id = ? order by position', id);
    return { id, directory: String(s.directory ?? ''), title: String(s.title ?? ''), created: Number(s.time_created ?? 0), updated: Number(s.time_updated ?? 0), messages, todos };
  }
  /** 2.x rows: user and assistant messages with their content inline, idle rows ending a turn. */
  private loadV2(id: string): OcSession | undefined {
    const s = this.one('select id, directory, title, time_created, time_updated from session_v2 where id = ?', id);
    if (!s) return undefined;
    const messages: OcSession['messages'] = [];
    let idle = false;
    const todos: Json[] = [];
    for (const r of this.all('select id, type, data, time_created from session_message where session_id = ? order by seq, time_created', id)) {
      const data = parse(r.data) ?? {};
      const type = String(r.type ?? data.type ?? '');
      const created = Number(data.time?.created ?? r.time_created ?? 0);
      if (type === 'idle') {
        idle = true;
        continue;
      }
      if (type !== 'user' && type !== 'assistant') continue;
      idle = false;
      const content: Json[] = Array.isArray(data.content) ? data.content : typeof data.text === 'string' ? [{ type: 'text', text: data.text }] : [];
      const parts = content.map((c) => (c?.type === 'tool' ? { type: 'tool', callID: c.id, tool: c.name, state: c.state } : c));
      for (const p of parts) if (p?.type === 'tool' && p.tool === 'todowrite' && Array.isArray(p.state?.input?.todos)) todos.splice(0, todos.length, ...p.state.input.todos);
      messages.push({
        info: { id: r.id, role: type, time: { created, completed: data.time?.completed }, modelID: data.model?.id, finish: data.finish, error: data.error, tokens: data.tokens },
        parts,
      });
    }
    return { id, directory: String(s.directory ?? ''), title: String(s.title ?? ''), created: Number(s.time_created ?? 0), updated: Number(s.time_updated ?? 0), messages, todos, idle };
  }
}

function parse(v: unknown): Json | undefined {
  if (v && typeof v === 'object') return v as Json;
  if (typeof v !== 'string') return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

// ---------- opencode -> Monty ----------

const iso = (ms: unknown) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined);

/** opencode tool calls in the names describeTool knows (Claude Code's). */
export function mapTool(name: string, input: Json, cwd: string): { name: string; input: Json } {
  const file = (p: unknown) => (typeof p === 'string' ? (path.isAbsolute(p) || !cwd ? p : path.join(cwd, p)) : undefined);
  const fp = file(input.filePath ?? input.path);
  switch (name) {
    case 'bash':
    case 'shell':
      return { name: 'Bash', input: { command: input.command, description: input.description } };
    case 'read':
      return { name: 'Read', input: { file_path: fp } };
    case 'write':
      return { name: 'Write', input: { file_path: fp, content: input.content } };
    case 'edit':
      return { name: 'Edit', input: { file_path: fp, old_string: input.oldString, new_string: input.newString } };
    case 'multiedit':
      return { name: 'MultiEdit', input: { file_path: fp, edits: (input.edits ?? []).map((e: Json) => ({ old_string: e.oldString, new_string: e.newString })) } };
    case 'patch':
    case 'apply_patch': {
      const files = patchFiles(String(input.patchText ?? '')).map((f) => file(f));
      return { name: 'Edit', input: { file_path: files[0], old_string: '', new_string: '' } };
    }
    case 'glob':
      return { name: 'Glob', input: { pattern: input.pattern } };
    case 'grep':
      return { name: 'Grep', input: { pattern: input.pattern } };
    case 'list':
      return { name: 'LS', input: { path: fp } };
    case 'task':
    case 'subagent':
      return { name: 'Agent', input: { description: input.description } };
    case 'webfetch':
      return { name: 'WebFetch', input: { url: input.url } };
    case 'websearch':
      return { name: 'WebSearch', input: { query: input.query } };
    case 'question':
      return { name: 'AskUserQuestion', input };
    case 'plan_exit':
      return { name: 'ExitPlanMode', input };
    case 'todowrite':
    case 'todoread':
      return { name: 'TodoWrite', input };
    case 'skill':
      return { name: 'Skill', input: { skill: input.name ?? input.id } };
    default:
      return { name, input };
  }
}

function todoStatus(s: unknown): TodoStatus {
  return s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
}

/** Replays one opencode session into a fresh model (cheap: sessions are re-read only when they change). */
export function replayModel(s: OcSession, file: string): SessionModel {
  const m = new SessionModel(file, s.id, DEFAULT_SESSION_OPTIONS);
  m.agent = 'opencode';
  m.agentName = 'opencode';
  m.folder(s.directory);
  m.repoFallback = path.basename(s.directory) || 'opencode';
  // Untitled sessions are "New session - <date>"; that says nothing, so the first prompt wins instead.
  if (s.title && !/^New session/i.test(s.title)) m.title('tool', s.title);
  m.seen(iso(s.created));
  let lastAssistant: Json | undefined;
  for (const { info, parts } of s.messages) {
    const created = iso(info.time?.created);
    const at = m.seen(created);
    const time = created ?? m.lastEventAt ?? new Date(0).toISOString();
    if (info.role === 'user') {
      const text = parts.filter((p) => p?.type === 'text' && !p.synthetic && !p.ignored && typeof p.text === 'string').map((p) => p.text).join(' ').trim();
      if (text) {
        const title = text.replace(/\s+/g, ' ').slice(0, 90);
        m.promptTitle(title);
        m.promptActivity(time, title);
      }
      m.promptSent();
      continue;
    }
    if (info.role !== 'assistant') continue;
    lastAssistant = info;
    if (typeof info.modelID === 'string') m.model = info.modelID;
    for (const p of parts) {
      if (p?.type === 'tool' && p.callID) {
        const st = p.state ?? {};
        const { name, input } = mapTool(String(p.tool ?? ''), st.input && typeof st.input === 'object' ? st.input : {}, m.cwd);
        const start = iso(st.time?.start) ?? time;
        m.toolStart(String(p.callID), name, input, Date.parse(start) || at, start);
        if (st.status === 'completed' || st.status === 'error') {
          const out = typeof st.output === 'string' ? st.output : Array.isArray(st.content) ? st.content.map((c: Json) => c?.text ?? '').join('\n') : '';
          const end = iso(st.time?.end) ?? start;
          m.seen(end);
          m.toolEnd(String(p.callID), { text: st.status === 'error' ? String(st.error ?? out) : out, isError: st.status === 'error' }, end);
        }
      } else if (p?.type === 'step-finish' && p.tokens) {
        const t = p.tokens;
        const cache = t.cache ?? {};
        m.usageFor(String(p.id ?? ''), at, {
          // tokens.input already excludes cache reads (opencode subtracts them for every provider).
          in: (t.input ?? 0) + (cache.write ?? 0),
          out: (t.output ?? 0) + (t.reasoning ?? 0),
          context: (t.input ?? 0) + (cache.read ?? 0) + (cache.write ?? 0),
        });
      }
    }
    // 2.x keeps tokens on the message rather than in step-finish parts.
    if (info.tokens && !parts.some((p) => p?.type === 'step-finish')) {
      const t = info.tokens;
      m.usageFor(String(info.id ?? ''), at, { in: (t.input ?? 0) + (t.cache?.write ?? 0), out: (t.output ?? 0) + (t.reasoning ?? 0), context: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) });
    }
    const done = iso(info.time?.completed);
    if (done) {
      m.seen(done);
      if (info.error?.name === 'MessageAbortedError') m.interrupt();
      // A loop round that ended to run tools is not the end of the turn; anything else is.
      else m.stop(info.finish === 'tool-calls' ? 'tool_use' : 'end_turn');
    } else {
      m.stop(null);
    }
  }
  if (s.idle && lastAssistant && !lastAssistant.time?.completed) m.stop('end_turn');
  m.todos = s.todos.filter((t) => t?.status !== 'cancelled').map((t): Todo => ({ text: String(t.content ?? ''), status: todoStatus(t.status) }));
  m.seen(iso(s.updated));
  return m;
}

// ---------- adapter ----------

class OcSource implements SessionSource {
  private stampSeen = '';
  private session?: OcSession;
  constructor(private store: Store, private id: string, private file: string) {}
  poll(): boolean {
    const stamp = this.store.stamp(this.id);
    if (stamp === this.stampSeen) return false;
    this.stampSeen = stamp;
    this.session = this.store.load(this.id) ?? this.session;
    return true;
  }
  snapshot(nowMs: number): Session {
    if (!this.session) this.poll();
    if (!this.session) return emptySession(this.id, this.file);
    // Rebuilt per snapshot so state is judged at the caller's time (it depends on quiet).
    return replayModel(this.session, this.file).snapshot(nowMs);
  }
}

function emptySession(id: string, file: string): Session {
  return new SessionModel(file, id).snapshot(0);
}

// One connection per core: opening is cheap, but a session poll runs every second.
let cached: { db?: DbStore; dbFile?: string; json?: JsonStore; jsonRoot?: string } = {};

/** The stores present: the database first (where current opencode writes), then the old files. */
function storesFor(cfg: Config): { kind: 'db' | 'json'; store: Store; file: string }[] {
  const out: { kind: 'db' | 'json'; store: Store; file: string }[] = [];
  const dbFile = process.env.OPENCODE_DB ?? path.join(cfg.opencodeDir, 'opencode.db');
  if (fs.existsSync(dbFile) && sqlite()) {
    if (cached.dbFile !== dbFile) cached = { ...cached, db: new DbStore(dbFile), dbFile };
    out.push({ kind: 'db', store: cached.db as DbStore, file: dbFile });
  }
  const root = path.join(cfg.opencodeDir, 'storage');
  if (fs.existsSync(path.join(root, 'session'))) {
    if (cached.jsonRoot !== root) cached = { ...cached, json: new JsonStore(root), jsonRoot: root };
    out.push({ kind: 'json', store: cached.json as JsonStore, file: root });
  }
  return out;
}

export const opencodeAdapter: AgentAdapter = {
  tool: 'opencode',
  live(cfg, nowMs) {
    const keys: string[] = [];
    // The database copies the JSON sessions in once and they never change after, so a
    // session seen in the database wins over the same id in the files.
    const seen = new Set<string>();
    for (const { kind, store } of storesFor(cfg)) {
      for (const id of store.live(nowMs - cfg.liveMs)) {
        if (seen.has(id)) continue;
        seen.add(id);
        keys.push(`${kind}|${id}`);
      }
    }
    return keys;
  },
  open(key, cfg) {
    const [kind, id] = key.split('|') as ['db' | 'json', string];
    const found = storesFor(cfg).find((x) => x.kind === kind);
    if (!found) throw new Error(`opencode ${kind} store went away`);
    return new OcSource(found.store, id, found.kind === 'db' ? found.file : path.join(found.file, 'session', id));
  },
};

/** For tests: forget cached connections. */
export function resetOpencodeCache(): void {
  cached = {};
}
