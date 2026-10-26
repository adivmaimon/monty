// Small markdown renderer for plan and spec files. Covers what the plans actually
// use: headings, paragraphs, lists with checkboxes, tables, code, quotes, bold,
// italics, links. File references in code spans (`app/(tabs)/scan.tsx:41,79-91`)
// become vscode:// links into the repo. Mermaid blocks are drawn by app.js.
(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const FILE_REF = /^([\w@.\-()[\]~+]+\/)*[\w@.\-()[\]+]+\.[a-zA-Z0-9]{1,6}(:\d+([,-]\d+)*)?$/;

  function refLink(code, repoPath) {
    if (!repoPath || !FILE_REF.test(code) || !(code.includes('/') || /:\d/.test(code))) return null;
    const [p, lines] = code.split(':');
    const line = lines ? lines.split(/[,-]/)[0] : '';
    // app.js turns data-open into "open in a new editor tab" (VS Code) or a vscode:// link (browser).
    return `<a class="ref" href="#" data-open="${esc(repoPath + '/' + p)}" data-line="${line}" title="Open ${esc(p)}"><code>${esc(code)}</code></a>`;
  }

  /** "../active/y.md" against the doc's folder: plain path arithmetic, no URL parsing. */
  function resolve(dir, rel) {
    const parts = (rel.startsWith('/') ? '' : dir).split('/');
    for (const seg of rel.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/').replace(/^(?!\/)/, '/');
  }

  function link(t, u, ctx) {
    if (/^(https?:|#|vscode:|mailto:)/.test(u)) return `<a href="${u}">${t}</a>`;
    // A link to another file in the repo: markdown opens in the readable view, the rest in the editor.
    const dir = ctx.docDir || ctx.repoPath;
    if (!dir) return `<a href="#">${t}</a>`;
    const [file, frag] = u.split('#');
    if (!file) return `<a href="#${frag ?? ''}">${t}</a>`;
    const abs = resolve(dir, decodeURIComponent(file));
    return /\.md$/i.test(abs) ? `<a href="#" data-doc="${abs}">${t}</a>` : `<a href="#" data-open="${abs}" data-line="">${t}</a>`;
  }

  function inline(text, ctx) {
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (_, c) => {
      codes.push(refLink(c, ctx.repoPath) || `<code>${esc(c)}</code>`);
      if (ctx.refs && FILE_REF.test(c) && c.includes('/')) ctx.refs.add(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = esc(s)
      // One level of parentheses inside the URL: wikipedia.org/wiki/Foo_(bar).
      .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, t, u) => link(t, u, ctx))
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])__([^_]+)__(?=[\s.,;:)]|$)/g, '$1<strong>$2</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s.,;:)]|$)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  }

  const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

  function itemHtml(it, ctx) {
    const cb = /^\[([ xX~-])\]\s*(.*)$/.exec(it.text);
    const extra = it.extra || '';
    if (!cb) return `<li>${inline(it.text, ctx)}${extra}${it.kids}`;
    const done = cb[1] === 'x' || cb[1] === 'X';
    return `<li class="cb">${done ? '✅' : '⬜'} ${done ? `<span class="muted">${inline(cb[2], ctx)}</span>` : inline(cb[2], ctx)}${extra}${it.kids}`;
  }

  /** Items deeper than the first one's indent nest under the item before them, as their own list. */
  function listHtml(items, ctx) {
    if (!items.length) return '';
    const base = items[0].indent;
    const top = [];
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.indent > base && top.length) top[top.length - 1].sub.push(it);
      else top.push({ ...it, sub: [] });
    }
    const ordered = top[0].ordered;
    const start = ordered && top[0].num !== 1 ? ` start="${top[0].num}"` : '';
    const li = top.map((it) => itemHtml({ ...it, kids: listHtml(it.sub, ctx) }, ctx) + '</li>');
    return `<${ordered ? 'ol' : 'ul'}${start}>${li.join('')}</${ordered ? 'ol' : 'ul'}>`;
  }

  function render(md, ctx) {
    const lines = md.replace(/\r/g, '').split('\n');
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      let l = lines[i];
      if (/^\s*```/.test(l)) {
        const lang = l.trim().slice(3);
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        i++;
        blocks.push({ html: `<pre data-lang="${esc(lang)}"><code>${esc(body.join('\n'))}</code></pre>` });
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(l);
      if (h) {
        blocks.push({ level: h[1].length, title: h[2].trim(), html: `<h${h[1].length}>${inline(h[2], ctx)}</h${h[1].length}>` });
        i++;
        continue;
      }
      if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        // Split on pipes outside code spans: `a || b` is one cell. "\|" is a literal pipe.
        const cells = (r) => {
          const out = [''];
          let code = false;
          const t = r.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
          for (let k = 0; k < t.length; k++) {
            const ch = t[k];
            if (ch === '\\' && t[k + 1] === '|') { out[out.length - 1] += '|'; k++; continue; }
            if (ch === '`') code = !code;
            if (ch === '|' && !code) out.push('');
            else out[out.length - 1] += ch;
          }
          return out.map((c) => c.trim());
        };
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        blocks.push({ html: `<table><thead><tr>${head.map((c) => `<th>${inline(c, ctx)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table>` });
        continue;
      }
      if (LIST_ITEM.test(l)) {
        // A list runs on across blank lines while the next line is another item or an
        // indented continuation: "1. a" / blank / "2. b" is one list, not two lists of one.
        const items = [];
        while (i < lines.length) {
          const cur = lines[i];
          const m = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(cur);
          if (m) {
            items.push({ indent: m[1].length, ordered: m[3] !== undefined, num: Number(m[3] || 1), text: m[4] });
            i++;
            continue;
          }
          // A code fence inside an item stays a code block under it, not text run into the item.
          if (items.length && /^\s*```/.test(cur) && /^\s+/.test(cur)) {
            const body = [];
            const fenceIndent = /^(\s*)/.exec(cur)[1].length;
            i++;
            while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++].slice(fenceIndent));
            i++;
            const last = items[items.length - 1];
            last.extra = (last.extra || '') + `<pre><code>${esc(body.join('\n'))}</code></pre>`;
            continue;
          }
          if (items.length && /^\s{2,}\S/.test(cur)) {
            items[items.length - 1].text += ' ' + cur.trim();
            i++;
            continue;
          }
          // A lazy continuation: wrapped text with no indent, straight after the item.
          if (items.length && cur.trim() && lines[i - 1].trim() && !/^(#{1,6}\s|\s*```|\s*\||\s*>|\s*(---|\*\*\*)\s*$)/.test(cur)) {
            items[items.length - 1].text += ' ' + cur.trim();
            i++;
            continue;
          }
          if (items.length && !cur.trim()) {
            let j = i;
            while (j < lines.length && !lines[j].trim()) j++;
            if (j < lines.length && (LIST_ITEM.test(lines[j]) || /^\s{2,}\S/.test(lines[j]))) { i = j; continue; }
          }
          break;
        }
        blocks.push({ html: listHtml(items, ctx) });
        continue;
      }
      if (/^\s*>/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        const inner = render(q.join('\n'), ctx);
        blocks.push({ html: `<blockquote>${inner.preamble}${inner.sections.map((s) => s.html).join('')}</blockquote>` });
        continue;
      }
      if (/^\s*(---|\*\*\*)\s*$/.test(l)) { i++; continue; }
      if (!l.trim()) { i++; continue; }
      // The first line always belongs to the paragraph: it matched no other block above.
      // Without that, a line no block takes (a "| a | b |" row with no separator under it)
      // stopped this loop before it read anything, and the renderer spun forever.
      const para = [lines[i++]];
      // A rule under a paragraph ends it; plans use "---" as a divider, not a setext heading.
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*\||\s*([-*+]|\d+[.)])\s+|\s*>|\s*(---|\*\*\*)\s*$)/.test(lines[i])) para.push(lines[i++]);
      blocks.push({ html: `<p>${inline(para.join(' '), ctx)}</p>` });
    }
    // Group by h2 into collapsible sections; everything before the first h2 is the preamble.
    const out = { title: '', preamble: '', sections: [] };
    let cur = null;
    for (const b of blocks) {
      if (b.level === 1 && !out.title) { out.title = b.title; continue; }
      if (b.level === 2) { cur = { title: b.title, html: '' }; out.sections.push(cur); continue; }
      if (cur) cur.html += b.html; else out.preamble += b.html;
    }
    return out;
  }

  window.MontyMD = { render, inline, esc };
})();
