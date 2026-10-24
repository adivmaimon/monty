// Small, careful file reading for adapters. Other tools' folders also hold credentials
// (opencode keeps auth.json beside its sessions), so adapters only ever open paths they
// name, through these helpers, never by globbing a folder's contents.

import * as fs from 'node:fs';
import * as path from 'node:path';

// A session record is small; a file far past this is not one we should parse on every poll.
const MAX_JSON_BYTES = 32 * 1024 * 1024;

export function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Called with every file an adapter opens; tests use it to prove what is never read. */
export const readTrace: { onRead?: (file: string) => void } = {};

/** Parsed JSON, or undefined when missing, too big or not JSON. */
export function readJson(file: string): any {
  readTrace.onRead?.(file);
  try {
    if (fs.statSync(file).size > MAX_JSON_BYTES) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Re-reads a JSON file only when its size or mtime changed since the last call for that
 * path. Returns the parsed value and whether it is new. Tools that rewrite a whole file
 * on every change (Cline, Copilot Chat) are read this way.
 */
export class ChangedJson {
  private seen = new Map<string, string>();
  private values = new Map<string, any>();

  read(file: string): { value: any; changed: boolean } {
    let key = '';
    try {
      const st = fs.statSync(file);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      return { value: undefined, changed: false };
    }
    if (this.seen.get(file) === key) return { value: this.values.get(file), changed: false };
    const value = readJson(file);
    this.seen.set(file, key);
    this.values.set(file, value);
    return { value, changed: true };
  }
}

export const join = path.join;

/** Files named by an apply_patch body ("*** Update File: src/a.ts"; opencode and Codex share the grammar). */
export function patchFiles(text: string): string[] {
  return [...text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => (m[1] ?? '').trim()).filter(Boolean);
}

/** A small text file (a markdown checklist), or '' when missing or too big. */
export function readText(file: string, maxBytes = 1024 * 1024): string {
  readTrace.onRead?.(file);
  try {
    if (fs.statSync(file).size > maxBytes) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
