// Plan history in VS Code: reads GET /api/history from the core (src/history.ts) for the
// open repo, for the panel's "Plans per file" view.

/** The core's history for a repo, or null when the core is down or answers oddly. */
export async function fetchHistory(port: number, repo: string): Promise<unknown | null> {
  try {
    // Building the index the first time runs git log; give it longer than a state poll.
    const res = await fetch(`http://127.0.0.1:${port}/api/history?repo=${encodeURIComponent(repo)}`, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
