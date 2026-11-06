// Answering a plan's open question from the reader: the one place Monty writes to a
// project file, and only when the person clicks (CLAUDE.md: read-only, except an explicit,
// user-triggered action). Kept narrow on purpose:
//   - only a markdown file that is a known plan or spec under a project root,
//   - only one line, inside its "## Open Questions" section, in the form Caddis's review
//     skill writes decisions: "Decided: <answer> (owner, YYYY-MM-DD)",
//   - Undo removes exactly that line and nothing else.
// The text transforms are pure; `answerRoute` adds the HTTP checks and the write.

import * as fs from 'node:fs';
import type * as http from 'node:http';
import { MONTY_DECISION, openQuestions } from './reader.js';

/** Long enough for a sentence of answer; a plan's decision is one line, not an essay. */
const MAX_ANSWER = 300;
/** The request is a file path, a question and an answer: anything bigger is not one. */
const MAX_BODY = 8 * 1024;

export type Result = { ok: true; text: string; line: string } | { ok: false; error: string };

const norm = (s: string) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Writes "Decided: <answer> (owner, <date>)" under question `index`, if its text still matches. */
export function answerQuestion(text: string, index: number, question: string, answer: string, date: string): Result {
  const a = answer.replace(/\s+/g, ' ').trim();
  if (!a) return { ok: false, error: 'An empty answer, I am afraid, says nothing.' };
  if (a.length > MAX_ANSWER) return { ok: false, error: `Answers stay under ${MAX_ANSWER} characters.` };
  const q = openQuestions(text)[index];
  // The file may have changed since the page drew it: never write under a different question.
  if (!q || norm(q.text) !== norm(question)) return { ok: false, error: 'The question has moved since this page was drawn. Have another look.' };
  if (q.answer) return { ok: false, error: 'That one is already answered.' };
  const lines = text.split('\n');
  const decision = `Decided: ${a} (owner, ${date})`;
  const line = q.form === 'bullet' ? `${' '.repeat(q.indent)}- ${decision}` : decision;
  const insert = q.form === 'bullet' ? [line] : ['', line];
  lines.splice(q.end, 0, ...insert);
  return { ok: true, text: lines.join('\n'), line };
}

/** Removes a decision line Monty wrote, found by its exact text inside Open Questions. */
export function undoAnswer(text: string, line: string): Result {
  if (!MONTY_DECISION.test(line)) return { ok: false, error: 'Only an answer Monty wrote can be undone here.' };
  const qs = openQuestions(text);
  const q = qs.find((x) => x.answer?.line === line);
  if (!q) return { ok: false, error: 'That answer is no longer in the plan.' };
  const lines = text.split('\n');
  const i = lines.indexOf(line, q.start);
  if (i < 0 || i >= q.end) return { ok: false, error: 'That answer is no longer in the plan.' };
  // A paragraph answer came with the blank line before it.
  const blankBefore = q.form !== 'bullet' && i > 0 && !(lines[i - 1] as string).trim();
  lines.splice(blankBefore ? i - 1 : i, blankBefore ? 2 : 1);
  return { ok: true, text: lines.join('\n'), line };
}

/**
 * Who may ask: the panel itself, or a client with no Origin (the VS Code extension relaying
 * its webview, curl). A page on another site always sends its Origin with a POST, and its
 * JSON content type needs a CORS preflight this server never approves.
 */
export function refuseRequest(headers: http.IncomingHttpHeaders, port: number): string | null {
  const origin = headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return 'Not from this panel';
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return 'Not from this panel';
  if (!/^application\/json\b/i.test(String(headers['content-type'] ?? ''))) return 'JSON only';
  return null;
}

export interface AnswerBody { file?: unknown; index?: unknown; question?: unknown; answer?: unknown; undo?: unknown }

/** Applies one request to the file on disk. `allowed` is the project-root and known-plan check. */
export function applyAnswer(body: AnswerBody, allowed: (file: string) => boolean, date = localDate()): Result {
  const file = typeof body.file === 'string' ? body.file : '';
  if (!file || !/\.md$/i.test(file) || !allowed(file)) return { ok: false, error: 'Only a plan or spec under a project root' };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, error: 'I could not read that plan.' };
  }
  const r = typeof body.undo === 'string'
    ? undoAnswer(text, body.undo)
    : typeof body.index === 'number' && typeof body.question === 'string' && typeof body.answer === 'string'
      ? answerQuestion(text, body.index, body.question, body.answer, date)
      : ({ ok: false, error: 'Nothing to do' } as Result);
  if (!r.ok) return r;
  fs.writeFileSync(file, r.text);
  return r;
}

export function answerRoute(req: http.IncomingMessage, res: http.ServerResponse, port: number, allowed: (file: string) => boolean): void {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });
  const refused = refuseRequest(req.headers, port);
  if (refused) return send(403, { ok: false, error: refused });
  let raw = '';
  let over = false;
  req.on('data', (c: Buffer) => {
    raw += c.toString('utf8');
    if (raw.length > MAX_BODY) {
      over = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (over) return;
    try {
      const r = applyAnswer(JSON.parse(raw) as AnswerBody, allowed);
      send(r.ok ? 200 : 400, r.ok ? { ok: true, line: r.line } : r);
    } catch {
      send(400, { ok: false, error: 'Bad request' });
    }
  });
}
