// Settings come from environment variables so the menu bar app, a launch agent
// and a terminal can all start the core the same way.

import * as os from 'node:os';
import * as path from 'node:path';

export interface Config {
  port: number;
  /** Optional folders whose immediate children are all scanned for plans (MONTY_PROJECTS). */
  projectRoots: string[];
  /** Claude Code's session log folder. */
  claudeProjectsDir: string;
  /** Sessions whose log changed within this window are listed. */
  liveMs: number;
  contextWindow: number;
  /** Which tools' sessions to read (MONTY_AGENTS, comma-separated; default all). */
  agents: Set<string>;
  /** opencode's data folder (opencode.db, or storage/ for versions before 1.2). */
  opencodeDir: string;
  /** Codex CLI's home (sessions/YYYY/MM/DD/rollout-*.jsonl). */
  codexDir: string;
  /** Cline 4's own data folder (sessions/<id>/), used by its SDK build instead of globalStorage. */
  clineDir: string;
  /** "User" folders of VS Code and its forks, where Cline, Roo and Copilot Chat keep sessions. */
  editorUserDirs: string[];
}

// VS Code and the forks that run the same extensions, by their app-data folder name.
const EDITORS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf'];

function editorUserDirs(env: NodeJS.ProcessEnv): string[] {
  if (env.MONTY_EDITOR_DIRS) return env.MONTY_EDITOR_DIRS.split(',').map((s) => expand(s.trim())).filter(Boolean);
  const base =
    process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? (env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
    : (env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'));
  return EDITORS.map((e) => path.join(base, e, 'User'));
}

function expand(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // No default folder: repos come from the open VS Code windows (MontyStore.addRepo).
  // MONTY_PROJECTS adds folders whose children are all scanned, for seeing every repo at once.
  const roots = (env.MONTY_PROJECTS ?? '').split(',').map((s) => expand(s.trim())).filter(Boolean);
  const claudeDir = env.CLAUDE_CONFIG_DIR ? path.join(expand(env.CLAUDE_CONFIG_DIR), 'projects') : path.join(os.homedir(), '.claude', 'projects');
  return {
    port: Number(env.MONTY_PORT ?? 4747),
    projectRoots: roots,
    claudeProjectsDir: env.MONTY_CLAUDE_PROJECTS ? expand(env.MONTY_CLAUDE_PROJECTS) : claudeDir,
    liveMs: Number(env.MONTY_LIVE_HOURS ?? 3) * 3_600_000,
    contextWindow: Number(env.MONTY_CONTEXT_WINDOW ?? 200_000),
    agents: new Set((env.MONTY_AGENTS ?? 'claude-code,opencode,codex,cline,roo,copilot-chat').split(',').map((s) => s.trim()).filter(Boolean)),
    // opencode uses $XDG_DATA_HOME/opencode (else ~/.local/share/opencode) on every platform:
    // opencode.db since 1.2, the storage/ JSON files before that.
    opencodeDir: expand(env.MONTY_OPENCODE_DIR ?? path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'opencode')),
    codexDir: expand(env.MONTY_CODEX_DIR ?? env.CODEX_HOME ?? path.join(os.homedir(), '.codex')),
    // Same order Cline resolves it: CLINE_DATA_DIR, else $CLINE_DIR/data, else ~/.cline/data.
    clineDir: expand(env.MONTY_CLINE_DIR ?? env.CLINE_DATA_DIR ?? path.join(env.CLINE_DIR ?? path.join(os.homedir(), '.cline'), 'data')),
    editorUserDirs: editorUserDirs(env),
  };
}
