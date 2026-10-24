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
// Every .js under dist/src, subfolders included (src/agents/): copying only the top level
// once shipped a core that could not start.
for (const f of fs.readdirSync(from, { recursive: true })) {
  if (!String(f).endsWith('.js')) continue;
  fs.mkdirSync(path.dirname(path.join(to, 'dist', 'src', f)), { recursive: true });
  fs.copyFileSync(path.join(from, f), path.join(to, 'dist', 'src', f));
}
fs.writeFileSync(path.join(to, 'package.json'), JSON.stringify({ type: 'module', private: true }) + '\n');
// Load the bundled store (it has no side effects, unlike cli.js): a file left out fails here, not on someone's machine.
try {
  await import(path.join(to, 'dist', 'src', 'state.js'));
} catch (e) {
  console.error(`The bundled core does not load: ${e.message}`);
  process.exit(1);
}
console.log(`Bundled the core into ${path.relative(process.cwd(), to) || to}`);
