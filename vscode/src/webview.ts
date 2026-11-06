// Turns the panel's index.html (web/, copied to media/web) into a webview page: every local
// script gets the nonce the Content-Security-Policy allows, every local stylesheet a
// webview URI, and window.MONTY is set just before app.js. Matching every local file
// rather than naming each one means a new web/*.js or *.css loads without touching this.
// vscode-free so it can be tested.

export interface PageParts {
  /** The webview URI for a file under media/web. */
  uri: (file: string) => string;
  nonce: string;
  cspSource: string;
  /** Becomes window.MONTY. */
  config: Record<string, unknown>;
}

const LOCAL = '[\\w./-]+';

export function webviewPage(page: string, { uri, nonce, cspSource, config }: PageParts): string {
  const monty = JSON.stringify({ ...config, nonce, mermaidSrc: uri('vendor/mermaid.min.js') }).replace(/</g, '\\u003c');
  return page
    .replace(/<link rel="icon"[^>]*>/, '')
    .replace(new RegExp(`<link rel="stylesheet" href="(${LOCAL}\\.css)">`, 'g'), (_m, f: string) => `<link rel="stylesheet" href="${uri(f)}">`)
    .replace(new RegExp(`<script src="(${LOCAL}\\.js)"></script>`, 'g'), (_m, f: string) =>
      (f === 'app.js' ? `<script nonce="${nonce}">window.MONTY = ${monty};</script>` : '') + `<script nonce="${nonce}" src="${uri(f)}"></script>`)
    .replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource};">`,
    );
}
