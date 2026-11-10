// Monty panel. Runs in two places:
//   - a browser tab on http://127.0.0.1:4747 (optionally ?repo=/abs/path to scope it)
//   - a VS Code webview, where the extension sets window.MONTY = { host: true, repo, mode, file }
//     and passes state in via postMessage. Files then open as real editor tabs.
// Scoped to one repo, it shows only that repo's sessions and plans.
(function () {
  const { esc } = window.MontyMD;
  const $ = (id) => document.getElementById(id);
  const cfg = window.MONTY || {};
  const vscode = cfg.host && typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  // "Changed since last look" (reader-changes.js): its snapshots go through the extension in VS Code.
  const changes = window.MontyChanges;
  if (changes) changes.init({ post: vscode ? (m) => vscode.postMessage(m) : null });
  const markChanges = () => changes && changes.apply({ file: docFile, md: docMd, raw: rawView });
  const params = new URLSearchParams(location.search);
  const scope = cfg.repo || params.get('repo') || '';
  // summary: the VS Code sidebar, the minimum. full: the editor tab / browser, everything.
  const mode = cfg.mode === 'live' ? 'summary' : cfg.mode || 'full';
  const LIMIT = { activity: 10, files: 10 };
  let state = null;
  let selected = null;
  let rawView = false;
  let docMd = '';
  let docFile = '';
  const open = { activity: false, files: false, completed: false, skills: false };
  // Open/closed choices the user made. The page re-renders on every live update, so
  // without these a closed card would snap back to its default.
  const groupOpen = new Map(); // plan group label -> open
  // Lines clicked open stay open across live re-renders.
  const X = new Set();
  // Follow mode lives in the extension (per workspace); the page only shows and flips it.
  let follow = !!cfg.follow;
  const followToggle = () => vscode ? `<label class="switch" title="Opens each file the agent edits beside yours, new lines highlighted, so you can look over its shoulder"><input type="checkbox" data-follow ${follow ? 'checked' : ''}><span>Follow live file edits</span></label>` : '';
  const xp = (key) => `expandable${X.has(key) ? ' expanded' : ''}" data-x="${esc(key)}`;

  if (vscode) document.body.classList.add('vscode');
  if (cfg.mode === 'doc') document.body.classList.add('doc');
  document.body.classList.add('mode-' + mode);

  // Which tool a session is from. Shown only when a live session is not Claude Code, so
  // nothing changes for people who only use Claude Code.
  const AGENT_LABEL = { 'claude-code': 'Claude Code', opencode: 'opencode', codex: 'Codex', cline: 'Cline', roo: 'Roo Code', 'copilot-chat': 'Copilot' };
  const mixedAgents = () => !!state && state.sessions.some((x) => x.state !== 'idle' && x.agent && x.agent !== 'claude-code');
  const agentTag = (s) => (mixedAgents() && s.agent ? `<span class="agent">${esc(AGENT_LABEL[s.agent] || s.agent)}</span>` : '');
  // Tags are read at a glance, so they stay short; the voice lives in the reasons beside them.
  const STATE_LABEL = { working: 'At work', needs_input: 'Needs you', your_turn: 'Your move', done: 'All done', idle: 'Resting' };
  const KIND_LABEL = { read: 'Reading', edit: 'Editing', write: 'Writing', run: 'Running', test: 'Testing', search: 'Searching', web: 'Web', agent: 'Subagent', ask: 'Asking', plan: 'Planning', tool: 'Tool', prompt: 'You' };
  // Same colours as the activity dots (.k-* in style.css), for text.
  const KIND_COLOR = { read: 'var(--peri)', edit: 'var(--accent)', write: 'var(--accent)', run: 'var(--lilac)', test: 'var(--lilac)', ask: 'var(--orchid)', agent: '#818cf8' };

  function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 172800) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
  const clock = (iso) => (iso ? new Date(iso).toTimeString().slice(0, 5) : '');
  const base = (p) => p.split('/').pop();
  const dir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  // Long paths in reasons and activity: keep the file name.
  const tidy = (t) => t.replace(/\S*\/\S*\/\S+/g, (m) => m.split('/').pop());

  // The one progress bar, used wherever progress shows (sessions, plans, plan view, and
  // the menu bar dropdown draws the same): a segment per phase or task, violet when done,
  // pale lilac for the current one, dim to do. Capped at 12 segments so long task lists stay legible.
  function segBar(done, total, current = true, cls = '') {
    if (total < 1) return '';
    const n = Math.min(total, 12);
    const on = total <= 12 ? done : Math.round((done / total) * n);
    return `<div class="segs ${cls}" role="img" aria-label="${done} of ${total} done">${Array.from({ length: n }, (_, i) => `<span class="${i < on ? 'on' : i === on && current ? 'cur' : ''}"></span>`).join('')}</div>`;
  }

  // A session's progress: its own todo list, else its repo's active plan (current
  // Claude Code has no todo tools, so the plan is usually all there is).
  // Only a session at work has a current step to highlight.
  const busy = (s) => s.state === 'working' || s.state === 'needs_input';
  function progOf(s) {
    const { done, total } = s.progress;
    if (total) return { done, total, pct: Math.round((done / total) * 100), label: `${done} of ${total} tasks` };
    const p = s.plan;
    if (!p) return null;
    return { done: p.done, total: p.total, pct: Math.round((p.done / p.total) * 100), label: p.label, plan: p };
  }
  function progRow(s) {
    const g = progOf(s);
    if (!g) return '';
    const label = g.plan
      ? `<a href="#" class="clamp1" data-doc="${esc(g.plan.file)}" title="${esc(g.plan.name)}">${esc(g.label)} · <span class="muted">${esc(g.plan.name)}</span></a>`
      : `<span>${esc(g.label)}</span>`;
    return `<div class="prog">${label}</div>${segBar(g.done, g.total, busy(s))}`;
  }

  // ---------- host bridge ----------

  function openFile(abs, line) {
    if (!abs) return;
    // Markdown (and rule files that are markdown under another name) opens in the readable view, not as source.
    if (/\.(md|mdc)$/i.test(abs) || /\/\.(cursor|windsurf|cline)rules$/.test(abs)) return openDoc(abs);
    if (vscode) vscode.postMessage({ type: 'open', path: abs, line: line ? Number(line) : undefined });
    else location.href = 'vscode://file' + encodeURI(abs) + (line ? ':' + line : '');
  }
  function openDoc(file) {
    if (vscode) vscode.postMessage({ type: 'openDoc', file });
    else location.hash = '#doc=' + encodeURIComponent(file);
  }
  function openDetails() {
    if (vscode) vscode.postMessage({ type: 'openDetails' });
  }
  // ---------- roadmap (web/roadmap.js) ----------
  // Browser: #roadmap=<repo>&sel=<id>. VS Code: its own tab (mode 'roadmap').
  const RM = window.MontyRoadmap;
  let rmRepo = '';
  let rmSel = cfg.select || '';
  function openRoadmap(repo, id) {
    if (vscode) return vscode.postMessage({ type: 'openRoadmap', select: id || '' });
    location.hash = '#roadmap=' + encodeURIComponent(repo) + (id ? '&sel=' + encodeURIComponent(id) : '');
  }
  /** A "Roadmap" link for a repo, only when it has two cards or more (a view with nothing to show is hidden). */
  function roadmapIn(repo, id) {
    if (!repo || !state || !RM.worth(state.projects.filter((p) => p.repo === repo))) return '';
    return `<a href="#" class="rdm-in" data-roadmap="${esc(repo)}" data-sel="${esc(id || '')}">View roadmap</a>`;
  }
  /** The reader header's Roadmap tile: what this spec needs and unblocks. '' when the repo has no roadmap. */
  function roadmapTile(p) {
    if (!roadmapIn(p.repo, p.id)) return '';
    const byId = new Map(state.projects.map((x) => [x.id, x]));
    const needs = (p.dependsOn || []).map((id) => byId.get(id)).filter(Boolean);
    const open = needs.filter((x) => x.status !== 'completed');
    const unblocks = state.projects.filter((x) => (x.dependsOn || []).includes(p.id));
    const names = (xs) => xs.slice(0, 2).map((x) => esc(x.name)).join(', ') + (xs.length > 2 ? ` +${xs.length - 2}` : '');
    const [big, unit, cls, tip] = p.status === 'completed' ? ['Done', 'nothing left to wait on', 'rm-ok', 'This plan is finished.']
      : open.length ? [String(open.length), `${open.length === 1 ? 'plan' : 'plans'} to finish first`, 'rm-warn', `This plan depends on ${open.length === 1 ? 'a plan that is' : 'plans that are'} not finished yet. Build ${open.length === 1 ? 'it' : 'them'} first.`]
      : ['Ready', needs.length ? 'everything it needs is done' : 'waits on no other plan', 'rm-ok', needs.length ? 'Every plan this one depends on is finished, so it can be built now.' : 'No other plan has to be finished before this one can be built.'];
    const lines = [
      needs.length ? `<span data-tip="Plans this one depends on, from its Depends on line.">Needs ${names(needs)}</span>` : '',
      unblocks.length ? `<span data-tip="Plans that depend on this one and can start once it is done.">Unblocks ${names(unblocks)}</span>` : '',
    ].filter(Boolean);
    return `<div class="rm-tile"><div class="lbl" data-tip="How this plan fits with the repo's other plans: what it waits on and what waits on it.">Roadmap</div>
      <div class="rm-big ${cls}"><span data-tip="${esc(tip)}">${big}</span></div><div class="rm-unit">${unit}</div>
      <div class="rm-tsub">${lines.length ? lines.join('<br>') : '<span data-tip="No plan in this repo names this one in a Depends on, Requires or Blocked by line, and this one names none.">Not linked to other plans</span>'}</div>
      <a href="#" class="rm-act" data-roadmap="${esc(p.repo)}" data-sel="${esc(p.id)}">View roadmap</a></div>`;
  }
  function showRoadmap() {
    if (!state) return;
    const repos = [...new Set(state.projects.map((p) => p.repo))].sort();
    const want = rmRepo || (scope ? base(scope) : '');
    const repo = repos.includes(want) ? want : repos[0] || want;
    $('roadmap').hidden = false;
    RM.render($('roadmap'), state.projects.filter((p) => p.repo === repo), {
      repo, select: rmSel, repos: vscode || scope ? [] : repos, back: !vscode,
      onBack: () => (history.length > 1 ? history.back() : (location.hash = '')),
      onRepo: (r) => (location.hash = '#roadmap=' + encodeURIComponent(r)),
    });
  }
  const pendingDocs = new Map();
  function fetchDoc(file) {
    if (!vscode) return fetch('/api/doc?file=' + encodeURIComponent(file)).then((r) => (r.ok ? r.text() : `I couldn't find ${file}, I'm afraid.`));
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      pendingDocs.set(id, resolve);
      vscode.postMessage({ type: 'getDoc', file, id });
    });
  }
  // Shared with reader-hover.js: there is only one acquireVsCodeApi() handle per page.
  window.MontyHost = { vscode, state: () => state, fetchDoc };
  // JSON from the core: fetched directly in a browser, through the extension in VS Code
  // (the webview's CSP allows no network). Null when it fails.
  function fetchApi(p) {
    if (!vscode) return fetch(p).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      pendingDocs.set(id, resolve);
      vscode.postMessage({ type: 'api', path: p, id });
    });
  }
  // One click handler for every [data-open] link: files open in a new editor tab.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-open]');
    if (a) {
      e.preventDefault();
      openFile(a.dataset.open, a.dataset.line);
      return;
    }
    const d = e.target.closest('[data-doc]');
    if (d) {
      e.preventDefault();
      openDoc(d.dataset.doc);
      return;
    }
    const rm = e.target.closest('[data-roadmap]');
    if (rm) {
      e.preventDefault();
      openRoadmap(rm.dataset.roadmap, rm.dataset.sel);
      return;
    }
    if (e.target.closest('[data-details]')) {
      e.preventDefault();
      openDetails();
      return;
    }
    const x = e.target.closest('.expandable');
    if (x && !x.classList.contains('fits')) {
      x.classList.toggle('expanded');
      if (x.dataset.x) (x.classList.contains('expanded') ? X.add(x.dataset.x) : X.delete(x.dataset.x));
    }
  });

  document.addEventListener('change', (e) => {
    if (!e.target.matches || !e.target.matches('[data-follow]')) return;
    follow = e.target.checked;
    vscode.postMessage({ type: 'setFollow', on: follow });
  });

  // ---------- live session ----------

  // Runs a program started (a benchmark spawning `claude -p`): one quiet line, not a card each.
  function scriptedNote() {
    const xs = state.scripted || [];
    if (!xs.length) return '';
    return `<div class="scripted muted" title="Sessions started by a program (Claude Code SDK or claude -p). They are not listed and never notify.">${xs.length} scripted run${xs.length > 1 ? 's' : ''} at work, not shown</div>`;
  }

  function renderLive() {
    const sessions = state.sessions;
    const live = sessions.filter((s) => s.state !== 'idle');
    const shown = live.length ? live : sessions.slice(0, 1);
    if (!selected || !shown.some((s) => s.id === selected)) selected = shown[0] && shown[0].id;

    $('sessionTabs').innerHTML = (shown.length > 1 ? shown.map((s) => `
      <button class="tab" data-id="${esc(s.id)}" aria-current="${s.id === selected}" title="${esc(s.title)}">
        ${progOf(s) ? segBar(progOf(s).done, progOf(s).total, busy(s), 'mini') : ''}
        <span class="clamp1" style="max-width:220px">${esc(scope ? s.title : s.repo)}</span>
        <span class="tag st-${s.state}">${STATE_LABEL[s.state]}</span>${agentTag(s)}
      </button>`).join('') : '') + scriptedNote();
    $('sessionTabs').querySelectorAll('.tab').forEach((b) => (b.onclick = () => { selected = b.dataset.id; renderAll(); }));

    const s = shown.find((x) => x.id === selected);
    if (!s) {
      $('dock').innerHTML = '';
      $('detail').innerHTML = `<div class="empty">No session ${scope ? 'in ' + esc(base(scope)) + ' ' : ''}at present. I shall keep an eye out.</div>`;
      $('extra').innerHTML = '';
      return;
    }
    const inRepo =(f) => (s.cwd ? s.cwd + '/' + f : f);
    const acts = s.activity.filter((a) => a.kind !== 'prompt');
    const actRows = (open.activity ? acts : acts.slice(0, LIMIT.activity)).map((a) => `
      <${a.file ? `button class="row${a.failed ? ' fail' : ''}" data-open="${esc(inRepo(a.file))}"` : `div class="row${a.failed ? ' fail' : ''}"`} title="${esc(a.text)}">
        <time class="mono">${clock(a.time)}</time><span class="d k-${a.kind}"></span>
        <span class="x clamp1">${esc(tidy(a.text))}</span>
        ${a.plus ? `<span class="plus mono">+${a.plus}</span>` : ''}${a.minus ? `<span class="minus mono">−${a.minus}</span>` : ''}
      </${a.file ? 'button' : 'div'}>`).join('');
    const files = s.touched.filter((f) => !f.path.startsWith('/'));
    const fileRows = (open.files ? files : files.slice(0, LIMIT.files)).map((f) => `
      <button class="row" data-open="${esc(inRepo(f.path))}" title="${esc(f.path)}">
        <span class="x clamp1"><span>${esc(base(f.path))}</span> <span class="muted">${esc(dir(f.path))}</span></span>
        ${f.edits ? `<span class="plus mono">+${f.plus}</span>${f.minus ? `<span class="minus mono">−${f.minus}</span>` : ''}` : '<span class="muted" style="font-size:11px">read</span>'}
      </button>`).join('');
    const now = s.now;

    const [card, cols] = [`
      <div class="box lead">
        <div class="head">
          <span class="tag st-${s.state}">${STATE_LABEL[s.state]}</span>${agentTag(s)}
          ${s.state === 'working' ? '' : `<span class="muted clamp1 ${xp('fr' + s.id)}" style="font-size:12px" title="${esc(s.stateReason)}">${esc(tidy(s.stateReason))}</span>`}
          <span class="spacer"></span>
          <span class="muted" style="font-size:11px;white-space:nowrap">${scope ? '' : esc(s.repo) + ' · '}${ago(s.lastEventAt)}</span>
          ${followToggle()}
        </div>
        <div class="title clamp1 ${xp('ft' + s.id)}" title="${esc(s.title)}">${esc(s.title)}</div>
        ${progRow(s)}
        ${s.progress.total ? `
          <ul class="todos">${s.todos.map((t, i) => `<li class="${t.status}"><span class="dot">${t.status === 'completed' ? '✓' : ''}</span><span class="t clamp1 ${xp('td' + s.id + i)}" title="${esc(t.text)}">${esc(t.text)}</span></li>`).join('')}</ul>`
        : ''}
      </div>`, `
      <div class="cols">
        <div class="box"><h2>Activity</h2><div class="rows">${actRows || '<span class="muted">Nothing to report yet</span>'}</div>
          ${acts.length > LIMIT.activity ? `<button class="more" data-toggle="activity">${open.activity ? 'Show less' : `Show ${acts.length - LIMIT.activity} more`}</button>` : ''}</div>
        <div class="box"><h2>Files changed</h2><div class="rows">${fileRows || '<span class="muted">Untouched so far</span>'}</div>
          ${files.length > LIMIT.files ? `<button class="more" data-toggle="files">${open.files ? 'Show less' : `Show ${files.length - LIMIT.files} more`}</button>` : ''}
        </div>
      </div>`];
    // Context and the last test run are about the session, not its files: their own card beside it.
    const stats = statsCard(s);
    $('detail').innerHTML = `<div class="toprow">${card}${stats}</div>${now ? nowCard(s, now, inRepo) : ''}`;
    // The docked bar: what the top row says, in one line, for when it has scrolled away.
    const g = progOf(s);
    $('dock').innerHTML = `<div class="dock-in">
      <span class="tag st-${s.state}">${STATE_LABEL[s.state]}</span>${agentTag(s)}
      <span class="dock-title clamp1" title="${esc(s.title)}">${esc(s.title)}</span>
      ${g ? `<span class="dock-prog"><span class="muted clamp1">${esc(g.label)}</span>${segBar(g.done, g.total, busy(s), 'dockbar')}</span>` : ''}
      <span class="dock-ctx"><span class="muted">Context ${s.context.pct}%</span><span class="bar thin ${ctxClass(s.context.pct)}"><span style="width:${s.context.pct}%"></span></span></span>
      ${speedo(s.throughput, false, 'dock' + s.id)}
    </div>`;
    watchDock();
    $('extra').innerHTML = cols;
    $('extra').querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => { open[b.dataset.toggle] = !open[b.dataset.toggle]; renderLive(); }));
  }

  // The effort speedometer: tokens in and out per minute over the last 5 minutes, as a half
  // dial. The core sets `level` (0..1, full scale 20k/min from real logs) so every surface agrees.
  const kTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
  // Each gauge keeps its last reading, so a redraw starts the arc where it was and
  // eases it to the new value (animateSpeedos) instead of jumping.
  const speedoAt = new Map(); // key -> level last shown
  const zoneOf = (l) => (l >= 0.85 ? 'var(--rose)' : l >= 0.5 ? 'var(--accent)' : 'var(--peri)');
  function speedo(t, big = false, key = '') {
    if (!t) return '';
    const level = Math.max(0, Math.min(1, t.level || 0));
    const from = speedoAt.has(key) ? speedoAt.get(key) : level;
    // A fixed-size dial with the count inside the arc: the number can grow from "9" to
    // "12k" without moving anything around it.
    const w = big ? 72 : 56, h = big ? 40 : 32, sw = big ? 6 : 5, r = w / 2 - sw / 2 - 1, cx = w / 2, cy = h - 2;
    const half = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
    const len = Math.PI * r;
    const total = t.inPerMin + t.outPerMin;
    return `<span class="speedo${big ? ' big' : ''}" data-k="${esc(key)}" data-level="${level}" title="${total.toLocaleString()} tokens per minute right now (${t.inPerMin.toLocaleString()} in, ${t.outPerMin.toLocaleString()} out)">
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${total.toLocaleString()} tokens per minute">
        <path d="${half}" class="track" stroke-width="${sw}"/>
        <path d="${half}" class="fill" stroke-width="${sw}" stroke="${zoneOf(from)}" stroke-dasharray="${len.toFixed(2)}" stroke-dashoffset="${(len * (1 - from)).toFixed(2)}" data-len="${len.toFixed(2)}" style="opacity:${from > 0.005 ? 1 : 0}"/>
        <text x="${cx}" y="${cy - 1}" text-anchor="middle" class="count">${kTok(total)}</text>
      </svg>
    </span>`;
  }
  function animateSpeedos() {
    const els = [...document.querySelectorAll('.speedo[data-k]')];
    if (!els.length) return;
    requestAnimationFrame(() => els.forEach((el) => {
      const to = Number(el.dataset.level);
      const fill = el.querySelector('.fill');
      if (fill) {
        fill.style.strokeDashoffset = String(Number(fill.dataset.len) * (1 - to));
        fill.style.stroke = zoneOf(to);
        fill.style.opacity = to > 0.005 ? '1' : '0'; // a round cap would leave a dot at zero
      }
      speedoAt.set(el.dataset.k, to);
    }));
  }

  /** Secondary facts about a session (context, last test run, subagents), kept out of the main card. */
  function statsCard(s, compact = false) {
    return `<div class="box stats${compact ? ' compact' : ''}">
      ${compact ? '' : '<h2>Session</h2>'}
      <div class="ctx"><span>Context</span><span>${s.context.pct}%${compact ? '' : ` · ${Math.round(s.context.tokens / 1000)}k of ${Math.round(s.context.window / 1000)}k`}</span></div>
      <div class="bar thin ${ctxClass(s.context.pct)}"><div style="width:${s.context.pct}%"></div></div>
      ${s.throughput ? `<div class="stat effort"><span class="muted">Tokens/min</span>${speedo(s.throughput, !compact, (compact ? 'side' : 'stats') + s.id)}</div>` : ''}
      ${s.lastTest ? `<div class="stat"><span class="muted">Last test run</span><span class="clamp1" style="color:${s.lastTest.ok ? 'var(--ok)' : 'var(--rose)'}" title="${esc(s.lastTest.summary)}">${esc(compact ? (s.lastTest.ok ? 'Passing' : 'Failing') : s.lastTest.summary.replace(/^Tests:\s*/, ''))}</span></div>` : ''}
      ${s.subagentsRunning ? `<div class="stat"><span class="muted">Subagents</span><span>${s.subagentsRunning} running</span></div>` : ''}
    </div>`;
  }

  // Docks the progress and context to the top edge once the session's top row has
  // scrolled out of view, and lets go when it scrolls back, like the plan view's status card.
  let dockObserver = null;
  let dockTarget = null;
  function watchDock() {
    const row = document.querySelector('#detail .toprow');
    if (!row || row === dockTarget || typeof IntersectionObserver === 'undefined') return;
    dockTarget = row;
    if (dockObserver) dockObserver.disconnect();
    const header = document.getElementById('top');
    const offset = header && getComputedStyle(header).display !== 'none' ? header.offsetHeight : 0;
    $('dock').style.top = offset + 'px';
    dockObserver = new IntersectionObserver(([e]) => {
      const stuck = !e.isIntersecting && e.boundingClientRect.top < offset;
      $('dock').classList.toggle('shown', stuck);
      $('dock').setAttribute('aria-hidden', String(!stuck));
    }, { rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 });
    dockObserver.observe(row);
  }

  // The NOW card, after the mockup: what Claude is doing (or did last), its file and diff.
  function nowCard(s, now, inRepo) {
    const live = s.state === 'working' || s.state === 'needs_input';
    const label = live ? 'NOW · ' + (KIND_LABEL[now.kind] || 'Working').toUpperCase() : 'LAST';
    return `<div class="box lead now${live ? '' : ' past'}">
      <div class="nk"><span class="d k-${now.kind}"></span><span class="k"${live ? ` style="color:${KIND_COLOR[now.kind] || 'var(--accent)'}"` : ''}>${label}</span><span class="spacer"></span><time class="mono">${clock(now.time)}</time></div>
      <div class="nt clamp1 ${xp('nw' + s.id)}" title="${esc(now.text)}">${esc(tidy(now.text))}</div>
      ${now.file || now.plus || now.minus ? `<div class="nf">
        ${now.file ? `<button class="chip mono" data-open="${esc(inRepo(now.file))}" title="${esc(now.file)}">${esc(now.file)}</button>` : ''}
        ${now.plus ? `<span class="plus mono">+${now.plus}</span>` : ''}${now.minus ? `<span class="minus mono">−${now.minus}</span>` : ''}</div>` : ''}
    </div>`;
  }
  // Context bar colour by how full it is: periwinkle, then violet past half, rose past three quarters.
  const ctxClass = (pct) => (pct >= 75 ? 'high' : pct >= 50 ? 'mid' : 'low');

  // ---------- plans ----------

  function segs(p) {
    const { done, total, basis } = p.progress;
    if (basis === 'status' || total < 2) return '';
    return segBar(done, total, p.status === 'active');
  }
  function progressLabel(p) {
    if (p.label !== undefined) return p.label;
    const { done, total, basis } = p.progress;
    if (basis === 'phases') return p.status === 'completed' ? `${total} phases` : done >= total ? `All ${total} phases done` : `Phase ${done + 1} of ${total}`;
    if (basis === 'tasks') return `${done}/${total} tasks`;
    return p.status === 'cancelled' ? 'cancelled' : '';
  }
  function planRow(p) {
    return `<a href="#" class="plan" data-doc="${esc(p.file)}" title="${esc(p.name)}">
      <div class="l1">${scope ? '' : `<span class="repo">${esc(p.repo)}</span>`}<span class="n clamp1">${esc(p.name)}</span><span class="lab">${esc(progressLabel(p))}</span></div>
      ${segs(p)}</a>`;
  }

  function renderPlans() {
    let projects = state.projects;
    const pick = $('repoFilter').value;
    if (!scope && pick) projects = projects.filter((p) => p.repo === pick);
    const by = (k) => projects.filter((p) => p.status === k).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const active = by('active');
    const pending = by('pending');
    const parked = by('parked');
    const finished = projects.filter((p) => p.status === 'completed' || p.status === 'cancelled').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
    // A closed column still shows its most recent plan; the chevron opens the rest.
    const group = (label, items, isOpen) => {
      if (!items.length) return '';
      const opened = groupOpen.has(label) ? groupOpen.get(label) : isOpen;
      const more = items.length > 1;
      return `<div class="group${opened ? ' open' : ''}">
        ${more ? `<button class="group-h" data-group="${label}" aria-expanded="${opened}"><span>${label} · ${items.length}</span></button>` : `<div class="group-h static"><span>${label} · 1</span></div>`}
        ${(opened ? items : items.slice(0, 1)).map(planRow).join('')}</div>`;
    };
    // Left to right in the order work moves: planned, under way, done. Parked sits off the line, at the end.
    const html = group('Pending', pending, active.length < 3) + group('Active', active, true) + group('Recently done', finished, false) + group('Parked', parked, false);
    const rmFor = scope ? base(scope) : pick || (new Set(projects.map((p) => p.repo)).size === 1 ? projects[0].repo : '');
    $('plans').innerHTML = projects.length ? `<div class="box"><h2>Plans${roadmapIn(rmFor)}</h2><div class="board">${html}</div></div>` : (scope ? '' : '<div class="empty">No plans about. How restful.</div>');
    $('plans').querySelectorAll('[data-group]').forEach((b) => (b.onclick = () => {
      groupOpen.set(b.dataset.group, b.getAttribute('aria-expanded') !== 'true');
      renderPlans();
      markFits();
    }));
  }

  // ---------- AI tool setup ----------
  // What the repo is set up with (src/setup.ts): tools, instructions files, skills and
  // commands, rules pulled from those files, guardrails. The sidebar gets the short card,
  // the details tab the full one.

  // The sidebar's Config card stays short: three, then "Show more".
  const SETUP_ROWS = 3;
  function repoSetup() {
    const all = state.setups || [];
    if (scope) return all[0] || null;
    const pick = $('repoFilter').value;
    return pick ? all.find((x) => x.repo === pick) || null : null;
  }
  /** The skill or command the repo's session ran last, if it is one of the repo's own. */
  function inUseName(setup) {
    const s = state.sessions.find((x) => x.state !== 'idle' && x.inUse);
    if (!s) return null;
    const n = s.inUse.name.split(':').pop();
    return setup.skills.some((k) => k.name === n || k.name === s.inUse.name) ? n : null;
  }
  const skillName = (k) => (k.kind === 'command' ? '/' + k.name : k.name);
  const KIND_NOUN = { skill: 'skill', command: 'command', agent: 'agent', prompt: 'prompt' };
  // Skills first, then commands, agents, prompts; the one in use leads its list.
  function orderedSkills(setup, using) {
    const rank = { skill: 0, command: 1, agent: 2, prompt: 3 };
    return [...setup.skills].sort((a, b) => (b.name === using) - (a.name === using) || rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
  }

  function setupSummary(setup) {
    const using = inUseName(setup);
    const list = orderedSkills(setup, using);
    const shown = open.skills ? list : list.slice(0, SETUP_ROWS);
    const rows = shown.map((k) => `<a href="#" class="row skill${k.name === using ? ' using' : ''}" data-doc="${esc(k.file)}" title="${esc(k.description || skillName(k))}">
      <span class="x clamp1">${esc(skillName(k))}</span>${k.name === using ? '<span class="tag st-working">in use</span>' : `<span class="muted kind">${KIND_NOUN[k.kind]}</span>`}</a>`).join('');
    return `<div class="box setupcard">
      <h2>Config</h2>
      <div class="chips toolchips">${setup.tools.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      ${rows ? `<div class="rows">${rows}</div>` : ''}
      ${list.length > SETUP_ROWS ? `<button class="more" data-toggle-skills>${open.skills ? 'Show less' : `Show ${list.length - SETUP_ROWS} more`}</button>` : ''}
    </div>`;
  }

  // The details tab's Project config: four sections, each collapsed to a one-line
  // summary so the card reads as an overview, opening into tiles rather than bare rows.
  function setupFull(setup) {
    const using = inUseName(setup);
    const g = setup.guardrails;
    const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
    const section = (key, title, preview, body) => `
      <details class="cfg" ${groupOpen.get(key) ? 'open' : ''} data-key="${key}">
        <summary><span class="cfg-t">${title}</span><span class="cfg-p muted clamp1">${preview}</span></summary>
        <div class="cfg-in">${body}</div>
      </details>`;

    const files = setup.instructions.map((i) => {
      const meta = [i.description, i.globs ? 'applies to ' + i.globs : '', i.alwaysApply ? 'always on' : ''].filter(Boolean).join(' · ');
      return `<a href="#" class="tile" data-open="${esc(i.file)}" title="${esc(i.file)}">
        <span class="tile-h"><span class="mono">${esc(i.label)}</span></span>
        ${meta ? `<span class="tile-d muted clamp2">${esc(meta)}</span>` : ''}</a>`;
    }).join('');

    // Rules under the heading they came from, so "Trust Contract" rules read as a set.
    const byHeading = new Map();
    for (const r of setup.rules) {
      const h = r.heading || 'Rules';
      if (!byHeading.has(h)) byHeading.set(h, []);
      byHeading.get(h).push(r);
    }
    const rules = [...byHeading].map(([h, list]) => `<div class="rulegroup"><div class="cfg-sub">${esc(h)}</div><ul class="rules">${list.map((r) => `
      <li><span class="${xp('rule' + r.label)} clamp2" title="${esc(r.text)}">${esc(r.text)}</span>
        <a href="#" class="src mono" data-open="${esc(r.file)}" title="Open ${esc(r.label)}">${esc(r.label)}</a></li>`).join('')}</ul></div>`).join('');

    const skills = orderedSkills(setup, using).map((k) => `<a href="#" class="tile skilltile${k.name === using ? ' using' : ''}" data-open="${esc(k.file)}" title="${esc(k.description || skillName(k))}">
      <span class="tile-h"><b>${esc(skillName(k))}</b>${k.name === using ? '<span class="tag st-working">in use</span>' : `<span class="tag st-idle">${KIND_NOUN[k.kind]}</span>`}</span>
      ${k.description ? `<span class="tile-d muted clamp2">${esc(k.description)}</span>` : ''}</a>`).join('');

    const guardParts = [];
    if (g.deny.length) guardParts.push(`<div class="cfg-sub">Blocked commands</div><div class="pills">${g.deny.map((d) => `<span class="pill-deny mono">${esc(d)}</span>`).join('')}</div>`);
    if (g.hooks.length) guardParts.push(`<div class="cfg-sub">Hooks</div><ul class="rules">${g.hooks.map((h) => `<li><span><b>${esc(h.event)}</b>${h.matcher ? ` <span class="muted">on ${esc(h.matcher)}</span>` : ''}</span><span class="mono muted clamp1 ${xp('hk' + h.event + h.command)}" title="${esc(h.command)}">${esc(h.command)}</span></li>`).join('')}</ul>`);
    if (g.mcp.length) guardParts.push(`<div class="cfg-sub">MCP servers</div><ul class="rules">${g.mcp.map((m) => `<li><span><b>${esc(m.name)}</b></span><span class="mono muted clamp1" title="${esc(m.detail)}">${esc(m.detail)}</span></li>`).join('')}</ul>`);

    const kinds = {};
    for (const k of setup.skills) kinds[k.kind] = (kinds[k.kind] || 0) + 1;
    const skillPreview = [kinds.skill && plural(kinds.skill, 'skill'), kinds.command && plural(kinds.command, 'command'), kinds.agent && plural(kinds.agent, 'agent'), kinds.prompt && plural(kinds.prompt, 'prompt')].filter(Boolean).join(', ')
      + (using ? ` · <span class="using-inline">${esc(using)} in use</span>` : '');
    const ruleFiles = [...new Set(setup.rules.map((r) => r.label.split(':')[0]))];
    const guardPreview = [g.deny.length && plural(g.deny.length, 'blocked command'), g.hooks.length && plural(g.hooks.length, 'hook'), g.mcp.length && plural(g.mcp.length, 'MCP server')].filter(Boolean).join(' · ');

    const cardOpen = groupOpen.has('setup') ? groupOpen.get('setup') : true;
    return `<details class="box setupfull" ${cardOpen ? 'open' : ''} data-key="setup">
      <summary><h2>Project config</h2><span class="chips toolchips">${setup.tools.map((t) => `<span>${esc(t)}</span>`).join('')}</span></summary>
      <div class="setupbody">
        ${setup.instructions.length ? section('s-instr', 'Instructions', esc(setup.instructions.map((i) => i.label).join(', ')), `<div class="tiles">${files}</div>`) : ''}
        ${setup.rules.length ? section('s-rules', 'Key rules', esc(`${plural(setup.rules.length, 'rule')} from ${ruleFiles.join(', ')}`), rules) : ''}
        ${setup.skills.length ? section('s-skills', 'Skills and commands', skillPreview, `<div class="tiles">${skills}</div>`) : ''}
        ${guardParts.length ? section('s-guard', 'Guardrails', esc(guardPreview), guardParts.join('')) : ''}
      </div>
    </details>`;
  }

  function renderSetup() {
    const setup = repoSetup();
    $('setup').innerHTML = setup && mode === 'summary' ? setupSummary(setup) : '';
    $('setupFull').innerHTML = setup && mode !== 'summary' ? setupFull(setup) : '';
    const sk = document.querySelector('[data-toggle-skills]');
    if (sk) sk.onclick = () => { open.skills = !open.skills; renderSetup(); };
    $('setupFull').querySelectorAll('details[data-key]').forEach((d) => (d.ontoggle = () => groupOpen.set(d.dataset.key, d.open)));
  }

  // ---------- sidebar summary ----------

  function renderSummary() {
    const sessions = state.sessions.filter((s) => s.state !== 'idle');
    const sCard = (s) => {
      const now = s.now;
      return `<div class="box lead sum">
        <div class="head"><span class="tag st-${s.state}">${STATE_LABEL[s.state]}</span>${agentTag(s)}<span class="spacer"></span><span class="muted" style="font-size:11px">${ago(s.lastEventAt)}</span></div>
        <div class="title clamp2 ${xp('t' + s.id)}" title="${esc(s.title)}">${esc(s.title)}</div>
        ${progRow(s)}
        ${s.state === 'needs_input' ? `<div class="reason clamp2 ${xp('r' + s.id)}" title="${esc(s.stateReason)}">${esc(tidy(s.stateReason))}</div>`
          : s.state === 'working' && now ? `<div class="reason clamp2 ${xp('n' + s.id)}" title="${esc(now.text)}">${esc(tidy(now.text))}</div>`
          : ''}
      </div>`;
    };
    const active = state.projects.filter((p) => p.status === 'active');
    const pending = state.projects.filter((p) => p.status === 'pending');
    const shownByCard = new Set(sessions.slice(0, 3).map((x) => x.plan && x.plan.file).filter(Boolean));
    const plans = [...active, ...pending].filter((p) => !shownByCard.has(p.file)).slice(0, 4);
    $('sessionTabs').innerHTML = '';
    // Context and tests are secondary: below the plans, for the session the sidebar leads with.
    $('stats').innerHTML = sessions.length ? statsCard(sessions[0], true) : '';
    $('detail').innerHTML = (sessions.length ? sessions.slice(0, 3).map(sCard).join('')
      : `<div class="empty">No session in ${esc(base(scope || 'this repo'))} at present. I shall keep an eye out.</div>`) + scriptedNote();
    $('extra').innerHTML = '';
    $('footer').innerHTML = `${vscode ? `<div class="box followcard">${followToggle()}</div>` : ''}<button class="btn wide" data-details>Open details</button>`;
    $('plans').innerHTML = plans.length ? `<div class="box lead"><h2>Plans${roadmapIn(plans[0].repo)}</h2>${plans.map(planRow).join('')}
      ${state.projects.length > plans.length ? `<a href="#" class="more" data-details>All ${state.projects.length} plans</a>` : ''}</div>` : '';
  }

  function renderAll() {
    if (!state) return;
    if (cfg.mode === 'doc') return;
    if (cfg.mode === 'roadmap') return showRoadmap();
    if (!$('roadmap').hidden) showRoadmap();
    if (!scope) {
      const repos = [...new Set(state.projects.map((p) => p.repo))].sort();
      const sel = $('repoFilter');
      const keep = sel.value;
      sel.innerHTML = '<option value="">All</option>' + repos.map((r) => `<option ${r === keep ? 'selected' : ''}>${esc(r)}</option>`).join('');
    } else {
      $('repoPick').hidden = true;
      $('scopeName').textContent = 'Monty · ' + base(scope);
    }
    if (mode === 'summary') renderSummary();
    else {
      $('stats').innerHTML = '';
      renderLive();
      renderPlans();
      // Plans per file (history.js): needs one repo, the scope or the one picked.
      const picked = !scope && $('repoFilter').value && state.projects.find((p) => p.repo === $('repoFilter').value);
      if (window.MontyHistory) window.MontyHistory.update($('history'), scope || (picked ? picked.repoPath : ''), { esc, vscode });
    }
    renderSetup();
    markFits();
    animateSpeedos();
    const needs = state.sessions.filter((s) => s.state === 'needs_input').length;
    document.title = needs ? `(${needs}) Monty` : 'Monty';
  }

  // Text that is clamped to a line or two expands on click. Text that already fits gets
  // no pointer and no click, so nothing looks clickable that is not.
  function markFits() {
    requestAnimationFrame(() => document.querySelectorAll('.expandable').forEach((el) => {
      if (el.classList.contains('expanded')) return el.classList.remove('fits');
      const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      el.classList.toggle('fits', !cut);
    }));
  }
  window.addEventListener('resize', () => markFits());

  // ---------- reader ----------

  async function showDoc(file) {
    docFile = file;
    $('reader').hidden = false;
    $('docPath').textContent = file.split('/').slice(-3).join('/');
    $('docPath').title = file;
    docMd = await fetchDoc(file);
    lastDocHtml = '';
    renderDoc();
  }

  // Brief and Full come from reader-modes.js; Raw is the file as written.
  let lastDocHtml = '';
  function renderDoc() {
    // A spec framework splits one change across files (proposal, design, tasks): any of them
    // shows the change's header and progress.
    const p = state && (state.projects.find((x) => x.file === docFile) || state.projects.find((x) => x.docs && x.docs.includes(docFile)));
    const R = window.MontyReader;
    const mode = rawView ? 'raw' : R.modeFor(!!p);
    $('reader').dataset.mode = mode;
    $('viewBrief').hidden = !p;
    $('viewBrief').setAttribute('aria-pressed', String(mode === 'brief'));
    $('viewNice').setAttribute('aria-pressed', String(mode === 'full'));
    $('viewRaw').setAttribute('aria-pressed', String(mode === 'raw'));
    if (rawView) {
      lastDocHtml = '';
      $('doc').innerHTML = `<div class="raw">${esc(docMd)}</div>`;
      $('docSide').innerHTML = '';
      $('docTop').innerHTML = '';
      markChanges();
      return;
    }
    const out = R.render({ md: docMd, file: docFile, project: p, state, mode, frontmatter, nameFromPath, docKind });
    // A row of tiles under the reader's headline card: footprint (filled by web/footprint.js
    // once its data arrives), roadmap and blast radius. A tile with nothing to show is left out.
    const extras = p ? '<div class="rm-tile" data-tile="footprint" hidden></div>' + roadmapTile(p) + (window.MontyBlast ? window.MontyBlast.tile(p) : '') : '';
    // Live state arrives every second or so; redrawing the same page would reset what the
    // reader has open and where the caret is.
    const html = out.doc + '\u0000' + out.side + '\u0000' + extras;
    if (html === lastDocHtml) return;
    lastDocHtml = html;
    $('docTop').innerHTML = '';
    $('doc').innerHTML = out.doc;
    $('docSide').innerHTML = out.side;
    if (extras) {
      const head = $('doc').querySelector('.rm-head');
      if (head) head.insertAdjacentHTML('beforeend', `<div class="rm-tiles">${extras}</div>`);
    }
    renderMermaid($('doc'));
    R.wire($('readerbody'));
    // Where the spec's work lands in the repo (web/footprint.js); hidden when there is nothing to show.
    if (p && window.MontyFootprint) window.MontyFootprint.side(p, { api: fetchApi, side: $('docSide'), reader: $('reader') });
    markChanges();
  }

  // ---------- mermaid ----------
  // Rendered from the vendored script (web/vendor), so diagrams work offline. Loaded only
  // when a plan has a mermaid block; results are cached by source so live re-renders of
  // the plan (Claude ticking a phase) do not redraw every diagram.
  const diagrams = new Map(); // source -> svg, or null when it failed
  let mermaidReady = null;
  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = cfg.mermaidSrc || 'vendor/mermaid.min.js';
      if (cfg.nonce) el.nonce = cfg.nonce; // the VS Code webview's CSP only runs scripts carrying its nonce
      el.onload = () => {
        const light = document.body.classList.contains('vscode-light');
        // Dark diagrams take the panel's violet palette instead of Mermaid's stock grey-green.
        const dark = { primaryColor: '#2a2436', primaryBorderColor: '#a78bfa', primaryTextColor: '#ece8f3', secondaryColor: '#221e2a', tertiaryColor: '#19161f', lineColor: '#cfc8da', textColor: '#ece8f3', actorBkg: '#2a2436', actorBorder: '#a78bfa', actorTextColor: '#ece8f3', signalColor: '#cfc8da', signalTextColor: '#ece8f3', noteBkgColor: '#332d3e', noteTextColor: '#ece8f3', noteBorderColor: '#8b5cf6' };
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: light ? 'default' : 'base', themeVariables: light ? undefined : dark, fontFamily: getComputedStyle(document.body).fontFamily });
        resolve(window.mermaid);
      };
      el.onerror = reject;
      document.head.appendChild(el);
    });
    return mermaidReady;
  }
  let diagramId = 0;
  function renderMermaid(root) {
    const blocks = [...root.querySelectorAll('pre[data-lang="mermaid"]')];
    if (!blocks.length) return;
    const place = (pre, svg) => {
      if (!pre.isConnected) return;
      if (svg === null) { pre.classList.add('mermaid-failed'); pre.title = 'This diagram got the better of me; here is its source instead'; return; }
      const box = document.createElement('div');
      box.className = 'mermaid';
      box.innerHTML = svg;
      pre.replaceWith(box);
    };
    for (const pre of blocks) {
      const src = pre.textContent;
      if (diagrams.has(src)) { place(pre, diagrams.get(src)); continue; }
      loadMermaid()
        .then((m) => m.render('mmd' + ++diagramId, src))
        .then(({ svg }) => { diagrams.set(src, svg); place(pre, svg); })
        .catch(() => { diagrams.set(src, null); place(pre, null); });
    }
  }

  /** YAML-ish frontmatter (`key: value` between --- fences, folded values joined), as src/setup.ts reads it. */
  function frontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[^\n]*\n?/.exec(text);
    if (!m) return { data: {}, body: text };
    const data = {};
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
      if (!kv) continue;
      let v = kv[2].trim();
      if (/^[>|]-?$/.test(v) || v === '') {
        const more = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim().replace(/^-\s+/, ''));
        v = more.join(v === '' ? ', ' : ' ');
      }
      data[kv[1]] = v.replace(/^(["'])(.*)\1$/, '$2');
    }
    return { data, body: text.slice(m[0].length) };
  }
  // No heading and no name: .claude/skills/complete/SKILL.md is "complete", not "Untitled".
  function nameFromPath(file) {
    const parts = file.split('/');
    const f = parts.pop() || '';
    if (/^(SKILL|README|index)\.md$/i.test(f) && parts.length) return parts.pop();
    return f.replace(/\.(prompt|instructions)?\.?(md|mdc)$/i, '') || f;
  }
  function docKind(file) {
    if (/\/\.claude\/skills\//.test(file)) return 'Skill';
    if (/\/\.claude\/commands\//.test(file)) return 'Command';
    if (/\/\.claude\/agents\//.test(file)) return 'Agent';
    if (/\.mdc$/.test(file) || /\.cursorrules$/.test(file)) return 'Cursor rule';
    if (/\.prompt\.md$/.test(file)) return 'Prompt';
    if (/\.instructions\.md$|copilot-instructions\.md$/.test(file)) return 'Copilot instructions';
    if (/\/(CLAUDE|AGENTS|GEMINI)\.md$/.test(file)) return 'Instructions';
    return '';
  }

  // The status card docks to the top edge once the page scrolls, and back when it returns.
  const rb = $('readerbody');
  const dock = () => {
    rb.style.setProperty('--padpx', getComputedStyle(rb).paddingLeft);
    $('docTop').classList.toggle('stuck', rb.scrollTop > 12);
  };
  rb.addEventListener('scroll', dock, { passive: true });
  window.addEventListener('resize', dock);

  window.MontyReader.init({ vscode, mode: cfg.readerMode, rerender: () => { lastDocHtml = ''; renderDoc(); }, reload: () => (vscode && cfg.mode === 'doc' ? renderDoc() : showDoc(docFile)) });
  $('viewBrief').onclick = () => { rawView = false; window.MontyReader.setMode('brief'); renderDoc(); };
  $('viewNice').onclick = () => { rawView = false; window.MontyReader.setMode('full'); renderDoc(); };
  $('viewRaw').onclick = () => {
    if (vscode && cfg.mode === 'doc') return vscode.postMessage({ type: 'editAsText', file: docFile });
    rawView = true;
    renderDoc();
  };
  if (vscode && cfg.mode === 'doc') $('viewRaw').textContent = 'Edit';
  $('back').onclick = (e) => { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = ''); };
  $('repoFilter').onchange = renderAll;

  function route() {
    const h = location.hash;
    if (h.startsWith('#doc=')) {
      $('roadmap').hidden = true;
      return showDoc(decodeURIComponent(h.slice(5)));
    }
    $('reader').hidden = true;
    if (h.startsWith('#roadmap=')) {
      const q = new URLSearchParams(h.slice(1));
      rmRepo = q.get('roadmap') || '';
      rmSel = q.get('sel') || '';
      return showRoadmap();
    }
    $('roadmap').hidden = true;
  }

  // ---------- data ----------

  function onState(next) {
    const first = !state;
    state = next;
    renderAll();
    if (cfg.mode === 'doc') {
      if (docMd) renderDoc(); // picks up phases and status once state arrives
    } else if (first && !vscode) route();
  }

  // A plan opened in its own tab does not need live state to render.
  if (cfg.mode === 'doc' && cfg.file) showDoc(cfg.file);

  if (vscode) {
    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type === 'state') onState(m.state);
      if (m.type === 'doc' && pendingDocs.has(m.id)) { pendingDocs.get(m.id)(m.text); pendingDocs.delete(m.id); }
      if (m.type === 'api' && pendingDocs.has(m.id)) { pendingDocs.get(m.id)(m.body); pendingDocs.delete(m.id); }
      // The plan changed on disk or in an editor (Claude ticking a phase): re-render live.
      if (m.type === 'docText' && cfg.mode === 'doc') { docMd = m.text; renderDoc(); }
      if (m.type === 'roadmapSelect') { rmSel = m.id || ''; RM.select(rmSel); }
      if (m.type === 'follow') { follow = !!m.on; renderAll(); }
      if (m.type === 'history' && window.MontyHistory) window.MontyHistory.onMessage(m);
      if (m.type === 'offline') $('detail').innerHTML = `<div class="empty">${esc(m.message)}</div>`;
    });
    vscode.postMessage({ type: 'ready' });
  } else {
    window.addEventListener('hashchange', route);
    const es = new EventSource('/api/events' + (scope ? '?repo=' + encodeURIComponent(scope) : ''));
    es.onopen = () => { $('conn').textContent = 'on duty'; $('conn').className = 'pill ok'; };
    es.onerror = () => { $('conn').textContent = 'one moment…'; $('conn').className = 'pill'; };
    es.onmessage = (ev) => onState(JSON.parse(ev.data));
  }
})();
