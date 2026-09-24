/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// CALIBRATION WALKER (build 80, Charlie's dev tool) — header CAL button (build 81).
// Steps one on-screen knob through its 0-127 positions EXACTLY the way a user
// drag does (synthetic mousedown/mousemove/mouseup on the knob, so every knob
// engine's own send path runs), and after each step records the rack's reply —
// the full-precision value from the last incoming message's 5-byte value field
// (see decodeFull32, protocol.js) — plus the app's own readout. Optional
// "wait for me" mode pauses each step so the rack's screen value can be typed
// in. Result: a table, a CSV in the Captures folder, and CALWALK log lines.
// Only moves the one control on the current patch (like turning it by hand);
// nothing is saved to the rack, and the knob is put back where it started.
// ════════════════════════════════════════════════════════════════════
var calRunning = false, calStop = false, calMsgs = [], calNextResolve = null, calRows = [];

// Hooked from the SysEx dispatcher (sysex-handler.js) — collects replies while a step runs.
function calSniff(data) { if (calRunning) calMsgs.push(Array.from(data)); }

function calKnobLabel(wrap) {
  var p = wrap.parentElement;
  for (var i = 0; i < 3 && p; i++, p = p.parentElement) {
    var l = p.querySelector('label, .knob-label, .ctrl-label');
    if (l && l.textContent.trim()) return l.textContent.trim();
  }
  return wrap.id;
}
function calValEl(wrap) {
  var id = wrap.id.replace(/-wrap$/, '-val').replace(/-w-/, '-v-').replace(/^tone-w/, 'tone-v');
  return document.getElementById(id) || (wrap.parentElement && wrap.parentElement.querySelector('.knob-val'));
}
function calControls() {
  var list = [];
  document.querySelectorAll('.knob-wrap').forEach(function(w) {
    if (!w.id || w.offsetParent === null || w.closest('#rigbal-overlay')) return;
    if (w.dataset.base === 'eq') return;   // Graphic EQ faders: different drag widget
    list.push({ wrap: w, label: calKnobLabel(w) });
  });
  return list;
}

// Turn a knob to `target` through its normal drag path.
function calDrive(wrap, target) {
  var cur = parseInt(wrap.dataset.value); if (isNaN(cur)) cur = 64;
  var r = wrap.getBoundingClientRect(), x = r.left + r.width / 2, y0 = r.top + r.height / 2;
  var canvas = wrap.querySelector('canvas') || wrap;
  canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y0, buttons: 1 }));
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y0 - (target - cur), buttons: 1 }));
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y0 - (target - cur) }));
}

// Last message that carries a 5-byte value field -> {hex, raw}.
function calLastValue() {
  for (var i = calMsgs.length - 1; i >= 0; i--) {
    var m = calMsgs[i];
    if (m.length >= 12 && m[m.length - 1] === 0xF7) {
      var off = m.length - 6;
      var raw = decodeFull32(m, off);
      if (raw !== null) return { hex: m.map(function(b) { return b.toString(16).padStart(2, '0').toUpperCase(); }).join(' '), raw: raw };
    }
  }
  return null;
}

function calSetStatus(t) { var e = document.getElementById('cal-status'); if (e) e.textContent = t; }

function calRenderRow(r) {
  var tb = document.getElementById('cal-table-body');
  if (!tb) return;
  var tr = document.createElement('tr');
  var frac = (r.raw === null) ? '' : ((r.raw + 2147483648) / 4294967296).toFixed(6);
  [r.step, r.raw === null ? '—' : r.raw, frac, r.app, r.rack === undefined ? '' : r.rack].forEach(function(v) {
    var td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
  });
  tb.appendChild(tr);
  tr.scrollIntoView({ block: 'nearest' });
}

function calWaitForUser(step) {
  var box = document.getElementById('cal-wait');
  var inp = document.getElementById('cal-rack-input');
  if (box) box.style.display = '';
  if (inp) { inp.value = ''; inp.focus(); }
  calSetStatus('Step ' + step + ' — type what the RACK shows, then Next');
  return new Promise(function(res) { calNextResolve = res; });
}

async function calRun() {
  if (calRunning || !bridgeMidiReady) return;
  var ctrls = calControls();
  var sel = document.getElementById('cal-control');
  var c = ctrls[parseInt(sel.value)];
  if (!c) return;
  var every = parseInt(document.getElementById('cal-steps').value) || 1;
  var pauseSel = document.getElementById('cal-pause').value;
  var waitMode = (pauseSel === 'wait');
  var pause = waitMode ? 300 : (parseInt(pauseSel) || 300);
  var wrap = c.wrap, valEl = calValEl(wrap);
  var orig = parseInt(wrap.dataset.value); if (isNaN(orig)) orig = 64;
  calRunning = true; calStop = false; calRows = [];
  document.getElementById('cal-table-body').innerHTML = '';
  appLog('CALWALK start: ' + c.label + ' (' + wrap.id + ') every ' + every + ', pause ' + pauseSel + ', start value ' + orig);
  for (var v = 0; v <= 127; v += every) {
    if (calStop) break;
    calMsgs = [];
    calDrive(wrap, v);
    await sleep(pause);
    var got = calLastValue();
    var row = { step: v, raw: got ? got.raw : null, hex: got ? got.hex : '', app: valEl ? valEl.textContent : '' };
    if (waitMode) row.rack = await calWaitForUser(v);
    calRows.push(row);
    calRenderRow(row);
    appLog('CALWALK ' + c.label + ' step=' + v + ' raw=' + row.raw + ' app="' + row.app + '"'
      + (row.rack !== undefined ? ' rack="' + row.rack + '"' : '') + ' msg=' + row.hex);
    if (!waitMode) calSetStatus('Step ' + v + ' / 127 — ' + row.app);
    if (v < 127 && v + every > 127) v = 127 - every;   // always finish on 127
  }
  calDrive(wrap, orig);   // put the knob back
  calRunning = false;
  var w = document.getElementById('cal-wait'); if (w) w.style.display = 'none';
  appLog('CALWALK end: ' + c.label + ', ' + calRows.length + ' steps, restored to ' + orig);
  calSetStatus((calStop ? 'Stopped' : 'Done') + ' — ' + calRows.length + ' steps. Knob restored. Save CSV to keep it.');
  calLastLabel = c.label;
}
var calLastLabel = '';

async function calSaveCsv() {
  if (!calRows.length) return;
  var csv = 'step,raw_int32,fraction,app_readout,rack_readout,message\n' + calRows.map(function(r) {
    var frac = (r.raw === null) ? '' : ((r.raw + 2147483648) / 4294967296).toFixed(6);
    var q = function(s) { return '"' + String(s === undefined ? '' : s).replace(/"/g, '""') + '"'; };
    return [r.step, r.raw === null ? '' : r.raw, frac, q(r.app), q(r.rack), q(r.hex)].join(',');
  }).join('\n') + '\n';
  var name = 'Calibration ' + (calLastLabel || 'knob').replace(/[\\/:*?"<>|]/g, '_');
  try {
    var res = await window.electronAPI.saveTextCapture(name, csv, 'csv');
    calSetStatus(res && res.ok ? 'Saved: ' + res.path : 'Save failed: ' + (res ? res.error : '?'));
  } catch (e) { calSetStatus('Save failed: ' + e.message); }
}

function calOpen() {
  var sel = document.getElementById('cal-control');
  sel.innerHTML = '';
  calControls().forEach(function(c, i) {
    var o = document.createElement('option'); o.value = String(i); o.textContent = c.label; sel.appendChild(o);
  });
  calSetStatus(sel.options.length ? 'Pick a control on the panel that is open, then Start.' : 'No knobs visible — open a panel first.');
  document.getElementById('cal-modal').classList.add('open');
}

document.addEventListener('DOMContentLoaded', function() {
  var byId = function(id) { return document.getElementById(id); };
  if (byId('btn-calibration')) byId('btn-calibration').addEventListener('click', calOpen);
  if (byId('cal-start')) byId('cal-start').addEventListener('click', calRun);
  if (byId('cal-stop'))  byId('cal-stop').addEventListener('click', function() { calStop = true; if (calNextResolve) { var r = calNextResolve; calNextResolve = null; r(''); } });
  if (byId('cal-save'))  byId('cal-save').addEventListener('click', calSaveCsv);
  if (byId('cal-close')) byId('cal-close').addEventListener('click', function() {
    if (calRunning) { calStop = true; return; }
    byId('cal-modal').classList.remove('open');
  });
  var next = function() {
    if (!calNextResolve) return;
    var r = calNextResolve; calNextResolve = null;
    var box = byId('cal-wait'); if (box) box.style.display = 'none';
    r(byId('cal-rack-input').value.trim());
  };
  if (byId('cal-next')) byId('cal-next').addEventListener('click', next);
  if (byId('cal-rack-input')) byId('cal-rack-input').addEventListener('keydown', function(e) { if (e.key === 'Enter') next(); });
});
