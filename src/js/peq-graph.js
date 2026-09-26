/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// PARAMETRIC EQ GRAPH VIEW (build 119, v1.2.0). An alternate view of the
// PEQ panel: KNOBS | GRAPH switch in the panel header (localStorage
// 'peqView', unset → graph). Graph view takes over the Auto Advance +
// Preset/Bank rows (restored on KNOBS / panel close / other model).
// The knob panel stays built (hidden) and remains the single source of
// truth: the graph READS each knob's data-value / data-orig and cell.display,
// and WRITES through the same path the knobs use (updateFxHostKnob +
// queueKnobSend → sendFxHostParamWrite). Type = the hidden knob panel's own
// <select>, driven by a dispatched 'change'. Curve math = peqCoef/peqMagDb
// (fx-panels.js, build 70).
// ════════════════════════════════════════════════════════════════════
var PEQG_GMIN = -24, PEQG_GMAX = 24, PEQG_STEP = 6, PEQG_FMIN = 20, PEQG_FMAX = 20000, PEQG_H = 380;
var PEQG_PAD = { l: 44, r: 12, t: 12, b: 26 };
var peqgBuilt = false, peqgActive = false, peqgRaf = 0, peqgDrag = null, peqgHidden = [];
var peqgTables = {};   // lo -> [128 numbers] from cell.display

function peqgRange() { try { return localStorage.getItem('peqRange') || '24'; } catch (e) { return '24'; } }
// Range selector (build 120): fixed ±12/±24/±48, or Fit = symmetric range just covering the
// combined curve (notch/pass nulls ignored — bottomless). Fit is frozen during a dot drag.
function peqgApplyRange(cur, out) {
  var r = peqgRange(), R;
  if (r === 'fit') {
    if (peqgDrag) return;
    var m = Math.abs(out);
    for (var i = 0; i <= 200; i++) {
      var f = PEQG_FMIN * Math.pow(PEQG_FMAX / PEQG_FMIN, i / 200), s = out;
      cur.forEach(function(b) { if (b && !b.gainless) s += peqgBandDb(b, f); });
      if (Math.abs(s) > m) m = Math.abs(s);
      cur.forEach(function(b) { if (b && !b.notch) m = Math.max(m, Math.abs(peqgBandDb(b, b.f))); });
    }
    R = Math.max(6, Math.min(48, Math.ceil((m + 2) / 6) * 6));
  } else R = parseInt(r, 10) || 24;
  PEQG_GMIN = -R; PEQG_GMAX = R; PEQG_STEP = R <= 12 ? 3 : ((R <= 36 || R % 12) ? 6 : 12);
}
// ── Spectrum (build 123) — rack's FINAL output via the audio engine ──
var peqgSpecBands = null, peqgSpecAt = 0, peqgSpecSent = null;
function peqgSpecPref() { try { return localStorage.getItem('peqSpectrum') !== 'off'; } catch (e) { return true; } }
function peqgSpecSync() {
  var eng = !!window.audioEngineRunning, want = peqgActive && eng && peqgSpecPref();
  var btn = document.getElementById('peq-spec-btn'), note = document.getElementById('peq-spec-note');
  if (btn) { btn.style.display = (peqgActive && eng) ? '' : 'none'; btn.classList.toggle('on', peqgSpecPref()); }
  if (note) note.style.display = want ? '' : 'none';
  if (!eng) peqgSpecSent = null;             // engine restart -> resend
  if (want !== peqgSpecSent && eng) {
    peqgSpecSent = want;
    if (window.electronAPI && window.electronAPI.audioSetSpectrum) window.electronAPI.audioSetSpectrum(want);
  }
  if (!want) peqgSpecBands = null;
}
function peqgSpecIn(b) {
  if (!Array.isArray(b)) return;
  if (!peqgSpecBands || peqgSpecBands.length !== b.length) peqgSpecBands = b.slice();
  else for (var i = 0; i < b.length; i++) {   // fast rise, slow fall (~30 dB/s)
    peqgSpecBands[i] = b[i] > peqgSpecBands[i] ? b[i] : Math.max(b[i], peqgSpecBands[i] - 1.5);
  }
  peqgSpecAt = Date.now();
  if (peqgActive) peqgSchedule();
}
function peqgView() { try { return localStorage.getItem('peqView') || 'graph'; } catch (e) { return 'graph'; } }
function peqgSetView(v) { try { localStorage.setItem('peqView', v); } catch (e) {} peqGraphRefresh(); }

function peqgHex(lo) { return lo.toString(16).padStart(2, '0'); }
// build 121: the PEQ model is looked up by name, not via the chain map (which
// lags a model switch by a beat) — the knob panel's own data-peq marker decides.
var peqgModel = null;
function peqgPeqModel() {
  if (!peqgModel) FX1_MODELS.forEach(function(m) { if (m.name === 'Parametric EQ') peqgModel = m; });
  return peqgModel;
}
function peqgCell(lo) {
  var m = peqgPeqModel(), c = null;
  if (m) fxHostAllCells(m).forEach(function(x) { if (x.lo === lo) c = x; });
  return c;
}
function peqgNum(s) { s = String(s); var n = parseFloat(s); return isNaN(n) ? null : (/kHz/.test(s) ? n * 1000 : n); }
function peqgTable(lo) {
  if (peqgTables[lo]) return peqgTables[lo];
  var c = peqgCell(lo); if (!c || typeof c.display !== 'function') return null;
  var t = []; for (var v = 0; v < 128; v++) t.push(peqgNum(c.display(v)));
  return (peqgTables[lo] = t);
}
function peqgNearest(lo, num) {
  var t = peqgTable(lo); if (!t) return null;
  var best = 0, bd = Infinity, logd = (lo === 0x03 || lo === 0x07 || lo === 0x0A || lo === 0x0D || lo === 0x04 || lo === 0x08 || lo === 0x0B || lo === 0x0E);
  for (var v = 0; v < 128; v++) {
    var d = logd ? Math.abs(Math.log(t[v] / num)) : Math.abs(t[v] - num);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}
function peqgWrap(lo) { return document.getElementById('fxhost-w-' + peqgHex(lo)); }
function peqgV(lo, orig) {
  var w = peqgWrap(lo); if (!w) return null;
  var s = orig ? w.dataset.orig : w.dataset.value;
  if (s === undefined || s === '') s = w.dataset.value;
  var v = parseInt(s, 10); return isNaN(v) ? null : v;
}
function peqgVal(lo, orig) { var v = peqgV(lo, orig), t = peqgTable(lo); return (v === null || !t) ? null : t[v]; }
function peqgTypeSel(band) { return band.type === null ? null : document.getElementById('fxhost-sel-' + peqgHex(band.type)); }
function peqgTypeLabel(band, orig) {
  var sel = peqgTypeSel(band); if (!sel) return 'Peaking';
  var idx = sel.selectedIndex;
  if (orig) {
    var m = peqgPeqModel();
    var k = 'fxhost-sel:' + openFxHostSlot + ':' + (m ? m.mid : '') + ':' + peqgHex(band.type);
    if (typeof dropdownLoadedValue !== 'undefined' && dropdownLoadedValue[k] !== undefined) idx = parseInt(dropdownLoadedValue[k], 10);
  }
  return (idx >= 0 && sel.options[idx]) ? sel.options[idx].text : 'Peaking';
}
function peqgFilters(band, orig) {
  var g = peqgVal(band.g, orig), f = peqgVal(band.f, orig), q = peqgVal(band.q, orig);
  if (g === null || f === null || q === null) return null;
  var lbl = peqgTypeLabel(band, orig), t = 'peak', n = 1;
  if (/Shelf/.test(lbl))          t = band.low ? 'lshelf' : 'hshelf';
  else if (/Notch/.test(lbl))     t = 'notch';
  else if (/pass 6dB/.test(lbl))  t = band.low ? 'hp1' : 'lp1';
  else if (/pass 12dB/.test(lbl)) t = band.low ? 'hp2' : 'lp2';
  else if (/pass 24dB/.test(lbl)) { t = band.low ? 'hp2' : 'lp2'; n = 2; }
  var list = []; for (var i = 0; i < n; i++) list.push(peqCoef(t, f, g, q));
  return { f: f, g: g, list: list, notch: t === 'notch', gainless: /pass|Notch/.test(lbl) };
}
function peqgBandDb(r, f) { var s = 0; r.list.forEach(function(k) { s += peqMagDb(k, f); }); return s; }

// ── Mode switch: show/hide graph + rows ──
function peqgIsPeqOpen() {
  var p = document.getElementById('panel-fxhost');
  if (!p || p.style.display === 'none' || openFxHostSlot === null) return false;
  return !!document.querySelector('#fxhost-knob-row [data-peq]');
}
// build 121: values are real only once the open/switch paint buffer has flushed
// and every knob shows a value (a fresh build holds placeholder 64s behind '--').
function peqgReady() {
  if ((typeof fxHostPaintDeferred !== 'undefined' && fxHostPaintDeferred) ||
      (typeof fxHostPendingBuild !== 'undefined' && fxHostPendingBuild)) return false;
  for (var lo = 0x02; lo <= 0x10; lo++) {
    if (lo === 0x05 || lo === 0x0F) continue;
    var v = document.getElementById('fxhost-v-' + peqgHex(lo));
    if (!v || v.textContent.trim() === '--') return false;
  }
  return true;
}
function peqGraphRefresh() {
  var seg = document.getElementById('peq-view-seg'), g = document.getElementById('peq-graph'),
      kr = document.getElementById('fxhost-knob-row');
  if (!seg || !g || !kr) return;
  var peq = peqgIsPeqOpen(), graph = peq && peqgView() === 'graph';
  seg.style.display = peq ? '' : 'none';
  seg.querySelectorAll('button').forEach(function(b) { b.classList.toggle('on', b.dataset.view === (graph ? 'graph' : 'knobs')); });
  if (graph !== peqgActive) {
    peqgActive = graph;
    if (graph) {
      peqgBuild();
      peqgHidden = [];
      ['roller-strip', 'btoolbar'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) { peqgHidden.push([el, el.style.display]); el.style.display = 'none'; }
      });
    } else {
      peqgHidden.forEach(function(p) { p[0].style.display = p[1]; });
      peqgHidden = [];
      peqgDrag = null;
    }
    kr.style.display = graph ? 'none' : 'flex';
    g.style.display = graph ? '' : 'none';
    var cm = document.getElementById('peqg-menu'); if (cm) cm.style.display = 'none';
  }
  if (graph) peqgSchedule();
  peqgSpecSync();
}
function peqgSchedule() {
  if (peqgRaf) return;
  peqgRaf = requestAnimationFrame(function() { peqgRaf = 0; if (peqgActive) { peqgDraw(); peqgStrip(); } });
}

// ── Writes (same path as a knob drag) ──
function peqgWrite(lo, v) {
  v = Math.max(0, Math.min(127, Math.round(v)));
  if (peqgV(lo) === v) return;
  var slotId = openFxHostSlot;
  updateFxHostKnob(lo, v);
  if (bridgeMidiReady) queueKnobSend('fxhost:' + lo, function(val) { sendFxHostParamWrite(slotId, lo, val); }, v);
  peqgSchedule();
}
function peqgSetType(band, idx) {
  var sel = peqgTypeSel(band); if (!sel) return;
  sel.value = String(idx); sel.dispatchEvent(new Event('change'));
  peqgSchedule();
}

// ── Build DOM (once) ──
var PEQG_BANDS = [   // band -> param los (mirrors PEQ_BANDS, fx-panels.js)
  { n: 'LF',  g: 0x02, f: 0x03, q: 0x04, type: 0x05, col: 'var(--red-hot)', low: true },
  { n: 'LMF', g: 0x06, f: 0x07, q: 0x08, type: null, col: 'var(--accent)' },
  { n: 'HMF', g: 0x09, f: 0x0A, q: 0x0B, type: null, col: 'var(--green)' },
  { n: 'HF',  g: 0x0C, f: 0x0D, q: 0x0E, type: 0x0F, col: '#3f8fe0', low: false }
];
var PEQG_ROWS = [['Freq', 'f'], ['Gain', 'g'], ['Q', 'q']];

function peqgBuild() {
  peqgTables = {};
  var g = document.getElementById('peq-graph');
  if (peqgBuilt) { peqgStripTypes(); return; }
  peqgBuilt = true;
  var html = '<div class="peqg-wrap"><select id="peqg-range" title="Graph range"><option value="12">±12 dB</option><option value="24">±24 dB</option><option value="48">±48 dB</option><option value="fit">Fit</option></select><canvas id="peqg-canvas"></canvas></div><div class="peqg-strip">';
  PEQG_BANDS.forEach(function(b, i) {
    html += '<div class="peqg-band" style="--bc:' + b.col + '"><div class="peqg-bt"><span class="peqg-n">' + b.n + '</span>'
      + (b.type !== null ? '<select class="peqg-type" data-b="' + i + '"></select>' : '<span class="peqg-fixed">Peaking</span>') + '</div>';
    PEQG_ROWS.forEach(function(r) {
      var lo = b[r[1]];
      html += '<div class="peqg-row"><span class="peqg-l">' + r[0] + '</span><span class="peqg-rw">'
        + '<input type="range" min="0" max="127" step="1" data-lo="' + lo + '"><i class="peqg-tick" data-lo="' + lo + '"></i></span>'
        + '<input class="peqg-vb" data-lo="' + lo + '" spellcheck="false"></div>';
    });
    html += '</div>';
  });
  html += '<div class="peqg-band" style="--bc:var(--red-hot)"><div class="peqg-bt"><span class="peqg-n">OUT</span></div>'
    + '<div class="peqg-row"><span class="peqg-l">Gain</span><span class="peqg-rw"><input type="range" min="0" max="127" step="1" data-lo="16">'
    + '<i class="peqg-tick" data-lo="16"></i></span><input class="peqg-vb" data-lo="16" spellcheck="false"></div></div></div>';
  g.innerHTML = html;
  var menu = document.createElement('div'); menu.id = 'peqg-menu'; document.body.appendChild(menu);
  peqgStripTypes();

  g.querySelectorAll('input[type=range]').forEach(function(r) {
    var lo = parseInt(r.dataset.lo, 10);
    r.addEventListener('input', function() { peqgWrite(lo, parseInt(r.value, 10)); });
    r.addEventListener('dblclick', function() { var o = peqgV(lo, true); if (o !== null) peqgWrite(lo, o); });
    r.addEventListener('wheel', function(e) {
      if (r.disabled) return; e.preventDefault();
      var v = peqgV(lo); if (v !== null) peqgWrite(lo, v - Math.sign(e.deltaY));
    }, { passive: false });
  });
  g.querySelectorAll('input.peqg-vb').forEach(function(box) {
    var lo = parseInt(box.dataset.lo, 10);
    function commit() {
      var s = box.value.trim(), n = parseFloat(s);
      if (!isNaN(n)) { if (/k/i.test(s)) n *= 1000; var v = peqgNearest(lo, n); if (v !== null) peqgWrite(lo, v); }
      box.blur(); peqgSchedule();
    }
    box.addEventListener('keydown', function(e) { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { box.blur(); peqgSchedule(); } });
    box.addEventListener('change', commit);
    box.addEventListener('focus', function() { box.select(); });
  });
  g.querySelectorAll('select.peqg-type').forEach(function(s) {
    s.addEventListener('change', function() { peqgSetType(PEQG_BANDS[parseInt(s.dataset.b, 10)], parseInt(s.value, 10)); });
  });

  var rs = document.getElementById('peqg-range');
  rs.value = peqgRange();
  rs.addEventListener('change', function() { try { localStorage.setItem('peqRange', rs.value); } catch (e) {} peqgSchedule(); });
  var cv = document.getElementById('peqg-canvas');
  cv.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    var b = peqgHit(e); if (!b) return;
    peqgDrag = b; e.preventDefault(); peqgSchedule();
  });
  window.addEventListener('mousemove', function(e) {
    if (!peqgDrag) return;
    if (e.buttons === 0) { peqgDrag = null; peqgSchedule(); return; }
    var p = peqgPos(e), r = peqgFilters(peqgDrag);
    var v = peqgNearest(peqgDrag.f, peqgXF(p.x)); if (v !== null) peqgWrite(peqgDrag.f, v);
    if (r && !r.gainless) { v = peqgNearest(peqgDrag.g, peqgYG(p.y)); if (v !== null) peqgWrite(peqgDrag.g, v); }
  });
  window.addEventListener('mouseup', function() { if (peqgDrag) { peqgDrag = null; peqgSchedule(); } });   // Fit re-scales on release
  cv.addEventListener('wheel', function(e) {
    var b = peqgHit(e); if (!b) return; e.preventDefault();
    var v = peqgV(b.q); if (v !== null) peqgWrite(b.q, v - Math.sign(e.deltaY));
  }, { passive: false });
  cv.addEventListener('dblclick', function(e) {
    var b = peqgHit(e); if (!b) return;
    [b.f, b.g, b.q].forEach(function(lo) { var o = peqgV(lo, true); if (o !== null) peqgWrite(lo, o); });
  });
  cv.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    var b = peqgHit(e), sel = b ? peqgTypeSel(b) : null;
    if (!b) { menu.style.display = 'none'; return; }
    var h = '<div class="h">' + b.n + ' type</div>';
    if (!sel) {   // LMF/HMF: the rack offers Peaking only (build 120)
      menu.innerHTML = h + '<div class="on dis">Peaking</div><div class="h">fixed on the rack</div>';
      menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px'; menu.style.display = 'block';
      return;
    }
    for (var i = 0; i < sel.options.length; i++)
      h += '<div data-i="' + i + '" class="' + (i === sel.selectedIndex ? 'on' : '') + '">' + sel.options[i].text + '</div>';
    menu.innerHTML = h;
    menu.querySelectorAll('div[data-i]').forEach(function(d) {
      d.addEventListener('click', function() { peqgSetType(b, parseInt(d.dataset.i, 10)); menu.style.display = 'none'; });
    });
    menu.style.left = e.clientX + 'px'; menu.style.top = e.clientY + 'px'; menu.style.display = 'block';
  });
  document.addEventListener('mousedown', function(e) { if (!menu.contains(e.target)) menu.style.display = 'none'; });
  window.addEventListener('resize', peqgSchedule);
}
function peqgStripTypes() {
  document.querySelectorAll('#peq-graph select.peqg-type').forEach(function(s) {
    var src = peqgTypeSel(PEQG_BANDS[parseInt(s.dataset.b, 10)]);
    s.innerHTML = src ? src.innerHTML : '';
  });
}

// ── Geometry ──
var peqgW = 0;
function peqgX(f) { return PEQG_PAD.l + Math.log(f / PEQG_FMIN) / Math.log(PEQG_FMAX / PEQG_FMIN) * (peqgW - PEQG_PAD.l - PEQG_PAD.r); }
function peqgXF(x) { return PEQG_FMIN * Math.pow(PEQG_FMAX / PEQG_FMIN, (x - PEQG_PAD.l) / (peqgW - PEQG_PAD.l - PEQG_PAD.r)); }
function peqgY(g) { return PEQG_PAD.t + (PEQG_GMAX - g) / (PEQG_GMAX - PEQG_GMIN) * (PEQG_H - PEQG_PAD.t - PEQG_PAD.b); }
function peqgYG(y) { return PEQG_GMAX - (y - PEQG_PAD.t) / (PEQG_H - PEQG_PAD.t - PEQG_PAD.b) * (PEQG_GMAX - PEQG_GMIN); }
function peqgPos(e) { var r = document.getElementById('peqg-canvas').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function peqgDotDb(r) {
  var y = r.notch ? 0 : peqgBandDb(r, r.f);   // on the band's own curve (build 120)
  return Math.max(PEQG_GMIN, Math.min(PEQG_GMAX, y));
}
function peqgHit(e) {
  var p = peqgPos(e), hit = null;
  PEQG_BANDS.forEach(function(b) {
    var r = peqgFilters(b); if (!r) return;
    if (Math.hypot(peqgX(r.f) - p.x, peqgY(peqgDotDb(r)) - p.y) < 12) hit = b;
  });
  return hit;
}

// ── Draw ──
function peqgDraw() {
  var cv = document.getElementById('peqg-canvas'); if (!cv) return;
  var W = cv.parentNode.clientWidth - 2; if (W < 200) return;
  var dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(PEQG_H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(PEQG_H * dpr);
    cv.style.width = W + 'px'; cv.style.height = PEQG_H + 'px';
  }
  peqgW = W;
  var x = cv.getContext('2d'), H = PEQG_H, P = PEQG_PAD;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, W, H);
  var ready = peqgReady();
  var cur = ready ? PEQG_BANDS.map(function(b) { return peqgFilters(b); }) : [];
  var out = ready ? (peqgVal(PEQ_OUT_LO) || 0) : 0;
  if (ready) peqgApplyRange(cur, out);
  x.font = '10px sans-serif'; x.lineWidth = 1;
  [30,40,60,70,80,90,300,400,600,700,800,900,3000,4000,6000,7000,8000,9000].forEach(function(f) {
    x.strokeStyle = '#1c1c1c'; x.beginPath(); x.moveTo(peqgX(f), P.t); x.lineTo(peqgX(f), H - P.b); x.stroke();
  });
  [20,50,100,200,500,1000,2000,5000,10000,20000].forEach(function(f) {
    x.strokeStyle = '#2a2a2a'; x.beginPath(); x.moveTo(peqgX(f), P.t); x.lineTo(peqgX(f), H - P.b); x.stroke();
    x.fillStyle = '#777'; x.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), peqgX(f) - 8, H - 8);
  });
  for (var gg = PEQG_GMIN; gg <= PEQG_GMAX; gg += PEQG_STEP) {
    x.strokeStyle = gg === 0 ? '#555' : '#2a2a2a';
    x.beginPath(); x.moveTo(P.l, peqgY(gg)); x.lineTo(W - P.r, peqgY(gg)); x.stroke();
    x.fillStyle = '#777'; x.fillText((gg > 0 ? '+' : '') + gg, 8, peqgY(gg) + 3);
  }
  if (!ready) return;   // grid only until the real values are in (build 121)
  if (peqgSpecBands && Date.now() - peqgSpecAt < 500 && peqgSpecPref()) {
    // Own scale: bottom = -90 dBFS, top = 0 dBFS (not the EQ's dB axis).
    var nb = peqgSpecBands.length, sy = function(d) { return (H - P.b) - (Math.max(-90, Math.min(0, d)) + 90) / 90 * (H - P.t - P.b); };
    x.save(); x.beginPath(); x.moveTo(P.l, H - P.b);
    for (var si = 0; si < nb; si++) {
      var sf = 20 * Math.pow(1000, (si + 0.5) / nb);
      x.lineTo(peqgX(sf), sy(peqgSpecBands[si]));
    }
    x.lineTo(W - P.r, H - P.b); x.closePath();
    x.fillStyle = 'rgba(120,160,200,0.18)'; x.fill();
    x.strokeStyle = 'rgba(140,180,220,0.45)'; x.lineWidth = 1; x.stroke(); x.restore();
  }
  function line(fn, col, w, dash, alpha) {
    x.save(); x.beginPath(); x.rect(P.l, P.t, W - P.l - P.r, H - P.t - P.b); x.clip();
    x.strokeStyle = col; x.lineWidth = w; x.globalAlpha = alpha || 1; if (dash) x.setLineDash(dash);
    x.beginPath();
    for (var px = P.l; px <= W - P.r; px += 0.5) {
      var y = Math.max(-500, Math.min(H + 500, peqgY(fn(peqgXF(px)))));
      if (px === P.l) x.moveTo(px, y); else x.lineTo(px, y);
    }
    x.stroke(); x.restore();
  }
  var sav = PEQG_BANDS.map(function(b) { return peqgFilters(b, true); });
  var outS = peqgVal(PEQ_OUT_LO, true); if (outS === null) outS = out;
  function sum(rs, o) { return function(f) { var s = o; rs.forEach(function(r) { if (r) s += peqgBandDb(r, f); }); return s; }; }
  if (sav.every(function(r) { return r; })) line(sum(sav, outS), '#9a9a9a', 1.5, [6, 4]);
  cur.forEach(function(r, i) { if (r) line(function(f) { return peqgBandDb(r, f); }, cssColor(PEQG_BANDS[i].col), 1.2, null, 0.55); });
  line(sum(cur, out), '#ffffff', 2.2);
  cur.forEach(function(r, i) {
    if (!r) return;
    var b = PEQG_BANDS[i], X = peqgX(r.f), Y = peqgY(peqgDotDb(r));
    x.fillStyle = cssColor(b.col); x.strokeStyle = '#fff'; x.lineWidth = 1.5;
    x.beginPath(); x.arc(X, Y, peqgDrag === b ? 9 : 7, 0, Math.PI * 2); x.fill(); x.stroke();
    x.fillStyle = '#ddd'; x.fillText(b.n, X - 8, Y - 12);
  });
}
function peqgStrip() {
  var g = document.getElementById('peq-graph'); if (!g || !peqgReady()) return;
  g.querySelectorAll('input[type=range]').forEach(function(r) {
    var lo = parseInt(r.dataset.lo, 10), v = peqgV(lo); if (v !== null) r.value = v;
    var band = null; PEQG_BANDS.forEach(function(b) { if (b.g === lo) band = b; });
    var rr = band ? peqgFilters(band) : null;
    r.disabled = !!(rr && rr.gainless);
  });
  g.querySelectorAll('i.peqg-tick').forEach(function(t) {
    var o = peqgV(parseInt(t.dataset.lo, 10), true);
    if (o !== null) t.style.left = 'calc(7px + ' + (o / 127) + ' * (100% - 14px))';
  });
  g.querySelectorAll('input.peqg-vb').forEach(function(box) {
    if (document.activeElement === box) return;
    var lo = parseInt(box.dataset.lo, 10), v = peqgV(lo), c = peqgCell(lo);
    box.value = (v !== null && c) ? c.display(v) : '--';
  });
  g.querySelectorAll('select.peqg-type').forEach(function(s) {
    var src = peqgTypeSel(PEQG_BANDS[parseInt(s.dataset.b, 10)]);
    if (src && s.options.length !== src.options.length) s.innerHTML = src.innerHTML;
    if (src) s.value = src.value;
  });
}

// ── Wiring ──
(function() {
  var sb = document.getElementById('peq-spec-btn');
  if (sb) sb.addEventListener('click', function() {
    try { localStorage.setItem('peqSpectrum', peqgSpecPref() ? 'off' : 'on'); } catch (e) {}
    peqgSpecSync(); peqgSchedule();
  });
  if (window.electronAPI && window.electronAPI.onAudioSpectrum) window.electronAPI.onAudioSpectrum(peqgSpecIn);
  var seg = document.getElementById('peq-view-seg');
  if (seg) seg.querySelectorAll('button').forEach(function(b) {
    b.addEventListener('click', function() { peqgSetView(b.dataset.view); });
  });
  var p = document.getElementById('panel-fxhost'), kr = document.getElementById('fxhost-knob-row');
  var mo = new MutationObserver(function() { peqGraphRefresh(); });
  if (p) mo.observe(p, { attributes: true, attributeFilter: ['style'] });
  if (kr) {
    mo.observe(kr, { childList: true });
    new MutationObserver(peqgSchedule).observe(kr, { attributes: true, subtree: true, attributeFilter: ['data-value', 'data-orig'] });
    kr.addEventListener('change', peqgSchedule);
  }
})();
