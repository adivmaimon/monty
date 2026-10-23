// Starts the built core on a spare port, asks it for state about this repo, and checks
// the answer has the expected shape. CI runs it where the full tests do not yet run (Windows).
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4799;
const core = spawn(process.execPath, [path.join(root, 'dist', 'src', 'cli.js')], { env: { ...process.env, MONTY_PORT: String(port) }, stdio: 'inherit' });
const fail = (msg) => { console.error(`smoke: ${msg}`); core.kill(); process.exit(1); };
setTimeout(() => fail('no answer in 15s'), 15_000).unref();
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 300));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state?repo=${encodeURIComponent(root)}`);
    const s = await res.json();
    if (!Array.isArray(s.sessions) || !Array.isArray(s.projects)) fail('state is missing sessions or projects');
    console.log(`smoke: ok (${s.sessions.length} sessions, ${s.projects.length} plans, ${(s.setups ?? []).length} setups)`);
    core.kill();
    process.exit(0);
  } catch {
    /* not up yet */
  }
}
fail('the core did not answer');
