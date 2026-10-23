// Copies the built core (../dist/src) into core/ so the extension can run it without the
// repo: core/dist/src keeps the layout the core expects, and core/package.json marks it
// as ES modules. Source maps stay out. The web panel is not bundled: VS Code shows its own
// copy (media/web), and the browser tab is a development tool.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, '..', '..', 'dist', 'src');
const to = path.resolve(here, '..', 'core');
if (!fs.existsSync(path.join(from, 'cli.js'))) {
  console.error(`No built core at ${from}. Run "npm run build" in the repo root first.`);
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(path.join(to, 'dist', 'src'), { recursive: true });
for (const f of fs.readdirSync(from)) {
  if (f.endsWith('.js')) fs.copyFileSync(path.join(from, f), path.join(to, 'dist', 'src', f));
}
fs.writeFileSync(path.join(to, 'package.json'), JSON.stringify({ type: 'module', private: true }) + '\n');
console.log(`Bundled the core into ${path.relative(process.cwd(), to) || to}`);
