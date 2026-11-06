// Plan history in VS Code: reads GET /api/history from the core (src/history.ts) for the
// open repo and shows it three ways, all about the active plan (history.ts activeSpec):
//   - explorer marks: ● changed for it, ○ named in it but not changed yet, ◆ changed outside what it names
//   - a CodeLens at the top of a file: the active plan changing it and how many earlier plans did
//   - a status bar item: the active plan and its phase
//   - with monty.planBlame on (off by default): plan names above blocks of the visible lines, from git blame
// Marks are glyphs without colour, as the session's own marks in extension.ts: colour would
// recolour file names and fight git's decorations.

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { activeSpec, blameBlocks, blameSpecs, explorerMarks, fileLens, relTo, type ActiveSpec, type BlameBlock, type History, type LiteState, type Mark } from './history';

// Commits land minutes apart; the core answers from its cache in between.
const HISTORY_POLL_MS = 30_000;

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

function asHistory(x: unknown): History | null {
  const h = x as History | null;
  return h && typeof h.repo === 'string' && Array.isArray(h.specs) && h.files && typeof h.files === 'object' ? h : null;
}

const MARK_TEXT: Record<Mark, [string, (plan: string) => string]> = {
  changed: ['●', (p) => `Changed for ${p}`],
  named: ['○', (p) => `Named in ${p}, not changed yet`],
  outside: ['◆', (p) => `Changed while ${p} is active, though the plan doesn't name it`],
};

class PlanMarks implements vscode.FileDecorationProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private marks = new Map<string, vscode.FileDecoration>();

  update(repo: string | undefined, active: ActiveSpec | undefined, history: History | null) {
    const next = new Map<string, vscode.FileDecoration>();
    if (repo && active) {
      for (const [rel, mark] of explorerMarks(active, history)) {
        const [badge, tip] = MARK_TEXT[mark];
        next.set(vscode.Uri.joinPath(vscode.Uri.file(repo), rel).fsPath, new vscode.FileDecoration(badge, tip(active.name)));
      }
    }
    const changed = [...new Set([...this.marks.keys(), ...next.keys()])].filter((k) => this.marks.get(k)?.tooltip !== next.get(k)?.tooltip);
    this.marks = next;
    if (changed.length) this.emitter.fire(changed.map((f) => vscode.Uri.file(f)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.marks.get(uri.fsPath);
  }
}

class PlanLens implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  constructor(private ctl: HistoryController) {}
  refresh() {
    this.emitter.fire();
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const h = this.ctl.history;
    const rel = h ? relTo(h.repo, doc.uri.fsPath) : undefined;
    const lens = rel ? fileLens(rel, this.ctl.active, h) : undefined;
    const out: vscode.CodeLens[] = [];
    if (lens && rel) out.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: lens.title, command: 'monty.filePlans', arguments: [rel], tooltip: 'Plans that changed this file, newest first' }));
    // monty.planBlame: a lens above each block of the visible lines whose commit belongs to a plan.
    for (const b of this.ctl.blame.blocks(doc)) {
      const specs = blameSpecs(b.sha, h);
      if (!specs.length) continue;
      const line = Math.max(0, Math.min(b.start - 1, doc.lineCount - 1));
      const first = specs.find((s) => s.file);
      out.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: specs.map((s) => s.name).join(' · '),
        command: first ? 'monty.openPlanFile' : '',
        arguments: first ? [first.file] : [],
        tooltip: `Lines ${b.start}-${b.end} last changed in ${b.sha.slice(0, 8)}, for this plan`,
      }));
    }
    return out;
  }
}

// Blame runs as you scroll; wait for the scrolling to stop.
const BLAME_DEBOUNCE_MS = 400;
// One file's blame over a screenful is quick; a huge history must not hold a git process.
const BLAME_TIMEOUT_MS = 4000;

/** git blame on the visible lines of the active editor, when monty.planBlame is on. Off by default. */
class PlanBlame implements vscode.Disposable {
  private byDoc = new Map<string, { version: number; blocks: BlameBlock[] }>();
  private timer: NodeJS.Timeout | undefined;
  private subs: vscode.Disposable[] = [];
  constructor(private repo: () => string | undefined, private changed: () => void) {
    const kick = () => this.schedule();
    this.subs.push(
      vscode.window.onDidChangeTextEditorVisibleRanges(kick),
      vscode.window.onDidChangeActiveTextEditor(kick),
      vscode.workspace.onDidSaveTextDocument(kick),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('monty.planBlame')) return;
        this.byDoc.clear();
        this.changed();
        kick();
      }),
    );
  }

  private on(): boolean {
    return vscode.workspace.getConfiguration('monty').get<boolean>('planBlame', false);
  }

  blocks(doc: vscode.TextDocument): BlameBlock[] {
    const got = this.byDoc.get(doc.uri.toString());
    // Unsaved edits shift lines away from what git blamed: show nothing rather than wrong lines.
    return this.on() && got && got.version === doc.version && !doc.isDirty ? got.blocks : [];
  }

  schedule() {
    if (!this.on()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), BLAME_DEBOUNCE_MS);
  }

  private async run() {
    const ed = vscode.window.activeTextEditor;
    const repo = this.repo();
    if (!ed || !repo || ed.document.uri.scheme !== 'file' || ed.document.isDirty) return;
    const doc = ed.document;
    if (!relTo(repo, doc.uri.fsPath)) return;
    const vis = ed.visibleRanges;
    if (!vis.length) return;
    const from = Math.min(...vis.map((r) => r.start.line)) + 1;
    const to = Math.min(doc.lineCount, Math.max(...vis.map((r) => r.end.line)) + 1);
    const out = await new Promise<string | null>((resolve) => {
      // Read-only, no index lock taken.
      execFile('git', ['blame', '--porcelain', '-L', `${from},${to}`, '--', doc.uri.fsPath], { cwd: repo, timeout: BLAME_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => resolve(err ? null : stdout));
    });
    this.byDoc.set(doc.uri.toString(), { version: doc.version, blocks: out ? blameBlocks(out) : [] });
    if (this.byDoc.size > 20) this.byDoc.delete(this.byDoc.keys().next().value as string);
    this.changed();
  }

  dispose() {
    clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
  }
}

export class HistoryController implements vscode.Disposable {
  history: History | null = null;
  active: ActiveSpec | undefined;
  private state: LiteState | null = null;
  private fetchedAt = 0;
  private fetching = false;
  private lastKey = '';
  private marks = new PlanMarks();
  private lens = new PlanLens(this);
  readonly blame: PlanBlame;
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private subs: vscode.Disposable[] = [];

  constructor(private port: () => number, private repo: () => string | undefined, private openPlan: (file: string) => void) {
    this.item.command = 'monty.openActivePlan';
    // Blame runs at the repo's top folder (the history's), else the workspace folder.
    this.blame = new PlanBlame(() => this.history?.repo ?? this.repo(), () => this.lens.refresh());
    this.subs.push(
      this.item,
      this.blame,
      vscode.commands.registerCommand('monty.openPlanFile', (file?: string) => file && this.openPlan(file)),
      vscode.window.registerFileDecorationProvider(this.marks),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.lens),
      vscode.commands.registerCommand('monty.filePlans', (rel?: string) => this.pickPlan(rel)),
      vscode.commands.registerCommand('monty.openActivePlan', () => this.active && this.openPlan(this.active.file)),
    );
  }

  /** Each state poll: the active plan may have moved; refetch the history when it is old or the plan changed. */
  onState(state: LiteState | null) {
    this.state = state;
    const prev = this.active?.file;
    this.apply();
    if (Date.now() - this.fetchedAt > HISTORY_POLL_MS || this.active?.file !== prev) void this.fetch();
  }

  private async fetch() {
    const repo = this.repo();
    if (!repo || this.fetching) return;
    this.fetching = true;
    try {
      const h = asHistory(await fetchHistory(this.port(), repo));
      this.fetchedAt = Date.now();
      if (h || !this.history) this.history = h;
      this.apply();
    } finally {
      this.fetching = false;
    }
  }

  private apply() {
    this.active = activeSpec(this.state, this.history);
    const a = this.active;
    if (a) {
      this.item.text = `$(book) ${[a.name, a.label].filter(Boolean).join(' · ')}`;
      this.item.tooltip = `The plan this repo is on${a.label ? `, ${a.label}` : ''}. Click to open it.`;
      this.item.show();
    } else this.item.hide();
    // Marks and lenses only change with the plan, the session's edits or the history.
    const key = JSON.stringify([a?.file, a?.label, a?.sessionEdits, this.history?.files ? Object.keys(this.history.files).length : 0, this.fetchedAt]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.marks.update(this.history?.repo, a, this.history);
    this.lens.refresh();
  }

  private async pickPlan(rel?: string) {
    const file = rel ?? (vscode.window.activeTextEditor && this.history ? relTo(this.history.repo, vscode.window.activeTextEditor.document.uri.fsPath) : undefined);
    const lens = file ? fileLens(file, this.active, this.history) : undefined;
    if (!lens) return void vscode.window.showInformationMessage('No plan has changed this file, as far as I can tell.');
    const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'this session');
    const items = lens.entries.map((e) => ({
      label: e.name,
      description: e.active ? 'active' : day(e.when),
      detail: [e.guess ? 'A guess, from the plan\'s dates and the files it names' : '', e.file ? '' : 'No longer in the repo'].filter(Boolean).join(' · ') || undefined,
      file: e.file,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: `Plans that changed ${file}`, placeHolder: 'Open one in Monty' });
    if (pick?.file) this.openPlan(pick.file);
  }

  dispose() {
    this.subs.forEach((s) => s.dispose());
  }
}
