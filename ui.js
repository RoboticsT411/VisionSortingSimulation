// Floating windows for the Python programs: OpenCV image windows, Tk windows, message boxes, terminal.
let layer, sendEvent, cascade = 0;
const cvWins = {}, tk = {}, tkRoots = new Set();

export function initUI(windowLayer, eventSender) { layer = windowLayer; sendEvent = eventSender; }

// ---------------------------------------------------------------- floating panel
function panel(title, onClose) {
  const p = document.createElement('div'); p.className = 'pwin'; p.tabIndex = 0;
  const bar = document.createElement('div'); bar.className = 'pbar';
  const t = document.createElement('span'); t.textContent = title; bar.appendChild(t);
  const x = document.createElement('button'); x.textContent = '×'; x.title = 'Close'; x.onclick = onClose; bar.appendChild(x);
  const body = document.createElement('div'); body.className = 'pbody';
  p.appendChild(bar); p.appendChild(body);
  const off = (cascade++ % 6) * 28; p.style.left = (20 + off) + 'px'; p.style.top = (20 + off) + 'px';
  layer.appendChild(p);
  let drag = null;
  bar.addEventListener('pointerdown', e => { if (e.target === x) return; drag = [e.clientX - p.offsetLeft, e.clientY - p.offsetTop]; bar.setPointerCapture(e.pointerId); });
  bar.addEventListener('pointermove', e => { if (drag) { p.style.left = Math.max(0, e.clientX - drag[0]) + 'px'; p.style.top = Math.max(0, e.clientY - drag[1]) + 'px'; } });
  bar.addEventListener('pointerup', () => drag = null);
  p.addEventListener('pointerdown', () => front(p));
  front(p);
  return { p, body, setTitle: s => t.textContent = s };
}
let z = 10;
function front(p) { p.style.zIndex = ++z; }

// ---------------------------------------------------------------- OpenCV windows
const KEYMAP = { Enter: 13, Backspace: 8, Escape: 27, Tab: 9, Delete: 127, ' ': 32 };
export function cvOpen(name) {
  if (cvWins[name]) return cvWins[name];
  const w = panel(name, () => { sendEvent({ type: 'winclose', name }); cvClose(name); });
  w.p.classList.add('cvwin');
  const c = document.createElement('canvas'); c.width = 640; c.height = 360; w.body.appendChild(c);
  const hint = document.createElement('div'); hint.className = 'cvhint'; hint.textContent = 'Click the picture, then press the keys it asks for.';
  w.body.appendChild(hint);
  const ctx = c.getContext('2d');
  w.p.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = KEYMAP[e.key] ?? (e.key.length === 1 ? e.key.charCodeAt(0) : null);
    if (code !== null) { sendEvent({ type: 'key', code }); e.preventDefault(); }
  });
  const mouse = (ev, e) => {
    const r = c.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) * c.width / r.width), y = Math.round((e.clientY - r.top) * c.height / r.height);
    sendEvent({ type: 'mouse', name, event: ev, x, y, flags: ev === 0 && e.buttons ? 1 : 0 });
  };
  let lastMove = 0;
  c.addEventListener('pointerdown', e => { w.p.focus(); mouse(1, e); });
  c.addEventListener('pointerup', e => mouse(4, e));
  c.addEventListener('pointermove', e => { const t = performance.now(); if (t - lastMove > 60) { lastMove = t; mouse(0, e); } });
  cvWins[name] = { ...w, c, ctx };
  setTimeout(() => w.p.focus(), 50);
  return cvWins[name];
}
export function cvShow(name, wpx, hpx, buf, done) {
  const w = cvOpen(name);
  if (w.c.width !== wpx || w.c.height !== hpx) { w.c.width = wpx; w.c.height = hpx; }
  w.ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), wpx, hpx), 0, 0);
  done();
}
export function cvClose(name) { const w = cvWins[name]; if (w) { w.p.remove(); delete cvWins[name]; } }
export function cvCloseAll() { for (const n of Object.keys(cvWins)) cvClose(n); }

// ---------------------------------------------------------------- message boxes and input
export function dialog({ kind, title, message }) {
  return new Promise(resolve => {
    const back = document.createElement('div'); back.className = 'modal';
    const box = document.createElement('div'); box.className = 'mbox ' + kind;
    box.innerHTML = '<div class="mtitle"></div><div class="mtext"></div><div class="mbtns"></div>';
    box.querySelector('.mtitle').textContent = title || ''; box.querySelector('.mtext').textContent = message || '';
    const btns = { info: [['OK', true]], warning: [['OK', true]], error: [['OK', true]], yesno: [['Yes', true], ['No', false]],
      okcancel: [['OK', true], ['Cancel', false]], retrycancel: [['Retry', true], ['Cancel', false]],
      yesnocancel: [['Yes', true], ['No', false], ['Cancel', null]] }[kind] || [['OK', true]];
    for (const [label, val] of btns) {
      const b = document.createElement('button'); b.textContent = label;
      b.onclick = () => { back.remove(); resolve({ answer: val }); };
      box.querySelector('.mbtns').appendChild(b);
    }
    back.appendChild(box); document.body.appendChild(back);
    box.querySelector('button').focus();
  });
}

// ---------------------------------------------------------------- Tk windows
const css = (el, o) => Object.assign(el.style, o);
function tkFont(f) {
  if (!f) return null;
  if (typeof f === 'string') f = f.split(' ');
  const [fam, size, ...style] = f;
  const px = Math.round(Math.abs(Number(size) || 10) * 1.33);
  return `${style.includes('italic') ? 'italic ' : ''}${style.includes('bold') ? 'bold ' : ''}${px}px ${fam === 'Courier' ? 'Consolas, monospace' : fam + ', Arial, sans-serif'}`;
}
const pad = v => v === undefined ? null : Array.isArray(v) ? v : [v, v];
function applyOpts(w, o) {
  const el = w.el;
  if ('text' in o) {
    if (w.kind === 'labelframe') w.legend.textContent = o.text;
    else if (w.kind === 'radio' || w.kind === 'check') w.label.textContent = o.text;
    else if (w.kind !== 'entry' && w.kind !== 'text' && w.kind !== 'option') el.textContent = o.text;
  }
  const fg = o.fg ?? o.foreground, bg = o.bg ?? o.background;
  if (fg !== undefined) el.style.color = fg;
  if (bg !== undefined) { el.style.background = bg; if (w.kind === 'entry') el.style.backgroundColor = bg; }
  if (o.font) el.style.font = tkFont(o.font);
  if (o.width !== undefined && w.kind !== 'frame' && w.kind !== 'labelframe') {
    const ch = Number(o.width); if (w.kind === 'text') el.style.width = (ch * 0.62) + 'em'; else el.style.minWidth = el.style.width = w.kind === 'entry' ? (ch + 1) + 'ch' : (ch + 2) + 'ch';
  }
  if (o.height !== undefined && w.kind === 'text') el.style.height = (Number(o.height) * 1.35) + 'em';
  if (o.state !== undefined) {
    const off = o.state === 'disabled';
    if (w.input) w.input.disabled = off; else if ('disabled' in el) el.disabled = off;
    el.classList.toggle('tkdisabled', off);
    if (w.kind === 'entry') el.readOnly = o.state === 'readonly';
  }
  if (o.anchor) el.style.textAlign = { w: 'left', nw: 'left', sw: 'left', e: 'right', ne: 'right', se: 'right' }[o.anchor] || 'center';
  if (o.justify) el.style.textAlign = o.justify === 'left' ? 'left' : o.justify === 'right' ? 'right' : el.style.textAlign;
  if (o.wraplength) el.style.maxWidth = o.wraplength + 'px';
  const px = pad(o.padx), py = pad(o.pady);
  if (px && w.kind !== 'button') { el.style.paddingLeft = px[0] + 'px'; el.style.paddingRight = px[1] + 'px'; }
  if (py && w.kind !== 'button') { el.style.paddingTop = py[0] + 'px'; el.style.paddingBottom = py[1] + 'px'; }
  const bd = o.bd ?? o.borderwidth;
  if (o.relief !== undefined || bd !== undefined) {
    const rel = o.relief ?? w.relief ?? 'flat'; w.relief = rel; const width = bd ?? w.bd ?? 1; w.bd = width;
    el.style.border = rel === 'flat' ? 'none' : `${width}px ${rel === 'solid' ? 'solid' : rel === 'groove' || rel === 'ridge' ? 'groove' : 'inset'} #8a8a8a`;
  }
}
function create(id, kind, parent, opts) {
  let w = { id, kind, parent, layout: null, order: [] };
  if (kind === 'root') {
    const pw = panel('tk', () => sendEvent({ type: 'tk', ev: 'close', id }));
    pw.p.classList.add('tkwin'); w.panel = pw; w.el = pw.body; w.box = pw.body; tkRoots.add(id);
  } else if (kind === 'labelframe') {
    w.el = document.createElement('fieldset'); w.legend = document.createElement('legend'); w.el.appendChild(w.legend); w.box = w.el;
  } else if (kind === 'frame') { w.el = document.createElement('div'); w.box = w.el; }
  else if (kind === 'label') { w.el = document.createElement('div'); w.el.className = 'tklabel'; }
  else if (kind === 'button') { w.el = document.createElement('button'); w.el.className = 'tkbutton'; w.el.onclick = () => sendEvent({ type: 'tk', ev: 'click', id }); }
  else if (kind === 'entry') {
    w.el = document.createElement('input'); w.el.className = 'tkentry';
    w.el.addEventListener('input', () => sendEvent({ type: 'tk', ev: 'input', id, value: w.el.value }));
    w.el.addEventListener('keyup', e => sendEvent({ type: 'tk', ev: 'keyrelease', id, value: w.el.value, keysym: e.key === 'Enter' ? 'Return' : e.key, char: e.key.length === 1 ? e.key : '' }));
    w.el.addEventListener('focus', () => sendEvent({ type: 'tk', ev: 'focus', id }));
  } else if (kind === 'text') { w.el = document.createElement('div'); w.el.className = 'tktext'; }
  else if (kind === 'radio' || kind === 'check') {
    w.el = document.createElement('label'); w.el.className = 'tkradio';
    w.input = document.createElement('input'); w.input.type = kind === 'radio' ? 'radio' : 'checkbox';
    w.label = document.createElement('span'); w.el.appendChild(w.input); w.el.appendChild(w.label);
    w.input.addEventListener('click', e => { e.preventDefault(); sendEvent({ type: 'tk', ev: 'click', id }); });
    if (opts.checked) w.input.checked = true;
  } else if (kind === 'option') {
    w.el = document.createElement('select'); w.el.className = 'tkoption';
    for (const v of opts.values || []) { const o = document.createElement('option'); o.value = o.textContent = v; w.el.appendChild(o); }
    w.el.value = opts.value; w.el.onchange = () => sendEvent({ type: 'tk', ev: 'select', id, value: w.el.value });
  } else { w.el = document.createElement('div'); w.box = w.el; }
  tk[id] = w; applyOpts(w, opts);
  if (parent && tk[parent]) tk[parent].order = tk[parent].order || [];
}
function relayout(cid) {
  const c = tk[cid]; if (!c || !c.box) return;
  const kids = c.order.map(i => tk[i]).filter(k => k && k.layout && k.layout.mode !== 'none');
  for (const k of Object.values(tk)) if (k.parent === cid && (!k.layout || k.layout.mode === 'none')) k.el.remove();
  if (c.regions) { c.regions.forEach(r => r.remove()); c.regions = null; }
  if (kids.some(k => k.layout.mode === 'grid')) {
    css(c.box, { display: 'grid', alignItems: 'center', justifyItems: 'center', gap: '0' });
    for (const k of kids) {
      const o = k.layout.opts, st = (o.sticky || '').toLowerCase();
      css(k.el, { gridRow: `${(o.row || 0) + 1} / span ${o.rowspan || 1}`, gridColumn: `${(o.column || 0) + 1} / span ${o.columnspan || 1}`,
        justifySelf: st.includes('w') && st.includes('e') ? 'stretch' : st.includes('w') ? 'start' : st.includes('e') ? 'end' : 'center',
        alignSelf: st.includes('n') && st.includes('s') ? 'stretch' : st.includes('n') ? 'start' : st.includes('s') ? 'end' : 'center' });
      margins(k.el, o); c.box.appendChild(k.el);
    }
    return;
  }
  // pack: left items | a column of top/bottom items | right items
  css(c.box, { display: 'flex', flexDirection: 'row', alignItems: 'stretch' });
  const left = document.createElement('div'), mid = document.createElement('div'), right = document.createElement('div');
  css(left, { display: 'flex', flexDirection: 'row', alignItems: 'center' });
  css(right, { display: 'flex', flexDirection: 'row-reverse', alignItems: 'stretch' });
  css(mid, { display: 'flex', flexDirection: 'column', flex: '1', minWidth: '0' });
  c.regions = [left, mid, right];
  const anyMid = kids.some(k => ['top', 'bottom', undefined].includes(k.layout.opts.side));
  for (const k of kids) {
    const o = k.layout.opts, side = o.side || 'top', fill = o.fill || 'none';
    k.el.style.flex = o.expand ? '1' : '0 0 auto';
    if (side === 'left' || side === 'right') {
      k.el.style.alignSelf = fill === 'y' || fill === 'both' ? 'stretch' : 'center';
      (side === 'left' ? left : right).appendChild(k.el);
    } else {
      k.el.style.alignSelf = fill === 'x' || fill === 'both' ? 'stretch' : (o.anchor === 'w' ? 'flex-start' : o.anchor === 'e' ? 'flex-end' : 'center');
      if (side === 'bottom') k.el.style.order = '1000';
      mid.appendChild(k.el);
    }
    margins(k.el, o);
  }
  if (!anyMid) { mid.style.flex = '0'; left.style.flex = '1'; }
  c.box.appendChild(left); c.box.appendChild(mid); c.box.appendChild(right);
}
function margins(el, o) {
  const px = pad(o.padx) || [0, 0], py = pad(o.pady) || [0, 0];
  css(el, { marginLeft: px[0] + 'px', marginRight: px[1] + 'px', marginTop: py[0] + 'px', marginBottom: py[1] + 'px' });
}
let pending = new Set();
function scheduleLayout(cid) { pending.add(cid); }
function flushLayout() { for (const id of pending) relayout(id); pending.clear(); }

export function tkOps(ops) {
  for (const [op, id, a, b, c] of ops) {
    if (op === 'create') { create(id, a, b, c); if (b && tk[b]) {} }
    else if (op === 'config') { if (tk[id]) applyOpts(tk[id], a); }
    else if (op === 'layout') {
      const w = tk[id]; if (!w) continue; const par = tk[w.parent]; if (!par) continue;
      w.layout = { mode: a, opts: b || {} };
      par.order = par.order.filter(i => i !== id); if (a !== 'none') par.order.push(id);
      scheduleLayout(w.parent);
    }
    else if (op === 'value') { const w = tk[id]; if (w) w.el.value = a; }
    else if (op === 'checked') { const w = tk[id]; if (w && w.input) w.input.checked = !!a; }
    else if (op === 'text') {
      const w = tk[id]; if (!w) continue; w.el.innerHTML = '';
      for (const [text, tag] of a) { const s = document.createElement('span'); s.textContent = text; const t = b[tag]; if (t) { if (t.foreground || t.fg) s.style.color = t.foreground || t.fg; if (t.background || t.bg) s.style.background = t.background || t.bg; if (t.font) s.style.font = tkFont(t.font); } w.el.appendChild(s); }
    }
    else if (op === 'title') { const w = tk[id]; if (w && w.panel) w.panel.setTitle(a); }
    else if (op === 'bind') {}
    else if (op === 'focus') { const w = tk[id]; if (w) w.el.focus(); }
    else if (op === 'destroy') { const w = tk[id]; if (!w) continue; if (w.panel) { w.panel.p.remove(); tkRoots.delete(id); } else w.el.remove(); delete tk[id]; }
  }
  flushLayout();
}
export function tkReset() { for (const id of tkRoots) { const w = tk[id]; if (w && w.panel) w.panel.p.remove(); } tkRoots.clear(); for (const k of Object.keys(tk)) delete tk[k]; }
