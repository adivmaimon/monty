// "Last seen" copies of specs for the readable view's "changed since last look" marks
// (web/reader-changes.js). Kept in the extension's own globalStorage folder, never in the
// repo or ~/.claude (read-only rule): webview localStorage and setState do not outlive a
// closed tab, and globalState would load every copy into memory at startup. No vscode
// import, so it is tested with plain node.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Specs people have opened, not every file in every repo: 300 covers months of plans and
// stays a few MB. The oldest go first.
export const MAX_ENTRIES = 300;
// A spec past 1 MB is generated data, not something read section by section.
export const MAX_BYTES = 1024 * 1024;

export class SeenStore {
  constructor(private dir: string) {}

  private fileFor(doc: string): string {
    // The path is only a key: hashed, it can never point outside the folder.
    return path.join(this.dir, crypto.createHash('sha1').update(doc).digest('hex') + '.json');
  }

  /** The text as last seen, or null: never seen, unreadable, or not ours. */
  get(doc: string): string | null {
    try {
      const rec = JSON.parse(fs.readFileSync(this.fileFor(doc), 'utf8'));
      return rec && rec.file === doc && typeof rec.text === 'string' ? rec.text : null;
    } catch {
      return null;
    }
  }

  /** Remember `text` as seen. False when it was not kept (too big, folder not writable). */
  set(doc: string, text: string): boolean {
    if (typeof doc !== 'string' || !doc || typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.fileFor(doc), JSON.stringify({ file: doc, text, at: Date.now() }));
      this.prune();
      return true;
    } catch {
      return false;
    }
  }

  private prune() {
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    if (files.length <= MAX_ENTRIES) return;
    const aged = files.map((f) => {
      try {
        return { f, t: fs.statSync(path.join(this.dir, f)).mtimeMs };
      } catch {
        return { f, t: 0 };
      }
    }).sort((a, b) => a.t - b.t);
    for (const { f } of aged.slice(0, files.length - MAX_ENTRIES)) {
      try {
        fs.rmSync(path.join(this.dir, f));
      } catch {
        /* gone already */
      }
    }
  }
}
