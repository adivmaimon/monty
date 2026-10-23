// Copies the panel (../web) into media/web for the webviews. A script rather than
// `cp -R` so packaging also works on Windows.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.resolve(here, '..', '..', 'web');
const to = path.resolve(here, '..', 'media', 'web');
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
