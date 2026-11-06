// The roadmap: every plan or spec in one repo as a card in Done, Active and Next, with
// right-angled lines for what needs what (Project.dependsOn, from src/deps.ts). Click a
// card and it, everything it needs and everything it unblocks stay lit.
//
// The layout is hand-written rather than a library (no build step, no dependency): each
// column splits into lanes by dependency depth, cards in a lane are ordered by the
// average row of their neighbours to cut crossings, and loops are found first so they
// can be drawn and called out instead of sending the depth walk round in circles.
//
// pick, layout and chain are pure and tested (test/roadmap.test.ts); render draws.
(function () {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Card size and spacing, from the mock (mocks/roadmap.dc.html): 220 x 92 cards, 110px
  // between lanes leaves room for the elbows; 24px between rows for lines routed under cards.
  const W = 220;
  const H = 92;
  const GAP = 110;
  const ROW = H + 24;
  const HEAD = 30; // column labels
  // Done keeps the five most recent, plus any linked to what is still to do.
  const RECENT_DONE = 5;
  // Barycenter passes: crossings stop improving after a few on boards this size.
  const SWEEPS = 4;

  const COLS = ['Done', 'Active', 'Next'];
  const colOf = (p) => (p.status === 'completed' ? 0 : p.status === 'active' ? 1 : 2);
  /** When a done plan finished: the date its Status line gives ("Complete (2026-10-24)"), else the file's. */
  const doneAt = (p) => (/(\d{4}-\d{2}-\d{2})/.exec(p.statusText || '') || [])[1] || (p.updatedAt || '').slice(0, 10);

  /** The cards to show for one repo's projects. Cancelled plans block nothing, so they stay off. */
  function pick(projects, recent = RECENT_DONE) {
    const live = projects.filter((p) => p.status !== 'cancelled');
    const open = live.filter((p) => p.status !== 'completed');
    const openIds = new Set(open.map((p) => p.id));
    const done = live.filter((p) => p.status === 'completed').sort((a, b) => doneAt(b).localeCompare(doneAt(a)));
    const linked = new Set();
    for (const p of open) for (const d of p.dependsOn || []) linked.add(d);
    for (const p of done) if ((p.dependsOn || []).some((d) => openIds.has(d))) linked.add(p.id);
    const shown = [...done.filter((p, i) => i < recent || linked.has(p.id)), ...open];
    const ids = new Set(shown.map((p) => p.id));
    return shown.map((p) => ({
      id: p.id,
      col: colOf(p),
      parked: p.status === 'parked',
      deps: [...new Set((p.dependsOn || []).filter((d) => ids.has(d) && d !== p.id))],
      p,
    }));
  }

  /** Strongly connected groups (Tarjan). Every group of two or more is a loop. */
  function loops(cards) {
    const byId = new Map(cards.map((c) => [c.id, c]));
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const groups = [];
    let i = 0;
    const visit = (id) => {
      index.set(id, i);
      low.set(id, i);
      i++;
      stack.push(id);
      onStack.add(id);
      for (const d of byId.get(id).deps) {
        if (!byId.has(d)) continue;
        if (!index.has(d)) {
          visit(d);
          low.set(id, Math.min(low.get(id), low.get(d)));
        } else if (onStack.has(d)) low.set(id, Math.min(low.get(id), index.get(d)));
      }
      if (low.get(id) === index.get(id)) {
        const g = [];
        let x;
        do {
          x = stack.pop();
          onStack.delete(x);
          g.push(x);
        } while (x !== id);
        if (g.length > 1) groups.push(g);
      }
    };
    for (const c of cards) if (!index.has(c.id)) visit(c.id);
    return groups;
  }

  function layout(cards) {
    const byId = new Map(cards.map((c) => [c.id, c]));
    const cycles = loops(cards);
    const groupOf = new Map();
    cycles.forEach((g, k) => g.forEach((id) => groupOf.set(id, k)));
    const inLoop = (a, b) => groupOf.has(a) && groupOf.get(a) === groupOf.get(b);

    // Depth within a column: how many of the column's own cards stand before this one.
    // Done stays one lane: finished work needs no order, and a long done chain would push
    // Active and Next off the screen.
    // Edges inside a loop are left out, so the walk always ends; memoised, so each card once.
    const depth = new Map();
    const depthOf = (id, seen = new Set()) => {
      if (depth.has(id)) return depth.get(id);
      if (seen.has(id)) return 0;
      seen.add(id);
      const c = byId.get(id);
      let d = 0;
      for (const x of c.deps) {
        const dc = byId.get(x);
        if (dc && dc.col === c.col && c.col !== 0 && !inLoop(x, id) && !c.parked && !dc.parked) d = Math.max(d, depthOf(x, seen) + 1);
      }
      depth.set(id, d);
      return d;
    };
    cards.forEach((c) => depthOf(c.id));

    // Lanes, left to right; empty columns take no room.
    const lanes = [];
    const cols = [];
    for (let col = 0; col < 3; col++) {
      const mine = cards.filter((c) => c.col === col);
      if (!mine.length) continue;
      const n = Math.max(...mine.map((c) => depth.get(c.id))) + 1;
      cols.push({ label: COLS[col], col, x: lanes.length * (W + GAP) });
      for (let k = 0; k < n; k++) lanes.push(mine.filter((c) => depth.get(c.id) === k));
    }
    // A first order that reads sensibly before the crossing passes: newest done first,
    // then the order the plans came in; parked always last.
    for (const lane of lanes) {
      lane.sort((a, b) => (a.parked - b.parked) || (a.col === 0 ? doneAt(b.p).localeCompare(doneAt(a.p)) : 0));
    }
    const laneOf = new Map();
    lanes.forEach((lane, li) => lane.forEach((c) => laneOf.set(c.id, li)));
    const dependents = new Map(cards.map((c) => [c.id, []]));
    for (const c of cards) for (const d of c.deps) dependents.get(d).push(c.id);

    const rowOf = new Map();
    const place = () => lanes.forEach((lane) => lane.forEach((c, r) => rowOf.set(c.id, r)));
    place();
    for (let s = 0; s < SWEEPS; s++) {
      const order = s % 2 ? [...lanes.keys()].reverse() : [...lanes.keys()];
      for (const li of order) {
        const lane = lanes[li];
        // Cards linked across lanes sit level with their neighbours; the rest go below
        // them, a loop's members side by side so its lines stay short.
        const key = new Map(lane.map((c, r) => {
          const near = [...c.deps, ...dependents.get(c.id)].filter((x) => laneOf.get(x) !== li).map((x) => rowOf.get(x));
          return [c.id, near.length ? [0, near.reduce((a, b) => a + b, 0) / near.length, r] : [1, groupOf.has(c.id) ? groupOf.get(c.id) : cycles.length, r]];
        }));
        const cmp = (a, b) => {
          const [x, y] = [key.get(a.id), key.get(b.id)];
          return (a.parked - b.parked) || x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
        };
        lane.sort(cmp);
        lane.forEach((c, r) => rowOf.set(c.id, r));
      }
    }

    const nodes = new Map();
    lanes.forEach((lane, li) => lane.forEach((c, r) => nodes.set(c.id, { id: c.id, lane: li, row: r, x: li * (W + GAP), y: HEAD + r * ROW })));

    // Lines. Forward ones (to a lane on the right) leave the card's right edge, turn in the
    // gap before the target and enter its left edge; each source into a gap gets its own
    // vertical so lines don't overlap. The rest (same lane, backwards, loops) run under the cards.
    const edges = [];
    const intoGap = new Map(); // target lane -> sources sorted by height
    for (const c of cards) for (const d of c.deps) {
      if (c.col === 0 && byId.get(d).col === 0) continue;
      const a = nodes.get(d);
      const b = nodes.get(c.id);
      if (a.lane < b.lane && !inLoop(d, c.id)) {
        if (!intoGap.has(b.lane)) intoGap.set(b.lane, []);
        const g = intoGap.get(b.lane);
        if (!g.includes(d)) g.push(d);
      }
    }
    for (const g of intoGap.values()) g.sort((x, y) => nodes.get(x).y - nodes.get(y).y);
    let under = 0;
    // Two finished plans: the link between them no longer blocks anything, so no line
    // (chain highlighting still follows it).
    const drawn = (c, d) => !(c.col === 0 && byId.get(d).col === 0);
    for (const c of cards) for (const d of c.deps) {
      if (!drawn(c, d)) continue;
      const a = nodes.get(d);
      const b = nodes.get(c.id);
      const cycle = inLoop(d, c.id);
      let points;
      if (a.lane < b.lane && !cycle) {
        const g = intoGap.get(b.lane);
        const mid = b.x - GAP + Math.round((GAP * (g.indexOf(d) + 1)) / (g.length + 1));
        const ya = a.y + H / 2;
        const yb = b.y + H / 2;
        if (b.lane - a.lane === 1) points = [[a.x + W, ya], [mid, ya], [mid, yb], [b.x, yb]];
        else {
          // Skipping lanes: a straight run would pass behind the cards between and read as
          // starting from one of them, so drop into the gap under the target's row instead.
          const out = a.x + W + Math.round(GAP / 3);
          const ch = b.y + H + 12;
          points = [[a.x + W, ya], [out, ya], [out, ch], [mid, ch], [mid, yb], [b.x, yb]];
        }
      } else {
        const off = 12 + (under++ % 3) * 8;
        const low = Math.max(a.y, b.y) + H + 12;
        if (a.lane === b.lane) {
          // Same lane: run down the gap on the right, so the line never passes behind a
          // card in between and seems to start from it.
          const side = a.x + W + off;
          points = [[a.x + W, a.y + H / 2], [side, a.y + H / 2], [side, b.y + H / 2], [b.x + W, b.y + H / 2]];
        } else points = [[a.x + W / 2 + off, a.y + H], [a.x + W / 2 + off, low], [b.x + W / 2 - off, low], [b.x + W / 2 - off, b.y + H]];
      }
      edges.push({ from: d, to: c.id, cycle, back: !(a.lane < b.lane), points });
    }
    const rows = Math.max(0, ...lanes.map((l) => l.length));
    return {
      nodes,
      edges,
      cycles,
      cols,
      width: Math.max(W, lanes.length * (W + GAP) - GAP),
      height: HEAD + rows * ROW,
    };
  }

  /** The card, everything it needs (all the way down) and everything it unblocks (all the way up). */
  function chain(id, cards) {
    const deps = new Map(cards.map((c) => [c.id, c.deps]));
    const ups = new Map(cards.map((c) => [c.id, []]));
    for (const c of cards) for (const d of c.deps) if (ups.has(d)) ups.get(d).push(c.id);
    const out = new Set([id]);
    const walk = (start, next) => {
      const todo = [start];
      const seen = new Set([start]);
      while (todo.length) {
        for (const x of next.get(todo.pop()) || []) {
          if (seen.has(x)) continue;
          seen.add(x);
          out.add(x);
          todo.push(x);
        }
      }
    };
    walk(id, deps);
    walk(id, ups);
    return out;
  }

  /** A roadmap is worth opening when it has two cards or more: one card is just the plan. */
  const worth = (projects) => pick(projects).length >= 2;

  // ---------- drawing ----------

  let sel = null;
  let lastSelect;
  let last = null;

  function bars(c) {
    const p = c.p;
    if (c.parked) return '';
    const { done, total, basis } = p.progress || { done: 0, total: 1, basis: 'status' };
    const n = basis === 'status' ? 1 : Math.min(Math.max(total, 1), 12);
    const on = basis === 'status' ? (p.status === 'completed' ? 1 : 0) : total <= 12 ? done : Math.round((done / total) * n);
    const cur = c.col === 1 ? on : -1;
    return `<span class="rm-bars">${Array.from({ length: n }, (_, i) => `<span class="${i < on ? 'on' : i === cur ? 'cur' : ''}"></span>`).join('')}</span>`;
  }

  function fmtDate(d) {
    const t = Date.parse(d + 'T00:00:00');
    return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function subline(c, byId) {
    const p = c.p;
    if (c.col === 0) return fmtDate(doneAt(p)) || 'Done';
    if (c.parked) return 'Parked';
    const waiting = c.deps.filter((d) => byId.get(d) && byId.get(d).col !== 0).length;
    if (c.col === 2 && waiting) return `Waiting on ${waiting}`;
    return p.label || (c.col === 2 ? 'Not started' : 'Under way');
  }

  const STATUS_CHIP = { 0: 'done', 1: 'active', 2: 'pending' };

  function render(el, projects, opts = {}) {
    last = { el, projects, opts };
    if (opts.select !== lastSelect) {
      lastSelect = opts.select;
      if (opts.select) sel = opts.select;
    }
    const cards = pick(projects);
    const byId = new Map(cards.map((c) => [c.id, c]));
    if (sel && !byId.has(sel)) sel = null;
    const L = layout(cards);
    const lit = sel ? chain(sel, cards) : null;
    const name = (id) => (byId.get(id) ? byId.get(id).p.name : id);

    const head = `<div class="rm-bar">
      ${opts.back ? '<a href="#" class="btn" data-rm-back>Back</a>' : ''}
      <span class="rm-repo">${esc(opts.repo || '')}</span>
      <span class="muted">${cards.length} plan${cards.length === 1 ? '' : 's'}</span>
      <span class="spacer"></span>
      ${opts.repos && opts.repos.length > 1 ? `<label class="filter">Repo <select data-rm-repo>${opts.repos.map((r) => `<option ${r === opts.repo ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>` : ''}
    </div>`;

    if (!cards.length) return paint(el, head + '<div class="rm-empty muted">No plans in this repo to put on a roadmap.</div>');

    const loopNote = L.cycles.length ? `<div class="rm-note">${L.cycles.map((g) => `${g.map((id) => esc(name(id))).join(', ')} depend on each other in a loop`).join('; ')}. The loop is drawn in rose; one of its Depends on lines is probably wrong.</div>` : '';

    const path = (pts) => 'M' + pts.map(([x, y]) => `${x} ${y}`).join(' L');
    const isLit = (e) => !lit || (lit.has(e.from) && lit.has(e.to));
    // Lit lines go last so they draw over the dim ones.
    const edges = [...L.edges].sort((a, b) => isLit(a) - isLit(b));
    const svg = `<svg class="rm-lines" width="${L.width}" height="${L.height}" aria-hidden="true">
      <defs><marker id="rm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>
      ${edges.map((e) => `<path d="${path(e.points)}" class="${e.cycle ? 'cycle' : ''} ${sel && isLit(e) ? 'lit' : ''} ${lit && !isLit(e) ? 'dim' : ''}" ${e.back || e.cycle ? 'marker-end="url(#rm-arrow)"' : ''}/>`).join('')}
    </svg>`;
    const labels = L.cols.map((c) => `<div class="rm-col" style="left:${c.x}px">${c.label}</div>`).join('');
    const cardsHtml = cards.map((c) => {
      const n = L.nodes.get(c.id);
      const q = c.col !== 0 && c.p.questions ? `<span class="rm-q" title="${c.p.questions} open question${c.p.questions > 1 ? 's' : ''}"></span>` : '';
      const cls = ['rm-card', 'c' + c.col, c.parked ? 'parked' : '', c.id === sel ? 'sel' : '', lit && !lit.has(c.id) ? 'dim' : ''].filter(Boolean).join(' ');
      return `<button class="${cls}" data-card="${esc(c.id)}" aria-pressed="${c.id === sel}" style="left:${n.x}px;top:${n.y}px" title="${esc(c.p.name)}">
        <span class="rm-t"><span class="clamp1">${esc(c.p.name)}</span>${q}</span>
        ${bars(c)}
        <span class="rm-sub">${esc(subline(c, byId))}</span>
      </button>`;
    }).join('');

    paint(el, `${head}<div class="rm-body">
      <div class="rm-main">${loopNote}<div class="rm-scroll"><div class="rm-board" style="width:${L.width}px;height:${L.height}px">${labels}${svg}${cardsHtml}</div></div></div>
      <aside class="rm-side">${side(sel && byId.get(sel), cards, byId, L)}</aside>
    </div>`);
  }

  // Live state arrives every few seconds: redraw only when something changed, and keep
  // the board where it was scrolled to.
  function paint(el, html) {
    if (el._rmHtml === html) return;
    const keep = [...el.querySelectorAll('.rm-scroll, .rm-body')].map((x) => [x.className, x.scrollLeft, x.scrollTop]);
    el.innerHTML = html;
    el._rmHtml = html;
    for (const [cls, l, t] of keep) {
      const x = el.querySelector('.' + cls.split(' ')[0]);
      if (x) { x.scrollLeft = l; x.scrollTop = t; }
    }
    wire(el);
  }

  function side(c, cards, byId, L) {
    if (!c) return `<p class="muted">Pick a plan to light up what it needs and what it unblocks.</p>`;
    const p = c.p;
    const status = c.parked ? 'parked' : STATUS_CHIP[c.col];
    const q = c.col !== 0 && p.questions ? ` · ${p.questions} question${p.questions > 1 ? 's' : ''}` : '';
    const list = (ids) => ids.map((id) => `<button class="rm-link" data-pick="${esc(id)}"><span class="clamp1">${esc(byId.get(id).p.name)}</span><span class="muted">${esc(subline(byId.get(id), byId))}</span></button>`).join('');
    const needs = c.deps;
    const unblocks = cards.filter((x) => x.deps.includes(c.id)).map((x) => x.id);
    const loop = L.cycles.find((g) => g.includes(c.id));
    return `<span class="rm-chip s-${status}">${status}${q}</span>
      <h2 class="rm-title">${esc(p.name)}</h2>
      ${p.goal ? `<p class="rm-goal">${esc(p.goal)}</p>` : ''}
      ${loop ? `<p class="rm-loopnote">In a loop with ${loop.filter((id) => id !== c.id).map((id) => esc(byId.get(id).p.name)).join(', ')}.</p>` : ''}
      ${needs.length ? `<div class="rm-list"><h3>Needs</h3>${list(needs)}</div>` : ''}
      ${unblocks.length ? `<div class="rm-list"><h3>Unblocks</h3>${list(unblocks)}</div>` : ''}
      <a href="#" class="rm-open" data-doc="${esc(p.file)}">Open plan</a>`;
  }

  function again() {
    if (last) render(last.el, last.projects, last.opts);
  }

  function wire(el) {
    el.querySelectorAll('[data-card]').forEach((b) => (b.onclick = () => {
      sel = sel === b.dataset.card ? null : b.dataset.card;
      again();
    }));
    el.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => {
      sel = b.dataset.pick;
      again();
      const card = el.querySelector(`[data-card="${CSS.escape(sel)}"]`);
      if (card) card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }));
    const back = el.querySelector('[data-rm-back]');
    if (back) back.onclick = (e) => {
      e.preventDefault();
      if (last && last.opts.onBack) last.opts.onBack();
    };
    const repo = el.querySelector('[data-rm-repo]');
    if (repo) repo.onchange = () => last && last.opts.onRepo && last.opts.onRepo(repo.value);
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sel && last && !last.el.hidden) {
        sel = null;
        again();
      }
    });
  }

  window.MontyRoadmap = {
    pick, layout, chain, loops, worth, render,
    select(id) { sel = id || null; again(); },
  };
})();
