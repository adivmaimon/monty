#!/usr/bin/env node
// monty            start the core and the web panel on http://127.0.0.1:4747
// monty --exit-when-idle   as above, but quit when no VS Code window has polled for 20s
// monty --scan     print what Monty can see (projects and live sessions) and exit
// monty --icon f   write the menu bar monocle to f.png at a few states, for eyeballing

import * as fs from 'node:fs';
import { loadConfig } from './config.js';
import { MontyStore } from './state.js';
import { msSinceEditorPoll, startServer } from './server.js';
import { renderMonocle } from './icon.js';

const args = process.argv.slice(2);
const cfg = loadConfig();
const portArg = args.indexOf('--port');
if (portArg >= 0 && args[portArg + 1]) cfg.port = Number(args[portArg + 1]);

if (args.includes('--icon')) {
  const base = args[args.indexOf('--icon') + 1] ?? 'monocle';
  for (const [name, pct, badge] of [['50', 0.5, 'none'], ['attention', 0.4, 'attention'], ['failing', 0.8, 'failing'], ['done', 1, 'done'], ['idle', 0, 'idle']] as const) {
    fs.writeFileSync(`${base}-${name}.png`, renderMonocle(pct, badge, 144));
  }
  console.log(`Wrote ${base}-*.png`);
  process.exit(0);
}

const store = new MontyStore(cfg);

if (args.includes('--scan')) {
  store.discover();
  store.tick();
  // The repo it is run from counts as open, as a VS Code window would register it.
  store.addRepo(process.cwd());
  store.rescanProjects();
  const s = store.state();
  console.log(`Project roots: ${cfg.projectRoots.join(', ') || '(none; MONTY_PROJECTS adds some)'}`);
  console.log(`Repos:         ${store.repos().join(', ')}`);
  console.log(`Session logs:  ${cfg.claudeProjectsDir}\n`);
  const byStatus = new Map<string, number>();
  for (const p of s.projects) byStatus.set(p.status, (byStatus.get(p.status) ?? 0) + 1);
  console.log(`Projects: ${s.projects.length} (${[...byStatus].map(([k, v]) => `${v} ${k}`).join(', ')})`);
  for (const p of s.projects.filter((p) => p.status === 'active' || p.status === 'pending' || p.status === 'parked')) {
    const { done, total, basis } = p.progress;
    console.log(`  [${p.status.padEnd(7)}] ${p.repo.padEnd(10)} ${p.name.slice(0, 60).padEnd(60)} ${done}/${total} ${basis}`);
  }
  console.log(`\nLive sessions: ${s.sessions.length}`);
  for (const x of s.sessions) {
    console.log(`  ${x.repo.padEnd(12)} ${x.state.padEnd(11)} ${x.progress.done}/${x.progress.total} ctx ${x.context.pct}%  ${x.title.slice(0, 50)}`);
    console.log(`    ${x.stateReason}`);
  }
  process.exit(0);
}

store.start();
const server = startServer(cfg, store);
server.on('error', (err: NodeJS.ErrnoException) => {
  // Another window already started one: that one serves everybody.
  if (err.code === 'EADDRINUSE') process.exit(0);
  throw err;
});

// Started by the VS Code extension: stop when no VS Code window is left.
// 20s covers a window reload; windows poll every 1.5s.
const EDITOR_GONE_MS = 20_000;
if (args.includes('--exit-when-idle')) {
  // After the Mac sleeps, the first tick sees an old editor poll and would quit before VS Code
  // has woken to poll again; the menu bar app then went with it. A late tick means we slept:
  // give the editors a fresh 20s from now.
  let lastTick = Date.now();
  let graceUntil = 0;
  setInterval(() => {
    const now = Date.now();
    if (now - lastTick > 15_000) graceUntil = now + EDITOR_GONE_MS;
    lastTick = now;
    if (now > graceUntil && msSinceEditorPoll() > EDITOR_GONE_MS) process.exit(0);
  }, 5000).unref();
}
console.log(`Monty is watching. Panel: http://127.0.0.1:${cfg.port}/`);
