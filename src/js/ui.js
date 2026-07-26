// ════════════════════════════════════════════════════════════════════
// UI.JS — knob rendering, value formatting, enable/disable state,
// display updates. Everything that touches the DOM to show something,
// as opposed to transport.js (sends/receives) or protocol.js (decodes).
// ════════════════════════════════════════════════════════════════════

// ── Knob colour states (item A, 7/26/2026) ──────────────────────────
// The rack's line-pointer knobs glow to show state; we mirror that.
//   amber = amp / main-panel base   green = fx (effect-panel) base
//   red   = current value differs from the patch's SAVED baseline
// Baseline = the value read back when the patch loads (see
// captureKnobBaselines). Any move away from it — from our drag, the front
// panel, or Avid — turns the knob red, exactly as the hardware pointer does.
// Kept as named values so item B can later read them from settings.json.
const KNOB_COLORS = {
  amber: '#e0a020',   // was hardcoded throughout drawKnob
  green: '#30c050',   // theme --green, matches active chain blocks
  red:   '#e83828'    // uncommitted change
};

// Decide a knob's colour from its wrap: fx base if data-base="fx", red if a
// baseline is stored and the current value differs from it.
function knobColor(canvas, value127) {
  const wrap = canvas.closest ? canvas.closest('.knob-wrap') : null;
  let base = KNOB_COLORS.amber;
  if (wrap && wrap.dataset.base === 'fx') base = KNOB_COLORS.green;
  if (wrap && wrap.dataset.orig !== undefined && wrap.dataset.orig !== ''
      && parseInt(wrap.dataset.orig) !== value127) {
    return KNOB_COLORS.red;
  }
  return base;
}

function drawKnob(canvas, value127) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w/2, cy = h/2, r = (w-6)/2;
  const knobCol = knobColor(canvas, value127);

  // 7 o'clock = 225° from top (12 o'clock), going clockwise
  // Canvas angles: 0 = right (3 o'clock), PI/2 = bottom, PI = left, 3PI/2 = top
  // 12 o'clock in canvas = -PI/2 (or 3PI/2)
  // 7 o'clock = -PI/2 + 225°*(PI/180) = -PI/2 + 3.927 = 2.356 rad
  const startRad = -Math.PI/2 + (225 * Math.PI/180);
  const sweepRad = 270 * Math.PI/180;
  const endRad   = startRad + (sweepRad * value127/127);

  ctx.clearRect(0, 0, w, h);

  // Track
  ctx.beginPath();
  ctx.arc(cx, cy, r-4, startRad, startRad+sweepRad);
  ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.stroke();

  // Value arc
  if (value127 > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r-4, startRad, endRad);
    ctx.strokeStyle = knobCol; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Body
  ctx.beginPath();
  ctx.arc(cx, cy, r-11, 0, Math.PI*2);
  ctx.fillStyle = '#242424'; ctx.fill();
  ctx.strokeStyle = '#484848'; ctx.lineWidth = 1.5; ctx.stroke();

  // Indicator dot — endRad is a canvas arc angle (0=3 o'clock).
  // The dot offset -(r-17) points up (12 o'clock) before rotation,
  // so we add PI/2 to align it with the arc endpoint.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(endRad + Math.PI/2);
  ctx.beginPath();
  ctx.arc(0, -(r-17), 4, 0, Math.PI*2);
  ctx.fillStyle = knobCol; ctx.fill();
  ctx.restore();
}

// Drop main-panel baselines and repaint to base colour. Called at nav start so
// the incoming patch's knobs show plain amber during the pull instead of a red
// flash (the old patch's baseline would otherwise read every new value as
// "changed"). The new baseline is taken at the end of the pull.
function clearMainKnobBaselines() {
  document.querySelectorAll('.knob-wrap:not([data-base="fx"])').forEach(function(w) {
    delete w.dataset.orig;
    var c = w.querySelector('canvas');
    if (c && w.dataset.value !== undefined && w.dataset.value !== '')
      drawKnob(c, parseInt(w.dataset.value) || 0);
  });
}

// Snapshot every MAIN-PANEL knob's current value as its baseline. Called once
// per patch load and once after a save, so the red "changed" state is measured
// against the patch's saved values — not against a live edit. Effect-panel
// knobs (data-base="fx") are excluded here; they baseline themselves when their
// panel's params arrive (see updateDistKnob / updateReverbKnob), because those
// values come in a separate query a moment later, not in this patch dump.
function captureKnobBaselines() {
  document.querySelectorAll('.knob-wrap:not([data-base="fx"])').forEach(function(w) {
    if (w.dataset.value !== undefined && w.dataset.value !== '') {
      w.dataset.orig = w.dataset.value;
      var c = w.querySelector('canvas');
      if (c) drawKnob(c, parseInt(w.dataset.value) || 0);  // reset colour to base
    }
  });
}

function valDisplay(v127) { return (v127/127*10).toFixed(1); }

// ── Effect-panel knob baseline (item A, FX truth) ───────────────────
// The effect-panel DOM is rebuilt every time a panel opens, so a knob's
// "original" value cannot live only on the wrap or it is lost on reopen —
// which is why FX knobs used to forget their red state after switching panels.
// It lives here instead: one entry per effect slot, surviving open/close and
// visits to other panels, exactly like the amp panel holds its truth.
//   fxBaseline[slotId][loHex] = original value for THIS patch
// Reset points:
//   - full patch nav  -> clearFxBaselines() from clearStaleReadoutsOnNav()
//   - effect model change -> clearFxBaselineForSlot() in the refresh funcs
//   - save -> re-anchored to the just-saved values (sysex-handler save path)
var fxBaseline = {};

// ── SAVE-button dirty latch (item, 7/26) ────────────────────────────
// Grey until the first patch edit, then green until the next patch nav or a
// save. Pure latch — set once on change, never re-checks whether values were
// put back. Global writes (To Amp source) and readbacks do not call these.
function markPatchDirty() {
  var b = document.getElementById('btn-save-menu');
  if (b) b.classList.add('green');
}
function clearPatchDirty() {
  var b = document.getElementById('btn-save-menu');
  if (b) b.classList.remove('green');
}

// ── Knob write throttle (item, 7/26) ────────────────────────────────
// A knob drag used to send one MIDI write per mouse-move — up to ~48/sec in a
// captured session. That flood swamps the rack; it reassigns the amp's internal
// handle mid-stream and starts broadcasting from the new one, which the app no
// longer recognises ("instId does not match currentParamHi, ignored"), so the
// knobs go dead in both directions and it looks like a disconnect. Same problem
// the tempo control already solved. This trailing throttle coalesces rapid
// changes per control: the on-screen knob still moves instantly (drawn locally);
// only the hardware write is paced, and the final value always lands.
var KNOB_SEND_INTERVAL = 60;   // ms between writes for one control while dragging
var _knobSendTimers  = {};
var _knobSendPending = {};
function queueKnobSend(key, fn, val) {
  _knobSendPending[key] = { fn: fn, val: val };
  if (_knobSendTimers[key]) return;               // a write is already scheduled
  _knobSendTimers[key] = setTimeout(function() {
    _knobSendTimers[key] = null;
    var p = _knobSendPending[key];
    _knobSendPending[key] = null;
    if (p) p.fn(p.val);                            // send the most recent value
  }, KNOB_SEND_INTERVAL);
}

function clearFxBaselines() { fxBaseline = {}; }
function clearFxBaselineForSlot(slotId) { delete fxBaseline[slotId]; }
function fxBaselineGet(slotId, loHex) {
  return fxBaseline[slotId] ? fxBaseline[slotId][loHex] : undefined;
}
// First value seen for a slot+lo this patch becomes its baseline; later calls
// return that same stored baseline rather than overwriting it, so a reopened
// panel measures the current (possibly changed) value against the original.
function fxBaselineSetIfUnset(slotId, loHex, val) {
  if (!fxBaseline[slotId]) fxBaseline[slotId] = {};
  if (fxBaseline[slotId][loHex] === undefined) fxBaseline[slotId][loHex] = val;
  return fxBaseline[slotId][loHex];
}

// After a save, whatever an open effect panel currently shows IS the saved
// truth — re-anchor its baseline to now so those knobs read green again.
function rebaselineOpenFxPanel() {
  var slotId = -1, sel = '';
  if (typeof distPanelOpen !== 'undefined' && distPanelOpen)        { slotId = SLOT_DIST;   sel = '#dist-knob-row .knob-wrap'; }
  else if (typeof reverbPanelOpen !== 'undefined' && reverbPanelOpen){ slotId = SLOT_REVERB; sel = '#reverb-knob-row .knob-wrap'; }
  if (slotId < 0) return;
  document.querySelectorAll(sel).forEach(function(w) {
    var loHex = w.dataset.distLo || w.dataset.reverbLo;
    if (loHex === undefined || w.dataset.value === undefined || w.dataset.value === '') return;
    var v = parseInt(w.dataset.value);
    if (!fxBaseline[slotId]) fxBaseline[slotId] = {};
    fxBaseline[slotId][loHex] = v;
    w.dataset.orig = v;
    drawKnob(w.querySelector('canvas'), v);
  });
}

// Gate Threshold: 0=OFF, 1-127 maps -90dB to -20dB
function valGateThresh(v127) {
  if (v127 === 0) return 'OFF';
  const db = -90 + (v127 / 127) * 70;
  return db.toFixed(1) + ' dB';
}

// Gate Release: logarithmic 10ms to 3000ms
// Hardware shows ~198ms at midpoint — log scale confirmed
function valGateRelease(v127) {
  if (v127 === 0) return '10 ms';
  // Logarithmic: ms = 10 * (300)^(v/127)
  const ms = 10 * Math.pow(300, v127 / 127);
  return ms >= 1000 ? (ms/1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';
}

// Rig Volume: 0-127 maps -24dB to 0dB
function valRigVol(v127) {
  const db = -24 + (v127 / 127) * 24;
  return db.toFixed(1) + ' dB';
}

// Amp Out Level — 0.6 dB per step, 0.0 dB at v127 = 98.
// ANCHORED 7/23/2026, replacing db = -60 + (v127/127)*78, which put 0.0 dB at
// v127 = 97.7 — a value that cannot exist, so the display could never print
// 0.0 and read +0.2 instead.
// EVIDENCE (session-2026-07-23-155947.log):
//   rack set to 0.0 dB  -> v127 = 98, we displayed +0.2
//   rack reading 4.8 dB -> v127 = 106, we displayed +5.1
// 106 is 8 steps above 98 and 4.8 / 8 = 0.6 exactly. The old 78 dB span
// implies 0.6142 per step, which would have shown 4.9 rather than the 4.8 on
// the rack, so 0.6 is the true step and the documented -60..+18 range was
// rounded. Implied endpoints are now -58.8 dB at 0 and +17.4 dB at 127 —
// worth a spot check at both extremes.
function valAmpOut(v127) {
  const db = (v127 - 98) * 0.6;
  const t = db.toFixed(1);
  // No '+' on a bare zero, matching the rack.
  return (parseFloat(t) > 0 ? '+' : '') + t + ' dB';
}

// To Amp 1/2 Volume: 0-127 maps -12dB to +12dB. v0=0x00 = MUTE.
// Confirmed from Avid editor display 7/17/2026.
//
// ANCHORED AT 64 (fixed 7/23/2026). The old formula was
//     db = -12 + (v127 / 127) * 24
// which puts 0.0 dB at v127 = 63.5 — a value that cannot exist. The display
// could therefore NEVER print 0.0: it showed +0.1 at 64 and -0.1 at 63.
// Evidence: with the rack reading 0.0 dB our own log recorded
//     CMD 0x36 ToAmp1 volume: v0=0x00 (+0.1 dB)
// and v0=0x00 decodes to 64. So 64 is the hardware's 0 dB point.
// The two sides therefore have slightly different step sizes (64 steps below
// centre, 63 above), which is what makes all three anchors land exactly:
// 0 -> -12.0, 64 -> 0.0, 127 -> +12.0.
// This is almost certainly the "0.2-0.4 dB midrange nonlinearity" recorded in
// Tech Ref Sec 21 as cosmetic — an offset scale is worst at the middle and
// vanishes at the ends, which is exactly the reported shape.
function valToAmpVol(v127) {
  if (v127 === 0) return 'MUTE';
  const db = (v127 < 64) ? (v127 - 64) * (12 / 64)
                         : (v127 - 64) * (12 / 63);
  const t = db.toFixed(1);
  // No '+' on zero — the rack shows a bare 0.0 dB, not +0.0.
  return (parseFloat(t) > 0 ? '+' : '') + t + ' dB';
}

// ════════════════════════════════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════════════════════════════════
function setInputButtons(inputVal) {
  const isGuitar = (inputVal === 0x00);
  const isMic    = (inputVal === 0x02);
  const isLine   = (inputVal === 0x03 || inputVal === 0x04 || inputVal === 0x05);
  const isDig    = (inputVal === 0x06 || inputVal === 0x07 || inputVal === 0x08);
  document.getElementById('btn-input-guitar').classList.toggle('active', isGuitar);
  document.getElementById('btn-input-mic').classList.toggle('active',    isMic);
  document.getElementById('btn-input-line').classList.toggle('active',   isLine);
  document.getElementById('btn-input-dig').classList.toggle('active',    isDig);
}

// ── Avid editor state — purely informational now. The Java bridge owns
// both Eleven Rack MIDI ports itself, so controls no longer depend on the
// editor being open. This just warns if the editor opens alongside the
// bridge, since both trying to own the same ports at once is the one
// scenario the docs flag as a real risk. ──
let avidRunning = false;
function updateAvidStatus(running) {
  if (running === avidRunning) return;
  avidRunning = running;

  const badge  = document.getElementById('avid-status-badge');
  const msg    = document.getElementById('avid-msg');

  badge.textContent = running ? 'AVID EDITOR: OPEN' : 'AVID EDITOR: CLOSED';
  badge.className   = running ? 'inactive' : 'active';
  msg.textContent   = 'Avid editor and this app both use the Eleven Rack ports — closing the editor avoids a conflict.';
  msg.style.display = running ? 'block' : 'none';

  if (running) {
    appLog('Avid editor detected — both apps are now sharing the Eleven Rack ports (potential conflict)');
  } else {
    appLog('Avid editor closed');
  }
}

// ── Knob initializer for permanent knobs (Rig Vol, Amp Out) ──
function initKnob(wrapId, valId, dispFn, onChangeCB) {
  const wrap = document.getElementById(wrapId);
  const valSpan = document.getElementById(valId);
  if (!wrap) return;
  const canvas = wrap.querySelector('canvas');
  let val = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
  drawKnob(canvas, val);
  if (valSpan) valSpan.textContent = dispFn(val);

  let dragging = false, startY = 0, startVal = 0;

  wrap.addEventListener('mousedown', e => {
    val = parseInt(wrap.dataset.value) || 0;
    dragging = true; startY = e.clientY; startVal = val; e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    // Release outside the window never delivers a mouseup here, which used to
    // leave the knob following the mouse with no button held until the next
    // click. e.buttons is 0 the moment the button is up, wherever it happened.
    if (e.buttons === 0) { dragging = false; return; }
    val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    wrap.dataset.value = val;
    drawKnob(canvas, val);
    if (valSpan) valSpan.textContent = dispFn(val);
    if (onChangeCB) queueKnobSend('knob:' + wrapId, onChangeCB, val);
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  window.addEventListener('blur', () => { dragging = false; });
  wrap.addEventListener('dblclick', () => {
    val = 64; wrap.dataset.value = 64;
    drawKnob(canvas, val); if (valSpan) valSpan.textContent = dispFn(val);
    if (onChangeCB) queueKnobSend('knob:' + wrapId, onChangeCB, 64);
  });
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    val = parseInt(wrap.dataset.value) || 0;
    val = Math.max(0, Math.min(127, val - Math.sign(e.deltaY)));
    wrap.dataset.value = val;
    drawKnob(canvas, val); if (valSpan) valSpan.textContent = dispFn(val);
    if (onChangeCB) queueKnobSend('knob:' + wrapId, onChangeCB, val);
  }, { passive: false });
}

// ════════════════════════════════════════════════════════════════════
// LOGGING — renderer side sends to main for file write
// ════════════════════════════════════════════════════════════════════
function appLog(line) {
  if (!logsEnabled) return;
  try { window.electronAPI.logWrite(line); } catch(e) {}
}

// ── 7-bit decode (port of ElevenHack SysEx.java extractFrom7bits) ──
function updateGateReadout(gate) {
  if (!gate) return;
  const tWrap = document.getElementById('gate-thresh-wrap');
  const rWrap = document.getElementById('gate-release-wrap');
  if (tWrap) {
    tWrap.dataset.value = gate.threshV;
    drawKnob(tWrap.querySelector('canvas'), gate.threshV);
    document.getElementById('gate-thresh-val').textContent = valGateThresh(gate.threshV);
  }
  if (rWrap) {
    rWrap.dataset.value = gate.releaseV;
    drawKnob(rWrap.querySelector('canvas'), gate.releaseV);
    document.getElementById('gate-release-val').textContent = valGateRelease(gate.releaseV);
  }
  appLog('Gate readout updated — thresh=' + valGateThresh(gate.threshV) + ' release=' + valGateRelease(gate.releaseV));
}

// Set true only once a REAL Amp Out value has actually been read back —
// from SEND_PATCH decode below, or from a live CMD 0x11 broadcast (a
// physical knob turn). Used to block the knob from transmitting anything
// before that happens, since it used to be able to send whatever
// arbitrary position it defaulted to on load — confirmed to be able to
// silently move the real hardware output level. See sendAmpOutIfReady().
function updateAmpOutReadout(v) {
  if (v == null) return;
  hasReceivedAmpOutValue = true;
  const wrap = document.getElementById('amp-out-wrap');
  if (wrap) {
    wrap.dataset.value = v;
    drawKnob(wrap.querySelector('canvas'), v);
    document.getElementById('amp-out-val').textContent = valAmpOut(v);
  }
  appLog('Amp Out readout updated — ' + valAmpOut(v));
}

// ── To Amp 1 & 2 volume readout update (from TFX decode on patch load) ──
function updateToAmpVolumeReadouts(vols) {
  if (!vols) return;
  const w1 = document.getElementById('toamp1-vol-wrap');
  if (w1) {
    w1.dataset.value = vols.amp1V;
    drawKnob(w1.querySelector('canvas'), vols.amp1V);
    document.getElementById('toamp1-vol-val').textContent = valToAmpVol(vols.amp1V);
  }
  const w2 = document.getElementById('toamp2-vol-wrap');
  if (w2) {
    w2.dataset.value = vols.amp2V;
    drawKnob(w2.querySelector('canvas'), vols.amp2V);
    document.getElementById('toamp2-vol-val').textContent = valToAmpVol(vols.amp2V);
  }
  appLog('To Amp volumes from TFX: amp1=' + valToAmpVol(vols.amp1V) + '  amp2=' + valToAmpVol(vols.amp2V));
}

// ── Push decoded tone knob values into the tone knob UI on patch load ──
// values = array from decodeToneKnobValues(), parallel to knob-type entries
// in AMP_TONE_PARAMS[currentAmpKey].knobs. null entries = key not found.
// ── Bright toggle ──
let brightOn = false;
// ── Tremolo on/off (paramLo 0x13) — undefined until the hardware tells us ──
let tremOn;
// ── Live Sync zone (0 = OFF) and a per-drag latch, so turning Speed clears
// Sync exactly once per drag rather than on every mousemove. ──
let currentSyncZone = 0;
let syncClearedThisDrag = false;

function updateBrightButton() {
  document.getElementById('btn-bright').classList.toggle('on', brightOn);
}

function updateBrightReadout(val) {
  // TFX: raw 0=OFF, raw 1=ON (decoded to val 0 or 127 by decodeToneKnobValues)
  // CMD 0x11 live: val=127=ON, val=0=OFF (confirmed Black Vib capture 7/15/2026)
  brightOn = (val > 63);
  updateBrightButton();
  appLog('Bright ' + (brightOn ? 'ON' : 'OFF') + ' (val=' + val + ')');
}

function updateBrightVisibility(ampKey) {
  const ap = ampKey ? AMP_TONE_PARAMS[ampKey] : null;
  // The Bright toggle is named MOD on SL100 Drive, so match on type, not label.
  const hasBright = !!(ap && ap.knobs && ap.knobs.some(k => k.type === 'toggle' && k.lo === 0x0E));
  const hasTrem   = ampHasTremolo(ampKey);

  const btn = document.getElementById('btn-bright');
  if (btn) {
    btn.style.display = hasBright ? '' : 'none';
    // Label from the amp table, not hardcoded: SL100 Drive names this same
    // toggle MOD while Crunch and Clean call it Bright.
    if (hasBright) {
      const bk = ap.knobs.find(k => k.lo === 0x0E);
      btn.textContent = (bk && bk.label ? bk.label : 'Bright').toUpperCase();
    }
  }
  const tbtn = document.getElementById('btn-trem');
  if (tbtn) tbtn.style.display = hasTrem ? '' : 'none';
  const sgrp = document.getElementById('sync-group');
  if (sgrp) sgrp.style.display = hasTrem ? '' : 'none';

  // The stack itself is hidden only when the amp has none of the three.
  const row = document.getElementById('amp-toggles-row');
  if (row) row.style.display = (hasBright || hasTrem) ? 'flex' : 'none';

  if (!hasBright) { brightOn = false; }
  if (!hasTrem) { tremOn = undefined; updateSyncReadout(null); }
}

// ── Tremolo ON/OFF — paramLo 0x13, confirmed 7/23/2026. Same two-state
// encoding as Bright: 127 = ON, 0 = OFF. ──
function updateTremButton() {
  const btn = document.getElementById('btn-trem');
  if (!btn) return;
  // Colour carries the state; the label stays constant (user, 7/23).
  btn.classList.toggle('on', tremOn === true);
}

function updateTremReadout(val) {
  tremOn = (val >= 64);
  updateTremButton();
  appLog('Tremolo readback: ' + (tremOn ? 'ON' : 'OFF') + ' (val=' + val + ')');
}

// ── Sync dropdown — paramLo 0x12. The wire value is continuous 0-127 and
// quantises into 14 zones; see SYNC_DIVISIONS in protocol.js. Display only
// for now: writes stay blocked by READ_ONLY_PARAM_LOS. ──
function populateSyncDropdown() {
  const sel = document.getElementById('sync-select');
  if (!sel || sel.options.length) return;
  SYNC_DIVISIONS.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = (i === 0) ? 'OFF' : (d.glyph + '   ' + d.text);
    sel.appendChild(opt);
  });
}

function updateSyncReadout(val) {
  const sel = document.getElementById('sync-select');
  if (!sel) return;
  populateSyncDropdown();
  if (val === null || val === undefined) { sel.selectedIndex = 0; currentSyncZone = 0; return; }
  const idx = syncIndexFromV127(val);
  currentSyncZone = idx;
  // The hardware has spoken, so any pending "clear Sync" for a drag in
  // progress is satisfied — don't send a second one.
  if (idx === 0) syncClearedThisDrag = true;
  sel.value = String(idx);
  appLog('Sync readback: val=' + val + ' -> zone ' + idx + ' (' + SYNC_DIVISIONS[idx].text + ')');
}

// User picks a division — write the CENTRE of that zone so a rounding error
// either way still lands in the intended division. Format confirmed against
// Avid's own Sync write, which is byte identical to what sendParamWrite emits
// (the 0x10 seen in the last byte of hardware broadcasts is added by the rack
// on the way out, not something we send).
document.addEventListener('DOMContentLoaded', function() {
  populateSyncDropdown();
  const sel = document.getElementById('sync-select');
  if (!sel) return;
  sel.addEventListener('change', function() {
    if (currentParamHi < 0) {
      appLog('Sync: no amp handle yet, not sending');
      updateSyncReadout(null);
      return;
    }
    const idx = parseInt(sel.value);
    if (isNaN(idx)) return;
    const v = syncV127FromIndex(idx);
    sendParamWrite(0x12, v);
    appLog('Sync set to zone ' + idx + ' (' + SYNC_DIVISIONS[idx].text + ') val=' + v);
  });
});

function updateToneReadouts(values, ampKey) {
  if (!values || !values.length) return;
  const ap = ampKey ? AMP_TONE_PARAMS[ampKey] : null;
  const knobs = ap && ap.knobs ? ap.knobs.filter(k => k.type === 'knob' || k.type === 'toggle') : [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    const knob = knobs[i];
    if (knob && knob.type === 'toggle') {
      updateBrightReadout(values[i]);
      continue;
    }
    const wrap = document.getElementById('tone-w' + i);
    const valEl = document.getElementById('tone-v' + i);
    if (wrap) {
      wrap.dataset.value = values[i];
      drawKnob(wrap.querySelector('canvas'), values[i]);
    }
    if (valEl) valEl.textContent = valDisplay(values[i]);
  }
  appLog('Tone readouts updated from TFX: [' + values.join(', ') + ']');
}

// ════════════════════════════════════════════════════════════════════
// CAB / MIC / AXIS / BREAKUP / MONO UI UPDATES
// ════════════════════════════════════════════════════════════════════

function updateCabTypeDisplay(index) {
  if (index == null || index < 0 || index >= CAB_TYPE_LIST.length) return;
  const sel = document.getElementById('cab-type-select');
  if (sel) sel.value = String(index);
  appLog('Cab type: ' + CAB_TYPE_LIST[index].name + ' (index=' + index + ')');
}

function updateMicTypeDisplay(index) {
  if (index == null || index < 0 || index >= MIC_TYPE_NAMES.length) return;
  const sel = document.getElementById('mic-type-select');
  if (sel) sel.value = String(index);
  appLog('Mic type: ' + MIC_TYPE_NAMES[index] + ' (index=' + index + ')');
}

function updateAxisDisplay(axisOn) {
  if (axisOn == null) return;
  const btn = document.getElementById('axis-btn');
  if (btn) {
    btn.textContent = axisOn ? 'ON AXIS' : 'OFF AXIS';
    btn.classList.toggle('on', axisOn);
  }
  appLog('Mic axis: ' + (axisOn ? 'ON AXIS' : 'OFF AXIS'));
}

function updateBreakupDisplay(v127) {
  if (v127 == null) return;
  const slider = document.getElementById('breakup-slider');
  const valEl  = document.getElementById('breakup-val');
  if (slider) slider.value = v127;
  if (valEl)  valEl.textContent = (Math.round(v127 / 127 * 100) / 10).toFixed(1);
  appLog('Speaker breakup: v=' + v127);
}

function updateCabMicReadouts(cabMic) {
  if (!cabMic) return;
  updateCabTypeDisplay(cabMic.cabIndex);
  updateMicTypeDisplay(cabMic.micIndex);
  updateAxisDisplay(cabMic.axisOn);
  updateBreakupDisplay(cabMic.breakupV);
  // Cab bypass comes from the TFX key sldJ, so it is known at patch load.
  // Amp bypass has no TFX key and arrives as null here — it is resolved by
  // requestAllBypass() once the chain map gives us handles. Show it as
  // unknown until then rather than guessing.
  if (cabMic.cabActive !== null && cabMic.cabActive !== undefined) {
    cabBypassActive = cabMic.cabActive;
  }
  updateCabBypassDisplay(cabMic.cabActive);
  blockBypass[SLOT_AMP] = (cabMic.ampActive === null || cabMic.ampActive === undefined)
    ? undefined : cabMic.ampActive;
  updateAmpBypassDisplay(cabMic.ampActive);
}

function updateMonoIndicator(isMono) {
  if (isMono == null) return;
  currentMonoState = isMono;
  const el = document.getElementById('mono-indicator');
  if (el) {
    el.textContent = isMono ? 'MONO' : 'STEREO';
    el.classList.toggle('mono-active', isMono);
    el.classList.toggle('mono-inactive', !isMono);
  }
  // Connector into the badge: one line for MONO, two for STEREO — tracks the
  // badge state, deliberately not any block's output channel count.
  const conn = document.getElementById('mono-connector');
  if (conn) {
    conn.innerHTML = isMono ? '<i></i>' : '<i></i><i></i>';
    conn.title = isMono ? 'Mono' : 'Stereo';
  }
  appLog('Stereo/Mono: ' + (isMono ? 'MONO' : 'STEREO'));
}

// Click handler for Stereo/Mono badge — wired up once DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  var monoBtn = document.getElementById('mono-indicator');
  if (monoBtn) {
    var monoLocked = false;
    monoBtn.addEventListener('click', function() {
      if (!bridgeMidiReady || monoLocked) return;
      monoLocked = true;
      setTimeout(function() { monoLocked = false; }, 300);
      var newMono = !currentMonoState;
      updateMonoIndicator(newMono);   // optimistic display
      sendMonoStereo(newMono);        // toggle hardware
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// RIG TEMPO — digital-clock field (CMD 0x50)
// ════════════════════════════════════════════════════════════════════
//
// Held internally as TENTHS of a BPM (integer), so stepping the tenths digit
// is plain +/- 1 and there is no floating-point drift on repeated steps.
// 100 = 10.0 BPM, 5000 = 500.0 BPM.
//
// Three ways in, all agreed with Charlie 7/24:
//   - click a segment, then arrows / mouse wheel / up-down keys
//   - the small stepper to the right of the box
//   - type the value straight in and press Enter
//
// Nothing is sent until a value is COMMITTED. Typing is buffered and only
// leaves the box on Enter or blur, so a half-typed "1" on the way to "120"
// never reaches the hardware as 10 BPM.
var currentTempoTenths = null;      // null until the first readback
var tempoSeg           = 'w';       // 'w' whole, 't' tenths
var tempoTypeBuf       = null;      // non-null while the user is typing
var tempoSendTimer     = null;
var tempoPendingSend   = null;

const TEMPO_MIN_T = Math.round(TEMPO_BPM_MIN * 10);
const TEMPO_MAX_T = Math.round(TEMPO_BPM_MAX * 10);

// Repaint from currentTempoTenths, or from the type buffer while typing.
function renderTempoField() {
  const wEl = document.getElementById('tempo-whole');
  const tEl = document.getElementById('tempo-tenth');
  const box = document.getElementById('tempo-box');
  if (!wEl || !tEl || !box) return;

  if (tempoTypeBuf !== null) {
    // Show exactly what has been typed so far, left as typed.
    const parts = tempoTypeBuf.split('.');
    wEl.textContent = (parts[0] === '' ? '_' : parts[0]);
    tEl.textContent = (parts.length > 1 ? (parts[1] === '' ? '_' : parts[1]) : '_');
    box.classList.add('tempo-typing');
    wEl.classList.remove('seg-on');
    tEl.classList.remove('seg-on');
    return;
  }

  box.classList.remove('tempo-typing');
  if (currentTempoTenths === null) {
    wEl.textContent = '---';
    tEl.textContent = '-';
  } else {
    wEl.textContent = String(Math.floor(currentTempoTenths / 10));
    tEl.textContent = String(currentTempoTenths % 10);
  }
  wEl.classList.toggle('seg-on', tempoSeg === 'w');
  tEl.classList.toggle('seg-on', tempoSeg === 't');
}

// Called by the CMD 0x50 handler for every broadcast, echo and query reply.
// Ignored mid-typing so the hardware cannot overwrite a value being entered.
function updateTempoDisplay(bpm) {
  if (bpm === null || bpm === undefined) return;
  const t = Math.round(bpm * 10);
  const changed = (t !== currentTempoTenths);
  currentTempoTenths = t;
  if (tempoTypeBuf === null) renderTempoField();
  if (changed) appLog('Rig tempo: ' + (t / 10).toFixed(1) + ' BPM');
}

// Trailing throttle. A tempo change makes the rack rebroadcast every
// tempo-synced parameter in the chain — three messages in the calibration
// capture, 753 in an earlier front-panel sweep — so held arrows and wheel
// spins must not turn into a message per step.
function queueTempoSend(tenths) {
  tempoPendingSend = tenths;
  if (tempoSendTimer) return;
  tempoSendTimer = setTimeout(function() {
    tempoSendTimer = null;
    const v = tempoPendingSend;
    tempoPendingSend = null;
    if (v !== null) sendRigTempo(v / 10);
  }, 150);
}

function setTempoTenths(t, send) {
  if (t < TEMPO_MIN_T) t = TEMPO_MIN_T;
  if (t > TEMPO_MAX_T) t = TEMPO_MAX_T;
  currentTempoTenths = t;
  renderTempoField();
  if (send) queueTempoSend(t);
}

// Step the SELECTED segment: tenths digit = 0.1 BPM, whole digits = 1.0 BPM.
function stepTempo(dir) {
  if (currentTempoTenths === null) {
    appLog('Rig tempo: no value read back yet — nothing to step');
    return;
  }
  setTempoTenths(currentTempoTenths + dir * (tempoSeg === 't' ? 1 : 10), true);
}

function commitTempoTyping() {
  if (tempoTypeBuf === null) return;
  const raw = tempoTypeBuf;
  tempoTypeBuf = null;
  const v = parseFloat(raw);
  if (isNaN(v)) { renderTempoField(); return; }
  const t = Math.round(v * 10);
  if (t < TEMPO_MIN_T || t > TEMPO_MAX_T) {
    appLog('Rig tempo: ' + v + ' is outside ' + TEMPO_BPM_MIN.toFixed(1)
           + '-' + TEMPO_BPM_MAX.toFixed(1) + ' BPM — clamped');
    setStatus('Tempo range is ' + TEMPO_BPM_MIN.toFixed(1) + ' to '
              + TEMPO_BPM_MAX.toFixed(1) + ' BPM');
  }
  setTempoTenths(t, true);
}

document.addEventListener('DOMContentLoaded', function() {
  const box = document.getElementById('tempo-box');
  const wEl = document.getElementById('tempo-whole');
  const tEl = document.getElementById('tempo-tenth');
  const up  = document.getElementById('tempo-up');
  const dn  = document.getElementById('tempo-dn');
  if (!box) return;

  function selectSeg(s) {
    if (tempoTypeBuf !== null) commitTempoTyping();
    tempoSeg = s;
    renderTempoField();
    box.focus();
  }
  if (wEl) wEl.addEventListener('mousedown', function(e) { e.preventDefault(); selectSeg('w'); });
  if (tEl) tEl.addEventListener('mousedown', function(e) { e.preventDefault(); selectSeg('t'); });
  box.addEventListener('mousedown', function(e) {
    if (e.target === box) { e.preventDefault(); selectSeg(tempoSeg); }
  });

  if (up) up.addEventListener('click', function() { stepTempo(1);  box.focus(); });
  if (dn) dn.addEventListener('click', function() { stepTempo(-1); box.focus(); });

  // Wheel only acts when the box has focus, so a stray scroll over the chain
  // strip on the way somewhere else cannot nudge the rig tempo.
  box.addEventListener('wheel', function(e) {
    if (document.activeElement !== box) return;
    e.preventDefault();
    stepTempo(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  box.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowUp')    { e.preventDefault(); stepTempo(1);  return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); stepTempo(-1); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); selectSeg('w'); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); selectSeg('t'); return; }
    if (e.key === 'Enter')      { e.preventDefault(); commitTempoTyping(); return; }
    if (e.key === 'Escape')     { e.preventDefault(); tempoTypeBuf = null; renderTempoField(); return; }
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (tempoTypeBuf !== null) {
        tempoTypeBuf = tempoTypeBuf.slice(0, -1);
        if (tempoTypeBuf === '') tempoTypeBuf = null;
        renderTempoField();
      }
      return;
    }
    if (/^[0-9]$/.test(e.key) || e.key === '.') {
      e.preventDefault();
      if (tempoTypeBuf === null) tempoTypeBuf = '';
      if (e.key === '.' && tempoTypeBuf.indexOf('.') !== -1) return;
      // Cap the entry so a stuck key cannot build an absurd string.
      if (tempoTypeBuf.replace('.', '').length >= 4) return;
      tempoTypeBuf += e.key;
      renderTempoField();
    }
  });

  box.addEventListener('blur', function() { commitTempoTyping(); });

  renderTempoField();
});

// ════════════════════════════════════════════════════════════════════
// CHAIN ROW — reorder, hover text, stereo connectors
// ════════════════════════════════════════════════════════════════════
//
// The row is TEN FIXED SLOTS, always all present, re-ordered to match the
// patch. Slots are MOVED, never rebuilt: each slot div carries its own
// data-slot / data-panel and its own listeners, so relocating the div takes
// its identity and behaviour with it. That is why the ▼ panel mapping keeps
// working with no extra code once a block moves.
//
// Called on every CMD 0x21, which covers patch load, stereo/mono toggle and
// reorder.
// ════════════════════════════════════════════════════════════════════
// CHAIN ROW — drag to reorder
// ════════════════════════════════════════════════════════════════════
//
// FX LOOP PLACEMENT RULE (Tech Ref Sec 4): the loop has only FOUR legal
// positions — first, immediately left of AMP-CAB, immediately right of it, or
// last. Both the Avid editor and the hardware front panel resolve this before
// anything is sent: the editor SNAPS a dropped loop to the nearest legal spot
// rather than refusing it. We do the same, so an illegal arrangement is never
// transmitted. Dragging the AMP can also strand the loop, so the loop is
// re-validated after every move, not just when the loop itself is dragged.
//
// Returns a reordered copy of currentChain, loop legality already resolved.
function computeReorder(fromSlotId, toIndex) {
  const rest = currentChain.filter(b => b.slotId !== fromSlotId);
  const moved = currentChain.find(b => b.slotId === fromSlotId);
  if (!moved) return null;
  let idx = Math.max(0, Math.min(toIndex, rest.length));
  rest.splice(idx, 0, moved);
  return enforceLoopPlacement(rest);
}

function legalLoopIndices(withoutLoop) {
  const a = withoutLoop.findIndex(b => b.slotId === SLOT_AMP);
  if (a < 0) return [0];
  // indices are insertion points into the 9-block list
  return Array.from(new Set([0, a, a + 1, withoutLoop.length])).sort((x,y) => x-y);
}

function enforceLoopPlacement(order) {
  const cur = order.findIndex(b => b.slotId === SLOT_LOOP);
  if (cur < 0) return order;
  const loop = order[cur];
  const without = order.filter(b => b.slotId !== SLOT_LOOP);
  const legal = legalLoopIndices(without);
  // where the loop currently sits, expressed as an insertion index into `without`
  const desired = cur;
  if (legal.includes(desired)) return order;
  let best = legal[0];
  for (const k of legal) if (Math.abs(k - desired) < Math.abs(best - desired)) best = k;
  const snapped = without.slice();
  snapped.splice(best, 0, loop);
  appLog('Chain drag: FX Loop snapped from position ' + (desired+1) + ' to ' + (best+1)
         + ' (only first / either side of AMP-CAB / last are legal)');
  return snapped;
}

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].slotId !== b[i].slotId) return false;
  return true;
}

let chainDragSlot = null;      // slot ID being dragged
let chainDragActive = false;   // suppresses the click that follows a drag

function clearDropMarks() {
  document.querySelectorAll('#chainstrip .drop-before, #chainstrip .drop-after')
    .forEach(el => el.classList.remove('drop-before','drop-after'));
}

function wireChainDrag() {
  const strip = document.getElementById('chainstrip');
  if (!strip || strip.dataset.dragWired) return;
  strip.dataset.dragWired = '1';

  strip.addEventListener('dragstart', function(ev) {
    const cont = ev.target.closest('.chain-slot, .chain-slot-stack');
    if (!cont || !strip.contains(cont)) return;
    const blk = currentChain.find(b => containerForSlot(b.slotId) === cont);
    if (!blk) return;
    chainDragSlot = blk.slotId;
    chainDragActive = true;
    cont.classList.add('dragging');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', String(blk.slotId));   // Firefox needs a payload
  });

  strip.addEventListener('dragover', function(ev) {
    if (chainDragSlot === null) return;
    const cont = ev.target.closest('.chain-slot, .chain-slot-stack');
    if (!cont || !strip.contains(cont)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const r = cont.getBoundingClientRect();
    const after = ev.clientX > r.left + r.width / 2;
    clearDropMarks();
    cont.classList.add(after ? 'drop-after' : 'drop-before');
  });

  strip.addEventListener('dragleave', function(ev) {
    if (!strip.contains(ev.relatedTarget)) clearDropMarks();
  });

  strip.addEventListener('drop', function(ev) {
    if (chainDragSlot === null) return;
    ev.preventDefault();
    const cont = ev.target.closest('.chain-slot, .chain-slot-stack');
    clearDropMarks();
    if (cont && strip.contains(cont)) {
      const target = currentChain.find(b => containerForSlot(b.slotId) === cont);
      if (target && target.slotId !== chainDragSlot) {
        const r = cont.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        // index within the list that excludes the dragged block
        const rest = currentChain.filter(b => b.slotId !== chainDragSlot);
        let ti = rest.findIndex(b => b.slotId === target.slotId);
        if (after) ti += 1;
        const next = computeReorder(chainDragSlot, ti);
        if (next && !sameOrder(next, currentChain)) {
          sendChainOrder(next);   // hardware replies with a map; renderChainRow adopts it
        }
      }
    }
    chainDragSlot = null;
  });

  strip.addEventListener('dragend', function() {
    clearDropMarks();
    document.querySelectorAll('#chainstrip .dragging')
      .forEach(el => el.classList.remove('dragging'));
    chainDragSlot = null;
    setTimeout(() => { chainDragActive = false; }, 0);   // let the stray click pass first
  });
}

// Map a chain slot ID to its (movable) container div in the chain row.
function containerForSlot(slotId) {
  if (slotId === SLOT_AMP) {
    const el = document.getElementById('chain-amp');
    return el ? el.closest('.chain-slot-stack') : null;
  }
  const dom = SLOT_ID_TO_DOM[slotId];
  if (!dom) return null;
  const el = document.getElementById('chain-' + dom);
  return el ? el.closest('.chain-slot') : null;
}

function renderChainRow() {
  const strip = document.getElementById('chainstrip');
  if (!strip || !currentChain.length) return;

  // Collect the movable pieces before touching anything.
  // The "drag blocks to reorder" hint was removed 7/24/2026 — 10px on #555 was
  // unreadable. #mono-indicator now carries the margin-left:auto that pushes
  // the right-hand group to the end of the strip.
  const arrows = Array.from(strip.querySelectorAll('.chain-arr:not(#mono-connector)'));
  const conn   = document.getElementById('mono-connector');
  const mono   = document.getElementById('mono-indicator');
  const tempo  = document.getElementById('tempo-wrap');

  const containerFor = containerForSlot;

  let arrowIdx = 0;
  currentChain.forEach((blk, i) => {
    const cont = containerFor(blk.slotId);
    if (!cont) return;
    strip.appendChild(cont);                       // move, do not clone
    cont.setAttribute('draggable', 'true');

    // Hover text on BOTH the label and the ▼, for a bigger target.
    const model = MODEL_NAMES[blk.modelId];
    const label = model || ('unknown model 0x' + blk.modelId.toString(16).padStart(2,'0'));
    const tip   = blk.name + ' — ' + label;
    cont.querySelectorAll('.chain-name, .chain-open').forEach(el => { el.title = tip; });

    // Connector after this block: double arrow when this block outputs stereo.
    if (i < currentChain.length - 1 && arrowIdx < arrows.length) {
      const arr = arrows[arrowIdx++];
      const st  = MODEL_OUT_STEREO[blk.modelId];
      // Stacked horizontal lines, fixed width: one = mono, two = stereo.
      // An unknown model gets a single DASHED line, never a solid one — an
      // unknown must not be indistinguishable from a confident "mono".
      arr.classList.remove('arr-unknown');
      if (st === undefined) {
        arr.innerHTML = '<i></i>';
        arr.classList.add('arr-unknown');
        arr.title = 'channel count unknown for ' + label;
        appLog('Chain row: no output-channel entry for ' + blk.name
               + ' model 0x' + blk.modelId.toString(16).padStart(2,'0')
               + ' (' + label + ') — drawn as unknown');
      } else {
        arr.innerHTML = st ? '<i></i><i></i>' : '<i></i>';
        arr.title = st ? 'stereo' : 'mono';
      }
      strip.appendChild(arr);
    }
  });

  // Trailing items stay at the end.
  arrows.slice(arrowIdx).forEach(a => { a.style.display = 'none'; });
  if (conn)  strip.appendChild(conn);
  if (mono)  strip.appendChild(mono);
  if (tempo) strip.appendChild(tempo);

  refreshBlockBypassDisplays();
  wireChainDrag();
}

// Paint every non-amp slot from the stored bypass state.
// Amp and cab have their own display functions and are not touched here.
function refreshBlockBypassDisplays() {
  currentChain.forEach(blk => {
    if (blk.slotId === SLOT_AMP) return;
    const dom = SLOT_ID_TO_DOM[blk.slotId];
    if (!dom) return;
    const el = document.getElementById('chain-' + dom);
    if (!el) return;
    const st = blockBypass[blk.slotId];
    el.classList.remove('slot-on','slot-off','slot-unknown');
    if (st === undefined) el.classList.add('slot-unknown');
    else el.classList.add(st ? 'slot-on' : 'slot-off');
  });
}

// Click a slot label = real bypass toggle.
// Replaces an inline handler in index.html that only flipped the colour and
// sent nothing — that made every non-amp slot lie about its state.
// No optimistic update: the hardware broadcast is what repaints, so a failed
// send leaves the display truthful.
document.addEventListener('DOMContentLoaded', function() {
  const strip = document.getElementById('chainstrip');
  if (!strip) return;
  strip.addEventListener('click', function(ev) {
    const lbl = ev.target.closest('.chain-name');
    if (!lbl || !strip.contains(lbl)) return;
    if (chainDragActive) return;      // ignore the click that trails a drag
    if (!bridgeMidiReady) return;
    const dom = lbl.id.replace(/^chain-/, '');
    const blk = currentChain.find(b => SLOT_ID_TO_DOM[b.slotId] === dom);
    if (!blk) { appLog('Bypass click: ' + dom + ' not in chain map yet'); return; }
    const cur = blockBypass[blk.slotId];
    if (cur === undefined) { appLog('Bypass click: ' + blk.name + ' state unknown yet'); return; }
    sendBypassWrite(blk.handle, BYPASS_PARAMLO_BLOCK, !cur);
  });
});

// Amp/Cab bypass chain row highlight.
// isOn: true = active, false = bypassed, null/undefined = not yet known.
function updateAmpBypassDisplay(isOn) {
  const el = document.getElementById('chain-amp');
  if (!el) return;
  el.classList.remove('slot-on','slot-off','slot-unknown');
  if (isOn === null || isOn === undefined) el.classList.add('slot-unknown');
  else el.classList.add(isOn ? 'slot-on' : 'slot-off');
}

function updateCabBypassDisplay(isOn) {
  const el = document.getElementById('chain-cab');
  if (!el) return;
  el.classList.remove('slot-on','slot-off','slot-unknown');
  if (isOn === null || isOn === undefined) el.classList.add('slot-unknown');
  else el.classList.add(isOn ? 'slot-on' : 'slot-off');
}

// Click to toggle amp / cab bypass.
// Both live on the AMP-CAB block's single handle with different paramLos, so
// they work wherever that block sits in the chain.
// No optimistic display: the hardware broadcasts the new state immediately and
// that broadcast is what updates the UI. If a send fails the display correctly
// stays put rather than lying about it.
document.addEventListener('DOMContentLoaded', function() {
  const ampEl = document.getElementById('chain-amp');
  if (ampEl) {
    ampEl.addEventListener('click', function() {
      if (!bridgeMidiReady) return;
      if (blockBypass[SLOT_AMP] === undefined) { appLog('Amp bypass state unknown yet, ignoring click'); return; }
      sendAmpBypass(!blockBypass[SLOT_AMP]);
    });
  }
  const cabEl = document.getElementById('chain-cab');
  if (cabEl) {
    cabEl.addEventListener('click', function() {
      if (!bridgeMidiReady) return;
      if (cabBypassActive === undefined) { appLog('Cab bypass state unknown yet, ignoring click'); return; }
      sendCabBypass(!cabBypassActive);
    });
  }
});

// ── Update amp display and gate knob CCs when amp changes ──
function syncAmpSelectDropdown(key) {
  const sel = document.getElementById('amp-select');
  if (!sel) return;
  sel.disabled = !key || currentParamHi < 0;  // disable until chain map arrives
  if (key && AMP_SELECT_BY_KEY[key]) {
    ampSelectSyncing = true;
    sel.value = key;
    ampSelectSyncing = false;
  }
}

function setCurrentAmp(key) {
  currentAmpKey = key;
  currentAmpName = key ? (AMP_NAME_MAP[key] || key) : null;
  document.getElementById('amp-name-display').textContent = currentAmpName || '';
  setGateControlsEnabled(!!key);
  syncAmpSelectDropdown(key);
  updateToneKnobs(key);
  updateBrightVisibility(key);
  appLog('Amp identified: ' + (currentAmpName || 'unknown') + ' key=' + key);
}

// ── Show/hide/relabel tone knob slots based on AMP_TONE_PARAMS ──
function updateToneKnobs(key) {
  const ap = key ? AMP_TONE_PARAMS[key] : null;
  const knobs = (ap && ap.knobs) ? ap.knobs.filter(k => k.type === 'knob') : []; // toggles excluded — rendered as buttons
  for (let i = 0; i < 8; i++) {
    const kEl = document.getElementById('tone-k' + i);
    const lEl = document.getElementById('tone-l' + i);
    const wEl = document.getElementById('tone-w' + i);
    const vEl = document.getElementById('tone-v' + i);
    if (!kEl) continue;
    if (i < knobs.length) {
      kEl.style.display = '';
      kEl.classList.remove('knob-disabled');
      // Controls the app is not allowed to WRITE (currently Speed, pending the
      // Sync interlock) are shown read-only rather than live. They still
      // display every hardware broadcast; they just cannot be dragged out of
      // step with the rack.
      const blocked = (typeof READ_ONLY_PARAM_LOS !== 'undefined')
                      && READ_ONLY_PARAM_LOS.indexOf(knobs[i].lo) !== -1;
      kEl.classList.toggle('knob-readonly', blocked);
      kEl.title = blocked
        ? knobs[i].label + ' is read-only for now — set it on the rack. '
          + 'It follows the Sync division, and writing it fights the hardware.'
        : '';
      if (lEl) lEl.textContent = knobs[i].label;
      if (vEl) vEl.textContent = '--';
      if (wEl) { wEl.dataset.value = 64; drawKnob(wEl.querySelector('canvas'), 64); }
    } else {
      kEl.style.display = 'none';
    }
  }
  appLog('Tone knobs updated for ' + (key || 'none') + ': ' + knobs.length + ' knob(s)');
}

// ── Volume knobs (Rig Vol / Amp Out) — plain CC sends, no amp-model
// dependency, so these only need the bridge connected ──
function setVolumeControlsEnabled(enabled) {
  ['amp-out-knob','rig-vol-knob','toamp1-knob','toamp2-knob'].forEach(id => {
    document.getElementById(id).classList.toggle('knob-disabled', !enabled);
  });
  if (!enabled) {
    ['amp-out-val','rig-vol-val','toamp1-vol-val','toamp2-vol-val'].forEach(id => {
      document.getElementById(id).textContent = '--';
    });
  } else {
    ['amp-out-wrap','rig-vol-wrap','toamp1-vol-wrap','toamp2-vol-wrap'].forEach(id => {
      const w = document.getElementById(id);
      if (w) drawKnob(w.querySelector('canvas'), parseInt(w.dataset.value)||0);
    });
  }
}

// ── Gate knobs — two-byte paramId, paramLo consistent across all amps (
// table), so these need an identified amp, not just a live bridge ──
function setGateControlsEnabled(enabled) {
  ['gate-thresh-knob','gate-release-knob'].forEach(id => {
    document.getElementById(id).classList.toggle('knob-disabled', !enabled);
  });
  if (!enabled) {
    ['gate-thresh-val','gate-release-val'].forEach(id => {
      document.getElementById(id).textContent = '--';
    });
  } else {
    ['gate-thresh-wrap','gate-release-wrap'].forEach(id => {
      const w = document.getElementById(id);
      if (w) drawKnob(w.querySelector('canvas'), parseInt(w.dataset.value)||0);
    });
  }
}


// ════════════════════════════════════════════════════════════════════
// JAVA BRIDGE — WebSocket transport (ws://localhost:57121)
// Replaces the old Focusrite (Web MIDI CC/PC) + Eleven Rack USB
// (Web MIDI SysEx receive) two-path setup. One socket now handles
// CC, PC, and SysEx in both directions via ElevenRackBridge.jar.
// ════════════════════════════════════════════════════════════════════
function slotLabel(slot) {
  if (slot < 0 || slot > MAX_SLOT) return '??';
  return BANKS[Math.floor(slot / 4)] + ((slot % 4) + 1);
}

function updateDisplay(slot) {
  currentSlot = slot;
  const el = document.getElementById('slot-display');
  el.textContent = slotLabel(slot);
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 80);
  document.getElementById('slot-num').textContent = 'Slot ' + slot;
  const nameEl = document.getElementById('patch-name');
  nameEl.textContent = '…';
  nameEl.classList.remove('live');
}

function setStatus(msg) { document.getElementById('status-msg').textContent = msg; }

// ── Tuner state — single source of truth is the confirmed hardware
// broadcast (CC 69: 0x40=ON, 0x3F=OFF), not our own click assumption.
// This is what makes it correctly reflect hardware-button changes too,
// same as gate/amp-out/amp-select already do for their own state. ──
function handleTunerCC(val) {
  if (val === 0x40 || val === 127) tunerOn = true;
  else if (val === 0x3F || val === 0) tunerOn = false;
  else return; // unrecognized value — not the state broadcast, ignore
  document.getElementById('btn-tuner').classList.toggle('on', tunerOn);
  setStatus('Tuner ' + (tunerOn ? 'ON' : 'OFF'));
  appLog('Tuner ' + (tunerOn ? 'ON' : 'OFF') + ' (confirmed via hardware)');
}

const logEl = document.getElementById('monitor-log');

function monitorLog(dir, text) {
  const ts  = new Date().toLocaleTimeString('en-US', { hour12:false });
  const cls = dir === 'OUT' ? 'mlog-out' : 'mlog-in';
  const row = document.createElement('div');
  row.innerHTML = '<span class="mlog-ts">' + ts + '</span><span class="' + cls + '">' + (dir==='OUT'?'▶':'◀') + ' ' + text + '</span>';
  logEl.appendChild(row);
  while (logEl.children.length > 300) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  // Everything in monitor also goes to log file
  appLog(dir + ' ' + text);
}

document.getElementById('monitor-header').addEventListener('click', e => {
  if (e.target === document.getElementById('btn-monitor-clear')) return;
  monitorOpen = !monitorOpen;
  document.getElementById('monitor-body').classList.toggle('open', monitorOpen);
  document.getElementById('monitor-toggle-label').textContent = monitorOpen ? '▼ HIDE' : '▶ SHOW';
});
document.getElementById('btn-monitor-clear').addEventListener('click', () => { logEl.innerHTML = ''; });

// ════════════════════════════════════════════════════════════════════
// ABOUT
// ════════════════════════════════════════════════════════════════════
document.getElementById('btn-about').addEventListener('click', () => { document.getElementById('about-overlay').classList.add('open'); });
document.getElementById('btn-about-close').addEventListener('click', () => { document.getElementById('about-overlay').classList.remove('open'); });
document.getElementById('about-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('about-overlay')) document.getElementById('about-overlay').classList.remove('open');
});

// ════════════════════════════════════════════════════════════════════
// WATCHDOG
// ════════════════════════════════════════════════════════════════════
if (window.electronAPI) {
  window.electronAPI.onWatchdogAlert((data) => {
    appLog('Watchdog: ' + data.message.replace(/\n/g,' '));
    updateAvidStatus(data.running);
    if (data.running) {
      // Editor opened — show popup so Charlie knows there's a potential
      // port conflict with the bridge (harmless if it closes again)
      document.getElementById('watchdog-msg').textContent = data.message;
      document.getElementById('watchdog-overlay').classList.add('open');
    }
    // Editor closed — just update badge silently, no popup needed (no
    // effect on this app since the bridge owns the ports independently)
  });
  document.getElementById('btn-watchdog-ok').addEventListener('click', () => {
    document.getElementById('watchdog-overlay').classList.remove('open');
  });
}

// ════════════════════════════════════════════════════════════════════
// BRIDGE PROCESS STATUS — surfaces jar launch/crash issues in the UI
// ════════════════════════════════════════════════════════════════════
if (window.electronAPI && window.electronAPI.onBridgeStatus) {
  window.electronAPI.onBridgeStatus((data) => {
    if (!data.launched) {
      appLog('Bridge process problem: ' + (data.error || 'stopped'));
      setStatus('Bridge process stopped — ' + (data.error || 'check ElevenRackBridge.jar / JRE install'));
    }
  });
}

document.getElementById('btn-restart-bridge').addEventListener('click', async function() {
  setStatus('Restarting bridge process...');
  appLog('Manual bridge restart requested');
  document.getElementById('midi-dot').classList.remove('connected');
  bridgeMidiReady = false;
  try {
    if (bridgeWs) { try { bridgeWs.close(); } catch(e) {} }
    await window.electronAPI.restartBridge();
    setTimeout(connectBridgeWs, 1500);
  } catch(e) {
    setStatus('Restart failed: ' + e.message);
  }
});

// ════════════════════════════════════════════════════════════════════
// ZOOM
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// TONE KNOB DRAG — delegated handler, sends via sendParamWrite
// ════════════════════════════════════════════════════════════════════
(function() {
  let dragging = false, startY = 0, startVal = 0, activeWrap = null, activeIdx = -1;

  document.addEventListener('mousedown', function(e) {
    const wrap = e.target.closest('.knob-wrap[data-tone-idx]');
    if (!wrap) return;
    activeIdx = parseInt(wrap.dataset.toneIdx);
    if (isNaN(activeIdx) || activeIdx < 0) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    syncClearedThisDrag = false;   // one Sync clear per drag, not per mousemove
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }  // released outside the window
    const val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    activeWrap.dataset.value = val;
    drawKnob(activeWrap.querySelector('canvas'), val);
    const vEl = document.getElementById('tone-v' + activeIdx);
    if (vEl) vEl.textContent = valDisplay(val);
    const ap = currentAmpKey ? AMP_TONE_PARAMS[currentAmpKey] : null;
    if (ap && currentParamHi >= 0) {
      const knobs = ap.knobs.filter(k => k.type === 'knob');
      if (activeIdx < knobs.length) {
        const lo = knobs[activeIdx].lo;
        // SPEED (0x11) — the rack refuses a Speed write while Sync is on a
        // division, and clears Sync to OFF the moment its OWN Speed knob is
        // turned. Mirror that: clear Sync once per drag, then write Speed
        // normally. Avid does NOT do this, which is why its Speed knob is
        // inert in the same state — Avid_Shark_Sync_Test.pcapng shows ~40
        // Speed writes ignored, the rack echoing the unchanged value back
        // every time.
        if (lo === 0x11 && currentSyncZone !== 0 && !syncClearedThisDrag) {
          syncClearedThisDrag = true;
          sendParamWrite(0x12, 0);
          appLog('Speed moved while Sync was on ' + SYNC_DIVISIONS[currentSyncZone].text
                 + ' — clearing Sync to OFF first (the rack does the same)');
        }
        queueKnobSend('tone:' + lo, function(v) { sendParamWrite(lo, v); }, val);
      }
    }
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeIdx = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeIdx = -1; });

  document.addEventListener('dblclick', function(e) {
    const wrap = e.target.closest('.knob-wrap[data-tone-idx]');
    if (!wrap) return;
    const idx = parseInt(wrap.dataset.toneIdx);
    if (isNaN(idx) || idx < 0) return;
    wrap.dataset.value = 64;
    drawKnob(wrap.querySelector('canvas'), 64);
    const vEl = document.getElementById('tone-v' + idx);
    if (vEl) vEl.textContent = valDisplay(64);
    const ap = currentAmpKey ? AMP_TONE_PARAMS[currentAmpKey] : null;
    if (ap && currentParamHi >= 0) {
      const knobs = ap.knobs.filter(k => k.type === 'knob');
      if (idx < knobs.length) queueKnobSend('tone:' + knobs[idx].lo, function(v) { sendParamWrite(knobs[idx].lo, v); }, 64);
    }
  });
})();

// ════════════════════════════════════════════════════════════════════
// SCROLL WHEEL on tone / DIST / REVERB knobs (item 4, 7/26)
// The Gate / To Amp / Rig Vol / Amp Out knobs already scroll via initKnob;
// these delegated-handler knobs did not. One notch = 1 hardware unit (the
// finest the rack accepts), matching the other knobs. Wheel up = increase.
// Sends go through the same throttle as drags so a fast spin cannot flood the
// rack; the red "changed" colour and SAVE-dirty latch follow automatically
// because the send path is identical.
// ════════════════════════════════════════════════════════════════════
(function() {
  function step(wrap, e) {
    var v = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    v = Math.max(0, Math.min(127, v - Math.sign(e.deltaY)));   // wheel up (deltaY<0) = increase
    wrap.dataset.value = v;
    drawKnob(wrap.querySelector('canvas'), v);
    return v;
  }
  document.addEventListener('wheel', function(e) {
    // Amp tone knobs (keyed by data-tone-idx, per-amp paramLo lookup)
    var tw = e.target.closest('.knob-wrap[data-tone-idx]');
    if (tw) {
      var idx = parseInt(tw.dataset.toneIdx);
      if (isNaN(idx) || idx < 0) return;
      e.preventDefault();
      var tv = step(tw, e);
      var tEl = document.getElementById('tone-v' + idx);
      if (tEl) tEl.textContent = valDisplay(tv);
      var ap = currentAmpKey ? AMP_TONE_PARAMS[currentAmpKey] : null;
      if (ap && currentParamHi >= 0) {
        var knobs = ap.knobs.filter(function(k){ return k.type === 'knob'; });
        if (idx < knobs.length) {
          var lo = knobs[idx].lo;
          // Speed (0x11): the rack ignores a Speed write while Sync is on a
          // division and clears Sync when its own Speed knob moves — mirror the
          // drag handler and clear Sync first.
          if (lo === 0x11 && currentSyncZone !== 0) {
            queueKnobSend('tone:12', function(){ sendParamWrite(0x12, 0); }, 0);
          }
          queueKnobSend('tone:' + lo, function(val){ sendParamWrite(lo, val); }, tv);
        }
      }
      return;
    }
    // DIST knobs (keyed by data-dist-lo)
    var dw = e.target.closest('.knob-wrap[data-dist-lo]');
    if (dw) {
      var dlo = parseInt(dw.dataset.distLo, 16);
      if (isNaN(dlo)) return;
      e.preventDefault();
      var dv = step(dw, e);
      var dEl = document.getElementById('dist-v-' + dw.dataset.distLo);
      if (dEl) dEl.textContent = valDisplay(dv);
      if (bridgeMidiReady) queueKnobSend('dist:' + dlo, function(val){ sendDistParamWrite(dlo, val); }, dv);
      return;
    }
    // REVERB knobs (keyed by data-reverb-lo; the Type composite re-syncs its
    // dropdown from the hardware echo, same as a drag)
    var rw = e.target.closest('.knob-wrap[data-reverb-lo]');
    if (rw) {
      var rlo = parseInt(rw.dataset.reverbLo, 16);
      if (isNaN(rlo)) return;
      e.preventDefault();
      var rv = step(rw, e);
      var rEl = document.getElementById('reverb-v-' + rw.dataset.reverbLo);
      if (rEl) rEl.textContent = valDisplay(rv);
      if (bridgeMidiReady) queueKnobSend('reverb:' + rlo, function(val){ sendReverbParamWrite(rlo, val); }, rv);
      return;
    }
  }, { passive: false });
})();

// ════════════════════════════════════════════════════════════════════
// TO AMP 1 & 2 — CMD 0x36 volume knobs, CMD 0x37 source dropdowns
// ════════════════════════════════════════════════════════════════════
// Drag flags — readback handler checks these and skips display update
// while the user is actively dragging, preventing HW broadcasts from
// fighting the drag in progress.
var toAmp1Dragging = false;
var toAmp2Dragging = false;

(function() {
  var w1 = document.getElementById('toamp1-vol-wrap');
  var w2 = document.getElementById('toamp2-vol-wrap');
  if (w1) {
    w1.addEventListener('mousedown', function() { toAmp1Dragging = true; });
    window.addEventListener('mouseup', function() { toAmp1Dragging = false; });
  }
  if (w2) {
    w2.addEventListener('mousedown', function() { toAmp2Dragging = true; });
    window.addEventListener('mouseup', function() { toAmp2Dragging = false; });
  }
})();

initKnob('toamp1-vol-wrap', 'toamp1-vol-val', valToAmpVol, function(v) { sendToAmpVolume(0x02, v); });
initKnob('toamp2-vol-wrap', 'toamp2-vol-val', valToAmpVol, function(v) { sendToAmpVolume(0x03, v); });

// To Amp source dropdown listeners removed 7/17/2026 — dropdowns removed
// from GUI pending full CMD 0x37 implementation. Code in transport.js and
// sysex-handler.js preserved for future use.

// ════════════════════════════════════════════════════════════════════
// DIST EFFECT PANEL
// ════════════════════════════════════════════════════════════════════

// Called when ▼ opens the DIST slot — populate dropdown, render knobs,
// query hardware for current values.
function openDistPanel() {
  distPanelOpen = true;
  const distBlk = currentChain.find(b => b.slotId === SLOT_DIST);
  if (!distBlk) {
    document.getElementById('dist-knob-row').innerHTML =
      '<div style="color:var(--muted);padding:8px;">Chain map not yet received — navigate to a patch first.</div>';
    appLog('openDistPanel: no DIST block in chain map yet');
    return;
  }
  // Sync dropdown to current model
  const sel = document.getElementById('dist-model-select');
  if (sel) sel.value = String(distBlk.modelId);
  // Render knobs for current model
  renderDistKnobs(distBlk.modelId);
  // Query hardware for current values
  requestDistParams();
  appLog('openDistPanel: mid=0x' + distBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + distBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// Called when DIST panel is hidden.
function closeDistPanel() {
  distPanelOpen = false;
}

// Build the knob row DOM for the given model mid.
// Called on open and when user changes model via dropdown.
// Build the knob area for a given model mid.
// Each model defines a rows array: [ row [ {label,lo} | null ] ]
// null = invisible spacer that holds column alignment (e.g. triangle layout).
// All rows are wrapped in a single dark framed group matching the gate/amp-out
// style. Knob IDs are dist-w-{loHex} / dist-v-{loHex} so updateDistKnob can
// look them up directly by paramLo without tracking array indices.
function renderDistKnobs(mid) {
  const container = document.getElementById('dist-knob-row');
  if (!container) return;
  const model = DIST_MODEL_BY_MID[mid];
  if (!model) {
    container.innerHTML = '<div style="color:var(--muted);padding:8px;">Unknown model</div>';
    return;
  }
  container.innerHTML = '';

  // Outer dark group — same background/border treatment as .gate-group
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:inline-flex;flex-direction:column;gap:14px;'
    + 'padding:12px 14px;background:#1e1e1e;border-radius:6px;border:1px solid #555;';

  model.rows.forEach(function(rowCells) {
    const rowDiv = document.createElement('div');
    rowDiv.style.cssText = 'display:flex;gap:18px;align-items:flex-start;';

    rowCells.forEach(function(cell) {
      if (!cell) {
        // Spacer: invisible, same width as a ctrl-knob so columns align
        var sp = document.createElement('div');
        sp.style.cssText = 'width:80px;flex-shrink:0;';
        rowDiv.appendChild(sp);
      } else {
        var loHex = cell.lo.toString(16).padStart(2,'0');
        var knobDiv = document.createElement('div');
        knobDiv.className = 'ctrl-knob';
        knobDiv.innerHTML =
          '<label>' + cell.label + '</label>'
          + '<div class="knob-wrap" id="dist-w-' + loHex + '" data-value="64" data-base="fx" data-dist-lo="' + loHex + '">'
          + '<canvas class="knob-canvas" width="80" height="80"></canvas></div>'
          + '<span class="knob-val" id="dist-v-' + loHex + '">--</span>';
        rowDiv.appendChild(knobDiv);
        drawKnob(knobDiv.querySelector('canvas'), 64);
      }
    });

    wrapper.appendChild(rowDiv);
  });

  container.appendChild(wrapper);
}

// Update a single DIST knob from a CMD 0x11 broadcast or REQU response.
// Looks up by paramLo directly — no index arithmetic needed.
function updateDistKnob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const wrap  = document.getElementById('dist-w-' + loHex);
  const valEl = document.getElementById('dist-v-' + loHex);
  if (wrap) {
    // Display the current value; anchor the baseline in the persistent store so
    // it survives panel close/reopen. First value this patch becomes the truth.
    wrap.dataset.orig  = fxBaselineSetIfUnset(SLOT_DIST, loHex, val);
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
  }
  if (valEl) valEl.textContent = valDisplay(val);
}

// Called from sysex-handler CMD 0x21 handler after currentChain is updated.
// Re-syncs dropdown (model may have changed on patch nav) and re-queries params.
function refreshDistPanelAfterChainMap() {
  if (!distPanelOpen) return;
  const distBlk = currentChain.find(b => b.slotId === SLOT_DIST);
  if (!distBlk) return;
  const sel = document.getElementById('dist-model-select');
  if (sel && parseInt(sel.value) !== distBlk.modelId) {
    sel.value = String(distBlk.modelId);
    renderDistKnobs(distBlk.modelId);
    clearFxBaselineForSlot(SLOT_DIST);   // new model = new reference point
  }
  // Short delay so firmware handle assignment settles before we query
  setTimeout(requestDistParams, 150);
  appLog('refreshDistPanelAfterChainMap: mid=0x' + distBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + distBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── DIST knob drag — delegated, keyed on data-dist-lo (hex paramLo string) ──
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;

  document.addEventListener('mousedown', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-dist-lo]');
    if (!wrap) return;
    activeParamLo = parseInt(wrap.dataset.distLo, 16);
    if (isNaN(activeParamLo)) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }  // released outside the window
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    activeWrap.dataset.value = val;
    drawKnob(activeWrap.querySelector('canvas'), val);
    var loHex = activeParamLo.toString(16).padStart(2,'0');
    var vEl = document.getElementById('dist-v-' + loHex);
    if (vEl) vEl.textContent = valDisplay(val);
    if (bridgeMidiReady) queueKnobSend('dist:' + activeParamLo, function(v) { sendDistParamWrite(activeParamLo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-dist-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.distLo, 16);
    if (isNaN(paramLo)) return;
    wrap.dataset.value = 64;
    drawKnob(wrap.querySelector('canvas'), 64);
    var loHex = paramLo.toString(16).padStart(2,'0');
    var vEl = document.getElementById('dist-v-' + loHex);
    if (vEl) vEl.textContent = valDisplay(64);
    if (bridgeMidiReady) queueKnobSend('dist:' + paramLo, function(v) { sendDistParamWrite(paramLo, v); }, 64);
  });
})();

// ════════════════════════════════════════════════════════════════════
// REVERB EFFECT PANEL
// Mirror of the DIST panel, plus the Eleven SR Type control (a dropdown
// and a knob that stay in sync — both drive paramLo 0x05).
// Knob IDs: reverb-w-{loHex} / reverb-v-{loHex}, keyed by paramLo.
// ════════════════════════════════════════════════════════════════════

function currentReverbModel() {
  const rvBlk = currentChain.find(b => b.slotId === SLOT_REVERB);
  if (!rvBlk) return null;
  return REVERB_MODEL_BY_MID[rvBlk.modelId] || null;
}

// Open the REVERB slot panel — sync model dropdown, render controls,
// query hardware for current values.
function openReverbPanel() {
  reverbPanelOpen = true;
  const rvBlk = currentChain.find(b => b.slotId === SLOT_REVERB);
  if (!rvBlk) {
    document.getElementById('reverb-knob-row').innerHTML =
      '<div style="color:var(--muted);padding:8px;">Chain map not yet received — navigate to a patch first.</div>';
    appLog('openReverbPanel: no REVERB block in chain map yet');
    return;
  }
  const model = REVERB_MODEL_BY_MID[rvBlk.modelId];
  const sel = document.getElementById('reverb-model-select');
  if (sel && model) sel.value = String(model.mid);   // base mid identifies the model
  renderReverbKnobs(rvBlk.modelId);
  requestReverbParams();
  appLog('openReverbPanel: mid=0x' + rvBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + rvBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

function closeReverbPanel() {
  reverbPanelOpen = false;
}

// Build the control row for the given model mid. One flat row:
// [Type dropdown+knob] (Eleven SR only) followed by the knob cells.
function renderReverbKnobs(mid) {
  const container = document.getElementById('reverb-knob-row');
  if (!container) return;
  const model = REVERB_MODEL_BY_MID[mid];
  if (!model) {
    container.innerHTML = '<div style="color:var(--muted);padding:8px;">Unknown model</div>';
    return;
  }
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:inline-flex;flex-direction:column;gap:14px;'
    + 'padding:12px 14px;background:#1e1e1e;border-radius:6px;border:1px solid #555;';

  const rowDiv = document.createElement('div');
  rowDiv.style.cssText = 'display:flex;gap:18px;align-items:flex-start;';

  // ── Type composite cell — knob aligned with the others, a dark-themed
  // dropdown below it in place of the numeric readout. The dropdown already
  // shows the type name, so no separate name label is drawn. Cell is a little
  // wider than a plain knob so the dropdown sits inside the frame. ──
  if (model.typeControl) {
    const tc = model.typeControl;
    const loHex = tc.lo.toString(16).padStart(2,'0');
    const cell = document.createElement('div');
    cell.className = 'ctrl-knob';
    cell.style.width = '120px';
    let opts = '';
    tc.list.forEach(function(t, i) { opts += '<option value="' + i + '">' + t.name + '</option>'; });
    cell.innerHTML =
      '<label>' + tc.label + '</label>'
      + '<div class="knob-wrap" id="reverb-w-' + loHex + '" data-value="64" data-base="fx" data-reverb-lo="' + loHex + '">'
      + '<canvas class="knob-canvas" width="80" height="80"></canvas></div>'
      + '<select id="reverb-type-select" style="width:112px;margin-top:2px;'
      + 'background:#1a1a1a;color:var(--text);border:1px solid var(--border-dim);'
      + 'border-radius:4px;padding:4px 6px;font-size:12px;">' + opts + '</select>';
    rowDiv.appendChild(cell);
    drawKnob(cell.querySelector('canvas'), 64);
    // Dropdown pick → snap the knob to that zone and send, via the normal path
    const sel = cell.querySelector('#reverb-type-select');
    sel.addEventListener('change', function() {
      const idx = parseInt(this.value, 10);
      if (isNaN(idx)) return;
      const v127 = REVERB_TYPE_LIST[idx].v127;
      updateReverbKnob(tc.lo, v127);                 // move knob locally
      if (bridgeMidiReady) sendReverbParamWrite(tc.lo, v127);
    });
  }

  // ── Standard knob cells ──
  model.rows[0].forEach(function(cell) {
    if (!cell) {
      const sp = document.createElement('div');
      sp.style.cssText = 'width:80px;flex-shrink:0;';
      rowDiv.appendChild(sp);
      return;
    }
    const loHex = cell.lo.toString(16).padStart(2,'0');
    const knobDiv = document.createElement('div');
    knobDiv.className = 'ctrl-knob';
    knobDiv.innerHTML =
      '<label>' + cell.label + '</label>'
      + '<div class="knob-wrap" id="reverb-w-' + loHex + '" data-value="64" data-base="fx" data-reverb-lo="' + loHex + '">'
      + '<canvas class="knob-canvas" width="80" height="80"></canvas></div>'
      + '<span class="knob-val" id="reverb-v-' + loHex + '">--</span>';
    rowDiv.appendChild(knobDiv);
    drawKnob(knobDiv.querySelector('canvas'), 64);
  });

  wrapper.appendChild(rowDiv);
  container.appendChild(wrapper);
}

// Display string for a reverb knob value — honours a cell's `unit`/`max`
// (e.g. Pre-Delay shows milliseconds over 0-200 instead of the default 0-10).
// NOTE (7/22): the 0-200 ms mapping is assumed linear pending hardware
// confirmation of the value the unit shows at full knob.
function reverbKnobDisplay(paramLo, val) {
  const model = currentReverbModel();
  if (model) {
    for (let r = 0; r < model.rows.length; r++) {
      const row = model.rows[r];
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (cell && cell.lo === paramLo && cell.unit === 'ms') {
          const max = cell.max || 200;
          return (val / 127 * max).toFixed(1) + ' ms';
        }
      }
    }
  }
  return valDisplay(val);
}

// Update a single REVERB control from a broadcast/REQU response or a local
// dropdown pick. For the Type control it also moves the dropdown and shows
// the type name instead of a 0-10 number.
function updateReverbKnob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const wrap  = document.getElementById('reverb-w-' + loHex);
  const valEl = document.getElementById('reverb-v-' + loHex);
  if (wrap) {
    // Baseline anchored in the persistent store — survives panel close/reopen.
    wrap.dataset.orig  = fxBaselineSetIfUnset(SLOT_REVERB, loHex, val);
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
  }
  const model = currentReverbModel();
  const isType = model && model.typeControl && model.typeControl.lo === paramLo;
  if (isType) {
    const idx = reverbTypeIndexFromV127(val);
    const sel = document.getElementById('reverb-type-select');
    if (sel) sel.value = String(idx);
    if (valEl) valEl.textContent = REVERB_TYPE_LIST[idx].name;
  } else if (valEl) {
    valEl.textContent = reverbKnobDisplay(paramLo, val);
  }
}

// Re-sync dropdown + knobs after a chain map (model may have changed on
// patch nav or via our own model switch), then re-query params.
function refreshReverbPanelAfterChainMap() {
  if (!reverbPanelOpen) return;
  const rvBlk = currentChain.find(b => b.slotId === SLOT_REVERB);
  if (!rvBlk) return;
  const model = REVERB_MODEL_BY_MID[rvBlk.modelId];
  const sel = document.getElementById('reverb-model-select');
  if (sel && model && parseInt(sel.value) !== model.mid) {
    sel.value = String(model.mid);
    renderReverbKnobs(rvBlk.modelId);   // model actually changed — rebuild controls
    clearFxBaselineForSlot(SLOT_REVERB);   // new model = new reference point
  }
  setTimeout(requestReverbParams, 150);
  appLog('refreshReverbPanelAfterChainMap: mid=0x' + rvBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + rvBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── REVERB knob drag — delegated, keyed on data-reverb-lo (hex paramLo) ──
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;

  document.addEventListener('mousedown', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-reverb-lo]');
    if (!wrap) return;
    activeParamLo = parseInt(wrap.dataset.reverbLo, 16);
    if (isNaN(activeParamLo)) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }  // released outside the window
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    updateReverbKnob(activeParamLo, val);
    if (bridgeMidiReady) queueKnobSend('reverb:' + activeParamLo, function(v) { sendReverbParamWrite(activeParamLo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-reverb-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.reverbLo, 16);
    if (isNaN(paramLo)) return;
    updateReverbKnob(paramLo, 64);
    if (bridgeMidiReady) queueKnobSend('reverb:' + paramLo, function(v) { sendReverbParamWrite(paramLo, v); }, 64);
  });
})();
