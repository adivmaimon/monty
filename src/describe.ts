// Turns a Claude Code tool call into one plain-English activity line.
// The tool names and input shapes here come from Claude Code's session logs, which
// are not a published API: when a new tool shows up it falls through to 'tool'
// rather than breaking anything.

import * as path from 'node:path';
import type { Activity, ActivityKind } from './types.js';

type Input = Record<string, unknown>;

const TEST_COMMAND = /\b(npm (run )?test|npx (jest|vitest)|jest|vitest|pytest|go test|cargo test|phpunit|swift test|xcodebuild test|bun test|pnpm test|yarn test|npm run check)\b/;

export function rel(file: string | undefined, cwd: string): string | undefined {
  if (!file) return undefined;
  if (cwd && file.startsWith(cwd + path.sep)) return file.slice(cwd.length + 1);
  return file;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function lineCount(s: string | undefined): number {
  if (!s) return 0;
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  return trimmed === '' ? 1 : trimmed.split('\n').length;
}

function clip(s: string, n = 70): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

export function isTestCommand(command: string | undefined): boolean {
  return !!command && TEST_COMMAND.test(command);
}

/** Returns null for bookkeeping tools that should not appear in the activity feed. */
export function describeTool(name: string, input: Input, cwd: string, time: string): Activity | null {
  const a = (kind: ActivityKind, text: string, extra: Partial<Activity> = {}): Activity => ({ time, kind, text, ...extra });
  // Files inside the repo keep a relative path and become clickable. Files outside it
  // (scratchpads, ~/.claude memory, /tmp) show by name only and stay out of "files touched".
  const abs = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const inside = abs !== undefined && (!path.isAbsolute(abs) || (!!cwd && abs.startsWith(cwd + path.sep)));
  const file = inside ? rel(abs, cwd) : undefined;
  const shown = file ?? (abs ? path.basename(abs) : undefined);

  switch (name) {
    case 'Read':
      return a('read', `Reading ${shown ?? 'a file'}`, { file });
    case 'Edit': {
      const plus = lineCount(str(input.new_string));
      const minus = lineCount(str(input.old_string));
      return a('edit', `Editing ${shown ?? 'a file'}`, { file, plus, minus });
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
      const plus = edits.reduce((n, e) => n + lineCount(str(e.new_string)), 0);
      const minus = edits.reduce((n, e) => n + lineCount(str(e.old_string)), 0);
      return a('edit', `Editing ${shown ?? 'a file'} (${edits.length} changes)`, { file, plus, minus });
    }
    case 'Write':
      return a('write', `Writing ${shown ?? 'a file'}`, { file, plus: lineCount(str(input.content)) });
    case 'NotebookEdit':
      return a('edit', `Editing notebook ${shown ?? ''}`.trim(), { file });
    case 'Bash': {
      const command = str(input.command) ?? '';
      const desc = str(input.description);
      if (isTestCommand(command)) return a('test', desc ? clip(desc) : 'Running tests');
      return a('run', desc ? clip(desc) : `Running ${clip(command, 50)}`);
    }
    case 'Grep':
      return a('search', `Searching for "${clip(str(input.pattern) ?? '', 40)}"`);
    case 'Glob':
      return a('search', `Finding files ${clip(str(input.pattern) ?? '', 40)}`);
    case 'LS':
      return a('search', `Listing ${shown ?? 'a folder'}`);
    case 'WebSearch':
      return a('web', `Searching the web: ${clip(str(input.query) ?? '', 50)}`);
    case 'WebFetch':
      return a('web', `Reading ${clip(str(input.url) ?? 'a web page', 50)}`);
    case 'Task':
    case 'Agent':
      return a('agent', `Delegating: ${clip(str(input.description) ?? 'a subtask', 50)}`);
    case 'AskUserQuestion':
      return a('ask', 'Asked you a question');
    case 'ExitPlanMode':
      return a('ask', 'A plan awaits your approval');
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
      return null;
    default: {
      if (name.startsWith('mcp__')) {
        const [, server = '', tool = ''] = name.split('__');
        return a('tool', `Using ${server} ${tool.replace(/_/g, ' ')}`.trim());
      }
      return a('tool', `Using ${name}`);
    }
  }
}

// 2 KB is enough to locate a change in the file (follow mode searches for it) and
// highlight a screenful, while keeping file contents out of every state poll.
export const SNIPPET_MAX = 2048;

/** The new text an editing tool wrote, capped; [] for tools that do not edit. */
export function editSnippets(name: string, input: Input): string[] {
  let parts: string[] = [];
  if (name === 'Edit') parts = [str(input.new_string) ?? ''];
  else if (name === 'MultiEdit' && Array.isArray(input.edits)) parts = (input.edits as Input[]).map((e) => str(e.new_string) ?? '');
  else if (name === 'Write') parts = [str(input.content) ?? ''];
  const out: string[] = [];
  let left = SNIPPET_MAX;
  for (const p of parts) {
    if (left <= 0) break;
    if (!p.trim()) continue;
    out.push(p.slice(0, left));
    left -= Math.min(p.length, left);
  }
  return out;
}

/**
 * Files a Bash command writes, as far as the command text shows: heredocs
 * (`cat > f <<'EOF'`, `cat <<EOF > f`, `tee f <<EOF`), `sed -i ... f`, and
 * `echo|printf|cat ... > f`. Sessions often edit this way rather than with Edit/Write.
 * A heredoc carries the new text; the others do not, so `text` is undefined there.
 * Paths are as written; `cd dir && ...` at the start sets the folder they are relative to.
 * Anything cleverer (python writing files, variables in paths) is not guessed at.
 */
export function bashWrites(command: string): { dir?: string; file: string; text?: string }[] {
  const out: { dir?: string; file: string; text?: string }[] = [];
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&/.exec(command);
  const dir = cd?.[1]?.replace(/^["']|["']$/g, '');
  const target = (s: string | undefined) => {
    const f = s?.replace(/^["']|["']$/g, '');
    return f && !f.startsWith('&') && !f.startsWith('/dev/') && !f.includes('$') ? f : undefined;
  };
  // Heredocs first: they span lines, so the per-line rules below skip their bodies.
  const F = `("[^"]+"|'[^']+'|[^\\s<>|;&]+)`;
  const HEREDOC = new RegExp(
    `(?:^|[;&|\\n]\\s*|\\s)(?:cat|tee(?:\\s+-a)?(?:\\s+(?<tee>${F}))?)\\s*(?:>>?\\s*(?<pre>${F})\\s*)?<<-?\\s*["']?(?<tag>\\w+)["']?(?:\\s*>>?\\s*(?<post>${F}))?[^\\n]*\\n(?<body>[\\s\\S]*?)\\n\\k<tag>[ \\t]*(?=\\n|$)`,
    'g',
  );
  let rest = command;
  for (const m of command.matchAll(HEREDOC)) {
    const g = m.groups ?? {};
    const file = target(g.pre ?? g.post ?? g.tee);
    if (file) out.push({ dir, file, text: g.body ?? '' });
    rest = rest.replace(m[0], '\n');
  }
  for (const seg of rest.split(/\n|&&|\|\||;/)) {
    const t = seg.trim();
    if (/^sed\s+(-[a-zA-Z]*i|--in-place)/.test(t)) {
      const words = t.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      const file = target(words[words.length - 1]);
      if (file && !/^-/.test(file) && words.length > 3) out.push({ dir, file });
      continue;
    }
    const redirect = /^(?:echo|printf|cat)\b[^>]*?(?<![0-9&])>>?\s*("[^"]+"|'[^']+'|[^\s<>|;&]+)/.exec(t);
    const file = target(redirect?.[1]);
    if (file) out.push({ dir, file });
  }
  return out;
}

/** Tools that mean "Claude is waiting on the human" while unanswered. */
export const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
