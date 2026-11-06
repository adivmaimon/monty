// Hover previews in the reader. Hovering or focusing a file reference (`src/auth/session.ts:41`)
// shows about eight lines from that line, coloured, with Open; a link to another spec shows a
// card with its title, status, goal and progress. Clicking a link is unchanged.
//
// Lines come from the core's /api/excerpt (browser) or through the extension, which asks the
// core for them (VS Code webviews cannot fetch). Spec cards come from the plans the adapters
// already found (state.projects); a markdown file they don't know shows its own title and
// first lines. app.js shares its host bridge as window.MontyHost.
(function () {
  const host = () => window.MontyHost || {};
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // The brief's "about 300ms": long enough that moving the pointer across a paragraph opens nothing.
  const OPEN_MS = 300;
  // Grace for crossing the gap between the link and the popover.
  const CLOSE_MS = 200;
  // Excerpts are cached briefly: hovering back and forth should not re-read, but an agent editing the file should show.
  const CACHE_MS = 10_000;
  // The extension or core may be gone; the popover says so instead of waiting forever.
  const TIMEOUT_MS = 3000;
  const SEL = '#reader [data-open], #reader [data-doc]';
  const isDoc = (f) => /\.(md|mdc)$/i.test(f);

  let pop = null; // the popover element, appended to body so live re-renders of the doc leave it alone
  let cur = null; // { key, where, anchor }
  let openTimer = 0;
  let openKey = null; // the link a pending open is for
  let closeTimer = 0;
  let watch = 0;
  let dismissed = null; // key closed with Esc: stays closed until the pointer or focus moves on

  const keyOf = (a) => (a.dataset.doc ? 'd:' + a.dataset.doc : 'o:' + a.dataset.open + ':' + (a.dataset.line || ''));
  const whereOf = (a) => (a.closest('#docSide') ? 'side' : 'doc');

  function style() {
    if (document.getElementById('hv-style')) return;
    const s = document.createElement('style');
    s.id = 'hv-style';
    s.textContent = `
.hv{position:fixed;z-index:50;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 16px 40px rgba(0,0,0,.45);overflow:hidden;font-size:13px;line-height:1.5;color:var(--text)}
.hv-head{display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--line);font-size:12px}
.hv-head .hv-path{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hv-head a{color:var(--accent);text-decoration:none;margin-left:auto}.hv-head a:hover{text-decoration:underline}
.hv-code{background:var(--bg);padding:8px 0;font-size:12px;line-height:1.65;overflow:hidden}
.hv-code div{display:flex;white-space:pre}
.hv-code .n{flex:none;width:44px;text-align:right;padding-right:12px;color:var(--muted);opacity:.7;user-select:none}
.hv-code .t{overflow:hidden;text-overflow:ellipsis}
.hv-miss{padding:8px 12px;color:var(--muted);font-size:12px}
.hv-foot{padding:6px 12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hv-card{padding:14px;display:flex;flex-direction:column;gap:8px}
.hv-card .hv-title{display:flex;align-items:center;gap:8px}.hv-card .hv-title b{flex:1;font-size:14px;font-weight:650;min-width:0}
.hv-card .hv-goal{color:var(--soft);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.hv-card .hv-meta{color:var(--muted);font-size:12px}
.hv-segs{display:flex;gap:3px}.hv-segs span{flex:1;height:4px;border-radius:2px;background:var(--track)}.hv-segs .on{background:var(--accent)}.hv-segs .cur{background:var(--lilac);opacity:.5}
.hv-card.done .hv-segs .on{background:var(--ok)}
.k-kw{color:var(--orchid)}.k-fn{color:var(--lilac)}.k-num{color:var(--ok)}.k-str{color:var(--lilac-hi)}.k-const{color:var(--peri)}.k-com{color:var(--muted);font-style:italic}`;
    document.head.appendChild(s);
  }

  // ---------- data ----------

  const cache = new Map(); // key -> { at, data }
  const pending = new Map(); // request id -> resolve
  let listening = false;

  function excerpt(file, line) {
    const k = file + ':' + (line || '');
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
    const fail = { status: 'refused', reason: 'preview unavailable', lines: [] };
    const { vscode } = host();
    let req;
    if (vscode) {
      if (!listening) {
        listening = true;
        window.addEventListener('message', (ev) => {
          const m = ev.data;
          if (m && m.type === 'excerpt' && pending.has(m.id)) { pending.get(m.id)(m.data || fail); pending.delete(m.id); }
        });
      }
      req = new Promise((resolve) => {
        const id = 'x' + Math.random().toString(36).slice(2);
        pending.set(id, resolve);
        vscode.postMessage({ type: 'getExcerpt', file, line: line ? Number(line) : undefined, id });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(fail); } }, TIMEOUT_MS);
      });
    } else {
      req = fetch('/api/excerpt?file=' + encodeURIComponent(file) + (line ? '&line=' + encodeURIComponent(line) : ''))
        .then((r) => r.json())
        .catch(() => fail);
    }
    return req.then((data) => {
      if (data && data.status !== 'refused') cache.set(k, { at: Date.now(), data });
      return data || fail;
    });
  }

  const project = (file) => {
    const s = host().state && host().state();
    return s && (s.projects.find((p) => p.file === file) || s.projects.find((p) => p.docs && p.docs.includes(file)));
  };

  // Both hosts answer a missing doc with a sentence rather than an error (app.js fetchDoc, extension getDoc).
  const missingDoc = (file, text) => text === `I couldn't find ${file}, I'm afraid.` || text === `Could not open ${file}`;

  // ---------- syntax colouring ----------
  // A glance, not an editor: comments, strings, numbers, keywords, calls and CONSTANTS, line by line.

  const KW = new Set(('const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of interface type enum implements public private protected static readonly abstract declare namespace void delete yield ' +
    'def elif lambda pass with as is not and or global nonlocal raise except del None True False ' +
    'null undefined true false this self super nil ' +
    'func struct impl fn pub mut use mod crate trait match loop where package go defer select chan map range fallthrough guard protocol extension init deinit override final open internal fileprivate ' +
    'echo then fi esac done local export unset').split(' '));
  const HASH = /^(py|sh|bash|zsh|rb|yml|yaml|toml|r|pl|ex|exs|conf|ini|cfg|dockerfile|mk|makefile|cmake|tf|nix|ps1)$/i;
  const DASH = /^(sql|lua|hs|elm)$/i;

  function colour(lines, file) {
    const ext = (/\.([^./]+)$/.exec(file) || [, base(file)])[1] || '';
    const line = HASH.test(ext) ? '#' : DASH.test(ext) ? '--' : '//';
    const lc = line === '//' ? '\\/\\/' : line;
    const block = line === '//';
    const TOK = new RegExp(`(${lc}.*$${block ? '|\\/\\*.*?(?:\\*\\/|$)' : ''})|("(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|\`(?:\\\\.|[^\`\\\\])*\`?)|\\b(\\d[\\w.]*)\\b|([A-Za-z_$][\\w$]*)(?=\\s*\\()|([A-Za-z_$][\\w$]*)`, 'g');
    let inBlock = false;
    return lines.map((text) => {
      let out = '';
      let rest = text;
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end < 0) return `<span class="k-com">${esc(rest)}</span>`;
        out += `<span class="k-com">${esc(rest.slice(0, end + 2))}</span>`;
        rest = rest.slice(end + 2);
        inBlock = false;
      }
      let last = 0;
      rest.replace(TOK, (m, com, str, num, call, word, at) => {
        out += esc(rest.slice(last, at));
        last = at + m.length;
        if (com) {
          if (block && com.startsWith('/*') && !com.endsWith('*/')) inBlock = true;
          out += `<span class="k-com">${esc(com)}</span>`;
        } else if (str) out += `<span class="k-str">${esc(str)}</span>`;
        else if (num) out += `<span class="k-num">${esc(num)}</span>`;
        else if (call) out += KW.has(call) ? `<span class="k-kw">${esc(call)}</span>` : `<span class="k-fn">${esc(call)}</span>`;
        else if (KW.has(word)) out += `<span class="k-kw">${esc(word)}</span>`;
        else if (/^[A-Z][A-Z0-9_]{2,}$/.test(word)) out += `<span class="k-const">${esc(word)}</span>`;
        else out += esc(word);
        return m;
      });
      return out + esc(rest.slice(last));
    });
  }

  // ---------- content ----------

  const base = (p) => p.split('/').pop();
  function shortPath(abs) {
    const s = host().state && host().state();
    const repo = s && s.projects.map((p) => p.repoPath).filter((r) => abs.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
    return repo ? abs.slice(repo.length + 1) : abs.split('/').slice(-3).join('/');
  }

  async function fileHtml(file, line) {
    const ex = await excerpt(file, line);
    const head = `<div class="hv-head"><span class="mono hv-path" title="${esc(file)}">${esc(shortPath(file))}${line ? ':' + esc(line) : ''}</span><a href="#" data-hv-open tabindex="-1">Open</a></div>`;
    if (!ex || ex.status !== 'ok' || !ex.lines.length) {
      const why = !ex ? 'Preview unavailable.' : ex.status === 'missing' ? 'Not found.' : ex.status === 'past-end' ? `Line ${esc(line)} is past the end (${ex.total} lines).` : `No preview: ${esc(ex.reason || 'not available')}.`;
      return head + `<div class="hv-miss">${why}</div>`;
    }
    const coloured = colour(ex.lines.map((l) => l.text), file);
    const rows = ex.lines.map((l, i) => `<div><span class="n">${l.n}</span><span class="t">${coloured[i] || ' '}</span></div>`).join('');
    const by = ex.importedBy && ex.importedBy.length ? `<div class="hv-foot mono" title="From the Caddis map">Imported by ${ex.importedBy.map((f) => esc(base(f))).join(', ')}</div>` : '';
    return head + `<div class="hv-code mono">${rows}</div>` + by;
  }

  function segs(done, total, current) {
    if (total < 1) return '';
    const n = Math.min(total, 12);
    const on = total <= 12 ? done : Math.round((done / total) * n);
    return `<div class="hv-segs" role="img" aria-label="${done} of ${total} done">${Array.from({ length: n }, (_, i) => `<span class="${i < on ? 'on' : i === on && current ? 'cur' : ''}"></span>`).join('')}</div>`;
  }

  async function docHtml(file) {
    const md = window.MontyMD;
    const p = project(file);
    if (p) {
      const tag = p.status === 'completed' ? 'done' : p.status === 'active' ? 'working' : 'idle';
      const when = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      const meta = [p.label, when].filter(Boolean).map(esc).join(' · ');
      const bar = p.progress && p.progress.basis !== 'status' ? segs(p.progress.done, p.progress.total, p.status === 'active') : '';
      return `<div class="hv-card${p.status === 'completed' ? ' done' : ''}">
        <div class="hv-title"><b class="clamp1">${esc(p.name)}</b><span class="tag st-${tag}">${esc(p.status)}</span></div>
        ${p.goal ? `<div class="hv-goal">${md ? md.inline(p.goal, {}) : esc(p.goal)}</div>` : ''}
        ${bar}
        ${meta ? `<div class="hv-meta">${meta}</div>` : ''}
      </div>`;
    }
    // A markdown file no adapter tracks: its own title and opening lines.
    const fetchDoc = host().fetchDoc;
    const text = fetchDoc ? await fetchDoc(file).catch(() => null) : null;
    if (text == null || missingDoc(file, text)) return `<div class="hv-head"><span class="mono hv-path">${esc(shortPath(file))}</span></div><div class="hv-miss">Not found.</div>`;
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const title = (/^#\s+(.+)$/m.exec(body) || [])[1] || base(file).replace(/\.mdc?$/i, '');
    const para = body.split(/\n\s*\n/).map((b) => b.trim()).find((b) => b && !/^(#|```|\||[-*+]\s|\d+[.)]\s|>|\*\*[^*]+\*\*\s*:|<)/.test(b)) || '';
    return `<div class="hv-card">
      <div class="hv-title"><b class="clamp1">${md ? md.inline(title, {}) : esc(title)}</b></div>
      ${para ? `<div class="hv-goal">${md ? md.inline(para.replace(/\s+/g, ' ').slice(0, 400), {}) : esc(para)}</div>` : ''}
      <div class="hv-meta mono">${esc(shortPath(file))}</div>
    </div>`;
  }

  // ---------- open, place, close ----------

  function anchorNow() {
    if (!cur) return null;
    if (cur.anchor.isConnected) return cur.anchor;
    // The doc re-renders on every live update: find the same link in the new markup.
    const again = [...document.querySelectorAll(SEL)].find((a) => keyOf(a) === cur.key && whereOf(a) === cur.where);
    if (again) cur.anchor = again;
    return again || null;
  }

  function place() {
    const a = anchorNow();
    if (!pop || !a) return close();
    const r = a.getBoundingClientRect();
    if (!r.width && !r.height) return close(); // inside a collapsed section
    const w = Math.min(pop.dataset.kind === 'file' ? 500 : 400, window.innerWidth - 24);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
    const h = pop.offsetHeight;
    const below = r.bottom + 6;
    const above = r.top - 6 - h;
    pop.style.top = (below + h > window.innerHeight - 8 && above > 8 ? above : below) + 'px';
  }

  async function show(a) {
    const key = keyOf(a);
    style();
    cur = { key, where: whereOf(a), anchor: a };
    const file = a.dataset.doc || a.dataset.open;
    const kind = a.dataset.doc || isDoc(file) ? 'doc' : 'file';
    const html = kind === 'doc' ? await docHtml(file) : await fileHtml(file, a.dataset.line);
    if (!cur || cur.key !== key) return; // moved on while loading
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'hv';
      pop.id = 'hv-pop';
      pop.setAttribute('role', 'tooltip');
      document.body.appendChild(pop);
      pop.addEventListener('mouseenter', () => clearTimeout(closeTimer));
      pop.addEventListener('mouseleave', (e) => { if (!(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(SEL))) later(); });
      pop.addEventListener('click', (e) => {
        if (!e.target.closest('[data-hv-open]')) return;
        e.preventDefault();
        const target = anchorNow();
        close();
        if (target) target.click(); // the app's own click handler decides how to open it
      });
    }
    pop.dataset.kind = kind;
    pop.innerHTML = html;
    pop.hidden = false;
    const at = anchorNow();
    if (at) at.setAttribute('aria-describedby', 'hv-pop');
    place();
    clearInterval(watch);
    watch = setInterval(() => (anchorNow() ? place() : close()), 400);
  }

  function close() {
    clearTimeout(openTimer);
    openKey = null;
    clearTimeout(closeTimer);
    clearInterval(watch);
    if (cur && cur.anchor.isConnected) cur.anchor.removeAttribute('aria-describedby');
    cur = null;
    if (pop) pop.hidden = true;
  }

  function soon(a) {
    clearTimeout(closeTimer);
    const key = keyOf(a);
    if (dismissed === key) return;
    if (cur && cur.key === key && pop && !pop.hidden) { cur.anchor = a; return; }
    // Crossing from the link onto its own <code> must not restart the delay.
    if (openKey === key) return;
    clearTimeout(openTimer);
    openKey = key;
    openTimer = setTimeout(() => { openKey = null; show(a); }, OPEN_MS);
  }

  function later() {
    clearTimeout(openTimer);
    openKey = null;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, CLOSE_MS);
  }

  document.addEventListener('mouseover', (e) => {
    const a = e.target.closest && e.target.closest(SEL);
    if (a) soon(a);
  });
  document.addEventListener('mouseout', (e) => {
    const a = e.target.closest && e.target.closest(SEL);
    if (!a) return;
    const to = e.relatedTarget;
    if (to && to.closest && (to.closest('#hv-pop') || to.closest(SEL) === a)) return;
    if (dismissed === keyOf(a)) dismissed = null;
    later();
  });
  document.addEventListener('focusin', (e) => {
    const a = e.target.closest && e.target.closest(SEL);
    if (a) soon(a);
  });
  document.addEventListener('focusout', (e) => {
    const a = e.target.closest && e.target.closest(SEL);
    if (!a) return;
    if (dismissed === keyOf(a)) dismissed = null;
    later();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!cur && !openKey)) return;
    if (cur) dismissed = cur.key;
    const a = document.activeElement && document.activeElement.closest && document.activeElement.closest(SEL);
    if (a) dismissed = keyOf(a);
    close();
  });
  // Clicking goes where it always did; the preview gets out of the way.
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest(SEL)) close(); }, true);
  document.addEventListener('scroll', () => { if (cur) place(); }, true);
  window.addEventListener('resize', () => { if (cur) place(); });
})();
