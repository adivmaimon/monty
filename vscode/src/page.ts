// Turns web/index.html into the webview page: every local script and stylesheet the page
// names is pointed at its webview URI, and every script gets the CSP nonce, so a new file
// in web/ loads in VS Code without touching the extension. No vscode import, so it is
// tested with plain node.

/**
 * `uri` maps a file name in media/web to its webview URI. `config` becomes window.MONTY,
 * set just before app.js. `csp` is the Content-Security-Policy meta content.
 */
export function webviewPage(page: string, uri: (f: string) => string, nonce: string, config: Record<string, unknown>, csp: string): string {
  // Only bare relative names from our own page ("md.js", "vendor/x.js"): never a URL.
  const local = /^[\w.-]+(\/[\w.-]+)*$/;
  const monty = `<script nonce="${nonce}">window.MONTY = ${JSON.stringify(config).replace(/</g, '\\u003c')};</script>`;
  return page
    .replace(/<link rel="icon"[^>]*>/, '')
    .replace(/<link rel="stylesheet" href="([^"]+)">/g, (tag, f: string) => (local.test(f) ? `<link rel="stylesheet" href="${uri(f)}">` : ''))
    .replace(/<script src="([^"]+)"><\/script>/g, (tag, f: string) => {
      if (!local.test(f)) return '';
      const el = `<script nonce="${nonce}" src="${uri(f)}"></script>`;
      return f === 'app.js' ? monty + el : el;
    })
    .replace('<meta charset="utf-8">', `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`);
}
