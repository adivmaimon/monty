// Kept so existing imports keep working: the Claude Code reader lives in agents/claude.ts,
// and the agent-neutral session model in model.ts.
export { SessionTracker } from './agents/claude.js';
export { DEFAULT_SESSION_OPTIONS, SessionModel, type SessionOptions } from './model.js';
export { rel } from './describe.js';
