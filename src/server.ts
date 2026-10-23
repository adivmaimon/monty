// Local HTTP server. Binds to 127.0.0.1 only: session logs contain code and prompts.
//   GET /                 web panel
//   GET /api/state        everything, as JSON (?repo=/abs/path limits it to one repo)
//   GET /api/events       the same, pushed on change (Server-Sent Events)
//   GET /api/bar          menu bar summary for the native app
//   GET /api/swiftbar     ready-made SwiftBar plugin output
//   GET /api/icon.png     the monocle (?pct=0.5&badge=attention), for testing
//   GET /api/doc?file=    raw markdown, only for files under a project root
//   POST /api/intent?repo=&doc=   ask the VS Code window for that repo to show Monty (or a plan)
//   GET  /api/intent?repo=        that window collects it (each intent is delivered once)

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { MontyState } from './types.js';
import { isUnderKnown, scopeState, type MontyStore } from './state.js';
import { summarise, swiftbarText } from './bar.js';
import { renderMonocle, type Badge } from './icon.js';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function startServer(cfg: Config, store: MontyStore): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.port}`);
    try {
      route(url, req, res, cfg, store);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  server.listen(cfg.port, '127.0.0.1');
  return server;
}

// Hand-off between VS Code windows: the window that receives a vscode://adivmaimon.monty link
// may not be the one with the repo open. It leaves an intent here and focuses the right
// window, whose extension picks it up on its next poll.
interface Intent { repo: string; doc?: string; at: number }
let intents: Intent[] = [];
const INTENT_TTL_MS = 20_000;

function under(a: string, b: string): boolean {
  return a === b || a.startsWith(b + path.sep);
}

// Set by every VS Code window's poll. With --exit-when-idle, the core quits once no
// window has polled for a while, so Monty stops when VS Code closes. The menu bar's
// polls deliberately do not count.
let lastEditorPoll = Date.now();
export function msSinceEditorPoll(): number {
  return Date.now() - lastEditorPoll;
}

function json(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function route(url: URL, req: http.IncomingMessage, res: http.ServerResponse, cfg: Config, store: MontyStore): void {
  switch (url.pathname) {
    case '/api/state':
      if (url.searchParams.get('client') === 'vscode') lastEditorPoll = Date.now();
      // Asking about a repo is what makes Monty look at it.
      if (url.searchParams.get('repo')) store.addRepo(url.searchParams.get('repo') as string);
      return json(res, scopeState(store.state(), url.searchParams.get('repo')));
    case '/api/bar':
      return json(res, summarise(scopeState(store.state(), url.searchParams.get('repo'))));
    case '/api/swiftbar':
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return void res.end(swiftbarText(store.state(), cfg.port));
    case '/api/icon.png': {
      const pct = Number(url.searchParams.get('pct') ?? 0.5);
      const badge = (url.searchParams.get('badge') ?? 'none') as Badge;
      const size = Math.min(512, Number(url.searchParams.get('size') ?? 36));
      res.writeHead(200, { 'content-type': 'image/png' });
      return void res.end(renderMonocle(pct, badge, size));
    }
    case '/api/events': {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const repo = url.searchParams.get('repo');
      if (repo) store.addRepo(repo);
      const send = (s: MontyState) => res.write(`data: ${JSON.stringify(scopeState(s, repo))}\n\n`);
      send(store.state());
      const off = store.subscribe(send);
      // Keep relative times and idle states fresh even when nothing changes.
      const beat = setInterval(() => send(store.state()), 5000);
      req.on('close', () => {
        off();
        clearInterval(beat);
      });
      return;
    }
    case '/api/intent': {
      const now = Date.now();
      intents = intents.filter((i) => now - i.at < INTENT_TTL_MS);
      const repo = path.resolve(url.searchParams.get('repo') ?? '');
      if (req.method === 'POST') {
        intents.push({ repo, doc: url.searchParams.get('doc') ?? undefined, at: now });
        return json(res, { ok: true });
      }
      const mine = intents.filter((i) => under(i.repo, repo) || under(repo, i.repo));
      intents = intents.filter((i) => !mine.includes(i));
      return json(res, mine);
    }
    case '/api/doc': {
      const file = path.resolve(url.searchParams.get('file') ?? '');
      const allowed = isUnderKnown(file, cfg.projectRoots, store.repos());
      if (!allowed || !isReadableDoc(file)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return void res.end('Only markdown and rules files under a project root');
      }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(fs.readFileSync(file, 'utf8'));
    }
    default:
      return serveStatic(url.pathname, res);
  }
}

/** Markdown, plus AI tool rule files that are markdown under another name (Cursor's .mdc, .cursorrules...). */
function isReadableDoc(file: string): boolean {
  return /\.(md|mdc)$/i.test(file) || ['.cursorrules', '.windsurfrules', '.clinerules'].includes(path.basename(file));
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return void res.end('Not found');
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}
