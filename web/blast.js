// Blast radius view: what else an open spec's changes reach. Reads `project.blast`, which
// the core works out from Caddis's import map (src/blast.ts); a spec without it gets no
// button and no view. Loaded before app.js in the browser panel and the VS Code webview;
// styles are inline here so the page needs no extra stylesheet.
//
// window.MontyBlast.button(project) returns the header button's HTML (or ''). Every render
// of the reader calls it, which also refreshes an open view with the latest numbers.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const specs = new Map(); // spec file -> project, from the latest render
  let openFor = '';
  let copied = false;

  // A handful of importers reads at a glance; the rest are grouped by area.
  const SHOW_IMPORTERS = 6;
  const SHOW_AREAS = 8;
  const SHOW_UNTESTED = 12;

  const css = `
.blast{position:fixed;inset:0;z-index:30;background:rgba(10,8,14,.72);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:32px 16px}
.blast[hidden]{display:none}
.blast .bl-in{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:28px 32px;width:100%;max-width:1180px;display:flex;flex-direction:column;gap:24px}
.blast .bl-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.blast .bl-head b{font-size:22px;font-weight:700}
.blast .bl-head .bl-close{margin-left:auto;cursor:pointer}
.blast .bl-body{display:flex;gap:36px;flex-wrap:wrap}
.blast .bl-cols{flex:1 1 640px;display:grid;grid-template-columns:1fr 28px 1fr 28px 1fr;align-items:start;min-width:0}
.blast .bl-col{display:flex;flex-direction:column;gap:6px;min-width:0}
.blast .bl-col h2,.blast aside h2{margin:0 0 4px}
.blast .bl-arrow{display:flex;justify-content:center;padding-top:32px}
.blast .bl-file{font-size:12.5px;background:var(--panel);border:1px solid transparent;border-radius:8px;padding:7px 10px;display:flex;justify-content:space-between;gap:8px;color:var(--text);text-decoration:none;min-width:0}
.blast a.bl-file:hover{border-color:var(--line)}
.blast .bl-file span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.blast .bl-file.edit{background:var(--accent-soft);border-color:var(--accent-strong)}
.blast .bl-file.hub{background:var(--peri-soft);border-color:var(--peri)}
.blast .bl-hub{font-size:11px;font-weight:600;color:var(--peri);font-family:inherit}
.blast .bl-more{font-size:12.5px;color:var(--muted);padding:3px 2px}
.blast .bl-area{display:grid;grid-template-columns:minmax(60px,110px) 1fr 32px;gap:8px;align-items:center;font-size:12.5px}
.blast .bl-area .bar{height:8px}.blast .bl-area .bar>div{background:var(--peri)}
.blast .bl-area span:last-child{color:var(--muted);text-align:right}
.blast aside{flex:0 1 260px;display:flex;flex-direction:column;gap:6px;min-width:200px}
.blast aside h2{color:var(--orchid)}
.blast aside .ok{color:var(--ok);font-size:12.5px}
.blast aside .mono a{display:block;font-size:12.5px;color:var(--text);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blast aside .mono a:hover{color:var(--accent)}
.blast aside button{align-self:flex-start;background:transparent;color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:5px 12px;font-size:12.5px;margin-top:6px;cursor:pointer}
.blast .bl-foot{font-size:12px;color:var(--muted)}
.btn.blast-open{align-self:flex-start;cursor:pointer;font-size:12.5px}
@media (max-width:760px){.blast .bl-cols{grid-template-columns:1fr;gap:18px}.blast .bl-arrow{display:none}.blast .bl-in{padding:20px 16px}}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'blast';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Blast radius');
  document.body.appendChild(root);

  const arrow = '<div class="bl-arrow"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" stroke="var(--muted)" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg></div>';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function fileLink(p, file, cls, tail) {
    return `<a href="#" class="bl-file mono ${cls}" data-open="${esc(p.repoPath + '/' + file)}" title="${esc(file)}"><span>${esc(file)}</span>${tail || ''}</a>`;
  }

  function render(p) {
    const b = p.blast;
    const hubs = new Set(b.hubs.map((h) => h.file));
    const edited = b.edited.map((f) => fileLink(p, f, hubs.has(f) ? 'edit' : '', hubs.has(f) ? '<span class="bl-hub">hub</span>' : '')).join('');
    const extra = [
      b.newFiles ? `+ ${plural(b.newFiles, 'new file', 'new files')}` : '',
      b.unimported ? `+ ${b.unimported} nothing imports` : '',
    ].filter(Boolean).map((t) => `<div class="bl-more">${t}</div>`).join('');

    // Hubs first: they are where a change spreads.
    const imp = [...b.importers].sort((x, y) => Number(y.hub) - Number(x.hub));
    const shown = imp.slice(0, SHOW_IMPORTERS);
    const left = new Map(b.importersByArea.map((a) => [a.area, a.files]));
    for (const f of shown) left.set(f.area, (left.get(f.area) || 0) - 1);
    const groups = [...left].filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
    const importers = shown.map((f) => fileLink(p, f.file, f.hub ? 'hub' : '', f.hub ? '<span class="bl-hub">hub</span>' : '')).join('')
      + groups.slice(0, 4).map(([a, n]) => `<div class="bl-file mono"><span>${esc(a === '(root)' ? '' : a + '/')}** · ${plural(n, 'file', 'files')}</span></div>`).join('')
      + (groups.length > 4 ? `<div class="bl-more">+ ${groups.slice(4).reduce((s, [, n]) => s + n, 0)} more elsewhere</div>` : '');

    // Through hubs when anything goes through one; otherwise all of the reach by area.
    const viaRows = b.byArea.filter((a) => a.viaHubs > 0).map((a) => [a.area, a.viaHubs]);
    const rows = (viaRows.length ? viaRows : b.byArea.map((a) => [a.area, a.files])).sort((x, y) => y[1] - x[1]).slice(0, SHOW_AREAS);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const areas = rows.map(([a, n]) => `<div class="bl-area"><span class="mono clamp1" title="${esc(a)}">${esc(a)}</span><div class="bar"><div style="width:${Math.max(4, Math.round((n / max) * 100))}%"></div></div><span>${n}</span></div>`).join('');
    const reachNote = `<div class="bl-more">${viaRows.length ? `${b.viaHubs} of ${b.reach} files in reach go through a hub` : plural(b.reach, 'file imports', 'files import') + ' these, directly or not'}</div>`;

    const untested = b.untestedTotal
      ? `<div class="mono">${b.untested.slice(0, SHOW_UNTESTED).map((f) => `<a href="#" data-open="${esc(p.repoPath + '/' + f)}" title="${esc(f)}">${esc(f)}</a>`).join('')}</div>
         ${b.untestedTotal > SHOW_UNTESTED ? `<div class="bl-more">+ ${b.untestedTotal - SHOW_UNTESTED} more</div>` : ''}
         ${navigator.clipboard ? `<button data-blast-copy title="Copies these as a markdown list, for the plan's Tests section">${copied ? 'Copied' : 'Copy for Tests'}</button>` : ''}`
      : '<div class="ok">Every importer is within reach of a test.</div>';

    root.innerHTML = `<div class="bl-in">
      <div class="bl-head"><b>${esc(p.name)}</b><span class="muted">what else these changes reach</span><a href="#" class="btn bl-close" data-blast-close>Close</a></div>
      <div class="bl-body">
        <div class="bl-cols">
          <div class="bl-col"><h2>Edited</h2>${edited}${extra}</div>
          ${arrow}
          <div class="bl-col"><h2>Imported by</h2>${importers}</div>
          ${arrow}
          <div class="bl-col"><h2>${viaRows.length ? 'Through the hubs' : 'Reach by area'}</h2>${areas}${reachNote}</div>
        </div>
        <aside><h2>No test reaches</h2>${untested}</aside>
      </div>
      <div class="bl-foot">From the files the plan names, through Caddis's import map${b.mapCommit ? ` (built at ${esc(b.mapCommit)})` : ''}. I don't rebuild the map, so it may be a step behind the code.</div>
    </div>`;
  }

  function show(file) {
    const p = specs.get(file);
    if (!p || !p.blast) return hide();
    openFor = file;
    render(p);
    root.hidden = false;
  }
  function hide() {
    openFor = '';
    copied = false;
    root.hidden = true;
    root.innerHTML = '';
  }

  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-blast]');
    if (o) {
      e.preventDefault();
      return show(o.dataset.blast);
    }
    if (root.hidden) return;
    if (e.target === root || e.target.closest('[data-blast-close]')) {
      e.preventDefault();
      return hide();
    }
    if (e.target.closest('[data-blast-copy]')) {
      const p = specs.get(openFor);
      if (!p) return;
      const text = p.blast.untested.map((f) => `- \`${f}\`: no test reaches it`).join('\n');
      navigator.clipboard.writeText(text).then(() => { copied = true; render(p); }, () => {});
    }
    // File links (data-open) are handled by app.js; the view stays open behind the editor tab.
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !root.hidden) hide();
  });

  window.MontyBlast = {
    /** The reader header's tile, or '' (same rules as button). */
    tile(p) {
      if (!this.button(p)) return '';
      const b = p.blast;
      return `<div class="rm-tile"><div class="lbl">Blast radius</div>
        <div class="rm-big">${b.reach}</div><div class="rm-unit">${b.reach === 1 ? 'file' : 'files'} in reach</div>
        <div class="rm-tsub">${plural(b.importersTotal, 'file imports', 'files import')} what it edits${b.untestedTotal ? `<br><span class="rm-warn">${b.untestedTotal} no test reaches</span>` : ''}</div>
        <a href="#" class="rm-act" data-blast="${esc(p.file)}">Show what it reaches</a></div>`;
    },
    /** The spec header's button, or '' when the spec has no blast radius (no Caddis map, or nothing imported). */
    button(p) {
      if (!p || !p.blast) {
        if (p && openFor === p.file) hide();
        return '';
      }
      specs.set(p.file, p);
      if (openFor === p.file) render(p);
      const b = p.blast;
      const title = `${plural(b.importersTotal, 'file imports', 'files import')} what this plan edits; ${b.reach} in reach`;
      return `<button class="btn blast-open" data-blast="${esc(p.file)}" title="${esc(title)}">Blast radius · ${b.reach}</button>`;
    },
  };
})();
