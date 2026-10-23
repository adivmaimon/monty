// What the menu bar shows: one icon state for the whole Mac, plus the dropdown.
// SwiftBar renders the text format below; the native app will read /api/bar instead.
// SwiftBar greys out lines with no action, so every line that matters gets an href.

import type { Badge } from './icon.js';
import { renderMonocle } from './icon.js';
import type { MontyState, Project, Session } from './types.js';

export interface BarSummary {
  pct: number;
  badge: Badge;
  text: string; // short text beside the icon, e.g. "3/6" or "needs you"
  focus?: { repo: string; title: string; state: Session['state']; reason: string };
  needsYou: number;
  working: number;
}

const STATE_LABEL: Record<Session['state'], string> = {
  needs_input: 'Needs you',
  working: 'Working',
  your_turn: 'Your turn',
  done: 'Done',
  idle: 'Idle',
};

// SF Symbols per state, with colours that match the mockup.
const STATE_ICON: Record<Session['state'], [string, string]> = {
  needs_input: ['exclamationmark.circle.fill', '#f0883e'],
  working: ['circle.dotted.circle', '#e8a26a'],
  your_turn: ['arrowshape.turn.up.left.circle', '#6cb6ff'],
  done: ['checkmark.circle.fill', '#56d364'],
  idle: ['moon.zzz', '#8b949e'],
};

export function summarise(state: MontyState): BarSummary {
  const live = state.sessions.filter((s) => s.state !== 'idle');
  const focus = live[0];
  const needsYou = live.filter((s) => s.state === 'needs_input').length;
  const working = live.filter((s) => s.state === 'working').length;
  if (!focus) return { pct: 0, badge: 'idle', text: '', needsYou, working };
  const { done, total } = focus.progress;
  const plan = focus.plan;
  const failing = focus.state === 'working' && focus.lastTest && !focus.lastTest.ok;
  const badge: Badge = needsYou ? 'attention' : failing ? 'failing' : focus.state === 'done' ? 'done' : 'none';
  // Beside the icon: the task list when there is one, else the repo's plan, else the
  // state in a word or two. "needs you" outranks plan progress: it is the reason to look.
  const text = total ? `${done}/${total}` : needsYou ? 'needs you' : plan ? plan.label : focus.state === 'working' ? focus.repo : '';
  return {
    pct: total ? done / total : plan ? plan.done / plan.total : 0,
    badge,
    text,
    focus: { repo: focus.repo, title: focus.title, state: focus.state, reason: focus.stateReason },
    needsYou,
    working,
  };
}

function esc(s: string): string {
  return s.replace(/\|/g, '¦').replace(/\s+/g, ' ').trim();
}

function projectLabel(p: Project): string {
  const { done, total, basis } = p.progress;
  if (basis === 'phases') return done >= total ? `All ${total} phases done` : `Phase ${done + 1} of ${total}`;
  if (basis === 'tasks') return `${done}/${total} tasks`;
  return '';
}

/** Links go through the Monty extension, so they land in the VS Code window that has the repo open. */
function show(repo?: string, doc?: string): string {
  const q = [repo ? `repo=${encodeURIComponent(repo)}` : '', doc ? `doc=${encodeURIComponent(doc)}` : ''].filter(Boolean).join('&');
  return `vscode://adivmaimon.monty/show${q ? '?' + q : ''}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

export function swiftbarText(state: MontyState, port: number): string {
  void port;
  const s = summarise(state);
  const icon = renderMonocle(s.pct, s.badge).toString('base64');
  const out: string[] = [];
  out.push(`${s.text} | templateImage=${icon} width=18 height=18 size=12`);
  out.push('---');

  const live = state.sessions.filter((x) => x.state !== 'idle');
  if (!live.length) out.push(`No Claude Code sessions running | color=gray href=${show()}`);
  for (const x of live) {
    const [sym, col] = STATE_ICON[x.state];
    const { done, total } = x.progress;
    const scoped = show(x.repoPath ?? x.cwd);
    out.push(`${esc(x.repo)}  ${esc(x.title)} | length=56 href=${scoped} sfimage=${sym} sfcolor=${col}`);
    const prog = total ? `${done} of ${total} tasks` : x.plan ? `${x.plan.label} (plan)` : '';
    const facts = [STATE_LABEL[x.state], prog, `context ${x.context.pct}%`].filter(Boolean).join(' · ');
    out.push(`${facts} | size=12 color=${col} href=${scoped}`);
    if (x.state === 'needs_input' || x.now) {
      const line = x.state === 'needs_input' ? x.stateReason : x.now?.text ?? '';
      out.push(`${esc(line)} | size=12 length=60 href=${scoped}`);
    }
    for (const t of x.todos) {
      const ic = t.status === 'completed' ? 'checkmark.circle.fill' : t.status === 'in_progress' ? 'circle.inset.filled' : 'circle';
      out.push(`--${esc(t.text)} | size=13 length=60 sfimage=${ic} href=${scoped}`);
    }
    out.push('---');
  }

  const active = state.projects.filter((p) => p.status === 'active').slice(0, 6);
  if (active.length) {
    out.push('Plans in progress | size=11 color=gray');
    for (const p of active) {
      const label = projectLabel(p);
      // Clip the name ourselves so the phase label never gets cut off.
      out.push(`${esc(p.repo)} · ${esc(clip(p.name, 34))}${label ? `  ·  ${label}` : ''} | size=13 sfimage=doc.text href=${show(p.repoPath, p.file)}`);
    }
    out.push('---');
  }
  out.push(`Open Monty in VS Code | href=${show()} sfimage=rectangle.on.rectangle`);
  return out.join('\n') + '\n';
}
