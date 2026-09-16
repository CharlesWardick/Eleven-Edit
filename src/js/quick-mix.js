/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// QUICK MIX — inline per-block wet-amount slider on the chain row.
// v1.2.0 candidate (may ride in v1.1.0). Approach confirmed 2026-09-16
// (private ROADMAP "v1.2.0 — Quick Mix strip"). Variant B2: a slim
// horizontal slider under each ENGAGED, wet-capable block's name in the
// chain row. Drag + mouse-wheel + double-click-to-saved. Dims when the
// block is OFF; hidden entirely for a block whose model has no wet control.
//
// PURE UI. No new transport: writes reuse the same CMD 0x11 wire format the
// panel send-fns use (sendReverbParamWrite etc. — identical payload for
// every block), addressed by the block's live handle from currentChain.
// Values are queried on each chain map (patch load / reorder / model
// change) so sliders are correct on sight without opening any panel, and
// updated live from CMD 0x11 broadcasts (hardware / front panel / a panel).
//
// WHICH PARAM PER BLOCK (confirmed 2026-09-16 — one slider = the block's
// MAIN wet blend; "Depth = the wet amount" where a model has only Depth):
//   REVERB          Mix   0x04   (all models)
//   DELAY           Mix   0x02   (all models — EP Tape / BBD / Dyn)
//   FX LOOP         Mix   0x04
//   host (MOD/FX1/FX2), by loaded model mid:
//     C1 Chorus / Flanger / Vibe Phaser   Depth 0x03
//     MultiChorus                         Depth 0x04  (voices Mix = sub)
//     Orange Phaser / Roto / compressors / EQs   none -> no slider
// The three "both mix and depth" models (BBD, Dyn, MultiChorus) intentionally
// show only their MAIN param here; the sub-element stays in the full panel.
// (A future pass could stack a 2nd slim slider on just those — deferred.)
// ════════════════════════════════════════════════════════════════════

// Fixed wet paramLo for the single-model blocks.
var QM_FIXED_WET = {};
QM_FIXED_WET[SLOT_REVERB] = 0x04;
QM_FIXED_WET[SLOT_DELAY]  = 0x02;
QM_FIXED_WET[SLOT_LOOP]   = 0x04;

// Host slots (MOD / FX1 / FX2) draw from FX1_MODELS; the wet paramLo depends
// on the LOADED model mid. Keyed by every mono/stereo variant mid so a match
// works whichever variant firmware loaded. Absent mid => no wet control =>
// no slider (compressors, EQs, Orange Phaser, Roto Speaker).
var QM_HOST_WET_BY_MID = {
  0x01: 0x03, 0x02: 0x03, 0x03: 0x03,  // C1 Chorus/Vibrato — Depth
  0x07: 0x03, 0x08: 0x03,              // Flanger          — Depth
  0x09: 0x03, 0x0A: 0x03,              // Vibe Phaser      — Depth
  0x04: 0x04, 0x05: 0x04, 0x06: 0x04   // MultiChorus      — Depth (voices Mix = sub)
};

var QM_HOST_SLOTS = [SLOT_MOD, SLOT_FX1, SLOT_FX2];

// slotId -> chain-row dom suffix (only the wet-capable blocks).
var QM_SLOT_DOM = {};
QM_SLOT_DOM[SLOT_LOOP]   = 'fxloop';
QM_SLOT_DOM[SLOT_MOD]    = 'mod';
QM_SLOT_DOM[SLOT_DELAY]  = 'delay';
QM_SLOT_DOM[SLOT_FX1]    = 'fx1';
QM_SLOT_DOM[SLOT_FX2]    = 'fx2';
QM_SLOT_DOM[SLOT_REVERB] = 'reverb';

// Saved (patch-load baseline) value per slot for double-click restore.
// Set on the first value seen after a chain map; cleared when the chain map
// re-fires (new patch / model / reorder). v127 (0-127) or undefined.
var qmSaved = {};

// The slot whose slider is being dragged right now (so an incoming broadcast
// doesn't fight the drag). null when idle.
var qmDragSlot = null;

// Show/hide preference — per-viewer, localStorage (a pure display pref; not
// hardware state, so it doesn't need the electron-store IPC the rig settings
// use). Defaults ON. Wrapped in try/catch per storage rules.
var qmShown = true;
function qmLoadPref() {
  try {
    var v = window.localStorage.getItem('quickMixShown');
    if (v === '0') qmShown = false;
  } catch (e) { /* storage blocked — default on */ }
}
function qmSavePref() {
  try { window.localStorage.setItem('quickMixShown', qmShown ? '1' : '0'); } catch (e) {}
}

// ── Which wet paramLo (if any) this block currently exposes. null = none.
function qmWetParamFor(blk) {
  if (!blk) return null;
  if (QM_FIXED_WET[blk.slotId] !== undefined) return QM_FIXED_WET[blk.slotId];
  if (QM_HOST_SLOTS.indexOf(blk.slotId) !== -1) {
    var lo = QM_HOST_WET_BY_MID[blk.modelId];
    return (lo === undefined) ? null : lo;
  }
  return null;
}

// ── The block currently occupying a wet-capable slot, from the chain map.
function qmBlockForSlot(slotId) {
  if (typeof currentChain === 'undefined' || !currentChain) return null;
  return currentChain.find(function(b) { return b.slotId === slotId; }) || null;
}

// ── Build the slider element for one slot (once), inserted into its
// .chain-slot under the name/caret. Idempotent — returns the existing one.
function qmEnsureSlider(slotId) {
  var dom = QM_SLOT_DOM[slotId];
  if (!dom) return null;
  var existing = document.getElementById('qm-' + dom);
  if (existing) return existing;
  var nameEl = document.getElementById('chain-' + dom);
  if (!nameEl || !nameEl.parentNode) return null;

  var wrap = document.createElement('div');
  wrap.className = 'qm-wrap';
  wrap.id = 'qm-' + dom;
  wrap.dataset.slot = slotId;
  wrap.title = 'Quick Mix — wet amount (drag / wheel / double-click = saved)';

  var track = document.createElement('div');
  track.className = 'qm-track';
  var fill = document.createElement('div');
  fill.className = 'qm-fill';
  track.appendChild(fill);
  var val = document.createElement('div');
  val.className = 'qm-val';
  val.textContent = '—';

  wrap.appendChild(track);
  wrap.appendChild(val);
  nameEl.parentNode.appendChild(wrap);
  qmWireSlider(wrap, slotId, track);
  return wrap;
}

// Convert an on-track pointer X into a 0-127 value.
function qmXToV127(track, clientX) {
  var r = track.getBoundingClientRect();
  var frac = (clientX - r.left) / r.width;
  frac = Math.max(0, Math.min(1, frac));
  return Math.round(frac * 127);
}

function qmSetSliderValue(wrap, v127, sendIt) {
  v127 = Math.max(0, Math.min(127, v127));
  wrap.dataset.value = v127;
  var pct = Math.round(v127 / 127 * 100);
  var fill = wrap.querySelector('.qm-fill');
  var val  = wrap.querySelector('.qm-val');
  if (fill) fill.style.width = pct + '%';
  if (val) {
    var shown = (wrap.dataset.disp === 'pct')
      ? (Math.round(v127 / 127 * 100) + '%')
      : (v127 / 127 * 10).toFixed(1);        // 0-10, one decimal (matches the panel)
    val.textContent = (wrap.dataset.label || 'Mix') + ' ' + shown;
  }
  if (sendIt) {
    var slotId = parseInt(wrap.dataset.slot, 10);
    var lo = parseInt(wrap.dataset.lo, 10);
    if (!isNaN(lo)) {
      queueKnobSend('qm:' + slotId, function(v) { qmSendWrite(slotId, lo, v); }, v127);
      qmMirrorPanel(slotId, lo, v127);
    }
  }
}

// Keep an OPEN panel's own knob in step while dragging the slider. No-op when
// that panel is closed (the update fns guard on their DOM), so this is safe.
function qmMirrorPanel(slotId, lo, v127) {
  if (slotId === SLOT_REVERB && typeof reverbPanelOpen !== 'undefined' && reverbPanelOpen
      && typeof updateReverbKnob === 'function') updateReverbKnob(lo, v127, true);
  else if (slotId === SLOT_DELAY && typeof delayPanelOpen !== 'undefined' && delayPanelOpen
      && typeof updateDelayKnob === 'function') updateDelayKnob(lo, v127);
  else if (slotId === SLOT_LOOP && typeof fxLoopPanelOpen !== 'undefined' && fxLoopPanelOpen
      && typeof updateFxLoopKnob === 'function') updateFxLoopKnob(lo, v127);
  else if (QM_HOST_SLOTS.indexOf(slotId) !== -1
      && typeof openFxHostSlot !== 'undefined' && openFxHostSlot === slotId
      && typeof updateFxHostKnob === 'function') updateFxHostKnob(lo, v127);
}

function qmWireSlider(wrap, slotId, track) {
  var dragging = false;
  function isEnabled() { return wrap.classList.contains('qm-active'); }
  track.addEventListener('mousedown', function(e) {
    if (!isEnabled()) return;
    dragging = true; qmDragSlot = slotId;
    qmSetSliderValue(wrap, qmXToV127(track, e.clientX), true);
    e.preventDefault(); e.stopPropagation();  // don't trigger a chain drag/bypass click
  });
  window.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    if (e.buttons === 0) { dragging = false; qmDragSlot = null; return; }
    qmSetSliderValue(wrap, qmXToV127(track, e.clientX), true);
  });
  window.addEventListener('mouseup', function() {
    if (dragging) { dragging = false; qmDragSlot = null; }
  });
  wrap.addEventListener('wheel', function(e) {
    if (!isEnabled()) return;
    e.preventDefault();
    var cur = parseInt(wrap.dataset.value, 10) || 0;
    qmSetSliderValue(wrap, cur + (e.deltaY < 0 ? 2 : -2), true);
  }, { passive: false });
  wrap.addEventListener('dblclick', function(e) {
    if (!isEnabled()) return;
    e.preventDefault(); e.stopPropagation();
    var slot = parseInt(wrap.dataset.slot, 10);
    if (qmSaved[slot] !== undefined) qmSetSliderValue(wrap, qmSaved[slot], true);
  });
}

// ── CMD 0x11 write (same wire format + endpoint sentinels as every panel
// send-fn — see sendReverbParamWrite). Addressed by the block's live handle.
function qmSendWrite(slotId, paramLo, v127) {
  if (!bridgeMidiReady) return false;
  var blk = qmBlockForSlot(slotId);
  if (!blk) return false;
  var tail;
  if (v127 >= 127)     tail = '3F 7F 7F 7F 0F';
  else if (v127 <= 0)  tail = '40 00 00 00 00';
  else {
    var v0 = ((v127 + 64) % 128) & 0x7F;
    tail = v0.toString(16).padStart(2, '0').toUpperCase() + ' 00 00 00 00';
  }
  var hh = blk.handle.toString(16).padStart(2, '0').toUpperCase();
  var lo = paramLo.toString(16).padStart(2, '0').toUpperCase();
  return sendPatchWrite('F0 13 0B 0F 00 11 ' + hh + ' ' + lo + ' ' + tail + ' F7');
}

// ── Query one param value (read form: CMD byte 01). Reply arrives as a CMD
// 0x11 broadcast handled by qmOnParam below.
function qmRequestValue(slotId, paramLo) {
  if (!bridgeMidiReady) return;
  var blk = qmBlockForSlot(slotId);
  if (!blk) return;
  var hh = blk.handle.toString(16).padStart(2, '0').toUpperCase();
  var lo = paramLo.toString(16).padStart(2, '0').toUpperCase();
  sendHex('F0 13 0B 0F 01 11 ' + hh + ' ' + lo + ' F7');
}

// ── Live value in from a CMD 0x11 broadcast (hardware / front panel / a
// panel edit / our own read reply). Called from sysex-handler's
// handleParamReadback. instId is the block handle, val is 0-127.
function quickMixOnParam(instId, paramLo, val) {
  if (typeof currentChain === 'undefined' || !currentChain) return;
  for (var i = 0; i < currentChain.length; i++) {
    var blk = currentChain[i];
    if (blk.handle !== instId) continue;
    var lo = qmWetParamFor(blk);
    if (lo === null || lo !== paramLo) continue;
    if (qmSaved[blk.slotId] === undefined) qmSaved[blk.slotId] = val;  // patch baseline
    if (qmDragSlot === blk.slotId) return;                             // don't fight a drag
    var wrap = document.getElementById('qm-' + QM_SLOT_DOM[blk.slotId]);
    if (wrap) qmSetSliderValue(wrap, val, false);
    return;
  }
}

// ── Rebuild sliders after every chain map (patch load / reorder / model
// change): show the ones whose block has a wet control, hide the rest, clear
// saved baselines, and re-query the current values so they're correct on
// sight. Active/dim state is set from bypass here and refreshed live by
// quickMixUpdateActive (called from refreshBlockBypassDisplays).
function quickMixAfterChainMap() {
  Object.keys(QM_SLOT_DOM).forEach(function(slotKey) {
    var slotId = parseInt(slotKey, 10);
    var blk = qmBlockForSlot(slotId);
    var lo  = qmWetParamFor(blk);
    var wrap = qmEnsureSlider(slotId);
    if (!wrap) return;
    qmSaved[slotId] = undefined;                 // new patch/model — re-baseline
    if (lo === null) {                           // model has no wet control
      delete wrap.dataset.lo;                     // clear stale param from a prior model
      wrap.hidden = true;
      return;
    }
    wrap.dataset.lo = lo;
    // Label the readout with the wet control's name: fixed blocks (Reverb/
    // Delay/FX Loop) use Mix; the host slots' wet control is Depth.
    wrap.dataset.label = (QM_HOST_SLOTS.indexOf(slotId) !== -1) ? 'Depth' : 'Mix';
    // Readout units mirror the block's own panel: FX Loop Mix is a percentage
    // (loopPct), every other wet control is a plain 0-10 value (delayTen /
    // the default valDisplay — same formula either way).
    wrap.dataset.disp = (slotId === SLOT_LOOP) ? 'pct' : 'ten';
    wrap.hidden = !qmShown;
    qmRequestValue(slotId, lo);                  // populate on sight
  });
  quickMixUpdateActive();
}

// ── Active (ON, interactive) vs dimmed (OFF/unknown). Called from
// refreshBlockBypassDisplays so a bypass toggle updates the slider instantly.
function quickMixUpdateActive() {
  Object.keys(QM_SLOT_DOM).forEach(function(slotKey) {
    var slotId = parseInt(slotKey, 10);
    var wrap = document.getElementById('qm-' + QM_SLOT_DOM[slotId]);
    if (!wrap || wrap.hidden) return;
    var on = (typeof blockBypass !== 'undefined') ? blockBypass[slotId] : undefined;
    wrap.classList.toggle('qm-active', on === true);
  });
}

// ── Show/hide toggle (Settings checkbox). Hides every slider but keeps their
// values current so flipping it back on shows correct positions immediately.
function quickMixSetShown(shown) {
  qmShown = !!shown;
  qmSavePref();
  Object.keys(QM_SLOT_DOM).forEach(function(slotKey) {
    var slotId = parseInt(slotKey, 10);
    var wrap = document.getElementById('qm-' + QM_SLOT_DOM[slotId]);
    if (!wrap) return;
    // Only unhide sliders whose block actually has a wet control (has a lo).
    var hasWet = wrap.dataset.lo !== undefined && wrap.dataset.lo !== '';
    wrap.hidden = !qmShown || !hasWet;
  });
  quickMixUpdateActive();
}

// ── Wire the Settings checkbox + initial pref on load.
document.addEventListener('DOMContentLoaded', function() {
  qmLoadPref();
  var cb = document.getElementById('qm-show-checkbox');
  if (cb) {
    cb.checked = qmShown;
    cb.addEventListener('change', function() { quickMixSetShown(cb.checked); });
  }
});
