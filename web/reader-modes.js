// The reader's Brief and Full modes (Raw stays in app.js). Brief: one screen of what
// matters now (title, status, risk, goal, a phase stepper, open questions you can answer,
// the spec's files). Full: the whole document, no collapsing, a table of contents that
// follows the scroll, and known sections drawn as components (Changes as a file tree,
// Phases as a stepper, Tests as rows, empty sections folded into one line).
//
// Any spec works from its headings, checkboxes and paths; /api/reader (src/reader.ts) adds
// the Risk level, questions, phase dates and commits, and which files changed. A part with
// nothing to show is left out, never drawn empty. Plain browser JS, no build step: it runs
// in the browser panel and in the VS Code webview, and test/reader-web.test.ts loads it in a vm.
(function () {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const MD = () => W.MontyMD;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------- parsing (pure, tested) ----------

  const HEADING = /^(#{1,6})\s+(.*)$/;
  const PHASE = /^(#{2,5})\s*(?:✅\s*)?Phase\s+(\d+)\b\s*[-—–:.]?\s*(.*)$/i;
  const DONE_DATE = /\b(?:DONE|COMPLETED?|SHIPPED)\b[^\n]*?(\d{4}-\d{2}-\d{2})/i;
  const PATH = /^(?:\.\/)?(?:[\w@+-][\w@.+-]*\/)+[\w@+()[\]{},-][\w@.+()[\]{},-]*\.[A-Za-z0-9]{1,6}(?::\d+[\d,-]*)?$/;
  const TEST = /(?:\.(?:test|spec)\.[A-Za-z0-9]+$)|(?:^|\/)(?:tests?|__tests__|spec)\//;

  /** Lines outside code fences, with their fence state, so a "## x" in a code block is not a heading. */
  function lineInfo(md) {
    let fence = false;
    return md.replace(/\r/g, '').split('\n').map((l) => {
      const isFence = /^\s*```/.test(l);
      if (isFence) fence = !fence;
      return { l, code: fence || isFence };
    });
  }

  /**
   * The doc as title, preamble and top-level sections, as raw markdown. Top level is h2,
   * or h3 for docs written without any h2 (the same rule as md.js).
   */
  function splitSections(md) {
    const info = lineInfo(md);
    const lv = (x) => { const h = !x.code && HEADING.exec(x.l.trim()); return h ? h[1].length : 0; };
    const top = info.some((x) => lv(x) === 2) ? 2 : info.some((x) => lv(x) === 3) ? 3 : 2;
    const out = { title: '', preamble: '', sections: [], level: top };
    const pre = [];
    let cur = null;
    for (const x of info) {
      const n = lv(x);
      if (n === 1 && !out.title && !cur) { out.title = HEADING.exec(x.l.trim())[2].trim(); continue; }
      if (n && n <= top && n > 1) {
        cur = { title: HEADING.exec(x.l.trim())[2].trim(), body: [] };
        out.sections.push(cur);
        continue;
      }
      (cur ? cur.body : pre).push(x.l);
    }
    out.preamble = pre.join('\n');
    out.sections = out.sections.map((s) => ({ title: s.title, body: s.body.join('\n').replace(/^\n+|\n+$/g, '') }));
    return out;
  }

  const plainTitle = (t) => String(t).replace(/[*_`]/g, '').replace(/\s*\(.*?\)\s*$/, '').replace(/[^\p{L}\p{N}\s&/-]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

  /** Which component a section heading gets; null renders as markdown. */
  function sectionKind(title) {
    const t = plainTitle(title).replace(/^\d+\s+/, '');
    if (/^goals?$/.test(t)) return 'goal';
    if (/^(changes|file changes|files|files changed|files to change)$/.test(t)) return 'changes';
    if (/^(phases|implementation phases|build phases)$/.test(t)) return 'phases';
    if (/^(tests?|testing|test plan)$/.test(t)) return 'tests';
    if (/^open questions?$/.test(t)) return 'questions';
    if (/^risks?$/.test(t)) return 'risk';
    return null;
  }

  /** A section that says nothing: "None", "N/A", "Skipped: <reason>". Returns its one-word value, or null. */
  function emptyValue(body) {
    const t = String(body ?? '').replace(/^\s*[-*]\s+/gm, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    // One short paragraph only: "None. Nothing to migrate." folds; a list or a table does not.
    if (t.length > 160 || /\n\s*\n/.test(String(body).trim()) || /^\s*\|/m.test(body)) return null;
    let m = /^skipped\b\s*[:.,-]?\s*(.*)$/i.exec(t);
    if (m) return { value: 'skipped', reason: m[1].replace(/\.$/, '') };
    m = /^(none|n\/a|not applicable)(?:\s+(?:touched|needed|yet|required))?\s*(?:[.:,;-]\s*(.*))?$/i.exec(t);
    if (m) return { value: /^none/i.test(m[1]) ? 'none' : 'n/a', reason: (m[2] || '').replace(/\.$/, '') };
    return null;
  }

  /** Sections in order, with every empty one folded into a single entry where the first stood. */
  function collapseEmpty(sections) {
    const out = [];
    let empties = null;
    sections.forEach((s, i) => {
      const e = emptyValue(s.body);
      if (!e) return out.push({ type: 'section', s, i });
      const item = { title: s.title, value: e.value, reason: e.reason, i };
      if (empties) empties.items.push(item);
      else out.push((empties = { type: 'empties', items: [item] }));
    });
    return out;
  }

  function phaseTitle(raw) {
    return String(raw).replace(/[*_`]/g, '')
      .replace(/\s*[-—–.,(]*\s*\b(DONE|COMPLETED?|SHIPPED)\b.*$/, '')
      .replace(/\s*[-—–]\s*(done|complete[d]?)\b.*$/i, '')
      .replace(/[\s:;,(+–—-]+$/, '').trim();
  }

  /** A Phases section's "### Phase N - name" blocks, each with its raw body. */
  function splitPhases(body) {
    const intro = [];
    const phases = [];
    let cur = null;
    for (const x of lineInfo(body)) {
      const m = !x.code && PHASE.exec(x.l.trim());
      if (m) {
        const d = DONE_DATE.exec(m[3]);
        cur = { n: Number(m[2]), title: phaseTitle(m[3]), date: d ? d[1] : '', marked: /\b(DONE|COMPLETED?|SHIPPED)\b/.test(m[3]), body: [] };
        phases.push(cur);
        continue;
      }
      (cur ? cur.body : intro).push(x.l);
    }
    return { intro: intro.join('\n').trim(), phases: phases.map((p) => ({ ...p, body: p.body.join('\n').trim() })) };
  }

  function cleanPath(p) {
    return p.replace(/^\.\//, '').replace(/:\d+([,-]\d+)*$/, '').replace(/[.,;:)]+$/, '');
  }
  function expandBraces(p) {
    const m = /^(.*)\{([^{}]+)\}(.*)$/.exec(p);
    return m ? m[2].split(',').map((x) => m[1] + x.trim() + m[3]) : [p];
  }
  function firstPath(text) {
    for (const m of String(text).matchAll(/`([^`]+)`/g)) if (PATH.test(m[1].trim())) return m[1].trim();
    const bare = /(?:^|\s)((?:[\w@.+-]+\/)+[\w@.+()[\]{},-]+\.[A-Za-z0-9]{1,6})/.exec(text);
    return bare ? bare[1] : '';
  }

  /** The Changes table (or list): one row per file, with what changes and whether it is new. */
  function changesRows(body) {
    const rows = [];
    const add = (cell, note) => {
      const p = firstPath(cell);
      if (!p) return;
      const isNew = /^\s*(\*\*)?new\b|\(new\)|\bnew file\b/i.test(note) || /\(new\)/i.test(cell);
      const text = note.replace(/^\s*(\*\*)?new(\*\*)?\b\s*[.:,-]?\s*/i, '').trim();
      for (const x of expandBraces(cleanPath(p))) if (!rows.some((r) => r.path === x)) rows.push({ path: x, note: text, isNew });
    };
    for (const l of String(body).split('\n')) {
      if (/^\s*\|/.test(l)) {
        if (/^\s*\|?\s*:?-{2,}/.test(l)) continue;
        const cells = l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|(?=(?:[^`]*`[^`]*`)*[^`]*$)/).map((c) => c.trim());
        if (cells.length < 2 || /^(file|path|files)$/i.test(cells[0].replace(/[*_`]/g, ''))) continue;
        add(cells[0], cells.slice(1).join(' · '));
        continue;
      }
      const b = /^\s*[-*]\s+(.*)$/.exec(l);
      if (b) {
        const p = firstPath(b[1]);
        if (p && b[1].indexOf(p) <= 2) add(b[1], b[1].replace(/`[^`]+`/, '').replace(/^\s*[-—–:]\s*/, ''));
      }
    }
    return rows;
  }

  /** Test files a Tests section names, each with the rest of its line. */
  function testFiles(body) {
    const out = [];
    for (const l of String(body).split('\n')) {
      for (const m of l.matchAll(/`([^`]+)`|(?:^|\s)((?:[\w@.+-]+\/)*[\w@.+-]+\.(?:test|spec)\.[A-Za-z0-9]+)/g)) {
        const p = cleanPath((m[1] || m[2] || '').trim());
        if (!p || !/\.[A-Za-z0-9]{1,6}$/.test(p) || !TEST.test(p) || /\s/.test(p)) continue;
        for (const x of expandBraces(p)) {
          if (out.some((t) => t.path === x)) continue;
          const note = l.replace(/^\s*[-*]\s+/, '').replace(m[0], '').replace(/^\s*[:\-—–,]\s*/, '').trim();
          out.push({ path: x, note });
        }
      }
    }
    return out;
  }

  /** "**Key**: value" lines above the first section, which read as chips rather than prose. */
  function metaLines(preamble) {
    const META = /^\*\*([^*]{1,24}?):?\*\*\s*:?\s*(.{1,120})$/;
    const meta = [];
    const rest = String(preamble).split('\n').filter((l) => {
      const parts = l.trim().split(/\s+\|\s+/);
      const pairs = parts.map((x) => /^\*\*[^*]+(:\*\*|\*\*\s*:)/.test(x) && META.exec(x)).filter(Boolean);
      if (!pairs.length || pairs.length !== parts.length) return true;
      for (const m of pairs) meta.push([m[1].replace(/:$/, ''), m[2].replace(/\*\*/g, '')]);
      return false;
    }).join('\n');
    return { meta, rest };
  }

  // ---------- host bridge ----------

  const host = { vscode: null, mode: '', reload: null };
  const MODE_KEY = 'monty.readerMode';
  const pendingReader = new Map();
  let reqId = 0;

  function init(opts) {
    host.vscode = opts.vscode || null;
    host.reload = opts.reload || null;
    host.rerender = opts.rerender || null;
    host.mode = opts.mode === 'brief' || opts.mode === 'full' ? opts.mode : '';
    if (!host.mode) {
      try { host.mode = W.localStorage.getItem(MODE_KEY) || ''; } catch { /* private window, no storage */ }
    }
    if (W.addEventListener) W.addEventListener('message', (ev) => {
      const m = ev.data || {};
      if ((m.type === 'reader' || m.type === 'answered') && pendingReader.has(m.id)) {
        pendingReader.get(m.id)(m.type === 'reader' ? m.data : m.result);
        pendingReader.delete(m.id);
      }
    });
  }

  /** The mode to show: the saved choice, but Brief only where there is a plan to brief. */
  function modeFor(hasProject) {
    if (host.mode === 'full' || !hasProject) return 'full';
    return 'brief';
  }
  function setMode(m) {
    host.mode = m;
    try { W.localStorage.setItem(MODE_KEY, m); } catch { /* not kept; still applies to this page */ }
    if (host.vscode) host.vscode.postMessage({ type: 'setReaderMode', mode: m });
  }

  function relay(type, payload) {
    return new Promise((resolve) => {
      const id = 'r' + ++reqId;
      pendingReader.set(id, resolve);
      host.vscode.postMessage({ type, id, ...payload });
      // The core may be gone; the reader still renders from the doc alone.
      setTimeout(() => { if (pendingReader.has(id)) { pendingReader.delete(id); resolve(null); } }, 8000);
    });
  }

  // Reader data, per file. Refetched when the doc changes or after REFRESH_MS, since
  // sessions keep editing the files a plan names.
  const REFRESH_MS = 10_000;
  const cache = new Map(); // file -> { at, data, loading }
  function readerFor(file, force) {
    const c = cache.get(file);
    const now = Date.now();
    if (c && (c.loading || (!force && now - c.at < REFRESH_MS))) return c.data;
    const entry = { at: now, data: c ? c.data : null, loading: true };
    cache.set(file, entry);
    const got = host.vscode
      ? relay('getReader', { file })
      : (typeof fetch === 'function' ? fetch('/api/reader?file=' + encodeURIComponent(file)).then((r) => (r.ok ? r.json() : null)).catch(() => null) : Promise.resolve(null));
    got.then((d) => {
      entry.loading = false;
      entry.at = Date.now();
      const changed = JSON.stringify(d) !== JSON.stringify(entry.data);
      entry.data = d;
      if (changed && host.rerender) host.rerender();
    });
    return entry.data;
  }

  function answer(body) {
    if (host.vscode) return relay('answer', { body });
    return fetch('/api/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json()).catch(() => ({ ok: false, error: 'Monty is not answering just now.' }));
  }

  // ---------- rendering ----------

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : ''; };
  const SOURCE = { openspec: 'openspec', 'spec-kit': 'spec kit', kiro: 'kiro' };
  const ICON = {
    done: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" class="ic-done"/><path d="M4.8 8.2l2.1 2.1 4.3-4.6" class="ic-tick"/></svg>',
    cur: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" class="ic-ring"/><circle cx="8" cy="8" r="2.5" class="ic-dot"/></svg>',
    todo: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" class="ic-todo"/></svg>',
  };

  function mdHtml(body, c) {
    if (!String(body).trim()) return '';
    const r = MD().render(body, c.mdCtx);
    const tag = /^###\s/m.test(body) ? 'h3' : 'h2';
    return r.preamble + r.sections.map((s) => `<${tag}>${MD().inline(s.title, c.mdCtx)}</${tag}>${s.html}`).join('');
  }

  /** Phases merged from the Project (done is its call), the doc's own headings, and /api/reader detail. */
  function phaseList(c) {
    const p = c.project;
    const details = new Map(((c.data && c.data.phases) || []).map((x) => [x.n, x]));
    const base = p && p.phases && p.phases.length ? p.phases : [];
    const list = base.map((ph) => ({ ...(details.get(ph.n) || { items: [] }), n: ph.n, title: ph.title || (details.get(ph.n) || {}).title || '', done: ph.done }));
    const cur = list.find((x) => !x.done);
    const live = !p || p.status === 'active' || p.status === 'pending';
    for (const x of list) x.state = x.done ? 'done' : x === cur && live ? 'cur' : 'todo';
    return list;
  }

  function commitTag(ph) {
    if (!ph.commit) return '';
    return `<span title="${esc(ph.commit.subject)} (matched to this phase by its DONE date, from Caddis-Plan trailers)">${esc(ph.commit.hash.slice(0, 7))}</span>`;
  }
  function phaseMeta(ph) {
    const parts = [];
    if (ph.date) parts.push(esc(day(ph.date)));
    if (ph.commit) parts.push(commitTag(ph));
    if (!parts.length && ph.items && ph.items.length) parts.push(`${ph.items.filter((i) => i.done).length} of ${ph.items.length}`);
    return parts.join(' · ');
  }
  const ITEMS_SHOWN = 6;
  function itemList(items, c) {
    if (!items || !items.length) return '';
    const shown = items.slice(0, ITEMS_SHOWN);
    return `<ul class="rm-items">${shown.map((i) => `<li class="${i.done ? 'done' : ''}"><span class="mk">${i.done ? '✓' : '○'}</span>${MD().inline(i.text, c.mdCtx)}</li>`).join('')}${items.length > ITEMS_SHOWN ? `<li class="more">+${items.length - ITEMS_SHOWN} more</li>` : ''}</ul>`;
  }

  // What each status means, for its tag's tooltip.
  const STATUS_TIP = {
    active: (n) => `In progress: this ${n} is being worked on now.`,
    pending: (n) => `Not started: this ${n} is written but no work has begun.`,
    completed: (n) => `Finished: all of this ${n}'s work is done.`,
    parked: (n) => `Parked: this ${n} is paused on purpose and nobody is working on it.`,
    cancelled: (n) => `Cancelled: this ${n} was dropped and won't be built.`,
  };

  function header(c, md, meta) {
    const p = c.project;
    const d = c.data;
    const pills = [];
    if (p) {
      const noun = SOURCE[p.source] ? 'spec' : 'plan';
      pills.push(`<span class="tag st-${p.status === 'completed' ? 'done' : p.status === 'active' ? 'working' : 'idle'}" tabindex="0" data-tip="${esc(STATUS_TIP[p.status] ? STATUS_TIP[p.status](noun) : `Status: ${p.status}.`)} From the ${noun}'s folder and its Status line.">${esc(p.status)}</span>`);
      if (d && d.risk) pills.push(`<span class="tag rm-risk rm-risk-${esc(d.risk.level.split('-').pop())}" tabindex="0" data-tip="Risk ${esc(d.risk.level)}, from the ${noun}'s Risk section: how likely this change is to break something, and so how carefully to review it.">risk ${esc(d.risk.level)}</span>`);
      if (SOURCE[p.source]) pills.push(`<span class="tag st-idle" tabindex="0" data-tip="A spec written with ${esc(SOURCE[p.source])}.">${esc(SOURCE[p.source])}</span>`);
      if (p.tasks && p.tasks.total && (!p.phases.length || SOURCE[p.source])) pills.push(`<span class="muted rm-count" tabindex="0" data-tip="Checkboxes ticked in the ${noun}.">${p.tasks.done} of ${p.tasks.total} tasks</span>`);
    } else if (c.kind) pills.push(`<span class="eyebrow">${esc(c.kind)}</span>`);
    const statusNote = p && p.statusText && !/^(active|pending|in progress|complete[d]?|done|planned|draft|parked|cancell?ed)\.?$/i.test(p.statusText.trim()) ? p.statusText : '';
    // Depends on is left to the Roadmap tile app.js adds under this card.
    const chips = (meta || []).filter(([k]) => !/^(status|phases?|type|reviewed|depends on|requires|blocked by)$/i.test(k.trim()));
    // One headline card; app.js adds a row of tiles (footprint, roadmap, blast radius) below it.
    return `<header class="rm-head">
      <div class="rm-main">
        ${pills.length ? `<div class="rm-pills">${pills.join('')}</div>` : ''}
        <h1>${esc(c.title)}</h1>
        ${c.goal ? `<p class="rm-goal">${MD().inline(c.goal, c.mdCtx)}</p>` : ''}
        ${statusNote || chips.length ? `<div class="rm-facts">${statusNote ? `<span class="rm-status" tabindex="0" data-tip="The ${p && SOURCE[p.source] ? 'spec' : 'plan'}'s own Status line, as written.">${MD().inline(statusNote, c.mdCtx)}</span>` : ''}${chips.map(([k, v]) => `<span><span class="rm-fk">${esc(k)}</span> ${esc(String(v).replace(/`/g, ''))}</span>`).join('')}</div>` : ''}
      </div>
    </header>`;
  }

  // Answers in progress: drafts of "Other" survive the page re-rendering on every live update.
  const ui = { other: new Set(), drafts: new Map(), busy: false, error: '', focus: null };

  function questionsHtml(c) {
    const qs = (c.data && c.data.questions) || [];
    if (!qs.length) return '';
    const file = c.data.questionsFile || c.file;
    const rows = qs.map((q) => {
      const key = file + '#' + q.index;
      let act;
      if (q.answer) {
        act = `<div class="rm-answered"><span>Answered: ${MD().inline(q.answer.text, c.mdCtx)}</span>${q.answer.undoable ? `<button class="rm-link" data-rm-undo="${esc(q.answer.line)}" data-rm-file="${esc(file)}">Undo</button>` : ''}</div>`;
      } else if (ui.other.has(key)) {
        act = `<div class="rm-acts"><input class="rm-input" data-rm-draft="${esc(key)}" maxlength="300" placeholder="Your answer"><button class="rm-primary" data-rm-save="${esc(key)}" data-rm-file="${esc(file)}" data-rm-i="${q.index}" data-rm-q="${esc(q.text)}">Save</button><button class="rm-link" data-rm-cancel="${esc(key)}">Cancel</button></div>`;
      } else {
        act = `<div class="rm-acts">${q.default ? `<button class="rm-primary clamp1" title="${esc(q.default)}" data-rm-answer="${esc(q.default)}" data-rm-file="${esc(file)}" data-rm-i="${q.index}" data-rm-q="${esc(q.text)}">${esc(q.default.length > 48 ? q.default.slice(0, 47) + '…' : q.default)}</button>` : ''}<button class="rm-ghost" data-rm-other="${esc(key)}">Other</button></div>`;
      }
      return `<div class="rm-q"><div class="rm-qt">${MD().inline(q.text, c.mdCtx)}</div>${q.detail ? `<div class="rm-qd">${MD().inline(q.detail, c.mdCtx)}</div>` : ''}${act}</div>`;
    }).join('');
    const err = ui.error ? `<div class="rm-err">${esc(ui.error)}</div>` : '';
    return `<div class="rm-qs" title="Answering writes a dated decision under the question in ${esc(file.split('/').pop())}">${rows}${err}</div>`;
  }

  /** Files the spec names, and which have changed; with the source of that judgement in the tooltip. */
  function fileFacts(c) {
    const files = (c.data && c.data.files) || [];
    const named = files.filter((f) => f.named);
    const outside = files.filter((f) => !f.named && f.changed);
    const since = c.data && c.data.since ? ` since ${day(c.data.since)}` : '';
    const basis = c.data && c.data.git ? `From git${since} and Monty's sessions` : "From Monty's sessions only (no git history here)";
    return { named, outside, changed: named.filter((f) => f.changed), basis };
  }

  function otherDocs(c) {
    const p = c.project;
    const others = p && p.docs ? p.docs.filter((f) => f !== c.file) : [];
    const dir = p ? p.file.replace(/\/[^/]*$/, '') : '';
    return others.map((f) => `<a class="mono" href="#" data-doc="${esc(f)}" title="${esc(f)}">${esc(f.startsWith(dir + '/') ? f.slice(dir.length + 1) : f.split('/').pop())}</a>`);
  }

  function renderBrief(c) {
    const phases = phaseList(c);
    const doneN = phases.filter((ph) => ph.state === 'done').length;
    const STEP_TIP = { done: 'Done: its gate passed.', cur: 'Current: the phase being worked on now.', todo: 'Not started yet.' };
    const stepper = phases.length ? `<section class="rm-phases"><div class="rm-phases-h"><span class="lbl">Phases</span><span class="muted rm-count" tabindex="0" data-tip="From the phase headings: a phase is done when its heading is marked DONE.">${doneN} of ${phases.length} done</span></div>
      <div class="rm-steps">${phases.map((ph) => `
      <div class="rm-step ${ph.state}">
        <div class="rm-rail"><span tabindex="0" data-tip="Phase ${ph.n}. ${STEP_TIP[ph.state] || ''}">${ICON[ph.state]}</span><span class="rm-line"></span></div>
        <div class="rm-pn">Phase ${ph.n}</div>
        <div class="rm-st">${esc(ph.title || 'Phase ' + ph.n)}</div>
        ${ph.state === 'cur' ? (ph.items && ph.items.length ? itemList(ph.items, c) : ph.gate ? `<div class="rm-gate"><span class="muted">Gate:</span> ${MD().inline(ph.gate, c.mdCtx)}</div>` : '') : phaseMeta(ph) ? `<div class="rm-sm mono">${phaseMeta(ph)}</div>` : ''}
      </div>`).join('')}</div></section>` : '';
    const p = c.project;
    const tasks = !phases.length && p && p.tasks && p.tasks.total ? `<div class="rm-strip rm-tasks" role="img" aria-label="${p.tasks.done} of ${p.tasks.total} tasks done">${Array.from({ length: Math.min(p.tasks.total, 24) }, (_, i) => `<span class="${i < Math.round((p.tasks.done / p.tasks.total) * Math.min(p.tasks.total, 24)) ? 'on' : ''}"></span>`).join('')}</div>` : '';
    const qs = questionsHtml(c);
    const docs = otherDocs(c);
    const lower = [
      qs ? `<div class="rm-col rm-col-q"><div class="lbl rm-lbl-q">Open questions</div>${qs}</div>` : '',
    ].filter(Boolean);
    return `<div class="rm-brief">
      ${header(c)}
      ${stepper}${tasks}
      ${lower.length ? `<div class="rm-lower">${lower.join('')}</div>` : ''}
      ${docs.length ? `<div class="rm-docs"><span class="lbl">Also in this ${p.source === 'openspec' ? 'change' : 'spec'}</span>${docs.join('')}</div>` : ''}
    </div>`;
  }

  function changesHtml(body, c) {
    const rows = changesRows(body);
    if (!rows.length) return null;
    const facts = new Map(((c.data && c.data.files) || []).map((f) => [f.path, f]));
    const all = rows.map((r) => ({ ...r, fact: facts.get(r.path), outside: false }));
    for (const f of facts.values()) if (!f.named && f.changed && !all.some((r) => r.path === f.path)) all.push({ path: f.path, note: 'changed, not in plan', isNew: !!f.isNew, fact: f, outside: true });
    const groups = new Map();
    for (const r of all) {
      const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/') + 1) : './';
      groups.set(dir, [...(groups.get(dir) || []), r]);
    }
    const known = !!(c.data && c.data.files);
    const tree = [...groups].map(([dir, rs]) => `<div class="rm-dir">${esc(dir)}</div>${rs.map((r) => {
      const dot = r.outside ? 'out' : r.fact && r.fact.changed ? 'on' : known ? 'todo' : 'unk';
      const isNew = r.isNew || (r.fact && r.fact.isNew);
      return `<div class="rm-frow${r.outside ? ' out' : ''}"><span class="rm-dot ${dot}"></span><a href="#" data-open="${esc(c.repoPath + '/' + r.path)}">${esc(r.path.slice(r.path.lastIndexOf('/') + 1))}${isNew ? ' <span class="rm-new" title="New file">+</span>' : ''}</a><span class="rm-note">${MD().inline(r.note, c.mdCtx)}</span></div>`;
    }).join('')}`).join('');
    const done = all.filter((r) => !r.outside && r.fact && r.fact.changed).length;
    const count = known ? `<span class="rm-sub" title="${esc(fileFacts(c).basis)}">${done} of ${rows.length} done</span>` : '';
    return { count, html: `<div class="rm-tree mono">${tree}</div>` };
  }

  function phasesHtml(body, c, open) {
    const { intro, phases } = splitPhases(body);
    if (!phases.length) return null;
    const pl = new Map(phaseList(c).map((x) => [x.n, x]));
    const anyCur = [...pl.values()].some((x) => x.state === 'cur');
    let curSeen = false;
    const steps = phases.map((ph, k) => {
      const known = pl.get(ph.n);
      let state = known ? known.state : ph.marked ? 'done' : 'todo';
      if (!known && !anyCur && state === 'todo' && !curSeen) { state = 'cur'; curSeen = true; }
      const meta = phaseMeta({ ...(known || {}), date: (known && known.date) || ph.date, items: [] });
      const key = c.file + '#ph' + ph.n;
      const isOpen = open.has(key) ? open.get(key) : state === 'cur';
      return `<details class="rm-vstep ${state}" data-rm-ph="${esc(key)}"${isOpen ? ' open' : ''}${k === phases.length - 1 ? ' data-last' : ''}>
        <summary><span class="rm-rail">${ICON[state]}</span><span class="rm-st">${esc(ph.title || 'Phase ' + ph.n)}</span>${meta ? `<span class="rm-sm mono">${meta}</span>` : ''}</summary>
        <div class="rm-pbody in">${mdHtml(ph.body, c)}</div>
      </details>`;
    }).join('');
    return { html: `${intro ? `<div class="in">${mdHtml(intro, c)}</div>` : ''}<div class="rm-vsteps">${steps}</div>` };
  }

  function testsHtml(body, c) {
    const rows = testFiles(body);
    if (!rows.length) return null;
    const known = new Map(((c.data && c.data.tests) || []).map((t) => [t.path, t]));
    const sessions = (c.state && c.state.sessions) || [];
    const ran = c.project ? sessions.find((s) => s.lastTest && s.plan && s.plan.file === c.project.file) : null;
    const list = rows.map((t) => {
      const k = known.get(t.path);
      return `<div class="rm-trow"><a href="#" class="ref" data-open="${esc(c.repoPath + '/' + t.path)}"><code>${esc(t.path)}</code></a><span class="rm-note">${MD().inline(t.note, c.mdCtx)}</span>${k && !k.exists ? '<span class="rm-tres muted">not written</span>' : ''}</div>`;
    }).join('');
    const last = ran ? `<div class="rm-lastrun ${ran.lastTest.ok ? 'ok' : 'bad'}">Last run in a session on this plan: ${esc(ran.lastTest.summary)}</div>` : '';
    // Anything else the section says (commands, notes) stays below the rows.
    const rest = String(body).split('\n').filter((l) => !rows.some((t) => l.includes(t.path))).join('\n');
    return { html: `<div class="rm-tests">${list}</div>${last}${rest.trim() ? `<div class="in">${mdHtml(rest, c)}</div>` : ''}` };
  }

  const phaseOpen = new Map();

  function renderFull(c, doc) {
    const entries = collapseEmpty(doc.sections);
    const toc = [];
    const parts = entries.map((e) => {
      if (e.type === 'empties') {
        return `<div class="rm-empties">${e.items.map((x) => `<span title="${esc(x.reason || '')}"><span class="rm-ek">${esc(x.title.replace(/[*_`]/g, ''))}</span> ${esc(x.value)}</span>`).join('')}</div>`;
      }
      const { s, i } = e;
      const kind = sectionKind(s.title);
      if (kind === 'goal' && c.goal && !/\n\s*\n|^\s*[-*|]/m.test(s.body.trim())) return '';
      let comp = null;
      if (kind === 'changes') comp = changesHtml(s.body, c);
      else if (kind === 'phases') comp = phasesHtml(s.body, c, phaseOpen);
      else if (kind === 'tests') comp = testsHtml(s.body, c);
      else if (kind === 'questions') { const q = questionsHtml(c); if (q) comp = { html: q }; }
      toc.push(`<a href="#" data-rm-toc="${i}">${esc(s.title.replace(/[`*]|__/g, ''))}</a>`);
      return `<section class="rm-sec" data-rm-sec="${i}" id="rm-sec-${i}"><div class="rm-h2"><h2>${MD().inline(s.title, c.mdCtx)}</h2>${comp && comp.count ? comp.count : ''}</div>${comp ? comp.html : `<div class="in">${mdHtml(s.body, c)}</div>`}</section>`;
    }).join('');
    const pre = mdHtml(doc.preambleRest || '', c);
    const docs = otherDocs(c);
    const side = (toc.length > 1 ? `<nav class="rm-toc" aria-label="Sections">${toc.join('')}</nav>` : '')
      + (docs.length ? `<div class="rm-tocdocs"><div class="lbl">In this ${c.project.source === 'openspec' ? 'change' : 'spec'}</div>${docs.join('')}</div>` : '');
    return { doc: `<div class="rm-full">${header(c, null, doc.meta)}${pre ? `<div class="in">${pre}</div>` : ''}${parts}</div>`, side };
  }

  /**
   * ctx: { md, file, project, state, mode, frontmatter, nameFromPath, docKind }.
   * Returns { mode, doc, side } as HTML for #doc and #docSide.
   */
  function render(ctx) {
    const { data: fm, body: text } = ctx.frontmatter ? ctx.frontmatter(ctx.md) : { data: {}, body: ctx.md };
    const p = ctx.project || null;
    const repoPath = p ? p.repoPath : ctx.file.replace(/\/\.claude\/.*$|\/\.caddis\/.*$|\/openspec\/.*$|\/specs\/.*$|\/\.kiro\/.*$/, '');
    const doc = splitSections(text);
    const { meta, rest } = metaLines(doc.preamble);
    for (const [k, v] of Object.entries(fm)) if (k !== 'name' && k !== 'description' && k !== 'title' && v) meta.push([k, v]);
    doc.meta = meta;
    doc.preambleRest = rest;
    const slug = /^[a-z0-9]+(-[a-z0-9]+)+$/;
    // Spec frameworks head every file with its kind ("Tasks: Photo Tags"); the adapter's name is the work's.
    const title = p && SOURCE[p.source] ? p.name : doc.title && !slug.test(doc.title) ? doc.title : (p && p.name) || fm.name || fm.title || doc.title || (ctx.nameFromPath ? ctx.nameFromPath(ctx.file) : ctx.file);
    const c = {
      file: ctx.file, project: p, state: ctx.state, repoPath, title,
      goal: (p && p.goal) || fm.description || '',
      kind: !p && ctx.docKind ? ctx.docKind(ctx.file) : '',
      data: !p ? null : ctx.data !== undefined ? ctx.data : readerFor(p.file, false),
      mdCtx: { repoPath, docDir: ctx.file.replace(/\/[^/]*$/, '') },
    };
    const mode = ctx.mode || modeFor(!!p);
    if (mode === 'brief' && p) return { mode, doc: renderBrief(c), side: '' };
    return { mode: 'full', ...renderFull(c, doc) };
  }

  // ---------- behaviour ----------

  let spy = null;
  /** Scroll-spy and focus restore, after each render. `scroller` is the reader's scroll container. */
  function wire(scroller) {
    // Drafts go back in after the HTML, so typing does not change the page's markup.
    scroller.querySelectorAll('[data-rm-draft]').forEach((el) => { el.value = ui.drafts.get(el.dataset.rmDraft) || ''; });
    if (ui.focus) {
      const el = scroller.querySelector(`[data-rm-draft="${CSS.escape(ui.focus)}"]`);
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
    scroller.querySelectorAll('details[data-rm-ph]').forEach((d) => (d.ontoggle = () => phaseOpen.set(d.dataset.rmPh, d.open)));
    if (spy) spy.disconnect();
    const secs = [...scroller.querySelectorAll('[data-rm-sec]')];
    if (!secs.length || typeof IntersectionObserver === 'undefined') return;
    const mark = (i) => scroller.querySelectorAll('[data-rm-toc]').forEach((a) => a.classList.toggle('on', a.dataset.rmToc === String(i)));
    const seen = new Map();
    // A section counts as current while its top is in the upper part of the view.
    spy = new IntersectionObserver((es) => {
      for (const e of es) seen.set(e.target.dataset.rmSec, e.isIntersecting);
      const first = secs.find((s) => seen.get(s.dataset.rmSec));
      if (first) mark(first.dataset.rmSec);
    }, { root: scroller, rootMargin: '-10% 0px -55% 0px' });
    secs.forEach((s) => spy.observe(s));
    mark(secs[0].dataset.rmSec);
  }

  async function send(body) {
    if (ui.busy) return;
    ui.busy = true;
    ui.error = '';
    const r = await answer(body);
    ui.busy = false;
    if (!r || !r.ok) ui.error = (r && r.error) || 'Monty is not answering just now.';
    // The doc changed on disk: fetch it and the questions again.
    for (const k of cache.keys()) cache.get(k).at = 0;
    if (host.reload) host.reload();
    else if (host.rerender) host.rerender();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('[data-rm-toc],[data-rm-answer],[data-rm-other],[data-rm-cancel],[data-rm-save],[data-rm-undo]');
      if (!t) return;
      e.preventDefault();
      const d = t.dataset;
      if (d.rmToc !== undefined) {
        const s = document.getElementById('rm-sec-' + d.rmToc);
        if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (d.rmOther) { ui.other.add(d.rmOther); ui.focus = d.rmOther; return host.rerender && host.rerender(); }
      if (d.rmCancel) { ui.other.delete(d.rmCancel); ui.drafts.delete(d.rmCancel); ui.focus = null; return host.rerender && host.rerender(); }
      if (d.rmAnswer) return send({ file: d.rmFile, index: Number(d.rmI), question: d.rmQ, answer: d.rmAnswer });
      if (d.rmSave) {
        const v = (ui.drafts.get(d.rmSave) || '').trim();
        if (!v) return;
        ui.other.delete(d.rmSave);
        ui.drafts.delete(d.rmSave);
        ui.focus = null;
        return send({ file: d.rmFile, index: Number(d.rmI), question: d.rmQ, answer: v });
      }
      if (d.rmUndo) return send({ file: d.rmFile, undo: d.rmUndo });
    });
    document.addEventListener('input', (e) => {
      const k = e.target.dataset && e.target.dataset.rmDraft;
      if (k) { ui.drafts.set(k, e.target.value); ui.focus = k; }
    });
    document.addEventListener('keydown', (e) => {
      const k = e.target.dataset && e.target.dataset.rmDraft;
      if (!k) return;
      if (e.key === 'Enter') { const b = document.querySelector(`[data-rm-save="${CSS.escape(k)}"]`); if (b) b.click(); }
      if (e.key === 'Escape') { const b = document.querySelector(`[data-rm-cancel="${CSS.escape(k)}"]`); if (b) b.click(); }
    });
    // A re-render removes the input; only a real move elsewhere ends the focus.
    document.addEventListener('focusout', (e) => { if (e.target.dataset && e.target.dataset.rmDraft && e.target.isConnected) ui.focus = null; });
  }

  W.MontyReader = { splitSections, sectionKind, emptyValue, collapseEmpty, splitPhases, changesRows, testFiles, metaLines, render, wire, init, modeFor, setMode, readerFor };
})();
