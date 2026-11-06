// Plans per file: the repo view of plan history (GET /api/history, src/history.ts).
// Folders as boxes, each file a chip shaded by how many plans changed it in a time window;
// click a chip for those plans, newest first, each opening in the readable view.
// Loaded before app.js, which calls MontyHistory.update() on each render in full mode.
// Self-contained (own fetch, own styles) so it can sit beside other repo views.
(function () {
  // Commits land minutes apart; refetching more often only re-reads the same index.
  const REFETCH_MS = 30_000;
  const WINDOWS = [['30', '30 days', 30], ['90', '90 days', 90], ['all', 'All', 0]];
  // Five shades, as the mock: 0, 1, 2, 3 to 6, 7 or more plans.
  const level = (n) => (n <= 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n < 7 ? 3 : 4);
  let data = null;
  let repo = '';
  let fetchedAt = 0;
  let loading = false;
  let win = '90';
  let sel = '';
  let el = null;
  let ctx = { esc: (s) => String(s), vscode: null };
  let lastHtml = '';
  const pending = new Map();

  const style = document.createElement('style');
  style.textContent = `
#history:empty{display:none}
.hist .hist-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.hist .hist-h h2{margin:0}
.hist .legend{display:flex;gap:2px;align-items:center;font-size:11px;color:var(--muted)}
.hist .legend i{width:16px;height:8px;display:inline-block}
.hist .hist-body{display:flex;gap:16px;align-items:flex-start}
.hist .areas{flex:1;display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.hist .area{background:var(--card);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:150px}
.hist .area>span{font-size:11.5px;color:var(--muted)}
.hist .chips{display:flex;flex-wrap:wrap;gap:3px;align-content:flex-start}
.hist .chips button{height:16px;border:0;padding:0;border-radius:3px;cursor:pointer}
.hist .chips button[aria-current=true]{outline:2px solid var(--text);outline-offset:1px}
.hist .h0{background:var(--track)}.hist .h1{background:#3b2f5c}.hist .h2{background:#5a45a0}.hist .h3{background:#8b5cf6}.hist .h4{background:#c4b5fd}
body.vscode-light .hist .h1{background:rgba(139,92,246,.25)}body.vscode-light .hist .h2{background:rgba(139,92,246,.45)}body.vscode-light .hist .h3{background:rgba(139,92,246,.7)}body.vscode-light .hist .h4{background:#6d28d9}
.hist .hside{width:260px;flex:0 0 auto;display:flex;flex-direction:column;gap:6px;min-width:0}
.hist .hside .p{display:flex;gap:8px;font-size:12.5px;color:var(--text);text-decoration:none}
.hist .hside .p:hover{color:var(--lilac)}
.hist .hside .p span:first-child{flex:1;min-width:0}
.hist .note{font-size:11px;margin-top:10px}
.hist .more{font-size:11px;color:var(--muted)}
@media (max-width:640px){.hist .hist-body{flex-direction:column}.hist .hside{width:100%}}`;
  document.head.appendChild(style);

  function fetchData() {
    if (loading || !repo) return;
    loading = true;
    const want = repo;
    const done = (h) => {
      loading = false;
      fetchedAt = Date.now();
      if (want !== repo) return;
      data = h && h.files ? h : null;
      draw();
    };
    if (!ctx.vscode) {
      fetch('/api/history?repo=' + encodeURIComponent(want)).then((r) => (r.ok ? r.json() : null)).then(done, () => done(null));
      return;
    }
    // The webview cannot reach the core itself (its CSP has no connect-src): the extension asks for it.
    const id = Math.random().toString(36).slice(2);
    pending.set(id, done);
    ctx.vscode.postMessage({ type: 'getHistory', id, repo: want });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); done(null); } }, 20_000);
  }

  function cutoff() {
    const w = WINDOWS.find((x) => x[0] === win);
    return w && w[2] ? Date.now() - w[2] * 86_400_000 : 0;
  }

  /** The plans that changed a file inside the window, newest first: [spec, iso, via]. */
  function plansFor(file, from) {
    return ((data && data.files[file]) || []).filter((x) => Date.parse(x[1]) >= from);
  }

  function chipWidth(size) {
    // Bigger files read as wider chips; log scale so one huge file does not dominate.
    return Math.round(10 + Math.min(46, 7 * Math.log2(1 + size / 400)));
  }

  function when(spec, iso) {
    if (spec && spec.status === 'active') return 'active';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function draw() {
    if (!el) return;
    const esc = ctx.esc;
    if (!data || !Object.keys(data.files).length || !data.areas.length) {
      // Nothing to show is hidden, not empty.
      if (lastHtml) el.innerHTML = '';
      lastHtml = '';
      return;
    }
    const from = cutoff();
    const counts = new Map();
    for (const a of data.areas) for (const [f] of a.files) counts.set(f, plansFor(f, from).length);
    if (!sel || !counts.has(sel)) sel = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const chips = (a) => a.files.map(([f, size]) => {
      const n = counts.get(f) || 0;
      return `<button class="h${level(n)}" data-hfile="${esc(f)}" aria-current="${f === sel}" style="width:${chipWidth(size)}px" title="${esc(f)}: ${n === 1 ? '1 plan' : n + ' plans'}" aria-label="${esc(f)}"></button>`;
    }).join('');
    const areas = data.areas.map((a) => `<div class="area" style="flex:${Math.max(1, Math.sqrt(a.files.length)).toFixed(2)} 1 160px">
      <span class="mono clamp1" title="${esc(a.name)}">${esc(a.name === '.' ? 'top level' : a.name)}</span>
      <div class="chips">${chips(a)}</div>${a.more ? `<span class="more">and ${a.more} more</span>` : ''}</div>`).join('');
    const list = plansFor(sel, from);
    const guess = (via) => via === 'window' || via === 'dates';
    const rows = list.map(([i, iso, via]) => {
      const s = data.specs[i] || { name: 'A plan' };
      const g = guess(via) ? '<span class="muted" title="Inferred: the commit touched a file the plan names, around the plan\'s dates. A guess.">~</span>' : '';
      const inner = `<span class="clamp1">${esc(s.name)}</span>${g}<span class="muted">${esc(when(s, iso))}</span>`;
      return s.file ? `<a href="#" class="p" data-doc="${esc(s.file)}" title="${esc(s.name)}">${inner}</a>` : `<div class="p" title="${esc(s.name)}: no longer in the repo">${inner}</div>`;
    }).join('');
    const n = list.length;
    const anyGuess = Object.values(data.files).some((xs) => xs.some((x) => guess(x[2]) && Date.parse(x[1]) >= from));
    const label = (WINDOWS.find((x) => x[0] === win) || [])[1];
    const html = `<div class="box hist">
      <div class="hist-h"><h2>Plans per file</h2><span class="muted" style="font-size:12px">${win === 'all' ? `all ${data.commits} commits${data.truncated ? ' kept' : ''}` : 'last ' + esc(label)}</span>
        <span class="spacer"></span>
        <div class="seg" role="group" aria-label="Time window">${WINDOWS.map(([k, t]) => `<button data-hwin="${k}" aria-pressed="${k === win}">${t}</button>`).join('')}</div>
        <span class="legend"><span style="margin-right:4px">0</span>${[0, 1, 2, 3, 4].map((l) => `<i class="h${l}"></i>`).join('')}<span style="margin-left:4px">7+</span></span>
      </div>
      <div class="hist-body"><div class="areas">${areas}</div>
        <aside class="hside"><span class="mono clamp1" title="${esc(sel)}">${esc(sel)}</span>
          <span class="muted" style="font-size:12px">${n === 0 ? 'No plans changed this file' : n === 1 ? '1 plan' : n + ' plans'}</span>${rows}</aside></div>
      ${anyGuess ? '<div class="note muted">~ inferred from the dates in a plan and the files it names, not from the commit itself: a guess.</div>' : ''}
    </div>`;
    if (html === lastHtml) return;
    lastHtml = html;
    el.innerHTML = html;
    el.querySelectorAll('[data-hfile]').forEach((b) => (b.onclick = () => { sel = b.dataset.hfile; draw(); }));
    el.querySelectorAll('[data-hwin]').forEach((b) => (b.onclick = () => { win = b.dataset.hwin; draw(); }));
  }

  window.MontyHistory = {
    /** Called on every render. Fetches when the repo changes or the data is old; redraws only on change. */
    update(target, repoPath, c) {
      el = target;
      if (c) ctx = c;
      if (repoPath !== repo) {
        repo = repoPath || '';
        data = null;
        sel = '';
        fetchedAt = 0;
        draw();
      }
      if (repo && Date.now() - fetchedAt > REFETCH_MS) fetchData();
    },
    /** The extension's answer to getHistory. */
    onMessage(m) {
      const done = pending.get(m.id);
      if (!done) return;
      pending.delete(m.id);
      done(m.history);
    },
  };
})();
