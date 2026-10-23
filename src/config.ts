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
  };
}
