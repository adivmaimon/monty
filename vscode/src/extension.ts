// Monty for VS Code: a side panel and status bar item scoped to the open repo, and a
// readable view for markdown plans. All data comes from the local Monty core
// (http://127.0.0.1:4747), which this extension starts if it is not running, so every
// VS Code window shares one watcher.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { changedLineRange, hunkRanges } from './diff';
import { findApp, installMenuBarApp, offerMenuBarApp } from './install';
import { ReadableByDefault } from './readable';

interface Session {
  id: string;
  agent?: string;
  cwd: string;
  title: string;
  state: 'working' | 'needs_input' | 'your_turn' | 'done' | 'idle';
  stateReason: string;
  progress: { done: number; total: number };
  plan?: { label: string; name: string };
  now?: { text: string; file?: string };
  touched?: { path: string; reads: number; edits: number; plus: number; minus: number }[];
}
interface Project { file: string; name: string }
interface State { sessions: Session[]; projects: Project[] }

const POLL_MS = 1500;
const AGENT_NAMES: Record<string, string> = { 'claude-code': 'Claude Code', opencode: 'opencode', codex: 'Codex', cline: 'Cline', roo: 'Roo Code', 'copilot-chat': 'Copilot' };

let latest: State | null = null;
/** Where the extension is installed; the bundled core lives in its core/ folder. */
let extensionRoot = '';
let lastJson = '';
let lastSpawn = 0;
const RESPAWN_MS = 10_000;
const webviews = new Set<vscode.Webview>();
let detailsPanel: vscode.WebviewPanel | undefined;

function cfg() {
  const c = vscode.workspace.getConfiguration('monty');
  const home = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
  // Empty: the core bundled in the extension (core/). Set: a development checkout.
  const coreDir = home(c.get<string>('coreDir', '')) || path.join(extensionRoot, 'core');
  // Empty: find the menu bar app in /Applications or ~/Applications (install.ts findApp).
  const appPath = home(c.get<string>('appPath', ''));
  return { coreDir, port: c.get<number>('port', 4747), appPath, menuBar: c.get<boolean>('menuBarApp', true), readable: c.get<boolean>('readableMarkdown', true) };
}

/**
 * Launches the menu bar app in the background if it is not already running. The app
 * quits itself 30s after the core goes away, and the core goes ~20s after the last
 * window, so Monty as a whole exists only while VS Code is open.
 */
function startMenuBarApp(): void {
  const { appPath: setting, menuBar } = cfg();
  const appPath = findApp(setting);
  if (process.platform !== 'darwin' || !menuBar || !appPath) return;
  // Matches both the repo build and a copy in /Applications: same executable name.
  const check = spawn('pgrep', ['-f', 'Monty.app/Contents/MacOS/Monty'], { stdio: 'ignore' });
  check.on('exit', (code) => {
    if (code === 0) return; // running
    spawn('open', ['-g', '-a', appPath], { detached: true, stdio: 'ignore' }).unref();
  });
  check.on('error', () => undefined);
}

function repoRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function fetchState(): Promise<State | null> {
  const repo = repoRoot();
  // client=vscode keeps the core alive; it quits ~20s after the last VS Code window closes.
  const url = `http://127.0.0.1:${cfg().port}/api/state?client=vscode${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok ? ((await res.json()) as State) : null;
  } catch {
    return null;
  }
}

/** Starts the core with VS Code's own Node runtime, so it works without node on PATH. */
function startCore(): string | null {
  const { coreDir } = cfg();
  const cli = path.join(coreDir, 'dist', 'src', 'cli.js');
  if (!fs.existsSync(cli)) return `Monty could not find its core at ${cli}. If monty.coreDir is set, run "npm run build" there or clear the setting.`;
  // Extra folders to watch, beyond the repos the windows ask about.
  const roots = vscode.workspace.getConfiguration('monty').get<string[]>('projectRoots', []).filter(Boolean).join(',');
  const child = spawn(process.execPath, [cli, '--exit-when-idle'], {
    cwd: coreDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(roots ? { MONTY_PROJECTS: roots } : {}) },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return null;
}

/**
 * Posting to a webview whose tab just closed throws (or rejects) "Webview is disposed".
 * That is only ever a race with its dispose handler, which removes it from `webviews`, so drop it.
 * Note: never read `panel.webview` once the panel is disposed; keep the reference from creation.
 */
function post(w: vscode.Webview, msg: unknown) {
  try {
    void w.postMessage(msg).then(undefined, () => webviews.delete(w));
  } catch {
    webviews.delete(w);
  }
}

function broadcast(msg: unknown) {
  for (const w of webviews) post(w, msg);
}

/** The session the sidebar leads with: state is scoped to this repo and sorted needs-you first. */
function currentSession(state: State | null): Session | undefined {
  return state?.sessions.find((s) => s.state !== 'idle');
}

// ---------- follow mode ----------
// Off by default, per workspace. When on, each file the repo's session changes opens
// beside the current editor (a real tab, not a preview) with the changed lines lit up.
//
// It watches the filesystem rather than the session log: sessions change files through
// Edit, Write, heredocs, sed, and Python scripts (`p.write_text(...)`), and only the
// first few show up in the log in a readable form. The log still decides *when*: only
// while this repo's session is working, so your own saves, git checkouts and builds
// between turns are not followed.

const FOLLOW_KEY = 'monty.follow';
// Long enough to find the lines on a glance at the other column, short enough not to linger.
const HIGHLIGHT_MS = 3000;
// A script often writes several files in a row; wait this long for the burst to end and
// open the last one, rather than flicking through every tab.
const BURST_MS = 400;
// The session's last write can land just after the log says the turn ended.
const WORKING_GRACE_MS = 5000;
// Your own save in VS Code also fires the watcher; ignore a change this soon after it.
const OWN_SAVE_MS = 1500;
// Files bigger than this are not snapshotted or diffed (generated data, not code being written).
const MAX_FOLLOW_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.build', 'out', 'target', 'coverage', '__pycache__', '.venv', 'venv', '.next', '.turbo', '.cache', 'DerivedData', '.pytest_cache']);
const SKIP_FILES = /(\.log|\.pyc|\.lock|-lock\.json|\.lockb|\.DS_Store|\.map)$/;

let workspaceState: vscode.Memento | undefined;
let highlight: vscode.TextEditorDecorationType | undefined;
let workingUntil = 0;
const snapshots = new Map<string, string>(); // abs path -> last text seen, to diff the next change against
const ownSaves = new Map<string, number>();
const ignoredByGit = new Map<string, boolean>();
const burst = new Set<string>();
let burstTimer: NodeJS.Timeout | undefined;

const following = () => workspaceState?.get<boolean>(FOLLOW_KEY, false) ?? false;

function setFollow(on: boolean) {
  void workspaceState?.update(FOLLOW_KEY, on);
  broadcast({ type: 'follow', on });
}

/** Called on every state poll: is this repo's session working (or was, a moment ago)? */
function noteWorking(state: State | null) {
  if (currentSession(state)?.state === 'working') workingUntil = Date.now() + WORKING_GRACE_MS;
}

function readSmall(file: string): string | undefined {
  try {
    if (fs.statSync(file).size > MAX_FOLLOW_BYTES) return undefined;
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return undefined; // binary
    return buf.toString('utf8');
  } catch {
    return undefined;
  }
}

/** Snapshot the files the session has read or touched, so their first change diffs precisely. */
function snapshotTouched(state: State | null) {
  const s = currentSession(state);
  if (!s) return;
  for (const f of s.touched ?? []) {
    if (f.path.startsWith('/')) continue;
    const abs = path.join(s.cwd, f.path);
    if (snapshots.has(abs) || snapshots.size > 400) continue;
    const text = readSmall(abs);
    if (text !== undefined) snapshots.set(abs, text);
  }
}

function skipPath(root: string, file: string): boolean {
  if (!file.startsWith(root + path.sep)) return true;
  const rel = file.slice(root.length + 1).split(path.sep);
  return rel.some((p) => SKIP_DIRS.has(p)) || SKIP_FILES.test(file);
}

function gitIgnored(root: string, file: string): Promise<boolean> {
  const known = ignoredByGit.get(file);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', file], { cwd: root, timeout: 2000 }, (err) => {
      // Exit 0: ignored. 1: not ignored. Anything else (not a git repo): treat as not ignored.
      const ignored = !err;
      ignoredByGit.set(file, ignored);
      resolve(ignored);
    });
  });
}

/** No snapshot: ask git which lines differ from the index (`@@ -a,b +c,d @@` hunks). */
function gitChangedRanges(root: string, file: string): Promise<[number, number][]> {
  return new Promise((resolve) => {
    execFile('git', ['diff', '--no-color', '-U0', '--', file], { cwd: root, timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      resolve(hunkRanges(out));
    });
  });
}

function onFileChanged(uri: vscode.Uri) {
  const root = repoRoot();
  const file = uri.fsPath;
  if (!root || !following() || Date.now() > workingUntil || skipPath(root, file)) return;
  if (Date.now() - (ownSaves.get(file) ?? 0) < OWN_SAVE_MS) return;
  burst.add(file);
  clearTimeout(burstTimer);
  burstTimer = setTimeout(() => void flushBurst(root), BURST_MS);
}

async function flushBurst(root: string) {
  const files = [...burst];
  burst.clear();
  let target: { file: string; ranges: [number, number][] } | undefined;
  for (const file of files) {
    if (await gitIgnored(root, file)) continue;
    const after = readSmall(file);
    if (after === undefined) continue;
    const before = snapshots.get(file);
    snapshots.set(file, after);
    if (before === after) continue;
    let ranges: [number, number][];
    if (before !== undefined) {
      const r = changedLineRange(before, after);
      ranges = r ? [r] : [];
    } else {
      ranges = await gitChangedRanges(root, file);
      // Untracked and new: the whole file is the change.
      if (!ranges.length) ranges = [[0, Math.max(0, after.split('\n').length - 1)]];
    }
    target = { file, ranges };
  }
  if (target) await reveal(target.file, target.ranges);
}

async function reveal(file: string, lines: [number, number][]) {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false, preserveFocus: true });
    const max = doc.lineCount - 1;
    const ranges = lines.map(([a, b]) => new vscode.Range(Math.min(a, max), 0, Math.min(b, max), 0));
    if (!ranges.length) return;
    editor.revealRange(ranges[0]!, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    highlight ??= vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    const deco = highlight;
    editor.setDecorations(deco, ranges);
    setTimeout(() => editor.setDecorations(deco, []), HIGHLIGHT_MS);
  } catch {
    /* deleted or moved since: nothing to follow */
  }
}

// ---------- file decorations ----------
// A dot on the files the current session changed, a fainter one on files it only read.
// Badges are text, so "fainter" is a smaller glyph; no colour, which would recolour the
// file name and fight git's own decorations.

class TouchedFiles implements vscode.FileDecorationProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private files = new Map<string, vscode.FileDecoration>();

  update(state: State | null) {
    const s = currentSession(state);
    const next = new Map<string, vscode.FileDecoration>();
    for (const f of s?.touched ?? []) {
      if (f.path.startsWith('/')) continue; // outside the repo
      const abs = path.join(s!.cwd, f.path);
      next.set(abs, f.edits
        ? new vscode.FileDecoration('●', `Changed by Claude this session (+${f.plus} −${f.minus})`)
        : new vscode.FileDecoration('·', 'Read by Claude this session'));
    }
    const changed = [...new Set([...this.files.keys(), ...next.keys()])].filter((k) => this.files.get(k)?.badge !== next.get(k)?.badge || this.files.get(k)?.tooltip !== next.get(k)?.tooltip);
    this.files = next;
    if (changed.length) this.emitter.fire(changed.map((f) => vscode.Uri.file(f)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.files.get(uri.fsPath);
  }
}

// ---------- webview content ----------

function html(webview: vscode.Webview, extUri: vscode.Uri, config: Record<string, unknown>): string {
  const webDir = vscode.Uri.joinPath(extUri, 'media', 'web');
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(webDir, f)).toString();
  let page = fs.readFileSync(vscode.Uri.joinPath(webDir, 'index.html').fsPath, 'utf8');
  page = page
    .replace(/<link rel="icon"[^>]*>/, '')
    .replace('href="style.css"', `href="${uri('style.css')}"`)
    .replace('<script src="md.js"></script>', `<script nonce="${nonce}" src="${uri('md.js')}"></script>`)
    .replace('<script src="app.js"></script>', `<script nonce="${nonce}">window.MONTY = ${JSON.stringify({ ...config, nonce, mermaidSrc: uri('vendor/mermaid.min.js') }).replace(/</g, '\\u003c')};</script><script nonce="${nonce}" src="${uri('app.js')}"></script>`)
    .replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">`,
    );
  return page;
}

function wire(webview: vscode.Webview, extUri: vscode.Uri, config: Record<string, unknown>): vscode.Disposable {
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')] };
  webview.html = html(webview, extUri, config);
  webviews.add(webview);
  return webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'ready' && latest) post(webview, { type: 'state', state: latest });
    if (m.type === 'open' && typeof m.path === 'string') {
      // preview: false = a real tab that stays open, not the italic preview tab.
      const line = typeof m.line === 'number' && m.line > 0 ? m.line - 1 : undefined;
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.path));
        await vscode.window.showTextDocument(doc, {
          preview: false,
          viewColumn: vscode.ViewColumn.Active,
          selection: line !== undefined ? new vscode.Range(line, 0, line, 0) : undefined,
        });
      } catch {
        void vscode.window.showWarningMessage(`Monty couldn't open ${m.path}, I'm afraid.`);
      }
    }
    if (m.type === 'openDoc' && typeof m.file === 'string') openReadable(extUri, m.file);
    if (m.type === 'openDetails') openDetails(extUri);
    if (m.type === 'setFollow') setFollow(!!m.on);
    if (m.type === 'editAsText' && typeof m.file === 'string') {
      readable?.keepAsText(vscode.Uri.file(m.file));
      void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(m.file), 'default', { preview: false });
    }
    if (m.type === 'getDoc' && typeof m.file === 'string') {
      let text = `Could not open ${m.file}`;
      // Markdown, and AI tool rule files that are markdown under another name (same list as the core's /api/doc).
      if (/\.(md|mdc)$/i.test(m.file) || ['.cursorrules', '.windsurfrules', '.clinerules'].includes(path.basename(m.file))) {
        try {
          // Prefer the open editor's text, so unsaved changes show too.
          const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === m.file);
          text = open ? open.getText() : fs.readFileSync(m.file, 'utf8');
        } catch {
          /* keep the message */
        }
      }
      post(webview, { type: 'doc', id: m.id, text });
    }
  });
}

/** Tab icons are drawn as images, so currentColor would be black: give VS Code one per theme. */
function tabIcon(extUri: vscode.Uri) {
  return { light: vscode.Uri.joinPath(extUri, 'media', 'monocle-light.svg'), dark: vscode.Uri.joinPath(extUri, 'media', 'monocle-dark.svg') };
}

/**
 * Links from Monty open plans in Monty's own tab (one per file). This path does not depend
 * on VS Code's editor associations, which can quietly fall back to the text editor; the
 * custom editor below covers .md files opened from the explorer.
 */
const docPanels = new Map<string, vscode.WebviewPanel>();

function openReadable(extUri: vscode.Uri, file: string) {
  const existing = docPanels.get(file);
  if (existing) return existing.reveal();
  const name = latest?.projects.find((p) => p.file === file)?.name ?? path.basename(file);
  const panel = vscode.window.createWebviewPanel('monty.doc', name, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true });
  panel.iconPath = tabIcon(extUri);
  const webview = panel.webview;
  const sub = wire(webview, extUri, { host: true, mode: 'doc', file, repo: repoRoot() });
  // Live: re-send the text when the file changes on disk or in an open editor.
  const send = (text: string) => post(webview, { type: 'docText', text });
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
  watcher.onDidChange(() => {
    try {
      send(fs.readFileSync(file, 'utf8'));
    } catch {
      /* deleted or moved: keep the last text */
    }
  });
  const edits = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document.uri.fsPath === file) send(e.document.getText());
  });
  docPanels.set(file, panel);
  panel.onDidDispose(() => {
    docPanels.delete(file);
    webviews.delete(webview);
    sub.dispose();
    watcher.dispose();
    edits.dispose();
  });
}

/** Plain opens of .md files swap to this (readable.ts); opens at a line stay text. */
let readable: ReadableByDefault | undefined;

/** The readable view for every .md file. "Edit" in its toolbar reopens the file as text. */
class MarkdownEditor implements vscode.CustomTextEditorProvider {
  constructor(private extUri: vscode.Uri) {}
  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const file = document.uri.fsPath;
    const webview = panel.webview;
    const sub = wire(webview, this.extUri, { host: true, mode: 'doc', file, repo: repoRoot() });
    // Live: when Claude (or you) changes the plan, the readable view follows.
    const change = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) post(webview, { type: 'docText', text: e.document.getText() });
    });
    panel.onDidDispose(() => {
      readable?.readableClosed(document.uri);
      webviews.delete(webview);
      sub.dispose();
      change.dispose();
    });
  }
}

/** The full view: one editor tab per window with everything about this repo's session and plans. */
function openDetails(extUri: vscode.Uri) {
  if (detailsPanel) return detailsPanel.reveal();
  const repo = repoRoot();
  const panel = vscode.window.createWebviewPanel('monty.details', `Monty · ${repo ? path.basename(repo) : 'all'}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  panel.iconPath = tabIcon(extUri);
  const webview = panel.webview;
  const sub = wire(webview, extUri, { host: true, mode: 'full', repo, follow: following() });
  detailsPanel = panel;
  panel.onDidDispose(() => {
    // Forget the panel first: anything below that throws must not leave a dead panel
    // behind for the next "Open details" to reveal ("Webview is disposed").
    if (detailsPanel === panel) detailsPanel = undefined;
    webviews.delete(webview);
    sub.dispose();
  });
}

class PanelProvider implements vscode.WebviewViewProvider {
  constructor(private extUri: vscode.Uri) {}
  resolveWebviewView(view: vscode.WebviewView) {
    // The view title reads "MONTY: <REPO>" instead of a generic label.
    const repo = repoRoot();
    view.title = repo ? path.basename(repo) : 'No folder open';
    const webview = view.webview;
    const sub = wire(webview, this.extUri, { host: true, mode: 'live', repo: repoRoot(), follow: following() });
    view.onDidDispose(() => {
      webviews.delete(webview);
      sub.dispose();
    });
  }
}

// ---------- status bar ----------

function updateStatus(item: vscode.StatusBarItem, state: State | null) {
  if (!state) {
    item.text = '$(eye-closed) Monty';
    item.tooltip = "Monty's core isn't running. Off duty, it seems.";
    item.backgroundColor = undefined;
    return;
  }
  const live = state.sessions.filter((s) => s.state !== 'idle');
  const s = live[0];
  if (!s) {
    item.text = '$(eye) Monty';
    item.tooltip = 'No session in this repo at present';
    item.backgroundColor = undefined;
    return;
  }
  const prog = s.progress.total ? `${s.progress.done}/${s.progress.total}` : s.plan?.label ?? '';
  const what = s.state === 'needs_input' ? 'Needs you' : s.state === 'done' ? 'All done' : s.state === 'your_turn' ? 'Your move' : s.now?.file ? path.basename(s.now.file) : 'Working';
  item.text = `${s.state === 'needs_input' ? '$(bell-dot)' : s.state === 'done' ? '$(check)' : '$(eye)'} ${[prog, what].filter(Boolean).join(' · ')}`;
  item.tooltip = `${s.title}\n${s.stateReason}${s.agent && s.agent !== 'claude-code' ? `\n${AGENT_NAMES[s.agent] ?? s.agent}` : ''}`;
  item.backgroundColor = s.state === 'needs_input' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}

// ---------- links from the menu bar ----------
// vscode://adivmaimon.monty/show?repo=<abs>&doc=<abs .md>
// VS Code hands the link to the last focused window. If that window has the repo open it
// acts directly; otherwise it leaves an intent with the core and focuses (or opens) the
// repo's window, which collects the intent on its next poll.

function under(a: string, b: string): boolean {
  return a === b || a.startsWith(b + path.sep);
}

function act(extUri: vscode.Uri, doc?: string) {
  if (doc) openReadable(extUri, doc);
  else openDetails(extUri);
}

async function handleUri(extUri: vscode.Uri, uri: vscode.Uri) {
  const q = new URLSearchParams(uri.query);
  const repo = q.get('repo') ?? undefined;
  const doc = q.get('doc') ?? undefined;
  const own = repoRoot();
  if (!repo || (own && (under(repo, own) || under(own, repo)))) return act(extUri, doc);
  try {
    const params = new URLSearchParams({ repo, ...(doc ? { doc } : {}) });
    await fetch(`http://127.0.0.1:${cfg().port}/api/intent?${params}`, { method: 'POST', signal: AbortSignal.timeout(1000) });
  } catch {
    /* the other window will still open; it just will not jump to the plan */
  }
  await openWindowFor(repo);
}

/**
 * Brings up the window that has this folder open, or opens one if none does: what `code <folder>`
 * does. The vscode.openFolder command with forceNewWindow opened a second window even when one
 * already had the repo. The CLI ships inside the app (code, code-insiders, cursor...).
 */
async function openWindowFor(folder: string): Promise<void> {
  const bin = path.join(vscode.env.appRoot, 'bin');
  const names = process.platform === 'win32' ? ['code.cmd', 'code-insiders.cmd', 'cursor.cmd'] : ['code', 'code-insiders', 'cursor', 'codium', 'windsurf'];
  let cli = names.map((n) => path.join(bin, n)).find((f) => fs.existsSync(f));
  if (!cli) cli = fs.readdirSync(bin, { withFileTypes: true }).filter((e) => e.isFile() && !/tunnel|shim/.test(e.name)).map((e) => path.join(bin, e.name))[0];
  if (cli) {
    const ok = await new Promise<boolean>((resolve) => {
      // Without the window's own CLI hook the request goes to the main process, which picks the window.
      const env = { ...process.env };
      delete env.VSCODE_IPC_HOOK_CLI;
      execFile(cli as string, [folder], { env, shell: process.platform === 'win32', timeout: 10_000 }, (err) => resolve(!err));
    });
    if (ok) return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
}

async function collectIntents(extUri: vscode.Uri) {
  const own = repoRoot();
  if (!own) return;
  try {
    const res = await fetch(`http://127.0.0.1:${cfg().port}/api/intent?repo=${encodeURIComponent(own)}`, { signal: AbortSignal.timeout(1000) });
    const list = res.ok ? ((await res.json()) as { doc?: string }[]) : [];
    for (const i of list) act(extUri, i.doc);
  } catch {
    /* core not up yet */
  }
}

// ---------- activation ----------

export function activate(context: vscode.ExtensionContext) {
  const extUri = context.extensionUri;
  extensionRoot = context.extensionPath;
  workspaceState = context.workspaceState;
  startMenuBarApp();
  if (cfg().menuBar) void offerMenuBarApp(context, cfg().appPath);
  const touched = new TouchedFiles();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(touched));
  const root = repoRoot();
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '**/*'), false, false, true);
    context.subscriptions.push(
      watcher,
      watcher.onDidChange(onFileChanged),
      watcher.onDidCreate(onFileChanged),
      vscode.workspace.onDidSaveTextDocument((d) => ownSaves.set(d.uri.fsPath, Date.now())),
    );
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('monty.panel', new PanelProvider(extUri), { webviewOptions: { retainContextWhenHidden: true } }));

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'monty.openDetails';
  item.show();
  context.subscriptions.push(item);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('monty.markdown', new MarkdownEditor(extUri), { webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true } }),
    (readable = new ReadableByDefault(() => cfg().readable)),
  );
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => handleUri(extUri, uri) }));

  context.subscriptions.push(
    vscode.commands.registerCommand('monty.focus', () => vscode.commands.executeCommand('monty.panel.focus')),
    vscode.commands.registerCommand('monty.openDetails', () => openDetails(extUri)),
    vscode.commands.registerCommand('monty.toggleFollow', () => setFollow(!following())),
    vscode.commands.registerCommand('monty.installMenuBar', () => installMenuBarApp().then(() => startMenuBarApp())),
    vscode.commands.registerCommand('monty.openReadable', (uri?: vscode.Uri) => {
      const file = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      if (file) openReadable(extUri, file);
    }),
  );

  const tick = async () => {
    const state = await fetchState();
    // No core: start one (and again later if it died). If another window starts one at
    // the same moment, the loser sees the port in use and exits.
    if (!state && Date.now() - lastSpawn > RESPAWN_MS) {
      lastSpawn = Date.now();
      const err = startCore();
      if (err) broadcast({ type: 'offline', message: err });
    }
    updateStatus(item, state);
    if (!state) return;
    await collectIntents(extUri);
    latest = state;
    touched.update(state);
    noteWorking(state);
    snapshotTouched(state);
    const json = JSON.stringify(state);
    if (json !== lastJson) {
      lastJson = json;
      broadcast({ type: 'state', state });
    }
  };
  void tick();
  const timer = setInterval(tick, POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate() {}
