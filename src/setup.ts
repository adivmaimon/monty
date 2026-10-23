// Reads a repo's AI tool setup: which tools it is configured for, their instructions
// files, skills and commands, the rules those files state, and guardrails (permission
// lists, hooks, MCP servers).
//
// Read-only, like the rest of Monty: nothing here writes. Every file is capped in size
// and must resolve inside the repo, so a symlink cannot pull in something outside it.
// These formats are each tool's own and change; anything unreadable is skipped.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoSetup, SetupGuardrails, SetupInstructions, SetupRule, SetupSkill, SetupTool } from './types.js';

// Instructions files are prose for a model; anything past 256 KB is not one.
const MAX_BYTES = 256 * 1024;
// The sidebar and details card show a handful; more than this is noise.
export const MAX_RULES = 10;
const MAX_PER_DIR = 60;

/** Instructions files at fixed paths, in the order their rules are read. */
const FILES: [SetupTool, string][] = [
  ['Claude Code', 'CLAUDE.md'],
  ['Claude Code', '.claude/CLAUDE.md'],
  ['Codex', 'AGENTS.md'],
  ['Gemini', 'GEMINI.md'],
  ['Copilot', '.github/copilot-instructions.md'],
  ['Cursor', '.cursorrules'],
  ['Windsurf', '.windsurfrules'],
];

/** Folders of instructions files: [tool, folder, file suffix]. */
const DIRS: [SetupTool, string, string][] = [
  ['Cursor', '.cursor/rules', '.mdc'],
  ['Copilot', '.github/instructions', '.instructions.md'],
  ['Windsurf', '.windsurf/rules', '.md'],
  ['Continue', '.continue/rules', '.md'],
];

const RULE_HEADING = /\b(rules?|constraints?|conventions?|guidelines?|guardrails?|principles?)\b/i;
const RULE_LINE = /^(never|always|must|do not|don't|avoid)\b/i;

export function readSetup(repoPath: string): RepoSetup {
  const tools = new Set<SetupTool>();
  const instructions: SetupInstructions[] = [];
  const skills: SetupSkill[] = [];
  const at = (...p: string[]) => path.join(repoPath, ...p);
  const label = (file: string) => path.relative(repoPath, file);

  for (const [tool, rel] of FILES) {
    const file = at(rel);
    if (isFile(repoPath, file)) {
      tools.add(tool);
      instructions.push({ tool, file, label: rel });
    }
  }

  // .clinerules is a file in older Cline versions and a folder of rules in newer ones.
  const cline = at('.clinerules');
  if (isFile(repoPath, cline)) instructions.push({ tool: 'Cline', file: cline, label: '.clinerules' });
  else for (const f of files(repoPath, cline, '')) instructions.push({ tool: 'Cline', file: f, label: label(f) });
  if (instructions.some((i) => i.tool === 'Cline')) tools.add('Cline');

  for (const [tool, dir, suffix] of DIRS) {
    for (const file of files(repoPath, at(dir), suffix)) {
      const fm = frontmatter(read(repoPath, file) ?? '').data;
      tools.add(tool);
      instructions.push({
        tool,
        file,
        label: label(file),
        description: fm.description || undefined,
        // Cursor says globs, Copilot says applyTo; both mean "files this applies to".
        globs: fm.globs || fm.applyTo || undefined,
        alwaysApply: fm.alwaysApply === undefined ? undefined : fm.alwaysApply === 'true',
      });
    }
  }

  // Claude Code skills, commands and agents.
  for (const dir of dirs(repoPath, at('.claude', 'skills'))) {
    const file = path.join(dir, 'SKILL.md');
    const text = read(repoPath, file);
    if (text === null) continue;
    const fm = frontmatter(text);
    skills.push({ tool: 'Claude Code', kind: 'skill', name: fm.data.name || path.basename(dir), description: fm.data.description || firstLine(fm.body), file });
  }
  const commands = at('.claude', 'commands');
  for (const file of files(repoPath, commands, '.md', true)) {
    const fm = frontmatter(read(repoPath, file) ?? '');
    // commands/git/push.md is /git:push.
    const name = path.relative(commands, file).replace(/\.md$/, '').split(path.sep).join(':');
    skills.push({ tool: 'Claude Code', kind: 'command', name, description: fm.data.description || firstLine(fm.body), file });
  }
  for (const file of files(repoPath, at('.claude', 'agents'), '.md')) {
    const fm = frontmatter(read(repoPath, file) ?? '');
    skills.push({ tool: 'Claude Code', kind: 'agent', name: fm.data.name || path.basename(file, '.md'), description: fm.data.description || undefined, file });
  }
  for (const file of files(repoPath, at('.github', 'prompts'), '.prompt.md')) {
    const fm = frontmatter(read(repoPath, file) ?? '');
    skills.push({ tool: 'Copilot', kind: 'prompt', name: path.basename(file, '.prompt.md'), description: fm.data.description || firstLine(fm.body), file });
  }
  for (const s of skills) tools.add(s.tool);

  const guardrails = readGuardrails(repoPath);
  if (guardrails.allow.length || guardrails.deny.length || guardrails.hooks.length || isFile(repoPath, at('.claude', 'settings.json'))) tools.add('Claude Code');
  if (guardrails.mcp.length) tools.add('Claude Code');

  return {
    repo: path.basename(repoPath),
    repoPath,
    tools: ORDER.filter((t) => tools.has(t)),
    instructions,
    skills,
    rules: extractRules(repoPath, instructions),
    guardrails,
  };
}

const ORDER: SetupTool[] = ['Claude Code', 'Cursor', 'Codex', 'Copilot', 'Gemini', 'Windsurf', 'Cline', 'Continue'];

export function hasSetup(s: RepoSetup): boolean {
  return s.tools.length > 0;
}

// ---------- guardrails ----------

function readGuardrails(repoPath: string): SetupGuardrails {
  const out: SetupGuardrails = { allow: [], deny: [], hooks: [], mcp: [] };
  const settingsFile = path.join(repoPath, '.claude', 'settings.json');
  const settings = json(repoPath, settingsFile);
  const perms = settings?.permissions;
  if (perms && typeof perms === 'object') {
    out.allow = strings(perms.allow);
    out.deny = strings(perms.deny);
  }
  // hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "..." }] }] }
  const hooks = settings?.hooks;
  if (hooks && typeof hooks === 'object') {
    for (const [event, groups] of Object.entries(hooks)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          if (typeof h?.command === 'string') out.hooks.push({ event, matcher: typeof g.matcher === 'string' && g.matcher ? g.matcher : undefined, command: h.command });
        }
      }
    }
  }
  const mcpFile = path.join(repoPath, '.mcp.json');
  const servers = json(repoPath, mcpFile)?.mcpServers;
  if (servers && typeof servers === 'object') {
    for (const [name, v] of Object.entries(servers as Record<string, any>)) {
      // Only the program or URL: env and headers can hold tokens, and never leave the file.
      const detail = typeof v?.url === 'string' ? v.url : typeof v?.command === 'string' ? [v.command, ...strings(v.args)].join(' ') : '';
      out.mcp.push({ name, detail, file: mcpFile });
    }
  }
  return out;
}

// ---------- rules ----------

/**
 * Up to MAX_RULES one-line rules: bullets under a heading like "Rules" or "Conventions",
 * and any line starting Never / Always / Must / Do not. Files in instruction order, so
 * CLAUDE.md's rules come before a Cursor rule's.
 */
export function extractRules(repoPath: string, instructions: SetupInstructions[]): SetupRule[] {
  const out: SetupRule[] = [];
  const seen = new Set<string>();
  for (const ins of instructions) {
    const text = read(repoPath, ins.file);
    if (text === null) continue;
    for (const r of rulesIn(text)) {
      const key = r.text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: r.text, file: ins.file, label: `${ins.label}:${r.line}`, heading: r.heading });
      if (out.length >= MAX_RULES) return out;
    }
  }
  return out;
}

export function rulesIn(markdown: string): { text: string; line: number; heading?: string }[] {
  const out: { text: string; line: number; heading?: string }[] = [];
  const { body, offset } = frontmatter(markdown);
  const stack: { level: number; title: string }[] = [];
  let fence = false;
  const lines = body.split('\n');
  // A line that starts a new block, so it cannot be the wrapped tail of the line above.
  const starts = (l: string) => !l.trim() || /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~|\||>)/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      const level = (h[1] ?? '').length;
      while (stack.length && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
      stack.push({ level, title: clean(h[2] ?? '') });
      continue;
    }
    const at = i;
    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    // Rules wrap in the source; take the whole rule, not its first line. A following line
    // continues it if it is indented (the usual hard-wrapped style) or if this one stops
    // mid-sentence. Not plain markdown continuation, which would merge separate one-line rules.
    let whole = bullet ? bullet[2] ?? '' : raw;
    while (i + 1 < lines.length && !starts(lines[i + 1] ?? '') && (/^\s{2,}\S/.test(lines[i + 1] ?? '') || !/[.!?:;)]\s*$/.test(whole))) whole += ' ' + (lines[++i] ?? '').trim();
    const text = clean(whole);
    if (text.length < 8) continue;
    const under = [...stack].reverse().find((s) => RULE_HEADING.test(s.title));
    if ((bullet && under) || RULE_LINE.test(text)) out.push({ text, line: at + 1 + offset, heading: under?.title ?? stack[stack.length - 1]?.title });
  }
  return out;
}

/** Markdown to one plain line: no bold, code ticks or link syntax. */
function clean(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- small readers ----------

/** YAML-ish frontmatter: `key: value` lines between --- fences. Enough for name, description, globs, applyTo, alwaysApply. */
export function frontmatter(text: string): { data: Record<string, string>; body: string; offset: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, offset: 0 };
  const data: Record<string, string> = {};
  const lines = (m[1] ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i] ?? '');
    if (!kv || !kv[1]) continue;
    let v = (kv[2] ?? '').trim();
    // Folded or literal blocks (description: >) continue on indented lines.
    if (v === '>' || v === '|' || v === '>-' || v === '|-' || v === '') {
      const more: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? '')) more.push((lines[++i] ?? '').trim());
      v = more.join(' ');
    }
    data[kv[1]] = v.replace(/^(["'])(.*)\1$/, '$2');
  }
  return { data, body: text.slice(m[0].length), offset: m[0].split('\n').length - 1 };
}

function firstLine(body: string): string | undefined {
  const l = body.split('\n').map((x) => clean(x.replace(/^#+\s*/, ''))).find((x) => x.length > 0);
  return l ? l.slice(0, 160) : undefined;
}

function inside(repoPath: string, file: string): boolean {
  try {
    const real = fs.realpathSync(file);
    const root = fs.realpathSync(repoPath);
    return real === root || real.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

function isFile(repoPath: string, file: string): boolean {
  try {
    return fs.statSync(file).isFile() && inside(repoPath, file);
  } catch {
    return false;
  }
}

function read(repoPath: string, file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES || !inside(repoPath, file)) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function json(repoPath: string, file: string): any {
  const t = read(repoPath, file);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function entries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function dirs(repoPath: string, dir: string): string[] {
  return entries(dir).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => path.join(dir, d.name)).filter((d) => inside(repoPath, d)).slice(0, MAX_PER_DIR);
}

function files(repoPath: string, dir: string, suffix: string, recurse = false, depth = 0): string[] {
  const out: string[] = [];
  for (const d of entries(dir)) {
    if (d.name.startsWith('.')) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory() && recurse && depth < 2) out.push(...files(repoPath, p, suffix, true, depth + 1));
    else if (d.isFile() && p.endsWith(suffix) && inside(repoPath, p)) out.push(p);
    if (out.length >= MAX_PER_DIR) break;
  }
  return out;
}
