// Turns web/index.html into a page a VS Code webview will run: every local script gets the
// CSP nonce and a webview URI, every local stylesheet a webview URI, and window.MONTY (the
// page's config) is set just before app.js. Rewriting every tag, not a fixed list, means a
// new file in web/ works in VS Code without touching this. No vscode import, so it is tested.

export interface PageParts {
  /** Webview URI for a file under media/web. */
  uri: (file: string) => string;
  nonce: string;
  cspSource: string;
  config: Record<string, unknown>;
}

export function webviewPage(page: string, p: PageParts): string {
  const cfg = `<script nonce="${p.nonce}">window.MONTY = ${JSON.stringify(p.config).replace(/</g, '\\u003c')};</script>`;
  return page
    .replace(/<link rel="icon"[^>]*>/, '')
    .replace(/<link rel="stylesheet" href="([\w./-]+\.css)">/g, (_, f: string) => `<link rel="stylesheet" href="${p.uri(f)}">`)
    .replace(/<script src="([\w./-]+\.js)"><\/script>/g, (_, f: string) => `${f === 'app.js' ? cfg : ''}<script nonce="${p.nonce}" src="${p.uri(f)}"></script>`)
    .replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${p.cspSource} 'unsafe-inline'; script-src 'nonce-${p.nonce}'; img-src ${p.cspSource} data:; font-src ${p.cspSource};">`,
    );
}
