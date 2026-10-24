// Which .md files open in the readable view, and which stay as text.
//
// A custom editor is never told where it was asked to open: when the readable view was
// the default for *.md, a search result or Go to Line landed at the top of the rendered
// page instead of on the line. So text is the default, and a plain open (explorer, Quick
// Open) is swapped for the readable view. An open that arrives with a position (a search
// hit, Go to Line, a link to a line, the Problems list) shows intent to edit, and stays
// as text at that spot.

import * as vscode from 'vscode';

const VIEW_TYPE = 'monty.markdown';
// The editor applies the requested selection just after it becomes active; deciding
// sooner would read every open as "at the top".
const SETTLE_MS = 60;
// "Reopen Editor With > Text Editor" closes the readable view, then opens the text: an
// open this soon after the readable view closed is a deliberate switch, not a fresh open.
const SWITCH_MS = 1500;

const isMarkdown = (uri: vscode.Uri) => uri.scheme === 'file' && /\.md$/i.test(uri.fsPath);
const key = (uri: vscode.Uri) => uri.toString();

/** Text tabs for this file, in any group. */
function textTabs(uri: vscode.Uri): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && key(t.input.uri) === key(uri));
}

export class ReadableByDefault implements vscode.Disposable {
  /** Files open as text on purpose: left alone until their last text tab closes. */
  private keepText = new Set<string>();
  private readableClosedAt = new Map<string, number>();
  private subs: vscode.Disposable[] = [];

  constructor(private enabled: () => boolean) {
    // Tabs restored from the last session were not just opened: leave them as they were.
    for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) if (t.input instanceof vscode.TabInputText && isMarkdown(t.input.uri)) this.keepText.add(key(t.input.uri));
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor((e) => e && setTimeout(() => void this.consider(e), SETTLE_MS)),
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const t of e.closed) if (t.input instanceof vscode.TabInputText && !textTabs(t.input.uri).length) this.keepText.delete(key(t.input.uri));
      }),
    );
  }

  /** The person asked for text (Monty's Edit button): keep it until they close it. */
  keepAsText(uri: vscode.Uri): void {
    this.keepText.add(key(uri));
  }

  /** The readable view for this file closed, possibly to reopen it as text. */
  readableClosed(uri: vscode.Uri): void {
    this.readableClosedAt.set(key(uri), Date.now());
  }

  private async consider(editor: vscode.TextEditor): Promise<void> {
    const uri = editor.document.uri;
    if (!this.enabled() || !isMarkdown(uri) || this.keepText.has(key(uri))) return;
    // Still the active editor, and a plain text tab (not a diff, not a notebook).
    if (vscode.window.activeTextEditor !== editor) return;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab || !(tab.input instanceof vscode.TabInputText) || key(tab.input.uri) !== key(uri)) return;
    const sel = editor.selection;
    const atTop = sel.isEmpty && sel.active.line === 0 && sel.active.character === 0;
    const switched = Date.now() - (this.readableClosedAt.get(key(uri)) ?? 0) < SWITCH_MS;
    if (!atTop || switched || editor.document.isDirty) {
      this.keepText.add(key(uri));
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { viewColumn: tab.group.viewColumn, preview: tab.isPreview });
    // Opening the readable view in the group can replace a preview tab by itself; a
    // pinned text tab stays behind and is closed here.
    const stale = tab.group.tabs.find((t) => t.input instanceof vscode.TabInputText && key(t.input.uri) === key(uri));
    if (stale) await vscode.window.tabGroups.close(stale, true);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
