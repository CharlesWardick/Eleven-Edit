// ── Chain row views (build 86 fence, build 87 Modern 1) ─────────────────────
// Classic = the original #chainstrip, never modified for Modern's sake.
// Modern  = #chainstrip-modern, its own markup/styles, laid over the Classic
// block area. Presentation only: Modern MIRRORS the Classic DOM (which the
// existing code keeps rendering + updating while visibility-hidden) and
// forwards every action to the Classic element that already does it, so both
// views drive exactly the same rack handlers:
//   button body click  -> the Classic thumb click (select + open panel)
//   lit-bar click      -> the Classic label click (bypass toggle)
//   drag               -> computeReorder + sendChainOrder (same as Classic drag)
//   STEREO/MONO click  -> the Classic S|M click
// App display pref (localStorage 'chainView'), default Classic.
var chainView = 'classic';
try {
  if (window.localStorage.getItem('chainView') === 'modern') chainView = 'modern';
} catch (e) {}

var CM_W = 78, CM_H = 58, CM_GAP = 6;   // size B
var cmRaf = 0;
var cmDrag = null;          // { slotId, el, startX, active, preview, targetEl }
var cmSuppressClick = false;

function applyChainView() {
  var modern = document.getElementById('chainstrip-modern');
  document.body.classList.toggle('cv-modern', chainView === 'modern');
  if (modern) modern.hidden = (chainView !== 'modern');
  cmScheduleRender();
}

function setChainView(v) {
  chainView = (v === 'modern') ? 'modern' : 'classic';
  try { window.localStorage.setItem('chainView', chainView); } catch (e) {}
  applyChainView();
}

function cmScheduleRender() {
  if (chainView !== 'modern' || cmRaf) return;
  cmRaf = requestAnimationFrame(function () { cmRaf = 0; cmRender(); });
}

// Classic element state -> 'on' | 'off' | 'unk'
function cmState(el) {
  if (!el) return 'unk';
  if (el.classList.contains('slot-on')) return 'on';
  if (el.classList.contains('slot-off')) return 'off';
  return 'unk';
}

function cmClassicThumb(slotId) {
  var cont = (typeof containerForSlot === 'function') ? containerForSlot(slotId) : null;
  return cont ? cont.querySelector('.chain-thumb') : null;
}

function cmMakeBtn(label, state, onBar) {
  var b = document.createElement('div');
  b.className = 'cm-btn' + (state === 'off' ? ' cm-off' : state === 'unk' ? ' cm-unk' : '');
  b.textContent = label;
  var bar = document.createElement('span');
  bar.className = 'cm-bar';
  bar.title = 'Click to bypass/enable';
  bar.addEventListener('click', function (ev) {
    ev.stopPropagation();
    if (cmSuppressClick) return;
    onBar();
  });
  b.appendChild(bar);
  return b;
}

// Position the overlay over the Classic block area (between the INPUT connector
// and the PHON/MAIN/TEMPO group) and size the buttons to fit.
function cmPlace(host) {
  var strip = document.getElementById('chainstrip');
  var inConn = document.getElementById('chain-input-connector');
  var tempo = document.getElementById('tempo-slot');
  if (!strip || !inConn || !tempo) return;
  var sr = strip.getBoundingClientRect();
  var left = inConn.getBoundingClientRect().right;
  var right = tempo.getBoundingClientRect().left - 12;
  var width = Math.max(0, right - left);
  host.style.left = left + 'px';
  host.style.top = sr.top + 'px';
  host.style.height = (sr.height - 2) + 'px';
  host.style.width = width + 'px';
  // 10 chain units + STEREO/MONO = 11 buttons; 10 gaps + 2 edge connectors.
  var w = Math.floor((width - 10 * CM_GAP - 20 - 4) / 11);
  w = Math.max(48, Math.min(CM_W, w));
  host.style.setProperty('--cm-w', w + 'px');
  host.style.setProperty('--cm-h', CM_H + 'px');
  host.style.setProperty('--cm-gap', CM_GAP + 'px');
}

// To Amp tap gap index: 0 = before first unit ... n = after last unit.
function cmTapGap(srcVal, order) {
  if (srcVal === 0) return 0;
  if (srcVal === 3) return order.length;
  var a = order.findIndex(function (b) { return b.slotId === SLOT_AMP; });
  if (a < 0) return -1;
  if (srcVal === 1) return a;
  if (srcVal === 2) return a + 1;
  return -1;
}

function cmRender() {
  var host = document.getElementById('chainstrip-modern');
  if (!host || chainView !== 'modern') return;
  if (cmDrag && cmDrag.active) return;   // don't fight a live drag
  cmPlace(host);
  host.innerHTML = '';
  if (typeof currentChain === 'undefined' || !currentChain.length) return;

  var order = currentChain;
  var readSrc = function (id) {
    var s = document.getElementById(id);
    var v = s ? parseInt(s.value, 10) : NaN;
    return (isNaN(v) || v < 0) ? null : v;
  };
  var taps = [];
  var s1 = readSrc('toamp1-src'); if (s1 !== null) taps.push({ n: '1', g: cmTapGap(s1, order) });
  var s2 = readSrc('toamp2-src'); if (s2 !== null) taps.push({ n: '2', g: cmTapGap(s2, order) });

  var row = document.createElement('div');
  row.className = 'cm-row';

  function gap(idx, edge) {
    var g = document.createElement('div');
    g.className = 'cm-gap' + (edge ? ' cm-edge' : '');
    var here = taps.filter(function (t) { return t.g === idx; });
    here.forEach(function (t) {
      var badge = document.createElement('span');
      badge.className = 'cm-tap' + (here.length > 1 ? (t.n === '1' ? ' tap-left' : ' tap-right') : '');
      badge.textContent = t.n;
      badge.title = 'To Amp ' + t.n + ' output tap';
      g.appendChild(badge);
    });
    return g;
  }

  row.appendChild(gap(0, false));
  order.forEach(function (blk, i) {
    var unit;
    var thumb = cmClassicThumb(blk.slotId);
    var selected = !!(thumb && thumb.classList.contains('chain-selected'));
    if (blk.slotId === SLOT_AMP) {
      unit = document.createElement('div');
      unit.className = 'cm-house';
      var ampEl = document.getElementById('chain-amp');
      var cabEl = document.getElementById('chain-cab');
      unit.appendChild(cmMakeBtn('AMP', cmState(ampEl), function () { if (ampEl) ampEl.click(); }));
      unit.appendChild(cmMakeBtn('CAB', cmState(cabEl), function () { if (cabEl) cabEl.click(); }));
    } else {
      var dom = SLOT_ID_TO_DOM[blk.slotId];
      var lbl = dom ? document.getElementById('chain-' + dom) : null;
      unit = cmMakeBtn(lbl ? lbl.textContent : blk.name, cmState(lbl), function () { if (lbl) lbl.click(); });
      if (lbl && lbl.title) unit.title = lbl.title;
    }
    if (selected) unit.classList.add('cm-sel');
    unit.dataset.slot = blk.slotId;
    unit.addEventListener('mousedown', function (ev) { cmDragStart(ev, blk.slotId, unit); });
    unit.addEventListener('click', function () {
      if (cmSuppressClick) return;
      if (thumb) thumb.click();
    });
    row.appendChild(unit);
    if (i < order.length - 1) row.appendChild(gap(i + 1, false));
  });
  row.appendChild(gap(order.length, true));

  // STEREO / MONO fixed stack (not draggable).
  var mono = (typeof currentMonoState !== 'undefined') ? currentMonoState : null;
  var sm = document.createElement('div');
  sm.className = 'cm-house cm-fixed';
  var monoBtn = document.getElementById('mono-indicator');
  [['STEREO', false], ['MONO', true]].forEach(function (p) {
    var st = (mono === null) ? 'unk' : (mono === p[1] ? 'on' : 'off');
    var pick = function () { if (mono !== null && mono !== p[1] && monoBtn) monoBtn.click(); };
    var b = cmMakeBtn(p[0], st, pick);
    b.title = 'Click to select ' + p[0].toLowerCase();
    b.addEventListener('click', pick);
    sm.appendChild(b);
  });
  row.appendChild(sm);
  host.appendChild(row);
}

// ── Drag to reorder (same rules as Classic: computeReorder + sendChainOrder) ──
function cmDragStart(ev, slotId, el) {
  if (ev.button !== 0 || ev.target.closest('.cm-bar')) return;
  cmDrag = { slotId: slotId, el: el, startX: ev.clientX, startY: ev.clientY,
             active: false, preview: null, targetEl: null, base: currentChain.slice() };
  ev.preventDefault();
}

function cmClearDropMarks() {
  document.querySelectorAll('#chainstrip-modern .cm-drop-before, #chainstrip-modern .cm-drop-after')
    .forEach(function (e) { e.classList.remove('cm-drop-before', 'cm-drop-after'); });
}

window.addEventListener('mousemove', function (ev) {
  if (!cmDrag) return;
  if (ev.buttons === 0) { cmDragEnd(false); return; }
  var dx = ev.clientX - cmDrag.startX;
  if (!cmDrag.active) {
    if (Math.hypot(dx, ev.clientY - cmDrag.startY) < 4) return;
    cmDrag.active = true;
    cmDrag.el.classList.add('cm-dragging');
    document.body.style.cursor = 'grabbing';
    // AMP-CAB with FX Loop linked beside it: the Loop travels with it (Classic rule).
    var link = (typeof linkedAmpLoopInfo === 'function') ? linkedAmpLoopInfo(cmDrag.slotId, cmDrag.base) : null;
    if (link) {
      cmDrag.partner = document.querySelector('#chainstrip-modern .cm-row > [data-slot="' + SLOT_LOOP + '"]');
      if (cmDrag.partner) cmDrag.partner.classList.add('cm-dragging');
    }
  }
  cmDrag.el.style.transform = 'translateX(' + dx + 'px)';
  if (cmDrag.partner) cmDrag.partner.style.transform = 'translateX(' + dx + 'px)';
  cmClearDropMarks();
  cmDrag.preview = null;
  var units = document.querySelectorAll('#chainstrip-modern .cm-row > [data-slot]');
  for (var i = 0; i < units.length; i++) {
    var u = units[i];
    if (u === cmDrag.el || u === cmDrag.partner) continue;
    var r = u.getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right) continue;
    var target = parseInt(u.dataset.slot, 10);
    var after = (target === cmDrag.base[0].slotId) ? false : ev.clientX > r.left + r.width / 2;
    var next = (typeof computeReorder === 'function') ? computeReorder(cmDrag.slotId, target, after, cmDrag.base) : null;
    if (next && !sameOrder(next, cmDrag.base)) {
      cmDrag.preview = next;
      u.classList.add(after ? 'cm-drop-after' : 'cm-drop-before');
    }
    break;
  }
});

window.addEventListener('mouseup', function () { if (cmDrag) cmDragEnd(true); });
window.addEventListener('blur', function () { if (cmDrag) cmDragEnd(false); });

function cmDragEnd(commit) {
  var d = cmDrag;
  cmDrag = null;
  document.body.style.cursor = '';
  cmClearDropMarks();
  if (d.active) {
    cmSuppressClick = true;
    setTimeout(function () { cmSuppressClick = false; }, 0);
    if (commit && d.preview && !sameOrder(d.preview, currentChain) && typeof sendChainOrder === 'function') {
      sendChainOrder(d.preview);   // rack replies with a chain map -> Classic re-renders -> Modern mirrors
    }
    cmRender();
  }
  // A plain click (no drag) must NOT re-render here: rebuilding the buttons
  // between mouseup and click swallows the click (build 87 bug — panels
  // never opened, ring stuck on AMP/CAB).
}

(function initChainView() {
  var sel = document.getElementById('chain-view-select');
  if (sel) {
    sel.value = chainView;
    sel.addEventListener('change', function () { setChainView(sel.value); });
  }
  // Mirror every Classic change (order, bypass, selection ring, taps, S|M).
  var strip = document.getElementById('chainstrip');
  if (strip) {
    new MutationObserver(cmScheduleRender).observe(strip,
      { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    if (typeof ResizeObserver === 'function') new ResizeObserver(cmScheduleRender).observe(strip);
  }
  ['toamp1-src', 'toamp2-src'].forEach(function (id) {
    var s = document.getElementById(id);
    if (s) s.addEventListener('change', cmScheduleRender);
  });
  window.addEventListener('resize', cmScheduleRender);
  window.addEventListener('scroll', cmScheduleRender, true);
  applyChainView();
})();
