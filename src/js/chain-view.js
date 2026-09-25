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
  if (chainView !== 'modern') { cmPlaceQuickMix(); cmAlignInput(); }   // hand back to Classic
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

// Line the Classic INPUT dropdown + its connector up with the Modern button row
// (build 90). Inline transforms on those two Classic elements, cleared in Classic.
function cmAlignInput() {
  var sel = document.getElementById('chain-input-select');
  var slot = sel ? sel.closest('.chain-slot') : null;
  var conn = document.getElementById('chain-input-connector');
  var row = document.querySelector('#chainstrip-modern .cm-row');
  [slot, conn].forEach(function (e) { if (e) e.style.transform = ''; });
  if (chainView !== 'modern' || !row || !slot) return;
  var rr = row.getBoundingClientRect();
  var mid = rr.top + rr.height / 2;
  var sr = sel.getBoundingClientRect();
  slot.style.transform = 'translateY(' + Math.round(mid - (sr.top + sr.height / 2)) + 'px)';
  if (conn) {
    var line = conn.querySelector('i');
    var lr = line ? line.getBoundingClientRect() : conn.getBoundingClientRect();
    conn.style.transform = 'translateY(' + Math.round(mid - (lr.top + lr.height / 2)) + 'px)';
  }
}

// Quick Mix (build 90): the Classic sliders stay the single source of truth;
// in Modern they're re-shown (CSS) and pinned under their Modern button.
function cmPlaceQuickMix() {
  if (typeof QM_SLOT_DOM === 'undefined') return;
  Object.keys(QM_SLOT_DOM).forEach(function (k) {
    var wrap = document.getElementById('qm-' + QM_SLOT_DOM[k]);
    if (!wrap) return;
    var unit = (chainView === 'modern')
      ? document.querySelector('#chainstrip-modern .cm-row > [data-slot="' + k + '"]') : null;
    if (!unit) {
      ['position', 'left', 'top', 'width', 'right', 'bottom'].forEach(function (p) { wrap.style[p] = ''; });
      return;
    }
    var r = unit.getBoundingClientRect();
    wrap.style.position = 'fixed';
    wrap.style.left = r.left + 'px';
    wrap.style.width = r.width + 'px';
    wrap.style.top = (r.bottom + 7) + 'px';   // clear the selection ring
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
  });
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
  var classicStrip = document.getElementById('chainstrip');
  host.classList.toggle('cm-qm', !!(classicStrip && classicStrip.classList.contains('qm-visible')));
  cmPlaceQuickMix();
  cmAlignInput();
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

var CM_SLIDE_MS = (typeof CHAIN_SLIDE_MS === 'number') ? CHAIN_SLIDE_MS : 1000;

function cmUnitCenter(el) { var r = el.getBoundingClientRect(); return r.left + r.width / 2; }

// Live preview (build 89): re-lay the Modern units in `order` and FLIP-slide
// every unit that moved (Classic's applyChainOrderAnimated, Modern's own copy).
// The dragged unit (and its linked Loop) are skipped — they follow the cursor.
function cmApplyPreview(order) {
  var row = document.querySelector('#chainstrip-modern .cm-row');
  if (!row) return;
  var units = {};
  row.querySelectorAll(':scope > [data-slot]').forEach(function (u) { units[u.dataset.slot] = u; });
  var gaps = Array.prototype.slice.call(row.querySelectorAll(':scope > .cm-gap'));
  var tail = row.querySelector(':scope > .cm-fixed');
  var movers = Object.keys(units).map(function (k) { return units[k]; })
    .filter(function (u) { return u !== cmDrag.el && u !== cmDrag.partner; });
  var first = new Map();
  movers.forEach(function (u) { first.set(u, u.getBoundingClientRect().left); });
  var gi = 0;
  row.insertBefore(gaps[gi++], tail);
  order.forEach(function (blk) {
    var u = units[blk.slotId];
    if (u) row.insertBefore(u, tail);
    if (gi < gaps.length) row.insertBefore(gaps[gi++], tail);
  });
  movers.forEach(function (u) {
    var dx = first.get(u) - u.getBoundingClientRect().left;
    if (Math.abs(dx) < 0.5) return;
    u.style.transition = 'none';
    u.style.transform = 'translateX(' + dx + 'px)';
    void u.offsetWidth;
    u.style.transition = 'transform ' + CM_SLIDE_MS + 'ms ease';
    u.style.transform = '';
  });
}

// Keep the dragged unit (and linked Loop) pinned under the cursor.
function cmFollow(ev) {
  var d = cmDrag;
  [d.el, d.partner].forEach(function (u) { if (u) u.style.transform = 'none'; });
  var dx = (ev.clientX - d.grabX) - d.el.getBoundingClientRect().left;
  [d.el, d.partner].forEach(function (u) { if (u) u.style.transform = 'translateX(' + dx + 'px)'; });
}

window.addEventListener('mousemove', function (ev) {
  if (!cmDrag) return;
  if (ev.buttons === 0) { cmDragEnd(false); return; }
  var d = cmDrag;
  if (!d.active) {
    if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 4) return;
    d.active = true;
    d.grabX = d.startX - d.el.getBoundingClientRect().left;
    d.lastX = ev.clientX;
    d.right = true;
    d.el.classList.add('cm-dragging');
    d.el.style.transition = 'none';
    document.body.classList.add('cm-drag-live');
    document.body.style.cursor = 'grabbing';
    document.querySelectorAll('#chainstrip-modern .cm-tap').forEach(function (t) { t.remove(); });
    // AMP-CAB with FX Loop linked beside it: the Loop travels with it (Classic rule).
    var link = (typeof linkedAmpLoopInfo === 'function') ? linkedAmpLoopInfo(d.slotId, d.base) : null;
    d.linkGap = 0;
    if (link) {
      d.partner = document.querySelector('#chainstrip-modern .cm-row > [data-slot="' + SLOT_LOOP + '"]');
      if (d.partner) {
        d.partner.classList.add('cm-dragging');
        d.partner.style.transition = 'none';
        d.linkGap = cmUnitCenter(d.partner) - cmUnitCenter(d.el);
      }
    }
    d.preview = d.base;
  }
  if (ev.clientX !== d.lastX) d.right = ev.clientX > d.lastX;
  d.lastX = ev.clientX;

  // Hit-test off the leading edge of the carried pair (Classic's rule).
  var hitX = ev.clientX - d.grabX + d.el.offsetWidth / 2
           + (d.right ? Math.max(0, d.linkGap) : Math.min(0, d.linkGap));
  var units = document.querySelectorAll('#chainstrip-modern .cm-row > [data-slot]');
  for (var i = 0; i < units.length; i++) {
    var u = units[i];
    if (u === d.el || u === d.partner) continue;
    var r = u.getBoundingClientRect();
    if (hitX < r.left || hitX > r.right) continue;
    var target = parseInt(u.dataset.slot, 10);
    // Swap a third of the way into the neighbour (build 90; was halfway —
    // felt like too much travel with Modern's tighter gaps).
    var curIdx = d.preview.findIndex(function (b) { return b.slotId === d.slotId; });
    var tgtIdx = d.preview.findIndex(function (b) { return b.slotId === target; });
    var edge = (tgtIdx > curIdx) ? r.left + r.width / 3 : r.right - r.width / 3;
    var after = (target === d.base[0].slotId) ? false : hitX > edge;
    var next = (typeof computeReorder === 'function') ? computeReorder(d.slotId, target, after, d.base) : null;
    if (next && !sameOrder(next, d.preview)) {
      d.preview = next;
      cmApplyPreview(next);
    }
    break;
  }
  cmFollow(ev);
});

window.addEventListener('mouseup', function () { if (cmDrag) cmDragEnd(true); });
window.addEventListener('blur', function () { if (cmDrag) cmDragEnd(false); });

function cmDragEnd(commit) {
  var d = cmDrag;
  cmDrag = null;
  document.body.style.cursor = '';
  document.body.classList.remove('cm-drag-live');
  cmClearDropMarks();
  if (d.active) {
    cmSuppressClick = true;
    setTimeout(function () { cmSuppressClick = false; }, 0);
    if (commit && d.preview && !sameOrder(d.preview, d.base) && !sameOrder(d.preview, currentChain) && typeof sendChainOrder === 'function') {
      sendChainOrder(d.preview);   // rack replies with a chain map -> Classic re-renders -> Modern mirrors
      // Leave the preview on screen (no snap-back); drop the cursor-follow offset.
      [d.el, d.partner].forEach(function (u) { if (u) { u.style.transform = ''; u.style.transition = ''; u.classList.remove('cm-dragging'); } });
      return;
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
