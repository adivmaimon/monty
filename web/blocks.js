// Typed blocks: small charts and flows written as YAML in fenced code blocks
// (```chart, ```flow). On GitHub they stay readable YAML; here md.js hands each fence
// to MontyBlocks.render, which draws it, or falls back to the plain code block with one
// line saying why. Spec files are untrusted input: every string from the YAML is
// escaped, and attributes only ever carry numbers computed here.
//
// The YAML reader is a hand-written subset (the core and panel take no dependencies):
// block maps and lists, one-line flow lists and maps, quoted strings, comments, and
// | / > block scalars. Scalars stay strings so values show as written ("38.0"); maps are
// Maps so step order survives even for numeric names.
(function () {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  class BlockError extends Error {}
  const fail = (n, msg) => { throw new BlockError(n ? `line ${n}: ${msg}` : msg); };

  // ---------- YAML subset ----------

  /** Cut a trailing comment. A quote only opens a string at the start of a token, so "don't # x" still loses its comment. */
  function stripComment(r) {
    let q = '';
    for (let k = 0; k < r.length; k++) {
      const ch = r[k];
      if (q) {
        if (q === '"' && ch === '\\') k++;
        else if (ch === q) q = '';
      } else if ((ch === '"' || ch === "'") && (k === 0 || /[\s[{,:-]/.test(r[k - 1]))) q = ch;
      else if (ch === '#' && (k === 0 || /\s/.test(r[k - 1]))) return r.slice(0, k);
    }
    return r;
  }

  /** A quoted string starting at s[p]; returns [text, index after the closing quote]. */
  function quoted(s, p, n) {
    const q = s[p];
    let out = '';
    for (let k = p + 1; k < s.length; k++) {
      const ch = s[k];
      if (q === "'" && ch === "'") {
        if (s[k + 1] === "'") { out += "'"; k++; continue; }
        return [out, k + 1];
      }
      if (q === '"' && ch === '"') return [out, k + 1];
      if (q === '"' && ch === '\\' && k + 1 < s.length) {
        const e = s[++k];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        continue;
      }
      out += ch;
    }
    return fail(n, 'a quoted string is not closed');
  }

  const ws = (s, p) => { while (p < s.length && (s[p] === ' ' || s[p] === '\t')) p++; return p; };
  const plain = (v) => (v === '' || v === '~' || v === 'null' ? null : v);

  /** One flow value ([..], {..}, quoted or plain) at s[p]; plain text stops at any of `stops`. */
  function flow(s, p, n, stops) {
    p = ws(s, p);
    const c = s[p];
    if (c === '[' || c === '{') {
      const list = c === '[';
      const close = list ? ']' : '}';
      const out = list ? [] : new Map();
      p = ws(s, p + 1);
      while (s[p] !== close) {
        if (p >= s.length) fail(n, `"${c}" is not closed (flow lists and maps must fit on one line)`);
        if (list) {
          let v;
          [v, p] = flow(s, p, n, ',]');
          out.push(v);
        } else {
          let k, v;
          [k, p] = flow(s, p, n, ':,}');
          if (typeof k !== 'string' || !k) fail(n, 'expected "key: value" inside {}');
          p = ws(s, p);
          if (s[p] === ':') [v, p] = flow(s, p + 1, n, ',}');
          else v = null;
          if (out.has(k)) fail(n, `duplicate key "${k}"`);
          out.set(k, v);
        }
        p = ws(s, p);
        if (s[p] === ',') p = ws(s, p + 1);
        else if (s[p] !== close) fail(n, p >= s.length ? `"${c}" is not closed (flow lists and maps must fit on one line)` : `unexpected "${s[p]}"`);
      }
      return [out, p + 1];
    }
    if (c === '"' || c === "'") return quoted(s, p, n);
    let e = p;
    while (e < s.length && !stops.includes(s[e])) e++;
    return [plain(s.slice(p, e).trim()), e];
  }

  /** A whole value written on one line after "key:" or "- ". */
  function inlineValue(s, n) {
    if (s[0] === '[' || s[0] === '{' || s[0] === '"' || s[0] === "'") {
      const [v, p] = flow(s, 0, n, '');
      if (s.slice(p).trim()) fail(n, `unexpected text after the value: "${s.slice(p).trim()}"`);
      return v;
    }
    return plain(s);
  }

  /** "key: rest" (rest may be empty), or null when the line is not a key. */
  function splitKey(t, n) {
    if (t[0] === '[' || t[0] === '{') return null;
    if (t[0] === '"' || t[0] === "'") {
      const [key, p] = quoted(t, 0, n);
      if (t[p] !== ':' || (p + 1 < t.length && t[p + 1] !== ' ')) return null;
      return { key, rest: t.slice(p + 1).trim() };
    }
    const m = /^([^:]*?[^\s:]|[^\s:]):(?:\s+(.*))?$/.exec(t);
    return m ? { key: m[1], rest: (m[2] || '').trim() } : null;
  }

  function parseYaml(src) {
    const L = String(src).replace(/\r/g, '').split('\n').map((raw, k) => {
      const lead = /^[ \t]*/.exec(raw)[0];
      const text = stripComment(raw).trim();
      if (text && lead.includes('\t')) fail(k + 1, 'tabs are not allowed for indentation');
      return { n: k + 1, indent: lead.length, text, raw };
    });
    let i = 0;
    const skip = () => { while (i < L.length && !L[i].text) i++; };
    const isSeq = (t) => t === '-' || t.startsWith('- ');

    function node() {
      skip();
      return isSeq(L[i].text) ? seq(L[i].indent) : map(L[i].indent);
    }

    /** The value after "key:" or "- " with nothing on the line: a nested block, a block scalar, or empty. */
    function nested(rest, l, ind, sameIndentList) {
      if (/^[|>][-+]?$/.test(rest)) return blockScalar(rest[0], ind);
      if (rest) return inlineValue(rest, l.n);
      skip();
      if (i < L.length && (L[i].indent > ind || (sameIndentList && L[i].indent === ind && isSeq(L[i].text)))) return node();
      return null;
    }

    function map(ind) {
      const m = new Map();
      for (;;) {
        skip();
        if (i >= L.length || L[i].indent < ind || isSeq(L[i].text)) break;
        const l = L[i];
        if (l.indent > ind) fail(l.n, 'unexpected indent');
        const kv = splitKey(l.text, l.n);
        if (!kv) fail(l.n, 'expected "key: value"');
        if (m.has(kv.key)) fail(l.n, `duplicate key "${kv.key}"`);
        i++;
        // "key:" may be followed by its list at the same indent, as people often write it.
        m.set(kv.key, nested(kv.rest, l, ind, true));
      }
      return m;
    }

    function seq(ind) {
      const a = [];
      for (;;) {
        skip();
        if (i >= L.length || L[i].indent < ind || !isSeq(L[i].text)) break;
        const l = L[i];
        if (l.indent > ind) fail(l.n, 'unexpected indent');
        const rest = l.text.slice(1).trim();
        const kv = rest && splitKey(rest, l.n);
        if (kv || isSeq(rest)) {
          // "- key: value" starts a map whose later keys line up under the first; "- - x" a list.
          L[i] = { ...l, indent: l.indent + l.text.indexOf(rest), text: rest };
          a.push(kv ? map(L[i].indent) : seq(L[i].indent));
          continue;
        }
        i++;
        a.push(nested(rest, l, ind, false));
      }
      return a;
    }

    function blockScalar(style, ind) {
      const body = [];
      while (i < L.length && (!L[i].raw.trim() || L[i].indent > ind)) body.push(L[i++].raw);
      const cut = Math.min(...body.filter((r) => r.trim()).map((r) => /^ */.exec(r)[0].length));
      const lines = body.map((r) => r.slice(Number.isFinite(cut) ? cut : 0)).join('\n').replace(/\s+$/, '');
      // ">" folds lines into one, keeping blank lines as paragraph breaks.
      return style === '|' ? lines : lines.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ')).join('\n');
    }

    skip();
    if (i >= L.length) return null;
    const out = node();
    skip();
    if (i < L.length) fail(L[i].n, L[i].indent ? 'unexpected indent' : isSeq(L[i].text) ? 'a list item where a key was expected' : 'expected "key: value"');
    return out;
  }

  // ---------- shared ----------

  const NUM = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
  const num = (v) => (typeof v === 'string' && NUM.test(v.trim()) ? Number(v) : NaN);
  const isMap = (v) => v instanceof Map;
  const text = (v, what) => {
    if (v == null) return '';
    if (typeof v !== 'string') fail(0, `${what} should be text`);
    return v;
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // ---------- chart ----------

  /** Bars are drawn on this share of the track when a row carries a tag, leaving room for the label beside the bar. */
  const TAGGED_SCALE = 78;

  function chart(doc) {
    if (!isMap(doc)) fail(0, 'expected keys: title, rows');
    const title = text(doc.get('title'), 'title');
    const better = doc.get('better');
    if (better != null && better !== 'lower' && better !== 'higher') fail(0, 'better should be lower or higher');
    const thRaw = doc.get('threshold');
    const threshold = thRaw == null ? null : num(thRaw);
    if (threshold !== null && !(threshold >= 0)) fail(0, 'threshold should be a number, zero or more');
    const note = text(doc.get('note'), 'note');
    const rowsRaw = doc.get('rows');
    if (!Array.isArray(rowsRaw) || !rowsRaw.length) fail(0, 'rows should be a list like - [label, value]');
    const rows = rowsRaw.map((r, k) => {
      const [label, value, tag] = Array.isArray(r) ? r : isMap(r) ? [r.get('label'), r.get('value'), r.get('tag')] : [];
      if (typeof label !== 'string' || !label) fail(0, `row ${k + 1} should be [label, value] or [label, value, tag]`);
      const v = num(value);
      if (Number.isNaN(v)) fail(0, `row ${k + 1}: "${typeof value === 'string' ? value : ''}" is not a number`);
      if (v < 0) fail(0, `row ${k + 1}: negative values are not drawn`);
      return { label, shown: value.trim(), v, tag: tag === 'winner' || tag === 'rejected' ? tag : '' };
    });
    const max = Math.max(...rows.map((r) => r.v), threshold ?? 0) || 1;
    const scale = rows.some((r) => r.tag) ? TAGGED_SCALE : 100;
    const pct = (v) => Math.round((v / max) * scale * 100) / 100;
    const sub = [better ? `${better} is better` : '', threshold !== null ? `threshold ${thRaw.trim()}` : ''].filter(Boolean).join(' · ');
    const cells = rows.map((r, k) => {
      const cls = r.tag ? ` tb-${r.tag === 'winner' ? 'win' : 'rej'}` : '';
      const at = `style="grid-row:${k + 1}"`;
      return `<span class="tb-label${cls}" ${at}>${esc(r.label)}</span>`
        + `<span class="tb-track${cls}" ${at}><span class="tb-bar" style="width:${pct(r.v)}%"></span>${r.tag ? `<span class="tb-tag">${r.tag}</span>` : ''}</span>`
        + `<span class="tb-val mono${cls}" ${at}>${esc(r.shown)}</span>`;
    }).join('');
    const line = threshold !== null ? `<span class="tb-th" style="grid-row:1 / span ${rows.length}"><i style="left:${pct(threshold)}%"></i></span>` : '';
    return `<figure class="tb tb-chart">`
      + (title || sub ? `<figcaption>${title ? `<span class="tb-title">${esc(title)}</span>` : ''}${sub ? `<span class="tb-sub">${esc(sub)}</span>` : ''}</figcaption>` : '')
      + `<div class="tb-rows">${cells}${line}</div>`
      + (note ? `<div class="tb-note">${esc(note)}</div>` : '')
      + `</figure>`;
  }

  // ---------- flow ----------

  const TONES = { bad: 'bad', danger: 'bad', error: 'bad', fail: 'bad', good: 'good', ok: 'good', success: 'good' };
  const ARROW = '<svg class="tb-arrow" width="20" height="30" viewBox="0 0 20 30" aria-hidden="true"><path d="M2 16h14M12 12l4 4-4 4"/></svg>';
  const ELBOW = '<svg class="tb-elbow" width="24" height="34" viewBox="0 0 24 34" aria-hidden="true"><path d="M4 0v20h14M14 16l4 4-4 4"/></svg>';

  function steps(raw) {
    const one = (name, detail, k) => {
      if (typeof name !== 'string' || !name) fail(0, `step ${k + 1} should be "name: detail"`);
      return { name, detail: text(detail, `step "${name}" detail`) };
    };
    if (isMap(raw)) return [...raw].map(([name, detail], k) => one(name, detail, k));
    if (!Array.isArray(raw)) return fail(0, 'steps should be "name: detail" lines');
    return raw.map((s, k) => {
      if (typeof s === 'string') return one(s, null, k);
      if (isMap(s) && s.size === 1) return one(...[...s][0], k);
      if (isMap(s) && s.has('name')) return one(s.get('name'), s.get('detail'), k);
      return fail(0, `step ${k + 1} should be "name: detail"`);
    });
  }

  function flowBlock(doc) {
    if (!isMap(doc)) fail(0, 'expected keys: title, steps');
    const title = text(doc.get('title'), 'title');
    const list = steps(doc.get('steps'));
    if (!list.length) fail(0, 'steps is empty');
    const b = doc.get('branch');
    const branches = (b == null ? [] : isMap(b) ? [b] : Array.isArray(b) ? b : fail(0, 'branch should be from, if, to')).map((br, k) => {
      if (!isMap(br)) fail(0, `branch ${k + 1} should be from, if, to`);
      const from = br.get('from');
      const at = list.findIndex((s) => typeof from === 'string' && s.name.toLowerCase() === from.toLowerCase());
      if (at < 0) fail(0, `branch from "${typeof from === 'string' ? from : ''}" is not one of the steps`);
      const to = br.get('to');
      if (typeof to !== 'string' || !to) fail(0, `branch ${k + 1} needs a "to"`);
      return { at, cond: text(br.get('if'), 'branch if'), to, tone: TONES[String(br.get('tone') || '').toLowerCase()] || 'neutral' };
    });
    const froms = new Set(branches.map((x) => x.at));
    // Columns alternate step, arrow, step, … so a branch can start under its step with no measuring.
    const cols = list.length * 2 - 1;
    const row = list.map((s, k) => `<div class="tb-step${froms.has(k) ? ' tb-from' : ''}" style="grid-column:${k * 2 + 1}"><span class="tb-node">${esc(cap(s.name))}</span>${s.detail ? `<span class="tb-detail">${esc(s.detail)}</span>` : ''}</div>`
      + (k < list.length - 1 ? `<span class="tb-gap" style="grid-column:${k * 2 + 2}">${ARROW}</span>` : '')).join('');
    const under = branches.map((x, k) => `<div class="tb-branch tb-${x.tone}" style="grid-column:${x.at * 2 + 1} / ${cols + 1};grid-row:${k + 2}">${ELBOW}${x.cond ? `<span class="tb-if">${esc(x.cond)}</span>` : ''}<span class="tb-node tb-to">${esc(cap(x.to))}</span></div>`).join('');
    return `<figure class="tb tb-flow">${title ? `<figcaption><span class="tb-title">${esc(title)}</span></figcaption>` : ''}<div class="tb-scroll"><div class="tb-grid">${row}${under}</div></div></figure>`;
  }

  // ---------- entry ----------

  const KINDS = { chart: [chart, 'chart'], 'caddis-chart': [chart, 'chart'], flow: [flowBlock, 'flow'], 'caddis-flow': [flowBlock, 'flow'] };

  /** HTML for a typed block, the fallback for one that does not read, or null for any other fence. */
  function render(lang, source) {
    const name = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
    const kind = Object.prototype.hasOwnProperty.call(KINDS, name) ? KINDS[name] : null;
    if (!kind) return null;
    try {
      return kind[0](parseYaml(source));
    } catch (e) {
      // Degrade, don't crash: anything unexpected (a bug, a stack overflow on absurd nesting) still shows the source.
      const why = e instanceof BlockError ? e.message : 'it would not parse';
      return `<div class="tb-failed"><p class="tb-reason">This ${kind[1]} got the better of me (${esc(why)}). Its source:</p><pre data-lang="${esc(name)}"><code>${esc(source)}</code></pre></div>`;
    }
  }

  window.MontyBlocks = { render, parseYaml };
})();
