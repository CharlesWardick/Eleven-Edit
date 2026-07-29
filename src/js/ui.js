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
// One decimal place throughout (7/27), matching every other readout
// (Gate Threshold, Rig Vol, Amp Out, To Amp Vol) — was showing a bare
// rounded integer below 1000ms ("10 ms") while the seconds branch above
// 1000ms already used .toFixed(1). The v127=0 special case is gone too:
// the formula already lands exactly on 10 at v127=0, so toFixed(1) alone
// gives "10.0 ms" with no separate branch needed.
function valGateRelease(v127) {
  // Logarithmic: ms = 10 * (300)^(v/127)
  const ms = 10 * Math.pow(300, v127 / 127);
  return ms >= 1000 ? (ms/1000).toFixed(1) + ' s' : ms.toFixed(1) + ' ms';
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

  // Passive clone at the start of the chain strip (7/28) — same source of
  // truth as the buttons above, updated in the same place so it can never
  // drift out of sync with them.
  const cloneEl = document.getElementById('chain-input-wrap');
  if (cloneEl) {
    cloneEl.textContent = isGuitar ? 'GUITAR' : isMic ? 'MIC' : isLine ? 'LINE' : isDig ? 'DIGITAL' : '--';
  }
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
// transmitted.
//
// AMP-CAB + LOOP "LINKED BLOCK" RULE (confirmed against the Avid editor
// 7/28/2026, Session Log): dragging AMP-CAB while LOOP sits immediately
// adjacent to it (either side) moves LOOP along with it, same direction, same
// distance, until LOOP would be pushed past either end of the chain — at
// which point LOOP stays parked at that end and further AMP-CAB movement is
// free (LOOP at position 1 or 10 is legal regardless of AMP-CAB's position).
// Dragging LOOP directly, or dragging AMP-CAB when LOOP is NOT adjacent to it,
// uses the plain snap-to-nearest-legal-stop behaviour below (unchanged, and
// already confirmed correct against a full legality table the same day).
//
// baseOrder defaults to currentChain but the live drag preview (wireChainDrag)
// passes a frozen snapshot taken at dragstart instead, so a chain-map arriving
// mid-drag can't perturb the on-screen preview (Session Log WATCH FOR, 7/19).
//
// Shared by computeReorder AND the drag-ghost builder (wireChainDrag), so the
// "is this drag a linked AMP-CAB+LOOP pair" question has exactly one answer
// used everywhere, not two independently-maintained copies of the same check.
// Returns null if not linked, else {ampIdx, loopIdx, loopBefore}.
function linkedAmpLoopInfo(fromSlotId, baseOrder) {
  if (fromSlotId !== SLOT_AMP) return null;
  const ampIdx  = baseOrder.findIndex(b => b.slotId === SLOT_AMP);
  const loopIdx = baseOrder.findIndex(b => b.slotId === SLOT_LOOP);
  if (ampIdx < 0 || loopIdx < 0 || Math.abs(ampIdx - loopIdx) !== 1) return null;
  // Adjacent alone isn't enough: LOOP already parked at an end (index 0 or
  // the last index) is legal on its own regardless of AMP-CAB's position, so
  // it must NOT be dragged along even though it's numerically "adjacent" —
  // confirmed by simulation: amp=9/loop=10 wrongly pulled loop to 2 before
  // this guard was added.
  if (loopIdx === 0 || loopIdx === baseOrder.length - 1) return null;
  return { ampIdx, loopIdx, loopBefore: loopIdx < ampIdx };
}

// Returns a reordered copy of baseOrder, loop legality already resolved.
function computeReorder(fromSlotId, targetSlotId, after, baseOrder) {
  const src = baseOrder || currentChain;
  if (fromSlotId === targetSlotId) return src;

  const linkInfo = linkedAmpLoopInfo(fromSlotId, src);
  if (linkInfo) return computeLinkedAmpLoopReorder(src, targetSlotId, after, linkInfo.ampIdx, linkInfo.loopIdx);

  const rest = src.filter(b => b.slotId !== fromSlotId);
  const moved = src.find(b => b.slotId === fromSlotId);
  if (!moved) return null;
  let idx = rest.findIndex(b => b.slotId === targetSlotId);
  if (idx < 0) idx = rest.length;
  if (after) idx += 1;
  idx = Math.max(0, Math.min(idx, rest.length));
  rest.splice(idx, 0, moved);
  return enforceLoopPlacement(rest);
}

// Moves AMP-CAB and its adjacent LOOP together as a two-item unit. Removing
// both from the order and reinserting them as a pair (in their original
// relative order, so LOOP stays on the same side it started on) means the
// normal 0..rest.length clamp that already bounds a single-item insertion
// now bounds the PAIR instead — which is exactly what stops LOOP from ever
// being pushed past either end. No separate boundary check needed.
function computeLinkedAmpLoopReorder(src, targetSlotId, after, ampIdx, loopIdx) {
  const loopBefore = loopIdx < ampIdx;
  const pair = loopBefore ? [src[loopIdx], src[ampIdx]] : [src[ampIdx], src[loopIdx]];
  const rest = src.filter(b => b.slotId !== SLOT_AMP && b.slotId !== SLOT_LOOP);
  let idx = rest.findIndex(b => b.slotId === targetSlotId);
  if (idx < 0) idx = rest.length;   // hovered over AMP/LOOP itself — park at the end for now
  if (after) idx += 1;
  idx = Math.max(0, Math.min(idx, rest.length));
  const result = rest.slice();
  result.splice(idx, 0, ...pair);
  return result;
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

// MOUSE-TRACKED DRAG (rewritten 7/28, replacing native HTML5 drag-and-drop).
// Native drag-and-drop does its own hit-testing of whatever's under the
// cursor, and it does not tolerate the dragged-over elements being moved
// while a native drag is in progress — which is exactly what the live
// preview does (applyChainOrder relocates divs on every update). Real-world
// testing showed this as a rapid ok/no-drop cursor flicker and, on a
// two-block swap, the two blocks flashing back and forth at high speed —
// the browser's native drag tracking losing and re-finding its target as
// the DOM shifted under it. Knobs in this app never had this problem
// because they were never native-drag-based; they use plain mousedown/
// mousemove/mouseup, same as this rewrite now does for the chain row.
let chainDragSlot       = null;   // slot ID being dragged
let chainDragPending    = false;  // mousedown happened; watching for the move
                                   // threshold before committing to a real drag
let chainDragActive     = false;  // TRUE once the threshold is crossed — this
                                   // (not chainDragPending) is what suppresses
                                   // the click that follows a real drag, so a
                                   // plain click without movement still reaches
                                   // the bypass-toggle handler normally
let chainDragCont       = null;   // .chain-slot/.chain-slot-stack container (still what gets reordered)
let chainDragThumb      = null;   // .chain-thumb inside it — the actual drag handle (7/28)
let chainDragStartX     = 0;
let chainDragStartY     = 0;
let chainDragOffsetX    = 0;      // cursor position WITHIN the grabbed block,
let chainDragOffsetY    = 0;      // used for grab-offset-independent hit
                                   // testing (see mousemove below)
let chainDragStartOrder = null;   // currentChain snapshot at mousedown — every
                                   // preview computation this drag uses THIS,
                                   // never the live currentChain, so an
                                   // incoming chain-map broadcast mid-drag
                                   // cannot yank the preview (WATCH FOR, 7/19)
let chainPreviewOrder   = null;   // order currently shown on screen
const CHAIN_DRAG_THRESHOLD = 4;   // px of movement before it counts as a drag

// 7/28 (2nd pass): the floating ghost clone that used to live here is gone.
// Charlie's screen recording of Avid's own editor showed no separate ghost at
// all during a drag — just the real block sliding smoothly into its new
// spot. Removed the clone entirely; applyChainOrderAnimated (defined right
// after applyChainOrder below, since it wraps it) gives the REAL blocks that
// same smooth slide via a FLIP animation, so the "what am I carrying" cue is
// now just the dragged thumb's own .dragging opacity plus it visibly sliding
// with everything else — no clone needed, and the old linked-pair "show both
// blocks in the ghost" special case is no longer needed either: since both
// blocks in a linked AMP-CAB/LOOP move for real now, they simply slide
// together in sync, which already reads as "these two travel together"
// without any dedicated code for it.

function wireChainDrag() {
  const strip = document.getElementById('chainstrip');
  if (!strip || strip.dataset.dragWired) return;
  strip.dataset.dragWired = '1';

  // 7/28: drag now starts ONLY from .chain-thumb, not anywhere in the slot.
  // Previously the whole slot (including the .chain-name label) was the
  // mousedown target, which is what put the drag-handle and the bypass-toggle
  // click on the same element — Charlie: "the clicker is also the drag
  // handle". Splitting them onto separate elements (thumb vs label) removes
  // that conflict at the source, matching how Avid's own editor works: you
  // grab the pedal graphic, you click the label.
  strip.addEventListener('mousedown', function(ev) {
    if (ev.button !== 0) return;   // left button only
    const thumb = ev.target.closest('.chain-thumb');
    if (!thumb || !strip.contains(thumb)) return;
    const cont = thumb.closest('.chain-slot, .chain-slot-stack');
    if (!cont) return;
    const blk = currentChain.find(b => containerForSlot(b.slotId) === cont);
    if (!blk) return;
    chainDragSlot = blk.slotId;
    chainDragPending = true;
    chainDragCont = cont;
    chainDragThumb = thumb;
    chainDragStartX = ev.clientX;
    chainDragStartY = ev.clientY;
    const r = thumb.getBoundingClientRect();
    chainDragOffsetX = ev.clientX - r.left;   // where within the THUMB it was
    chainDragOffsetY = ev.clientY - r.top;    // grabbed, so the ghost doesn't jump
    chainDragStartOrder = currentChain.slice();
    chainPreviewOrder = chainDragStartOrder;
    ev.preventDefault();   // no text selection / stray native drag ghost
  });

  // LIVE PREVIEW (7/28): the blocks physically shift into the speculative
  // order as you drag, instead of a static insertion marker that only
  // resolved on drop. Recomputed off chainDragStartOrder, applied to the DOM
  // immediately — nothing is sent to hardware until mouseup.
  window.addEventListener('mousemove', function(ev) {
    if (chainDragSlot === null) return;
    if (ev.buttons === 0) { endChainDrag(false); return; }   // button released outside the window

    if (chainDragPending) {
      const dx = ev.clientX - chainDragStartX, dy = ev.clientY - chainDragStartY;
      if (Math.hypot(dx, dy) < CHAIN_DRAG_THRESHOLD) return;   // still just a click so far
      chainDragPending = false;
      chainDragActive = true;
      chainDragThumb.classList.add('dragging');
      document.body.style.cursor = 'grabbing';
    }

    // Hit-test off the DRAGGED BLOCK'S OWN position, not the raw cursor
    // (7/28, Charlie: "matters where I place the mouse on the source block").
    // ev.clientX alone is offset by wherever within the thumb you happened to
    // grab it — chainDragOffsetX undoes that grab offset, landing on the
    // dragged thumb's own current center. That makes the reorder trigger
    // point consistent regardless of where on the block you clicked, instead
    // of shifting by the grab offset.
    const dragCenterX = ev.clientX - chainDragOffsetX + chainDragThumb.offsetWidth  / 2;
    const dragCenterY = ev.clientY - chainDragOffsetY + chainDragThumb.offsetHeight / 2;

    // elementFromPoint does fresh hit-testing against whatever is actually
    // rendered right now — unlike native drag's event target, it is not
    // confused by applyChainOrder having just moved things around.
    const el = document.elementFromPoint(dragCenterX, dragCenterY);
    const cont = el ? el.closest('.chain-slot, .chain-slot-stack') : null;
    if (!cont || !strip.contains(cont)) return;
    const target = chainDragStartOrder.find(b => containerForSlot(b.slotId) === cont);
    if (!target) return;
    const r = cont.getBoundingClientRect();
    // Position 1 gets its whole width as the "before" zone, not just its left
    // half (7/28, Charlie: not enough room before the window's left edge to
    // reliably cross the midpoint). No position is lost by this: landing
    // right after this same block is still reachable via the SECOND block's
    // left half, so this only removes a redundant, cramped path — it doesn't
    // block reaching anywhere the plain midpoint math could reach.
    const after = (target.slotId === chainDragStartOrder[0].slotId)
                  ? false
                  : dragCenterX > r.left + r.width / 2;

    const next = computeReorder(chainDragSlot, target.slotId, after, chainDragStartOrder);
    if (next && !sameOrder(next, chainPreviewOrder)) {
      chainPreviewOrder = next;
      applyChainOrderAnimated(next);
    }
  });

  window.addEventListener('mouseup', function() {
    if (chainDragSlot === null) return;
    endChainDrag(true);
  });

  window.addEventListener('blur', function() {
    if (chainDragSlot === null) return;
    endChainDrag(false);   // losing focus mid-drag cancels, never commits
  });

  function endChainDrag(allowCommit) {
    const wasReallyDragging = chainDragActive;
    let committed = false;
    if (allowCommit && wasReallyDragging
        && chainPreviewOrder && !sameOrder(chainPreviewOrder, currentChain)) {
      sendChainOrder(chainPreviewOrder);   // hardware replies with a map; renderChainRow adopts it
      committed = true;
    }
    if (chainDragThumb) chainDragThumb.classList.remove('dragging');
    document.body.style.cursor = '';
    chainDragSlot = null;
    chainDragThumb = null;
    chainDragPending = false;
    chainDragCont = null;
    chainDragStartOrder = null;
    chainPreviewOrder = null;
    setTimeout(() => {
      chainDragActive = false;   // let the stray click pass first
      // A committed drag leaves the preview's DOM alone — the hardware's own
      // CMD 0x21 reply will call renderChainRow() for real once it lands, and
      // currentChain will match what's already on screen by then (no visible
      // jump). A cancelled/no-op drag, or a plain click that never became a
      // real drag, has nothing coming, so re-sync now (a no-op if nothing
      // ever moved).
      if (!committed) renderChainRow();
    }, 0);
  }
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
  // A live drag preview (wireChainDrag) is showing its own speculative order
  // on screen right now — a chain-map arriving mid-drag (front panel, Avid,
  // an echo) must not fight it. dragend re-syncs for real once the drag ends
  // (Session Log WATCH FOR, 7/19).
  if (chainDragActive) return;

  applyChainOrder(currentChain);
  refreshBlockBypassDisplays();
  wireChainDrag();
}

// Moves the chain-slot divs into `order` and repaints the connector arrows.
// Pulled out of renderChainRow (7/28) so the live drag preview can call it
// with a SPECULATIVE order while dragging, without touching currentChain or
// re-running the bypass-paint / drag-wiring side effects.
function applyChainOrder(order) {
  const strip = document.getElementById('chainstrip');
  if (!strip) return;

  // Collect the movable pieces before touching anything.
  // The "drag blocks to reorder" hint was removed 7/24/2026 — 10px on #555 was
  // unreadable. #mono-indicator now carries the margin-left:auto that pushes
  // the right-hand group to the end of the strip.
  // #chain-input-connector is also .chain-arr (so it inherits the same line
  // styling) but it is NOT one of the between-block connectors this loop
  // assigns — excluded the same way #mono-connector already is, or this loop
  // would hijack it as a stereo/mono arrow and throw off the block<->arrow
  // pairing by one (7/28).
  const arrows = Array.from(strip.querySelectorAll('.chain-arr:not(#mono-connector):not(#chain-input-connector)'));
  const conn    = document.getElementById('mono-connector');
  // 7/28 BUG FIX: #mono-indicator is now wrapped in a .chain-slot (with a
  // hidden .chain-open) so it bottom-aligns at the same baseline as every
  // real block's label. Grabbing and re-appending the bare label (as this
  // used to do) ripped it straight back out of that wrapper on every single
  // reorder — which is constantly, in the real app — leaving an orphaned
  // empty wrapper sitting in the row (the extra gap Charlie saw) and the
  // badge reverting to plain align-self:center (why it drifted back to
  // looking wrong after any chain-map update, not just on first load).
  // Move the WRAPPER, not the label.
  const monoLbl = document.getElementById('mono-indicator');
  const mono    = monoLbl ? monoLbl.closest('.chain-slot') : null;
  const tempo   = document.getElementById('tempo-wrap');

  let arrowIdx = 0;
  order.forEach((blk, i) => {
    const cont = containerForSlot(blk.slotId);
    if (!cont) return;
    strip.appendChild(cont);                       // move, do not clone

    // Hover text on BOTH the label and the ▼, for a bigger target.
    const model = MODEL_NAMES[blk.modelId];
    const label = model || ('unknown model 0x' + blk.modelId.toString(16).padStart(2,'0'));
    const tip   = blk.name + ' — ' + label;
    cont.querySelectorAll('.chain-name, .chain-open').forEach(el => { el.title = tip; });

    // Connector after this block: double arrow when this block outputs stereo.
    if (i < order.length - 1 && arrowIdx < arrows.length) {
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
}

// How long the live-drag slide takes. First guess (a common, unremarkable UI
// default), NOT yet confirmed against real hardware — Charlie's own feel-check
// on a real rebuild is the actual test; adjust this one number if it reads as
// too sluggish or too snappy.
const CHAIN_SLIDE_MS = 1000;

// FLIP-animates a reorder instead of letting applyChainOrder's instant
// DOM move snap into place — used ONLY for the live drag preview (7/28, 2nd
// pass: replaces the floating ghost clone, see the comment above where that
// used to live). Avid's own editor has no separate "carried" visual during a
// drag — just the real block sliding smoothly — so this makes the REAL
// blocks slide instead of adding anything extra on top.
//
// FLIP = First (record where things are), Last (do the actual instant DOM
// move), Invert (paint each moved element back at its OLD spot via a
// transform, so nothing appears to have moved yet), Play (clear the
// transform with a transition enabled, so the browser animates the actual
// slide). Only translateX is needed — every mover here sits in a single
// horizontal row, nothing changes rows.
//
// Sampling live rects (not tracking some idealized target) is what makes
// this safe to call again before a previous slide has finished: a rapid drag
// fires many of these in quick succession, and each call just captures
// wherever things visually are AT THAT INSTANT (mid-slide or settled) as its
// own "First" — no queuing or cancellation bookkeeping needed.
function applyChainOrderAnimated(order) {
  const strip = document.getElementById('chainstrip');
  if (!strip) { applyChainOrder(order); return; }

  const movers = Array.from(strip.querySelectorAll('.chain-slot, .chain-slot-stack, .chain-arr'));
  const firstRects = new Map();
  movers.forEach(el => firstRects.set(el, el.getBoundingClientRect()));

  applyChainOrder(order);   // Last — the real, instant reorder

  movers.forEach(el => {
    const first = firstRects.get(el);
    const last  = el.getBoundingClientRect();
    const dx = first.left - last.left;
    if (Math.abs(dx) < 0.5) return;   // didn't actually move, nothing to animate

    el.style.transition = 'none';
    el.style.transform  = `translateX(${dx}px)`;   // Invert — paint at the old spot
    void el.offsetWidth;                             // force a reflow so the browser commits that starting point
    el.style.transition = `transform ${CHAIN_SLIDE_MS}ms ease`;
    el.style.transform  = '';                          // Play — animate back to natural position

    el.addEventListener('transitionend', function cleanup() {
      el.style.transition = '';
      el.style.transform  = '';
    }, { once: true });
  });
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

