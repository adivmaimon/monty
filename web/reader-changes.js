// "Changed since last look" for the readable view. Agents edit specs while you work; this
// keeps a copy of each spec as you last saw it and, on the next open, marks what changed,
// section by section.
//
// Two halves:
//   - pure functions (splitDoc, diffDoc, lineDiff) that take two markdown texts and say
//     what changed. No DOM, so test/changes.test.ts runs them in node.
//   - the reader glue (init, apply) that app.js calls after every render: marks, the
//     change bar, and the snapshot store.
//
// Snapshots are Monty's own state, never the repo's (read-only rule): localStorage on the
// panel's origin in a browser tab, the extension's globalStorage folder in VS Code (the
// webview asks the extension by message, see vscode/src/seen.ts).
(function () {
  const FENCE = /^\s*```/;
  const HEAD = /^(#{1,6})\s+(.*)$/;

  /**
   * Title, preamble and sections, grouped the way md.js groups them: by ##, or by ### when
   * the file has no ##; the first # is the title; headings inside code fences don't count.
   */
  function splitDoc(md) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const heads = new Map();
    let fenced = false;
    lines.forEach((l, i) => {
      if (FENCE.test(l)) { fenced = !fenced; return; }
      if (fenced) return;
      const h = HEAD.exec(l);
      if (h) heads.set(i, { level: h[1].length, title: h[2].trim() });
    });
    const levels = [...heads.values()].map((h) => h.level);
    const top = levels.includes(2) ? 2 : levels.includes(3) ? 3 : 2;
    let titleLine = -1;
    for (const [i, h] of heads) if (h.level === 1) { titleLine = i; break; }
    const out = { title: titleLine >= 0 ? heads.get(titleLine).title : '', preamble: [], sections: [] };
    let cur = null;
    lines.forEach((l, i) => {
      if (i === titleLine) return;
      const h = heads.get(i);
      if (h && h.level === top) { cur = { title: h.title, lines: [] }; out.sections.push(cur); return; }
      (cur ? cur.lines : out.preamble).push(l);
    });
    return out;
  }

  /** Lines that carry content: trailing space and blank lines don't count as changes. */
  const content = (lines) => lines.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());

  /** A heading as text: markdown marks gone, spaces collapsed. */
  const plain = (t) => String(t).replace(/[`*~]|__/g, '').replace(/\s+/g, ' ').trim();
  /** What sections are matched on: "Phase 2 - Engine - DONE (2026-11-06)" is still "phase 2 - engine". */
  const titleKey = (t) => plain(t).replace(/✅\s*/g, '').replace(/\s+[-—–]\s+(done|complete[d]?|shipped)\b.*$/i, '').toLowerCase();

  // Above this many cells (lines x lines) the LCS table costs more than it is worth; a
  // multiset difference is close enough for a section that long. 250k cells is a
  // 500-line section against another, a few milliseconds.
  const LCS_CELLS = 250000;

  /** Lines of `b` that are new against `a` (by longest common subsequence), and how many of `a` went. */
  function lineDiff(a, b) {
    if (a.length * b.length > LCS_CELLS) {
      const left = new Map();
      for (const l of a) left.set(l, (left.get(l) || 0) + 1);
      const added = [];
      for (const l of b) {
        const n = left.get(l) || 0;
        if (n) left.set(l, n - 1); else added.push(l);
      }
      let removed = 0;
      for (const n of left.values()) removed += n;
      return { added, removed };
    }
    const w = b.length + 1;
    const t = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    const added = [];
    let i = 0, j = 0, common = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; common++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else added.push(b[j++]);
    }
    while (j < b.length) added.push(b[j++]);
    return { added, removed: a.length - common };
  }

  /** Share of lines two bodies have in common, against the longer one. */
  function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    const { added } = lineDiff(a, b);
    return (b.length - added.length) / Math.max(a.length, b.length);
  }
  // A heading that changed name but kept most of its body is the same section renamed,
  // not one removed and one added. 60%: a rename plus a line or two edited still pairs up;
  // two different sections that share a stock line or two ("None.") do not.
  const RENAME_SIMILARITY = 0.6;

  // "**Status**: x" and "**Status:** x", alone or as one of "a | b" pairs (as app.js reads them).
  const META = /^\*\*([^*]{1,24}?):?\*\*\s*:?\s*(.{1,200})$/;
  function metaValue(lines, key) {
    for (const l of lines) {
      for (const part of l.trim().split(/\s+\|\s+/)) {
        const m = META.exec(part);
        if (m && m[1].trim().replace(/:$/, '').toLowerCase() === key) return m[2].replace(/\*\*/g, '').trim();
      }
    }
    return '';
  }
  const LEVEL = /^(low|medium|high|critical)(?:\s*[-/]\s*(low|medium|high|critical))?\b/i;
  /** Risk as a level: a "**Risk**:" line, else the first word of a Risk section ("**Medium.** The parser..."). */
  function riskOf(doc) {
    const meta = metaValue(doc.preamble, 'risk');
    if (meta) return (LEVEL.exec(meta) || [meta])[0];
    const sec = doc.sections.find((s) => /^risks?\b/.test(titleKey(s.title)));
    if (!sec) return '';
    const first = content(sec.lines)[0] || '';
    const m = LEVEL.exec(first.replace(/^[\s>*_-]+/, '').replace(/\*\*/g, ''));
    return m ? m[0] : '';
  }

  // Phase lines as src/projects.ts reads them: "### Phase 2 - x - DONE (date)", "- **Phase 2 - x**".
  const PHASE_LINE = /^\s*(?:#{2,6}\s*|[-*]\s+\*\*|\*\*)(?:✅\s*)?Phase\s+(\d+)\b(.*)$/i;
  // Upper case anywhere on the line; any case only as the line's last word ("- Done (date)"),
  // so a phase named "Complete the flow" is not done.
  const PHASE_DONE = [/\b(DONE|SHIPPED|COMPLETED?)\b(?!\s+when)|✅/, /[-—–(:]\s*(done|complete[d]?|shipped)\b\)?\s*(\(\d{4}-\d{2}-\d{2}\))?[\s.*]*$/i];
  /** Phase number -> done, from the phase lines' own markers. */
  function phaseMarks(md) {
    const out = new Map();
    let fenced = false;
    for (const l of String(md || '').replace(/\r/g, '').split('\n')) {
      if (FENCE.test(l)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const m = PHASE_LINE.exec(l);
      if (!m) continue;
      const n = Number(m[1]);
      out.set(n, out.get(n) || PHASE_DONE.some((r) => r.test(l)));
    }
    return out;
  }

  /**
   * What changed from `before` to `after`, or null when there is no `before` (first open).
   * sections: one entry per section of `after`, in order: kind same | added | edited | renamed,
   * `from` the old title of a renamed one, `added` its new lines.
   * removed: sections of `before` that are gone, with `after` the index of the section they
   * followed (-1: at the top).
   */
  function diffDoc(before, after) {
    if (before == null) return null;
    const a = splitDoc(before);
    const b = splitDoc(after);
    const match = new Array(b.sections.length).fill(-1);
    const taken = new Set();
    // Pass 1: same title, nth to nth, wherever it moved to. A move alone adds nothing to read.
    const byKey = new Map();
    a.sections.forEach((s, i) => {
      const k = titleKey(s.title);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(i);
    });
    b.sections.forEach((s, j) => {
      const list = byKey.get(titleKey(s.title));
      if (list && list.length) { match[j] = list.shift(); taken.add(match[j]); }
    });
    // Pass 2: renames, best pairs first.
    const renamed = new Set();
    const pairs = [];
    b.sections.forEach((s, j) => {
      if (match[j] >= 0) return;
      a.sections.forEach((o, i) => {
        if (taken.has(i)) return;
        const sim = similarity(content(o.lines), content(s.lines));
        if (sim >= RENAME_SIMILARITY) pairs.push([sim, i, j]);
      });
    });
    pairs.sort((x, y) => y[0] - x[0]);
    for (const [, i, j] of pairs) {
      if (taken.has(i) || match[j] >= 0) continue;
      match[j] = i;
      taken.add(i);
      renamed.add(j);
    }
    const sections = b.sections.map((s, j) => {
      const now = content(s.lines);
      if (match[j] < 0) return { title: s.title, kind: 'added', added: now, removed: 0 };
      const old = a.sections[match[j]];
      const d = lineDiff(content(old.lines), now);
      if (renamed.has(j)) return { title: s.title, kind: 'renamed', from: old.title, added: d.added, removed: d.removed };
      const kind = d.added.length || d.removed || plain(old.title) !== plain(s.title) ? 'edited' : 'same';
      return { title: s.title, kind, added: d.added, removed: d.removed };
    });
    // Where each removed section stood: after the nearest earlier old section still here.
    const whereNow = new Map();
    match.forEach((i, j) => { if (i >= 0) whereNow.set(i, j); });
    const removed = [];
    a.sections.forEach((s, i) => {
      if (taken.has(i)) return;
      let after = -1;
      for (let k = i - 1; k >= 0; k--) if (whereNow.has(k)) { after = whereNow.get(k); break; }
      removed.push({ title: s.title, after });
    });
    const pre = lineDiff(content(a.preamble), content(b.preamble));
    const preamble = { changed: plain(a.title) !== plain(b.title) || pre.added.length > 0 || pre.removed > 0, added: pre.added };
    const level = (from, to) => (from && to && from.toLowerCase() !== to.toLowerCase() ? { from, to } : null);
    const status = level(metaValue(a.preamble, 'status'), metaValue(b.preamble, 'status'));
    const risk = level(riskOf(a), riskOf(b));
    const was = phaseMarks(before);
    const phasesDone = [...phaseMarks(after)].filter(([n, done]) => done && was.has(n) && !was.get(n)).map(([n]) => n);
    const count = sections.filter((s) => s.kind !== 'same').length + removed.length + (preamble.changed ? 1 : 0);
    return { sections, removed, preamble, status, risk, phasesDone, count };
  }

  // ---------- snapshot store ----------
  // get() resolves to the text as last seen, null when never seen (first open: save it),
  // or undefined when storage can't be reached (then nothing is saved or marked).

  const KEY = 'monty.seen:';
  // The extension answers from disk in milliseconds; past this it is not going to.
  const SEEN_TIMEOUT_MS = 3000;
  let post = null; // set by init() in VS Code: messages go to the extension
  const waiting = new Map();

  function onMessage(m) {
    if (m && m.type === 'seen' && waiting.has(m.id)) {
      waiting.get(m.id)(typeof m.text === 'string' ? m.text : null);
      waiting.delete(m.id);
    }
  }

  const store = {
    get(file) {
      if (post) {
        return new Promise((resolve) => {
          const id = Math.random().toString(36).slice(2);
          waiting.set(id, resolve);
          post({ type: 'getSeen', file, id });
          setTimeout(() => { if (waiting.delete(id)) resolve(undefined); }, SEEN_TIMEOUT_MS);
        });
      }
      try {
        const raw = window.localStorage.getItem(KEY + file);
        if (raw == null) return Promise.resolve(null);
        const rec = JSON.parse(raw);
        return Promise.resolve(rec && typeof rec.text === 'string' ? rec.text : null);
      } catch {
        return Promise.resolve(undefined);
      }
    },
    set(file, text) {
      if (post) return post({ type: 'setSeen', file, text });
      const ls = (() => { try { return window.localStorage; } catch { return null; } })();
      if (!ls) return;
      const rec = JSON.stringify({ text, at: Date.now() });
      try {
        ls.setItem(KEY + file, rec);
      } catch {
        // Full: drop the oldest half of our own entries, then try once more.
        try {
          const ours = [];
          for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (k && k.startsWith(KEY) && k !== KEY + file) {
              let at = 0;
              try { at = JSON.parse(ls.getItem(k)).at || 0; } catch { /* unreadable: oldest */ }
              ours.push([at, k]);
            }
          }
          ours.sort((x, y) => x[0] - y[0]).slice(0, Math.ceil(ours.length / 2)).forEach(([, k]) => ls.removeItem(k));
          ls.setItem(KEY + file, rec);
        } catch { /* still no room: this spec just won't be marked next time */ }
      }
    },
  };

  /** VS Code: `post` sends a message to the extension; its replies arrive as window messages. */
  function init(opts) {
    post = (opts && opts.post) || null;
    if (post) window.addEventListener('message', (ev) => onMessage(ev.data));
  }

  window.MontyChanges = { splitDoc, diffDoc, lineDiff, titleKey, init, store };
})();
