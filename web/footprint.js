// Footprint view for the readable view of a plan or spec: where its work lands in the
// repo, and where it strayed. Data from /api/footprint (src/footprint.ts); app.js passes in
// how to fetch it (fetch in a browser, postMessage in VS Code), so this file never talks to
// the host itself. Two parts: a side card with the counts, and a full view over the reader
// with the repo as area boxes and a cell per file. Files open through app.js's [data-open].
(function () {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // The reader re-renders on every live update; plans change on agent time, so a footprint
  // this fresh is as good as a new one, and git is not asked again on every render.
  const REFRESH_MS = 15000;
  const cache = new Map(); // spec file -> { at, data, loading }
  let ctx = null; // the last side() call: { p, api, side, reader }
  let viewFile = null; // spec whose full view is open
  let sel = null; // selected file path in the full view

  const base = (p) => p.split('/').pop();
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

  function load(file) {
    const hit = cache.get(file);
    if (hit && (hit.loading || Date.now() - hit.at < REFRESH_MS)) return hit.data;
    const entry = { at: Date.now(), data: hit ? hit.data : null, loading: true };
    cache.set(file, entry);
    Promise.resolve(ctx.api('/api/footprint?file=' + encodeURIComponent(file)))
      .then((d) => { entry.data = d && Array.isArray(d.areas) ? d : entry.data; })
      .catch(() => {})
      .then(() => {
        entry.loading = false;
        entry.at = Date.now();
        if (ctx && ctx.p.file === file) { placeSide(); if (viewFile === file) renderView(); }
      });
    return entry.data;
  }

  const hasAny = (d) => d && (d.counts.named > 0 || d.counts.outside > 0);
  const noun = (d) => (d.kind === 'spec' ? 'spec' : 'plan');

  function countLines(d) {
    const c = d.counts;
    return `${c.named ? `<span>${c.namedChanged} of ${plural(c.named, `${noun(d) === 'plan' ? 'planned' : 'named'} file`)} changed</span>` : ''}
      ${c.outside ? `<span class="fp-outside">${plural(c.outside, 'file')} changed outside the ${noun(d)}</span>` : ''}`;
  }

  // Heuristics say so: the window is a guess for busy repos, so the view names its sources.
  function sources(d) {
    const parts = [];
    if (d.git && d.since) parts.push(`git since ${day(d.since)}${d.sinceBasis === 'commit' ? '' : d.sinceBasis === 'file-created' ? ' (when the file was made)' : ' (from the file date)'}${d.until ? ` to ${day(d.until)}` : ''}`);
    if (d.sessions) parts.push(plural(d.sessions, 'live session'));
    if (!parts.length) return d.git ? 'No changes found yet.' : 'Not a git repo, and no live session on it: only the files it names.';
    return 'Changes from ' + parts.join(' and ') + '.' + (d.areaBasis === 'caddis' ? ' Areas from the Caddis map.' : '');
  }

  /** Called from app.js renderDoc for a doc that belongs to a project. */
  function side(p, c) {
    ctx = { p, api: c.api, side: c.side, reader: c.reader };
    if (viewFile && viewFile !== p.file) close();
    load(p.file);
    placeSide();
  }

  function placeSide() {
    if (!ctx || !ctx.side.isConnected) return;
    const d = (cache.get(ctx.p.file) || {}).data;
    // The reader's header tile row (app.js), when the page has one.
    const tile = document.querySelector('#doc [data-tile="footprint"]');
    if (tile) {
      if (!hasAny(d)) { tile.hidden = true; return; }
      const c = d.counts;
      const n = noun(d);
      const src = 'Changes come from git commits and uncommitted edits since the ' + n + ' was written, plus edits made in a live session working on it.';
      const big = c.named
        ? `<span data-tip="The ${n} lists ${plural(c.named, 'file')} to create or change. ${c.namedChanged} of them ${c.namedChanged === 1 ? 'has' : 'have'} changed so far. ${src}">${c.namedChanged}<span class="rm-of">/${c.named}</span></span>`
        : `<span data-tip="The ${n} lists no files, so every change counts as outside it. ${src}">${c.outside}</span>`;
      const unit = c.named ? `of its files changed` : `${c.outside === 1 ? 'file' : 'files'} changed`;
      const other = c.outside
        ? `<span class="rm-warn" data-tip="${plural(c.outside, 'file')} changed since the ${n} was written that the ${n} never mentions. Could be work it missed, or unrelated work in the same repo.">${plural(c.outside, 'other file')} changed</span>`
        : `<span data-tip="Every change since the ${n} was written is to a file it lists.">No other files changed</span>`;
      tile.innerHTML = `<div class="lbl" data-tip="Which files this ${n} touches, and whether work has landed anywhere it didn't plan.">Footprint</div>
        <div class="rm-big">${big}</div><div class="rm-unit">${unit}</div>
        <div class="rm-tsub">${c.named ? other : ''}</div>
        <a href="#" class="rm-act" data-fp-open>View footprint map</a>`;
      tile.querySelector('[data-fp-open]').onclick = (e) => { e.preventDefault(); open(ctx.p.file); };
      tile.hidden = false;
      return;
    }
    const old = ctx.side.querySelector('.fp-side');
    if (old) old.remove();
    if (!hasAny(d)) return; // nothing to show: hidden, not empty
    const card = document.createElement('div');
    card.className = 'side fp-side';
    card.innerHTML = `<h2>Footprint</h2><div class="fp-counts">${countLines(d)}</div><a href="#" class="fp-open" data-fp-open>View footprint map</a>`;
    card.querySelector('[data-fp-open]').onclick = (e) => { e.preventDefault(); open(ctx.p.file); };
    // After the phases card, so progress still leads the column.
    const first = ctx.side.firstElementChild;
    ctx.side.insertBefore(card, first && first.classList.contains('lead') ? first.nextSibling : first);
  }

  // ---------- full view ----------

  const STATE = {
    changed: ['Changed', 'fp-c-changed'],
    planned: ['Planned, not changed yet', 'fp-c-planned'],
    outside: ['Changed, not in the plan', 'fp-c-outside'],
  };
  function stateText(f, d) {
    if (f.state === 'planned') return d.kind === 'spec' ? 'Named, not changed yet' : STATE.planned[0];
    if (f.state === 'outside') return `Changed, not in the ${noun(d)}`;
    return STATE.changed[0];
  }
  function noteFor(f, d) {
    const bits = [];
    if (f.state === 'planned' && !f.exists) bits.push('Not created yet');
    else if (f.added) bits.push('New file');
    if (f.where.length) bits.push(f.where.join(', '));
    if (f.state === 'outside') bits.push(`Not named anywhere in the ${noun(d)}`);
    if (f.via.includes('session') && f.state !== 'planned') bits.push('edited in a live session');
    return bits.join(' · ');
  }

  function open(file) {
    viewFile = file;
    sel = null;
    renderView();
  }
  let sheet = null; // the footprint map's MontyOverlay sheet, made on first open
  function close() {
    viewFile = null;
    if (sheet) sheet.hidden = true;
  }

  function renderView() {
    if (!ctx || !viewFile) return;
    const d = (cache.get(viewFile) || {}).data;
    if (!d) return;
    if (!sheet) {
      sheet = window.MontyOverlay.create(close);
      sheet.addEventListener('click', (e) => {
        const cell = e.target.closest('[data-fp-cell]');
        if (cell) { sel = cell.dataset.fpCell; renderView(); }
      });
    }
    sheet.hidden = false;
    const marked = d.areas.flatMap((a) => a.marked);
    if (!sel || !marked.some((f) => f.path === sel)) {
      const pick = marked.find((f) => f.state === 'outside') || marked.find((f) => f.state === 'planned') || marked[0];
      sel = pick ? pick.path : null;
    }
    const cur = marked.find((f) => f.path === sel);
    const plainW = (p) => Math.max(26, Math.min(96, base(p).length * 6));
    const areas = d.areas.map((a) => {
      // Square root, so one big folder does not squeeze every other area to a sliver.
      const grow = Math.sqrt(a.total).toFixed(2);
      const cells = a.marked.map((f) => `<button class="fp-cell mono ${STATE[f.state][1]}${f.path === sel ? ' sel' : ''}" data-fp-cell="${esc(f.path)}" title="${esc(f.path)}" aria-label="${esc(f.path)}: ${esc(stateText(f, d))}">${esc(base(f.path))}</button>`).join('')
        + a.plain.map((p) => `<span class="fp-cell fp-c-plain" style="width:${plainW(p)}px" title="${esc(p)}"></span>`).join('')
        + (a.more ? `<span class="fp-more muted">+${a.more} files</span>` : '');
      return `<div class="fp-area" style="flex:${grow} 1 ${Math.min(360, 140 + Math.sqrt(a.total) * 14)}px"><span class="fp-name mono">${esc(a.name)}</span><div class="fp-cells">${cells}</div></div>`;
    }).join('');
    const abs = cur ? d.repoPath + '/' + cur.path : '';
    const legend = `<span class="fp-key" data-tip="A file the ${noun(d)} names that has changed since it was written."><span class="fp-sw fp-c-changed"></span>changed</span>
        <span class="fp-key" data-tip="A file the ${noun(d)} names that has not changed yet: work still to do."><span class="fp-sw fp-c-planned"></span>${d.kind === 'spec' ? 'named' : 'planned'}, not yet</span>
        <span class="fp-key" data-tip="A file that changed since the ${noun(d)} was written but that the ${noun(d)} never mentions."><span class="fp-sw fp-c-outside"></span>changed, not in the ${noun(d)}</span>`;
    sheet.innerHTML = window.MontyOverlay.bar({
      kind: 'Footprint map',
      title: d.name,
      sub: `Where this ${noun(d)}'s work lands in the repo. Each box is a folder; each cell a file.`,
      controls: legend,
    }) + `<div class="ov-body fp-view">
      <div class="fp-body">
        <div class="fp-areas">${areas}</div>
        <aside class="fp-aside">
          ${cur ? `<div class="fp-detail">
            <span class="mono fp-path">${esc(cur.path)}</span>
            <span class="fp-state ${STATE[cur.state][1]}-t">${esc(stateText(cur, d))}</span>
            ${noteFor(cur, d) ? `<span class="fp-note">${esc(noteFor(cur, d))}</span>` : ''}
            ${cur.exists ? `<a href="#" data-open="${esc(abs)}">Open file</a>` : ''}
          </div>` : ''}
          <div class="fp-prog">
            <h2>Progress</h2>
            <div class="fp-counts">${countLines(d)}</div>
            <span class="muted fp-src">${esc(sources(d))}</span>
            <span class="muted fp-src">${plural(d.files, 'file')} in ${plural(d.areas.length, 'area')}.</span>
          </div>
        </aside>
      </div></div>`;
  }

  window.MontyFootprint = { side };
})();
