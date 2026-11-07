// Shared pieces every panel view uses, so they look and behave the same:
//
// - MontyOverlay: a full-window sheet for a map view (footprint, blast radius, roadmap).
//   A bar on top names the view on the left and has Close on the right; Esc closes the
//   topmost one. Views render their own content into the sheet's body.
// - Tooltips: any element with data-tip="..." explains itself on hover or keyboard focus.
//
// Loaded before the views that use it, in the browser panel and the VS Code webview.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- overlay ----------

  /**
   * The sheet's top bar. kind names the view ("Footprint map"), title what it is about,
   * sub one plain sentence on what the view shows. controls is extra HTML (a legend, a
   * picker) placed before Close. closable: false where the view is its own tab.
   */
  function bar({ kind, title, sub, controls, closable = true }) {
    return `<div class="ov-bar">
      <div class="ov-names">
        <span class="ov-kind">${esc(kind)}</span>
        ${title ? `<span class="ov-title clamp1">${esc(title)}</span>` : ''}
        ${sub ? `<span class="ov-sub">${esc(sub)}</span>` : ''}
      </div>
      ${controls ? `<div class="ov-controls">${controls}</div>` : ''}
      ${closable ? '<button class="ov-close" data-ov-close data-tip="Close (Esc)" aria-label="Close">Close <span aria-hidden="true">✕</span></button>' : ''}
    </div>`;
  }

  /** Makes el (or a new element on <body>) a sheet; onClose runs on Close and on Esc. */
  function adopt(el, onClose) {
    el.classList.add('ov');
    el.addEventListener('ov-close', () => onClose());
    return el;
  }
  function create(onClose) {
    const el = document.createElement('div');
    el.hidden = true;
    document.body.appendChild(el);
    return adopt(el, onClose);
  }

  // Close and Esc are handled once, here. Listeners on window run after a view's own
  // listeners on document, so a view can take Esc first (the roadmap clears its selection)
  // by calling preventDefault.
  window.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-ov-close]');
    if (!b) return;
    e.preventDefault();
    const ov = b.closest('.ov');
    if (ov) ov.dispatchEvent(new CustomEvent('ov-close'));
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const open = [...document.querySelectorAll('.ov:not([hidden])')].filter((x) => x.querySelector('[data-ov-close]'));
    const top = open[open.length - 1];
    if (top) top.dispatchEvent(new CustomEvent('ov-close'));
  });

  window.MontyOverlay = { bar, adopt, create };

  // ---------- tooltips ----------

  const DELAY_MS = 250; // long enough that sweeping the pointer across the page does not flash tips
  let tip = null;
  let timer = 0;
  let owner = null;

  function show(el) {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tip';
      tip.setAttribute('role', 'tooltip');
      tip.id = 'monty-tip';
      document.body.appendChild(tip);
    }
    owner = el;
    tip.textContent = text;
    tip.hidden = false;
    el.setAttribute('aria-describedby', 'monty-tip');
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const gap = 8;
    let top = r.bottom + gap;
    if (top + t.height > window.innerHeight - 4) top = r.top - t.height - gap; // no room below: above
    const left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
    tip.style.top = Math.max(4, top) + 'px';
    tip.style.left = left + 'px';
  }
  function hide() {
    clearTimeout(timer);
    if (owner) owner.removeAttribute('aria-describedby');
    owner = null;
    if (tip) tip.hidden = true;
  }
  const target = (e) => e.target && e.target.closest && e.target.closest('[data-tip]');
  document.addEventListener('pointerover', (e) => {
    const el = target(e);
    if (el === owner) return;
    hide();
    if (el) timer = setTimeout(() => show(el), DELAY_MS);
  });
  document.addEventListener('pointerout', (e) => {
    const el = target(e);
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = target(e);
    if (el) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && owner) hide(); });
})();
