// How a coding tool plugs into Monty: it lists the sessions active recently and opens a
// source for each, which reads that tool's own records and returns the shared Session view.

import type { Config } from '../config.js';
import type { AgentTool, Session } from '../types.js';

export type { AgentTool };

export interface SessionSource {
  /** Reads whatever is new. Returns true if anything changed. */
  poll(): boolean;
  snapshot(nowMs: number): Session;
}

export interface AgentAdapter {
  tool: AgentTool;
  /** Keys (usually file or folder paths) of sessions active within cfg.liveMs. */
  live(cfg: Config, nowMs: number): string[];
  open(key: string, cfg: Config): SessionSource;
}
