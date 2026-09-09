/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// FX-PANELS.JS — per-effect-panel UI (open/close, render knobs, update
// from hardware, chain-map refresh, drag handling), split out of ui.js
// on 7/27.
//
// WHY THIS FILE EXISTS: ui.js's core (knob-drawing primitives, the tempo
// clock, the chain row, general readouts) doesn't grow as new effect
// panels are added, but this DOES — every DISTINCT model family (WAH, MOD*,
// DELAY, VOL, DIST, REVERB, FX LOOP) adds another open/render/update/
// refresh/drag set here in the same DIST/REVERB shape. Keeping that growth
// in its own file means ui.js stays the size it is today no matter how many
// more panels get built; this file is where they land instead.
// *MOD is a GENERIC HOST SLOT sharing FX1/FX2's model family (see FX-HOST
// ENGINE below) — it does NOT get its own function set.
//
// PATTERN for a genuinely new model family (copy the DIST functions, not
// FX1/FX2/MOD — those three share ONE engine, see the FX-HOST EFFECT PANEL
// section below, and a new generic host slot is a config hook into that
// engine, not a new copy of this pattern). REVERB's typeControl selector
// cell and ms/unit display are still worth copying on top of DIST's
// pattern, for blocks that need them:
//   open<Block>Panel() / close<Block>Panel()
//   render<Block>Knobs(mid)              — build the knob row DOM
//   update<Block>Knob(paramLo, val)      — apply one CMD 0x11 value
//   refresh<Block>PanelAfterChainMap()   — re-sync model + re-query
//   a delegated drag handler keyed on a data-<block>-lo attribute
//   a scroll-wheel branch in ui.js's shared wheel listener (search
//     "SCROLL WHEEL on tone / DIST / REVERB knobs")
//   a branch in rebaselineOpenFxPanel() (ui.js) so save-then-green works
//
// PURE RELOCATION (7/27): every function below is unchanged from its
// original position in ui.js — same logic, same comments, same
// behaviour. Nothing was rewritten. (FX1's functions were later replaced
// by the shared FX-host engine on 2026-08-01 — see that section below;
// this note describes the file's original 7/27 split, not FX1's code today.)
//
// 2026-07-30 — TWO BUGS retrofitted to all five panels that existed at the
// time (DIST/REVERB/WAH/VOL/FX1), both now MANDATORY for any new panel:
//   (1) DRAG-QUEUE RACE. A knob-drag's mousemove handler queues its
//       hardware write through queueKnobSend's throttle (fires up to 60ms
//       later). If the closure passed to queueKnobSend reads the drag's
//       shared paramLo variable directly, a mouseup within that window
//       (which resets the variable to -1) can make the delayed send fire
//       with paramLo=-1 — encoded as byte 0xFF, not a legal 7-bit MIDI data
//       byte, and confirmed to hang the rack when it landed mid-SysEx. FIX:
//       snapshot into a local (`var lo = activeParamLo;`) immediately
//       before the queueKnobSend call in the mousemove handler, and close
//       over that local. See any of the five drag handlers below for the
//       exact shape.
//   (2) THE 9.9 BUG — see fx-transport.js header / sendFxHostParamWrite for
//       the send-side half of this (endpoint sentinels).
// Session Log (2026-07-30, Dyn3 Ratio capture entries) has the full
// incident for (1); do not copy a drag handler from before this date.
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// GENERIC BLOCK MODEL CACHE/BASELINE ENGINE (2026-09-01)
// Generalized from DELAY's own per-model cache/baseline (state.js
// delayModelCache/delayModelBaseline, proven live on DELAY across several
// rounds — see Session Log 2026-09-01) for reuse on any OTHER multi-model
// block. Callers now: DIST, REVERB, WAH, the AMP block, and the FX-host
// engine (FX1/FX2/MOD, via openFxHostSlot) — all wired onto this engine and
// tested live 2026-09-01/03 (Change Log). Built per the "prepare it so it
// doesn't need rework for future blocks" design decision (Session Log
// 2026-09-01, "shared cache/baseline engine" entry) — that entry also
// covers how this stays forward-compatible with
// a possible future named-preset feature (a disk-based source could feed
// blockCacheApply the same way blockCacheSave's in-memory source does).
//
// Same three rules DELAY proved out:
//   - blockCacheSave: snapshot the model being LEFT (whatever it's
//     currently showing, edited or not) before a switch.
//   - blockCacheApply: on return to an already-cached model, push its
//     values to both panel and hardware; returns false if never cached
//     (first visit this patch-load), so the caller falls back to querying
//     hardware's own defaults.
//   - blockBaselineSetIfUnset: the red/green "unchanged" reference, set
//     ONCE per (slot, model) per patch-load and never touched by a
//     switch — only clearBlockModelState (a real patch nav or a Save
//     commit) resets it.
// DELAY is NOT wired through this engine — it keeps its own functions.
// ════════════════════════════════════════════════════════════════════

// cells: flat array of {lo, ...} (a block's *AllCells helper).
// readValueFn(cell) -> current raw v127 or undefined (skipped if so).
function blockCacheSave(slotId, mid, cells, readValueFn) {
  if (!blockModelCache[slotId]) blockModelCache[slotId] = {};
  const snap = {};
  cells.forEach(function(cell) {
    const v = readValueFn(cell);
    if (v !== undefined && !isNaN(v)) snap[cell.lo] = v;
  });
  blockModelCache[slotId][mid] = snap;
}

// applyValueFn(lo, val) — update the panel's own DOM for one paramLo.
// sendWriteFn(lo, val) — push that same value to hardware.
// Returns false (does nothing) if `mid` was never cached for this slot.
function blockCacheApply(slotId, mid, applyValueFn, sendWriteFn) {
  const bucket = blockModelCache[slotId];
  const snap = bucket ? bucket[mid] : undefined;
  if (!snap) return false;
  // Sequence guard (2026-09-02) — see blockCacheApplySeq, state.js. Bump
  // BEFORE scheduling, so a second call for this same slot (a rapid
  // re-switch before this one's stagger finishes) invalidates every one
  // of THIS call's still-pending writes.
  if (!blockCacheApplySeq[slotId]) blockCacheApplySeq[slotId] = 0;
  const mySeq = ++blockCacheApplySeq[slotId];
  Object.keys(snap).forEach(function(loStr, i) {
    const lo = parseInt(loStr, 10);
    const val = snap[loStr];
    setTimeout(function() {
      if (blockCacheApplySeq[slotId] !== mySeq) return;  // superseded
      applyValueFn(lo, val);
      if (bridgeMidiReady) sendWriteFn(lo, val);
    }, i * 20);
  });
  return true;
}

function blockBaselineSetIfUnset(slotId, mid, loHex, val) {
  if (!blockModelBaseline[slotId]) blockModelBaseline[slotId] = {};
  if (!blockModelBaseline[slotId][mid]) blockModelBaseline[slotId][mid] = {};
  if (blockModelBaseline[slotId][mid][loHex] === undefined) {
    blockModelBaseline[slotId][mid][loHex] = val;
  }
  return blockModelBaseline[slotId][mid][loHex];
}

// Clears one slot's (or, with no argument, every slot's) cache/baseline/
// switch-pending state. Called on a real patch nav (any nav path — see
// clearStaleReadoutsOnNav, capture-scan.js) and on an actual Save commit
// (handleBulkTfxData's isSave branch, sysex-handler.js) — same two clear
// points DELAY's own store uses.
function clearBlockModelState(slotId) {
  if (slotId === undefined) {
    blockModelCache = {}; blockModelBaseline = {}; blockModelSwitchPending = {};
    // Bump every slot's apply-sequence rather than just deleting the
    // entries — a blockCacheApply stagger already in flight when a real
    // nav lands must not write its now-stale captured values once the
    // clear above has happened (deleting the key would make a bare
    // undefined !== undefined comparison misbehave; bumping guarantees a
    // mismatch against whatever mySeq any in-flight timeout closed over).
    Object.keys(blockCacheApplySeq).forEach(function(k) { blockCacheApplySeq[k]++; });
    reverbLoadTypeKey = null;
    return;
  }
  delete blockModelCache[slotId];
  delete blockModelBaseline[slotId];
  delete blockModelSwitchPending[slotId];
  if (blockCacheApplySeq[slotId]) blockCacheApplySeq[slotId]++;
  if (slotId === SLOT_REVERB) reverbLoadTypeKey = null;
}

// ════════════════════════════════════════════════════════════════════
// DIST EFFECT PANEL
// ════════════════════════════════════════════════════════════════════

// Flatten a DIST model's rows into a plain cell list (nulls are layout
// spacers, not cells) — same purpose as delayAllCells (DELAY section).
function distAllCells(model) {
  const cells = [];
  model.rows.forEach(function(row) { row.forEach(function(c) { if (c) cells.push(c); }); });
  return cells;
}

// Current raw value of one DIST knob, read straight from its DOM —
// blockCacheSave's readValueFn for DIST.
function distCellReadValue(cell) {
  const w = document.getElementById('dist-w-' + cell.lo.toString(16).padStart(2,'0'));
  return w ? parseInt(w.dataset.value) : undefined;
}

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
  if (sel) { sel.value = String(distBlk.modelId); syncLoadedMarker(sel, 'dist-model-select'); }
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
          + '<div class="knob-wrap" id="dist-w-' + loHex + '" data-value="64" data-base="fx" data-dist-lo="' + loHex + '" data-style="tick">'
          + '<canvas class="knob-canvas" width="70" height="70"></canvas></div>'
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
  const distBlk = currentChain.find(function(b) { return b.slotId === SLOT_DIST; });
  const model = distBlk ? DIST_MODEL_BY_MID[distBlk.modelId] : null;
  const wrap  = document.getElementById('dist-w-' + loHex);
  const valEl = document.getElementById('dist-v-' + loHex);
  if (wrap) {
    // Display the current value; anchor the baseline PER MODEL (blockModelBaseline,
    // generic engine above) so it survives panel close/reopen AND a model
    // switch — first value seen for THIS model this patch becomes its truth.
    wrap.dataset.orig  = model ? blockBaselineSetIfUnset(SLOT_DIST, model.mid, loHex, val) : val;
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
  const model = DIST_MODEL_BY_MID[distBlk.modelId];
  const sel = document.getElementById('dist-model-select');
  if (blockModelSwitchPending[SLOT_DIST]) {
    // This chain-map reply is confirming OUR OWN dropdown-initiated switch
    // (flag set in the change handler, index.html) — same detection DELAY
    // uses and for the same reason: the dropdown already shows the new
    // value, so a sel.value/modelId comparison can't tell this case apart
    // from a genuinely different patch that happens to share a model.
    blockModelSwitchPending[SLOT_DIST] = false;
    if (sel) sel.value = String(distBlk.modelId);
    renderDistKnobs(distBlk.modelId);
    // NO baseline clear here — the red/green reference is per-model
    // (blockModelBaseline) and must survive a switch; only a real patch
    // nav or Save resets it (clearBlockModelState).
    const applied = model && blockCacheApply(SLOT_DIST, model.mid, updateDistKnob,
      function(lo, val) { if (typeof sendDistParamWrite === 'function') sendDistParamWrite(lo, val); });
    if (!applied) setTimeout(requestDistParams, 150);
    appLog('refreshDistPanelAfterChainMap: own switch confirmed, mid=0x'
      + distBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  if (sel && parseInt(sel.value) !== distBlk.modelId) {
    // Dropdown stale for some other reason (e.g. panel opened fresh on a
    // patch whose DIST model differs from whatever the dropdown last
    // showed) — no cache to trust here, just resync to hardware truth.
    sel.value = String(distBlk.modelId);
    syncLoadedMarker(sel, 'dist-model-select');
    renderDistKnobs(distBlk.modelId);
    setTimeout(requestDistParams, 150);
    appLog('refreshDistPanelAfterChainMap: dropdown resync, mid=0x'
      + distBlk.modelId.toString(16).padStart(2,'0'));
    return;
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
    // Snapshot into a local before queuing — the queued send fires up to
    // KNOB_SEND_INTERVAL later, and if mouseup has already reset the shared
    // activeParamLo to -1 by then, a closure over activeParamLo directly
    // sends paramLo=-1 (encodes as byte 0xFF, not a legal 7-bit MIDI data
    // byte, inside a SysEx message — confirmed to wedge the hardware,
    // 2026-07-30, FX1 Ratio knob). lo here is a fresh binding per call, so
    // it can't be touched by a later mouseup.
    var lo = activeParamLo;
    if (bridgeMidiReady) queueKnobSend('dist:' + lo, function(v) { sendDistParamWrite(lo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-dist-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.distLo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
    var loHex = paramLo.toString(16).padStart(2,'0');
    var vEl = document.getElementById('dist-v-' + loHex);
    if (vEl) vEl.textContent = valDisplay(val);
    if (bridgeMidiReady) queueKnobSend('dist:' + paramLo, function(v) { sendDistParamWrite(paramLo, v); }, val);
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

// Flatten a REVERB model into a plain cell list — the Type control (Eleven
// SR only) counts as a cell too, since it has its own knob/paramLo (its
// dropdown is just an alternate way to move that same knob). Generic
// engine's blockCacheSave/blockCacheApply source, same purpose as
// distAllCells (DIST section).
function reverbAllCells(model) {
  const cells = [];
  if (model.typeControl) cells.push({ lo: model.typeControl.lo });
  model.rows.forEach(function(row) { row.forEach(function(c) { if (c) cells.push(c); }); });
  return cells;
}

// Current raw value of one REVERB knob, read straight from its DOM —
// blockCacheSave's readValueFn for REVERB.
function reverbCellReadValue(cell) {
  const w = document.getElementById('reverb-w-' + cell.lo.toString(16).padStart(2,'0'));
  return w ? parseInt(w.dataset.value) : undefined;
}

// ── ELEVEN SR TYPE SUB-CACHE (2026-09-01, Charlie's own follow-up) ──
// The Type control isn't a hardware model change — it's a plain knob
// (paramLo 0x05), so turning it never triggers a CMD 0x21 or a firmware
// default-push the way switching REVERB's outer model (Blackpanel <->
// Eleven SR) does. There's no bug here to fix. But the same engine that
// remembers "what BBD Delay looked like" per model can just as well
// remember "what Cathedral looked like" per Type, by using a RICHER key
// (mid + type index) instead of mid alone — reusing blockCacheSave/
// blockCacheApply/blockBaselineSetIfUnset completely unchanged; only the
// key construction and the Type dropdown's own listener are new.
// reverbSubCells/reverbCellReadValue give the non-Type knobs (Decay/
// Pre-Delay/Tone/Mix) to cache per Type; the Type knob's own value stays
// governed by the OUTER model-level key (reverbAllCells/model.mid,
// unchanged above) since "did Type itself change since load" is a
// model-wide question, not a per-Type one.
function reverbTypeKey(mid, typeIdx) { return mid + '-t' + typeIdx; }

// Every cell EXCEPT the Type control — the sub-cache's own cell list.
function reverbSubCells(model) {
  const cells = [];
  model.rows.forEach(function(row) { row.forEach(function(c) { if (c) cells.push(c); }); });
  return cells;
}

// Which sub-cache key a given paramLo's baseline/cache should use: the
// Type control itself uses the outer model.mid; every other knob uses
// model.mid + the CURRENTLY SELECTED Type index (read straight off the
// Type knob's own live DOM value, so it's always correct even mid-switch —
// see the Type dropdown listener below, which moves that knob BEFORE
// restoring the other knobs from cache).
function reverbBaselineKey(model, paramLo) {
  if (!model.typeControl || paramLo === model.typeControl.lo) return String(model.mid);
  const tw = document.getElementById('reverb-w-' + model.typeControl.lo.toString(16).padStart(2,'0'));
  const idx = tw ? reverbTypeIndexFromV127(parseInt(tw.dataset.value) || 0) : 0;
  return reverbTypeKey(model.mid, idx);
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
  if (sel && model) { sel.value = String(model.mid); syncLoadedMarker(sel, 'reverb-model-select'); }   // base mid identifies the model
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
      + '<div class="knob-wrap" id="reverb-w-' + loHex + '" data-value="64" data-base="fx" data-reverb-lo="' + loHex + '" data-style="tick">'
      + '<canvas class="knob-canvas" width="70" height="70"></canvas></div>'
      + '<select id="reverb-type-select" style="width:112px;margin-top:2px;'
      + 'background:#1a1a1a;color:var(--text);border:1px solid var(--border-dim);'
      + 'border-radius:4px;padding:4px 6px;font-size:12px;">' + opts + '</select>';
    rowDiv.appendChild(cell);
    drawKnob(cell.querySelector('canvas'), 64);
    // Dropdown pick → snap the knob to that zone and send. The sub-cache
    // save/apply/seed sequence now lives INSIDE updateReverbKnob itself
    // (reverbHandleTypeChange, below) so it fires no matter which input
    // method moved the Type value — this listener is just one of several
    // callers now, not the only path (2026-09-01: dragging or scrolling
    // the Type knob directly, which shares the exact same knob-wrap as
    // every other REVERB control, was silently skipping this whole
    // mechanism before — the real cause of Charlie's persistent tick
    // reports, not the sub-cache logic itself, which traced correctly in
    // every log where the dropdown was the only thing used).
    const sel = cell.querySelector('#reverb-type-select');
    // Debounced (2026-09-02, generalized from the Amp Select fix — see
    // queueKnobSend, ui.js) — a held arrow key fires a real 'change'
    // event, and thus a real hardware write PLUS the sub-cache switch
    // machinery (updateReverbKnob -> reverbHandleTypeChange), on every
    // repeat with no throttling. Whole body coalesced so an intermediate
    // Type passed through in under the debounce window never triggers its
    // own sub-cache save/restore either — nothing was actually seen there.
    sel.addEventListener('change', function() {
      const idx = parseInt(this.value, 10);
      if (isNaN(idx)) return;
      queueKnobSend('reverb-type-select', function(idx2) {
        const v127 = REVERB_TYPE_LIST[idx2].v127;
        updateReverbKnob(tc.lo, v127, true);
        if (bridgeMidiReady) sendReverbParamWrite(tc.lo, v127);
      }, idx);
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
      + '<div class="knob-wrap" id="reverb-w-' + loHex + '" data-value="64" data-base="fx" data-reverb-lo="' + loHex + '" data-style="tick">'
      + '<canvas class="knob-canvas" width="70" height="70"></canvas></div>'
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

// Runs the Type sub-cache save/apply/seed sequence — called from
// updateReverbKnob itself (not just the dropdown listener) so it fires no
// matter what moved the Type value. See the SUB-CACHE comment block above
// (reverbTypeKey/reverbSubCells/reverbBaselineKey) for the design; this is
// just the "a switch actually happened" trigger, consolidated to one place
// (2026-09-01 — previously duplicated in the dropdown listener only, which
// meant a drag or scroll-wheel on the Type knob itself silently skipped
// all of it, leaving stale ticks nothing else could explain).
function reverbHandleTypeChange(model, oldIdx, newIdx) {
  appLog('REVERB Type switch: from=' + REVERB_TYPE_LIST[oldIdx].name
    + ' to=' + REVERB_TYPE_LIST[newIdx].name + ' (idx ' + oldIdx + ' -> ' + newIdx + ')');
  if (typeof blockCacheSave === 'function') {
    blockCacheSave(SLOT_REVERB, reverbTypeKey(model.mid, oldIdx), reverbSubCells(model), reverbCellReadValue);
  }
  const newKey = reverbTypeKey(model.mid, newIdx);
  const applied = typeof blockCacheApply === 'function' && blockCacheApply(SLOT_REVERB, newKey, updateReverbKnob,
    function(lo, val) { if (typeof sendReverbParamWrite === 'function') sendReverbParamWrite(lo, val); });
  appLog('REVERB Type switch: key=' + newKey + ' sub-cache ' + (applied ? 'HIT — restoring cached values' : 'MISS — seeding baseline from current screen'));
  if (!applied) {
    // Never visited this Type before. Seed it from the PATCH'S TRUE
    // LOADED state (reverbLoadTypeKey's own baseline) rather than from
    // whatever the Type being LEFT currently shows — Charlie's own call
    // (2026-09-01): every never-visited Type should look identical to how
    // the patch loaded, regardless of edits made to OTHER Types in
    // between, since hardware itself has no independent per-Type memory
    // to fall back on anyway. Falls back to the current screen only if
    // the load state genuinely isn't known yet (shouldn't normally
    // happen — the outer Type reading establishes it before any switch
    // is even possible).
    const loadBaseline = (reverbLoadTypeKey && reverbLoadTypeKey !== newKey
      && blockModelBaseline[SLOT_REVERB]) ? blockModelBaseline[SLOT_REVERB][reverbLoadTypeKey] : null;
    reverbSubCells(model).forEach(function(cell) {
      const cLoHex = cell.lo.toString(16).padStart(2,'0');
      const w = document.getElementById('reverb-w-' + cLoHex);
      if (!w) return;
      let v = (loadBaseline && loadBaseline[cLoHex] !== undefined) ? loadBaseline[cLoHex] : parseInt(w.dataset.value);
      if (isNaN(v)) return;
      w.dataset.orig = blockBaselineSetIfUnset(SLOT_REVERB, newKey, cLoHex, v);
      w.dataset.value = v;
      drawKnob(w.querySelector('canvas'), v);
      if (bridgeMidiReady && typeof sendReverbParamWrite === 'function') sendReverbParamWrite(cell.lo, v);
      appLog('REVERB Type switch: seeded lo=0x' + cLoHex + ' val=' + v + ' as ' + newKey + '\'s baseline'
        + (loadBaseline ? ' (from patch-load state ' + reverbLoadTypeKey + ')' : ' (load state unknown — used current screen)'));
    });
  }
}

// Update a single REVERB control from a broadcast/REQU response or a local
// dropdown pick. For the Type control it also moves the dropdown and shows
// the type name instead of a 0-10 number.
// isInteractive: true ONLY when a real user action (dropdown pick, drag,
// wheel notch) is what moved the Type value — never for a hardware query
// response, a broadcast readback, or blockCacheApply restoring cached
// values. This is what reverbHandleTypeChange gates on (2026-09-01
// regression fix): deriving "did Type change" purely from the DOM's
// before/after value is NOT reliable, because renderReverbKnobs always
// rebuilds the Type knob at a placeholder (64) before any real broadcast
// lands — so the very first real reading (query response) looks
// indistinguishable from a genuine switch, and reopening the panel later
// on an already-known Type hits the exact same trap. Gating on WHO is
// calling, rather than inferring from a snapshot of DOM state, closes
// that gap for good instead of chasing each new race it produces.
function updateReverbKnob(paramLo, val, isInteractive) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const wrap  = document.getElementById('reverb-w-' + loHex);
  const valEl = document.getElementById('reverb-v-' + loHex);
  const model = currentReverbModel();
  const isTypeParam = !!(model && model.typeControl && model.typeControl.lo === paramLo);
  // Capture the Type's PREVIOUS index before we overwrite its DOM value
  // below — needed so reverbHandleTypeChange (called further down) knows
  // what was actually left, regardless of which input method (dropdown,
  // drag, wheel, or a live hardware broadcast) is driving this call.
  const oldTypeIdx = isTypeParam && wrap ? reverbTypeIndexFromV127(parseInt(wrap.dataset.value) || 0) : null;
  if (wrap) {
    // Baseline anchored per model (or per Type, for Eleven SR's non-Type
    // knobs — reverbBaselineKey) — survives panel close/reopen, a model
    // switch, AND a Type switch.
    const baselineKey = model ? reverbBaselineKey(model, paramLo) : null;
    wrap.dataset.orig  = baselineKey ? blockBaselineSetIfUnset(SLOT_REVERB, baselineKey, loHex, val) : val;
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
    // TEMP DIAGNOSTIC (2026-09-01, Charlie's Type-sub-cache tick report) —
    // one line per knob update showing exactly what the tick logic saw:
    // which key it compared against, the stored baseline, the incoming
    // value, and red/green. No MIDI traffic happens when a tick just
    // moves on screen, so this is the only way to see it after the fact —
    // pull the app log right after reproducing it. Remove once the report
    // is resolved (see Session Log "REVERB Type sub-cache" entries).
    if (baselineKey) {
      appLog('REVERB tick: key=' + baselineKey + ' lo=0x' + loHex + ' val=' + val
        + ' orig=' + wrap.dataset.orig + ' -> ' + (parseInt(wrap.dataset.orig) !== val ? 'RED' : 'green'));
    }
  }
  if (isTypeParam) {
    const idx = reverbTypeIndexFromV127(val);
    const sel = document.getElementById('reverb-type-select');
    if (sel) { sel.value = String(idx); syncLoadedMarker(sel, 'reverb-type-select'); }
    if (valEl) valEl.textContent = REVERB_TYPE_LIST[idx].name;
    // The first NON-interactive Type reading this patch-load (a real
    // hardware query response, never a user action) is the patch's true
    // loaded Type — record its sub-cache key once, so a later never-
    // visited Type can seed itself from this exact state instead of
    // whatever the type being left currently shows (reverbHandleTypeChange
    // reads this). Cleared alongside everything else on a real nav/save.
    if (!isInteractive && model && reverbLoadTypeKey === null) {
      reverbLoadTypeKey = reverbTypeKey(model.mid, idx);
    }
    // Run the sub-cache switch machinery whenever the Type genuinely
    // changed — covers the dropdown, a knob drag, a wheel notch, or a
    // live hardware broadcast, all in one place (2026-09-01 fix).
    if (isInteractive && model && oldTypeIdx !== null && oldTypeIdx !== idx) {
      reverbHandleTypeChange(model, oldTypeIdx, idx);
    }
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
  if (blockModelSwitchPending[SLOT_REVERB]) {
    // Confirming OUR OWN dropdown-initiated switch — same detection DIST/
    // DELAY use, for the same reason (the dropdown already shows the new
    // value the instant it's clicked).
    blockModelSwitchPending[SLOT_REVERB] = false;
    if (sel && model) sel.value = String(model.mid);
    renderReverbKnobs(rvBlk.modelId);
    // NO baseline clear — per-model reference must survive a switch.
    const applied = model && blockCacheApply(SLOT_REVERB, model.mid, updateReverbKnob,
      function(lo, val) { if (typeof sendReverbParamWrite === 'function') sendReverbParamWrite(lo, val); });
    if (!applied) setTimeout(requestReverbParams, 150);
    appLog('refreshReverbPanelAfterChainMap: own switch confirmed, mid=0x'
      + rvBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  if (sel && model && parseInt(sel.value) !== model.mid) {
    // Dropdown stale for some other reason — no cache to trust, resync to
    // hardware truth.
    sel.value = String(model.mid);
    syncLoadedMarker(sel, 'reverb-model-select');
    renderReverbKnobs(rvBlk.modelId);
    setTimeout(requestReverbParams, 150);
    appLog('refreshReverbPanelAfterChainMap: dropdown resync, mid=0x'
      + rvBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  setTimeout(requestReverbParams, 150);
  appLog('refreshReverbPanelAfterChainMap: mid=0x' + rvBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + rvBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── REVERB knob drag — delegated, keyed on data-reverb-lo (hex paramLo) ──
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;
  // Set at mousedown ONLY when the grabbed knob is the Type control — the
  // zone it was in before this drag started. A drag across the Type knob's
  // face sweeps through every zone between start and end (confirmed live,
  // 2026-09-01: a ~2s drag crossed 15 zones), and treating each one as a
  // deliberate "switch" auto-seeded them all from whatever the other knobs
  // happened to show mid-sweep — not a real visit to any of them. Only the
  // FINAL settled zone, at mouseup, is a genuine switch.
  var dragStartTypeIdx = null;

  document.addEventListener('mousedown', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-reverb-lo]');
    if (!wrap) return;
    activeParamLo = parseInt(wrap.dataset.reverbLo, 16);
    if (isNaN(activeParamLo)) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    var model = typeof currentReverbModel === 'function' ? currentReverbModel() : null;
    dragStartTypeIdx = (model && model.typeControl && model.typeControl.lo === activeParamLo)
      ? reverbTypeIndexFromV127(startVal) : null;
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }  // released outside the window
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    updateReverbKnob(activeParamLo, val);   // NOT interactive mid-drag — see dragStartTypeIdx above
    // Snapshot before queuing — see the DIST handler above for why (a
    // closure over the shared activeParamLo can fire after mouseup resets
    // it to -1, sending a malformed paramLo byte).
    var lo = activeParamLo;
    if (bridgeMidiReady) queueKnobSend('reverb:' + lo, function(v) { sendReverbParamWrite(lo, v); }, val);
  });

  function endReverbDrag() {
    if (dragStartTypeIdx !== null && activeWrap) {
      var model = typeof currentReverbModel === 'function' ? currentReverbModel() : null;
      var curIdx = reverbTypeIndexFromV127(parseInt(activeWrap.dataset.value) || 0);
      if (model && curIdx !== dragStartTypeIdx && typeof reverbHandleTypeChange === 'function') {
        reverbHandleTypeChange(model, dragStartTypeIdx, curIdx);
      }
    }
    dragging = false; activeWrap = null; activeParamLo = -1; dragStartTypeIdx = null;
  }
  window.addEventListener('mouseup', endReverbDrag);
  window.addEventListener('blur', endReverbDrag);

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-reverb-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.reverbLo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    updateReverbKnob(paramLo, val, true);
    if (bridgeMidiReady) queueKnobSend('reverb:' + paramLo, function(v) { sendReverbParamWrite(paramLo, v); }, val);
  });
})();

// ════════════════════════════════════════════════════════════════════
// WAH EFFECT PANEL
// ════════════════════════════════════════════════════════════════════

function openWahPanel() {
  wahPanelOpen = true;
  const wahBlk = currentChain.find(b => b.slotId === SLOT_WAH);
  if (!wahBlk) {
    document.getElementById('wah-knob-row').innerHTML =
      '<div style="color:var(--muted);padding:8px;">Chain map not yet received — navigate to a patch first.</div>';
    appLog('openWahPanel: no WAH block in chain map yet');
    return;
  }
  const sel = document.getElementById('wah-model-select');
  if (sel) { sel.value = String(wahBlk.modelId); syncLoadedMarker(sel, 'wah-model-select'); }
  renderWahKnobs(wahBlk.modelId);
  requestWahParams();
  appLog('openWahPanel: mid=0x' + wahBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + wahBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

function closeWahPanel() {
  wahPanelOpen = false;
}

function renderWahKnobs(mid) {
  const container = document.getElementById('wah-knob-row');
  if (!container) return;
  const model = WAH_MODEL_BY_MID[mid];
  if (!model) {
    container.innerHTML = '<div style="color:var(--muted);padding:8px;">Unknown model</div>';
    return;
  }
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:inline-flex;flex-direction:column;gap:14px;'
    + 'padding:12px 14px;background:#1e1e1e;border-radius:6px;border:1px solid #555;';

  model.rows.forEach(function(rowCells) {
    const rowDiv = document.createElement('div');
    rowDiv.style.cssText = 'display:flex;gap:18px;align-items:flex-start;';

    rowCells.forEach(function(cell) {
      if (!cell) {
        const sp = document.createElement('div');
        sp.style.cssText = 'width:80px;flex-shrink:0;';
        rowDiv.appendChild(sp);
      } else {
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const knobDiv = document.createElement('div');
        knobDiv.className = 'ctrl-knob';
        knobDiv.innerHTML =
          '<label>' + cell.label + '</label>'
          + '<div class="knob-wrap" id="wah-w-' + loHex + '" data-value="64" data-base="fx" data-wah-lo="' + loHex + '" data-style="tick">'
          + '<canvas class="knob-canvas" width="70" height="70"></canvas></div>'
          + '<span class="knob-val" id="wah-v-' + loHex + '">--</span>';
        rowDiv.appendChild(knobDiv);
        drawKnob(knobDiv.querySelector('canvas'), 64);
      }
    });

    wrapper.appendChild(rowDiv);
  });

  container.appendChild(wrapper);
}

// Flatten a WAH model's rows into a plain cell list — same purpose as
// distAllCells (DIST section).
function wahAllCells(model) {
  const cells = [];
  model.rows.forEach(function(row) { row.forEach(function(c) { if (c) cells.push(c); }); });
  return cells;
}

// Current raw value of one WAH knob, read straight from its DOM —
// blockCacheSave's readValueFn for WAH.
function wahCellReadValue(cell) {
  const w = document.getElementById('wah-w-' + cell.lo.toString(16).padStart(2,'0'));
  return w ? parseInt(w.dataset.value) : undefined;
}

function updateWahKnob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const wahBlk = currentChain.find(function(b) { return b.slotId === SLOT_WAH; });
  const model = wahBlk ? WAH_MODEL_BY_MID[wahBlk.modelId] : null;
  const wrap  = document.getElementById('wah-w-' + loHex);
  const valEl = document.getElementById('wah-v-' + loHex);
  if (wrap) {
    wrap.dataset.orig  = model ? blockBaselineSetIfUnset(SLOT_WAH, model.mid, loHex, val) : val;
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
  }
  if (valEl) valEl.textContent = valDisplay(val);
}

function refreshWahPanelAfterChainMap() {
  if (!wahPanelOpen) return;
  const wahBlk = currentChain.find(b => b.slotId === SLOT_WAH);
  if (!wahBlk) return;
  const model = WAH_MODEL_BY_MID[wahBlk.modelId];
  const sel = document.getElementById('wah-model-select');
  if (blockModelSwitchPending[SLOT_WAH]) {
    blockModelSwitchPending[SLOT_WAH] = false;
    if (sel) sel.value = String(wahBlk.modelId);
    renderWahKnobs(wahBlk.modelId);
    const applied = model && blockCacheApply(SLOT_WAH, model.mid, updateWahKnob,
      function(lo, val) { if (typeof sendWahParamWrite === 'function') sendWahParamWrite(lo, val); });
    if (!applied) setTimeout(requestWahParams, 150);
    appLog('refreshWahPanelAfterChainMap: own switch confirmed, mid=0x'
      + wahBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  if (sel && parseInt(sel.value) !== wahBlk.modelId) {
    sel.value = String(wahBlk.modelId);
    syncLoadedMarker(sel, 'wah-model-select');
    renderWahKnobs(wahBlk.modelId);
    setTimeout(requestWahParams, 150);
    appLog('refreshWahPanelAfterChainMap: dropdown resync, mid=0x'
      + wahBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  setTimeout(requestWahParams, 150);
  appLog('refreshWahPanelAfterChainMap: mid=0x' + wahBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + wahBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── WAH knob drag — delegated, keyed on data-wah-lo ──
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;

  document.addEventListener('mousedown', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-wah-lo]');
    if (!wrap) return;
    activeParamLo = parseInt(wrap.dataset.wahLo, 16);
    if (isNaN(activeParamLo)) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    updateWahKnob(activeParamLo, val);
    // Snapshot before queuing — see the DIST handler above for why.
    var lo = activeParamLo;
    if (bridgeMidiReady) queueKnobSend('wah:' + lo, function(v) { sendWahParamWrite(lo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-wah-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.wahLo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    updateWahKnob(paramLo, val);
    if (bridgeMidiReady) queueKnobSend('wah:' + paramLo, function(v) { sendWahParamWrite(paramLo, v); }, val);
  });
})();

// ════════════════════════════════════════════════════════════════════
// VOL EFFECT PANEL
// Single user-facing model (Volume Pedal); firmware picks mono/stereo.
// No model dropdown — the knob row is rendered once on open.
// ════════════════════════════════════════════════════════════════════

function openVolPanel() {
  volPanelOpen = true;
  const volBlk = currentChain.find(b => b.slotId === SLOT_VOL);
  if (!volBlk) {
    document.getElementById('vol-knob-row').innerHTML =
      '<div style="color:var(--muted);padding:8px;">Chain map not yet received — navigate to a patch first.</div>';
    appLog('openVolPanel: no VOL block in chain map yet');
    return;
  }
  renderVolKnobs(volBlk.modelId);
  requestVolParams();
  appLog('openVolPanel: mid=0x' + volBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + volBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

function closeVolPanel() {
  volPanelOpen = false;
}

function renderVolKnobs(mid) {
  const container = document.getElementById('vol-knob-row');
  if (!container) return;
  const model = VOL_MODEL_BY_MID[mid];
  if (!model) {
    container.innerHTML = '<div style="color:var(--muted);padding:8px;">Unknown model</div>';
    return;
  }
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:inline-flex;flex-direction:column;gap:14px;'
    + 'padding:12px 14px;background:#1e1e1e;border-radius:6px;border:1px solid #555;';

  model.rows.forEach(function(rowCells) {
    const rowDiv = document.createElement('div');
    rowDiv.style.cssText = 'display:flex;gap:18px;align-items:flex-start;';

    rowCells.forEach(function(cell) {
      if (!cell) {
        const sp = document.createElement('div');
        sp.style.cssText = 'width:80px;flex-shrink:0;';
        rowDiv.appendChild(sp);
      } else if (cell.toggle) {
        // Binary toggle cell (e.g. Taper: Linear/Log).
        // val=0 → options[0] (Linear), val≠0 → options[1] (Log).
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const tglDiv = document.createElement('div');
        tglDiv.className = 'ctrl-knob';
        tglDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
        const lbl = document.createElement('label');
        lbl.textContent = cell.label;
        const btn = document.createElement('button');
        btn.id = 'vol-tgl-' + loHex;
        btn.dataset.value = '0';
        btn.dataset.base = 'fx';
        btn.style.cssText = 'min-width:70px;padding:6px 10px;background:#2a2a2a;'
          + 'border:1px solid #666;border-radius:4px;color:var(--fg);cursor:pointer;font-size:12px;';
        btn.textContent = cell.options[0];
        btn.addEventListener('mouseover', function() { this.style.borderColor = '#aaa'; });
        btn.addEventListener('mouseout',  function() { this.style.borderColor = '#666'; });
        btn.addEventListener('click', function() {
          var cur = parseInt(btn.dataset.value) || 0;
          var newVal = (cur === 0) ? 127 : 0;
          updateVolKnob(cell.lo, newVal);
          if (typeof sendVolParamWrite === 'function') sendVolParamWrite(cell.lo, newVal);
        });
        tglDiv.appendChild(lbl);
        tglDiv.appendChild(btn);
        rowDiv.appendChild(tglDiv);
      } else {
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const knobDiv = document.createElement('div');
        knobDiv.className = 'ctrl-knob';
        knobDiv.innerHTML =
          '<label>' + cell.label + '</label>'
          + '<div class="knob-wrap" id="vol-w-' + loHex + '" data-value="64" data-base="fx" data-vol-lo="' + loHex + '" data-style="tick">'
          + '<canvas class="knob-canvas" width="70" height="70"></canvas></div>'
          + '<span class="knob-val" id="vol-v-' + loHex + '">--</span>';
        rowDiv.appendChild(knobDiv);
        drawKnob(knobDiv.querySelector('canvas'), 64);
      }
    });

    wrapper.appendChild(rowDiv);
  });

  container.appendChild(wrapper);
}

function updateVolKnob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  // Check if this paramLo is a toggle cell
  const volModel = VOL_MODEL_BY_MID[currentChain.find ? (currentChain.find(function(b) { return b.slotId === SLOT_VOL; }) || {}).modelId : undefined];
  var isToggle = false;
  var toggleOptions = ['Linear','Log'];
  if (volModel) {
    volModel.rows.forEach(function(row) {
      row.forEach(function(cell) {
        if (cell && cell.lo === paramLo && cell.toggle) {
          isToggle = true;
          if (cell.options) toggleOptions = cell.options;
        }
      });
    });
  }
  if (isToggle) {
    const btn = document.getElementById('vol-tgl-' + loHex);
    if (btn) {
      btn.dataset.orig  = fxBaselineSetIfUnset(SLOT_VOL, loHex, val);
      btn.dataset.value = val;
      btn.textContent   = (val === 0) ? toggleOptions[0] : toggleOptions[1];
    }
    return;
  }
  const wrap  = document.getElementById('vol-w-' + loHex);
  const valEl = document.getElementById('vol-v-' + loHex);
  if (wrap) {
    wrap.dataset.orig  = fxBaselineSetIfUnset(SLOT_VOL, loHex, val);
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
  }
  if (valEl) valEl.textContent = valDisplay(val);
}

function refreshVolPanelAfterChainMap() {
  if (!volPanelOpen) return;
  const volBlk = currentChain.find(b => b.slotId === SLOT_VOL);
  if (!volBlk) return;
  setTimeout(requestVolParams, 150);
  appLog('refreshVolPanelAfterChainMap: mid=0x' + volBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + volBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── VOL knob drag — delegated, keyed on data-vol-lo ──
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;

  document.addEventListener('mousedown', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-vol-lo]');
    if (!wrap) return;
    activeParamLo = parseInt(wrap.dataset.volLo, 16);
    if (isNaN(activeParamLo)) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    updateVolKnob(activeParamLo, val);
    // Snapshot before queuing — see the DIST handler above for why.
    var lo = activeParamLo;
    if (bridgeMidiReady) queueKnobSend('vol:' + lo, function(v) { sendVolParamWrite(lo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-vol-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.volLo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    updateVolKnob(paramLo, val);
    if (bridgeMidiReady) queueKnobSend('vol:' + paramLo, function(v) { sendVolParamWrite(paramLo, v); }, val);
  });
})();

// ════════════════════════════════════════════════════════════════════
// FX LOOP EFFECT PANEL
// Single user-facing model (Send/Return/Mix); firmware picks one of 7
// routing-variant mids from chain context. No model dropdown.
// ════════════════════════════════════════════════════════════════════

function openFxLoopPanel() {
  fxLoopPanelOpen = true;
  const loopBlk = currentChain.find(b => b.slotId === SLOT_LOOP);
  if (!loopBlk) {
    document.getElementById('fxloop-knob-row').innerHTML =
      '<div style="color:var(--muted);padding:8px;">Chain map not yet received — navigate to a patch first.</div>';
    appLog('openFxLoopPanel: no FX LOOP block in chain map yet');
    return;
  }
  renderFxLoopKnobs(loopBlk.modelId);
  requestFxLoopParams();
  // Reflect the global routing already read on connect (CMD 0x3C); if it hasn't
  // been read yet, setFxLoopRoutingDisplay(-1) is a no-op and the connect
  // reply/broadcast will populate it when it lands.
  if (typeof setFxLoopRoutingDisplay === 'function') setFxLoopRoutingDisplay(fxLoopRouting);
  if (typeof setOutputModeDisplay === 'function') setOutputModeDisplay(outputMode);
  appLog('openFxLoopPanel: mid=0x' + loopBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + loopBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

function closeFxLoopPanel() {
  fxLoopPanelOpen = false;
}

function renderFxLoopKnobs(mid) {
  const container = document.getElementById('fxloop-knob-row');
  if (!container) return;
  const model = FXLOOP_MODEL_BY_MID[mid];
  if (!model) {
    container.innerHTML = '<div style="color:var(--muted);padding:8px;">Unknown model</div>';
    return;
  }
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:inline-flex;flex-direction:column;gap:14px;'
    + 'padding:12px 14px;background:#1e1e1e;border-radius:6px;border:1px solid #555;';

  model.rows.forEach(function(rowCells) {
    const rowDiv = document.createElement('div');
    rowDiv.style.cssText = 'display:flex;gap:18px;align-items:flex-start;';

    rowCells.forEach(function(cell) {
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
        + '<div class="knob-wrap" id="fxloop-w-' + loHex + '" data-value="64" data-base="fx" data-fxloop-lo="' + loHex + '" data-style="tick">'
        + '<canvas class="knob-canvas" width="70" height="70"></canvas></div>'
        + '<span class="knob-val" id="fxloop-v-' + loHex + '">--</span>';
      rowDiv.appendChild(knobDiv);
      drawKnob(knobDiv.querySelector('canvas'), 64);
    });

    wrapper.appendChild(rowDiv);
  });

  container.appendChild(wrapper);
}

// Display string for a FX LOOP knob value — Send/Return are -12..+12 dB
// (same two-slope-anchored-at-64 shape as valToAmpVol, without the To
// Amp-specific "MUTE" override at 0), Mix is a plain 0-100% linear scale.
// Both anchor exactly at both true endpoints (Sec 20A R1/R5) — confirmed
// by the Wireshark sweep capture 2026-08-02 (Charlie confirmed Mix's
// capture-start readout was 0%, pinning it to the linear reading rather
// than the dB centre-anchored one, despite sharing the identical wire
// pattern with Send/Return).
function fxLoopKnobDisplay(paramLo, val) {
  const model = FXLOOP_MODELS[0];
  for (let r = 0; r < model.rows.length; r++) {
    const row = model.rows[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || cell.lo !== paramLo) continue;
      if (cell.display === 'loopDb') {
        const db = (val < 64) ? (val - 64) * (12 / 64) : (val - 64) * (12 / 63);
        const t = db.toFixed(1);
        return (parseFloat(t) > 0 ? '+' : '') + t + ' dB';
      }
      if (cell.display === 'loopPct') {
        return (val / 127 * 100).toFixed(0) + '%';
      }
    }
  }
  return valDisplay(val);
}

function updateFxLoopKnob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const wrap  = document.getElementById('fxloop-w-' + loHex);
  const valEl = document.getElementById('fxloop-v-' + loHex);
  if (wrap) {
    wrap.dataset.orig  = fxBaselineSetIfUnset(SLOT_LOOP, loHex, val);
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
  }
  if (valEl) valEl.textContent = fxLoopKnobDisplay(paramLo, val);
}

function refreshFxLoopPanelAfterChainMap() {
  if (!fxLoopPanelOpen) return;
  const loopBlk = currentChain.find(b => b.slotId === SLOT_LOOP);
  if (!loopBlk) return;
  setTimeout(requestFxLoopParams, 150);
  appLog('refreshFxLoopPanelAfterChainMap: mid=0x' + loopBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + loopBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── FX LOOP knob drag — delegated, keyed on data-fxloop-lo ──
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;

  document.addEventListener('mousedown', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-fxloop-lo]');
    if (!wrap) return;
    activeParamLo = parseInt(wrap.dataset.fxloopLo, 16);
    if (isNaN(activeParamLo)) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    updateFxLoopKnob(activeParamLo, val);
    // Snapshot before queuing — R6, drag-queue race (Sec 20A).
    var lo = activeParamLo;
    if (bridgeMidiReady) queueKnobSend('fxloop:' + lo, function(v) { sendFxLoopParamWrite(lo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-fxloop-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.fxloopLo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    updateFxLoopKnob(paramLo, val);
    if (bridgeMidiReady) queueKnobSend('fxloop:' + paramLo, function(v) { sendFxLoopParamWrite(paramLo, v); }, val);
  });
})();

// ════════════════════════════════════════════════════════════════════
// DELAY EFFECT PANEL
// Single user-facing model (BBD Delay); firmware picks mono/stereo.
// No model dropdown. Denser than the other panels (9 controls: 5 knobs,
// 3 toggles, 1 wide-encoded Sync selector) — laid out as two rows rather
// than one flat knob row, same general idea (not the literal shape) as
// MultiChorus's grouped/boxed layout referenced when planning this panel.
// ════════════════════════════════════════════════════════════════════

function openDelayPanel() {
  delayPanelOpen = true;
  const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
  if (!delayBlk) {
    document.getElementById('delay-knob-row').innerHTML =
      '<div style="color:var(--muted);padding:8px;">Chain map not yet received — navigate to a patch first.</div>';
    appLog('openDelayPanel: no DELAY block in chain map yet');
    return;
  }
  const model = DELAY_MODEL_BY_MID[delayBlk.modelId];
  const sel = document.getElementById('delay-model-select');
  if (sel && model) { sel.value = String(model.mid); syncLoadedMarker(sel, 'delay-model-select'); }   // base mid identifies the model
  renderDelayKnobs(delayBlk.modelId);
  // Buffered (2026-09-03) — nothing to preserve on a fresh open (blank is
  // fine, matches FX-host's openFxHostPanel), but the incoming values
  // should still land in one flush instead of trickling in one at a time.
  if (model && model.captured) {
    delayPaintDeferred = true; delayPendingPaints = [];
    delayArrivalGate = makeArrivalGate(model.paramLos, 1500, flushDelayPaint);
  }
  requestDelayParams();
  appLog('openDelayPanel: mid=0x' + delayBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + delayBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

function closeDelayPanel() {
  delayPanelOpen = false;
}

// Flatten a DELAY model's rows into a plain cell list, walking both box
// entries ({group?, rows:[[cells],...]}) and plain top-level flat rows —
// same shape/purpose as fxHostAllCells above, ported here because DELAY
// keeps its own render/update functions rather than sharing the FX-host
// engine (Primer: DELAY/FX LOOP are distinct model families, not generic
// host slots). Added for Dyn Delay's grouped/boxed layout (2026-08-02);
// BBD Delay's flat-only rows still work unchanged (entry.rows is just
// absent, falls through to the `[entry]` branch).
function delayAllCells(model) {
  const cells = [];
  model.rows.forEach(function(entry) {
    const rows = entry.rows ? entry.rows : [entry];
    rows.forEach(function(row) { row.forEach(function(c) { if (c) cells.push(c); }); });
  });
  return cells;
}

// Render one DELAY cell (knob/toggle/delaySync/select/spacer) into rowDiv.
// Extracted so both a flat row and a group box's sub-rows share one path.
function renderDelayCell(cell, rowDiv) {
  if (!cell) {
    const sp = document.createElement('div');
    sp.style.cssText = 'width:80px;flex-shrink:0;';
    rowDiv.appendChild(sp);
    return;
  }
  if (cell.toggle) {
    const loHex = cell.lo.toString(16).padStart(2,'0');
    const tglDiv = document.createElement('div');
    tglDiv.className = 'ctrl-knob';
    tglDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
    const lbl = document.createElement('label');
    lbl.textContent = cell.label;
    const btn = document.createElement('button');
    btn.id = 'delay-tgl-' + loHex;
    btn.dataset.value = '0';
    btn.dataset.base = 'fx';
    btn.style.cssText = 'min-width:70px;padding:6px 10px;background:#2a2a2a;'
      + 'border:1px solid #666;border-radius:4px;color:var(--fg);cursor:pointer;font-size:12px;';
    btn.textContent = cell.options[0];
    btn.addEventListener('mouseover', function() { this.style.borderColor = '#aaa'; });
    btn.addEventListener('mouseout',  function() { this.style.borderColor = '#666'; });
    btn.addEventListener('click', function() {
      var cur = parseInt(btn.dataset.value) || 0;
      var newVal = (cur === 0) ? 127 : 0;
      updateDelayKnob(cell.lo, newVal);
      if (typeof sendDelayParamWrite === 'function') sendDelayParamWrite(cell.lo, newVal);
    });
    tglDiv.appendChild(lbl);
    tglDiv.appendChild(btn);
    rowDiv.appendChild(tglDiv);
  } else if (cell.delaySync) {
    // Sync — plain named-position dropdown, no paired knob. Standard
    // v127 Sync mechanism (SYNC_DIVISIONS / syncIndexFromV127 /
    // syncV127FromIndex), same as amp Tremolo and FX1 C1 Chorus —
    // NOT a special encoding (retracted 2026-08-02, see protocol.js).
    const syDiv = document.createElement('div');
    syDiv.className = 'ctrl-knob';
    syDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
    const lbl = document.createElement('label');
    lbl.textContent = cell.label;
    let opts = '';
    SYNC_DIVISIONS.forEach(function(z, i) { opts += '<option value="' + i + '">' + z.text + '</option>'; });
    syDiv.appendChild(lbl);
    const sel = document.createElement('select');
    sel.id = 'delay-sync-select';
    sel.style.cssText = 'width:112px;background:#1a1a1a;color:var(--text);'
      + 'border:1px solid var(--border-dim);border-radius:4px;padding:4px 6px;font-size:12px;';
    sel.innerHTML = opts;
    // Debounced (2026-09-02, generalized from the Amp Select fix — see
    // queueKnobSend, ui.js) — a held arrow key fires a real 'change'
    // event, and thus a real hardware write, on every repeat with no
    // throttling.
    sel.addEventListener('change', function() {
      const idx = parseInt(this.value, 10);
      if (isNaN(idx)) return;
      queueKnobSend('delay-sync-select', function(idx2) {
        const v127 = syncV127FromIndex(idx2);
        updateDelaySync(v127);
        if (bridgeMidiReady && typeof sendDelayParamWrite === 'function') sendDelayParamWrite(0x05, v127);
      }, idx);
    });
    syDiv.appendChild(sel);
    rowDiv.appendChild(syDiv);
  } else if (cell.select) {
    // Generic named-position dropdown (Dyn Delay's Feedback Mode —
    // 4-way, no tempo relationship, so cell.select not cell.delaySync).
    // Nearest-match on readback, same as FX-host's cell.select.
    const loHex = cell.lo.toString(16).padStart(2,'0');
    const selDiv = document.createElement('div');
    selDiv.className = 'ctrl-knob';
    selDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
    const lbl = document.createElement('label');
    lbl.textContent = cell.label;
    const sel = document.createElement('select');
    sel.id = 'delay-sel-' + loHex;
    sel.style.cssText = 'width:112px;background:#1a1a1a;color:var(--text);'
      + 'border:1px solid var(--border-dim);border-radius:4px;padding:4px 6px;font-size:12px;';
    cell.options.forEach(function(opt, i) {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = opt.label;
      sel.appendChild(o);
    });
    // Debounced (2026-09-02, generalized from the Amp Select fix — see
    // queueKnobSend, ui.js) — a held arrow key fires a real 'change'
    // event, and thus a real hardware write, on every repeat with no
    // throttling.
    sel.addEventListener('change', function() {
      const idx = parseInt(this.value, 10);
      if (isNaN(idx) || !cell.options[idx]) return;
      queueKnobSend('delay-sel-' + loHex, function(idx2) {
        const v127 = cell.options[idx2].v127;
        updateDelayKnob(cell.lo, v127);
        if (bridgeMidiReady && typeof sendDelayParamWrite === 'function') sendDelayParamWrite(cell.lo, v127);
      }, idx);
    });
    selDiv.appendChild(lbl);
    selDiv.appendChild(sel);
    rowDiv.appendChild(selDiv);
  } else {
    const loHex = cell.lo.toString(16).padStart(2,'0');
    const knobDiv = document.createElement('div');
    knobDiv.className = 'ctrl-knob';
    knobDiv.innerHTML =
      '<label>' + cell.label + '</label>'
      + '<div class="knob-wrap" id="delay-w-' + loHex + '" data-value="64" data-base="fx" data-delay-lo="' + loHex + '" data-tol="1" data-style="tick">'
      + '<canvas class="knob-canvas" width="70" height="70"></canvas></div>'
      + '<span class="knob-val" id="delay-v-' + loHex + '">--</span>';
    rowDiv.appendChild(knobDiv);
    drawKnob(knobDiv.querySelector('canvas'), 64);
  }
}

function renderDelayRow(rowCells, parentEl) {
  const rowDiv = document.createElement('div');
  rowDiv.style.cssText = 'display:flex;gap:18px;align-items:flex-start;';
  rowCells.forEach(function(cell) { renderDelayCell(cell, rowDiv); });
  parentEl.appendChild(rowDiv);
}

// ── DELAY panel paint buffering + no-blank model-change swap (2026-09-03)
// — same mechanism as the FX-host engine above (see its header comment for
// the full rationale), a separate copy because DELAY is its own hand-
// rolled panel (predates the FX-host engine, deliberately left as-is when
// the shared engine was built — Charlie's own repeated call at the time:
// "they work, leave where they are"). Now that the SAME class of bug
// turned up here too — Charlie's report: a brief "--" on value text
// within the same Delay model, and (once the mechanism below is in place)
// the same off-DOM build for an actual Delay model switch (BBD <-> Dyn
// Delay <-> EP Tape Echo) — it gets the identical fix, adapted to two
// real differences from the FX-host engine:
//   - requestDelayParams (fx-transport.js) sends its whole query burst
//     UNPACED (no await between sends), so "the send loop finished" is NOT
//     a usable "replies have landed" signal the way FX-host's paced,
//     awaited burst was. makeArrivalGate below tracks actual arrivals
//     instead (or a timeout, if one is ever dropped).
//   - applyDelayModelCache restores its cached values on staggered
//     setTimeouts (i*20ms apart) rather than one synchronous loop, so it
//     has the same "sent, but not yet landed" gap even though it's all
//     local data with no real hardware round-trip.
var delayPaintDeferred = false;
var delayPendingPaints = [];
function deferDelayPaintOrRun(fn) {
  if (delayPaintDeferred) { delayPendingPaints.push(fn); return; }
  fn();
}
function flushDelayPaint() {
  delayPaintDeferred = false;
  var paints = delayPendingPaints;
  delayPendingPaints = [];
  paints.forEach(function(fn) { fn(); });
}

// Fires onDone once every paramLo in `los` has been reported via the
// returned gate's markSeen(lo), or after timeoutMs — whichever comes
// first. The timeout is a safety net (a dropped reply, or a paramLo this
// build didn't actually end up touching), not the normal path.
// makeArrivalGate moved to ui.js (2026-09-03, main-nav-pull follow-up) so
// transport.js/sysex-handler.js can share the exact same implementation
// instead of a second copy — loaded before this file, see index.html's
// script order.

var delayPendingBuild = null;   // { seq, cellsByLo, model } while a model-change build is in flight
var delayBuildSeq = 0;
var delayArrivalGate = null;    // active gate for whichever paint (staged or live) is currently pending

// Builds a complete DELAY knob row for `mid` into a DETACHED
// DocumentFragment — mirrors buildFxHostPanel above (see its comment).
// Untouched cell-building code (renderDelayRow/renderDelayCell) — only the
// container changed from the live element to a fragment.
function buildDelayPanel(mid) {
  const model = DELAY_MODEL_BY_MID[mid];
  const frag = document.createDocumentFragment();
  if (!model) {
    const div = document.createElement('div');
    div.style.cssText = 'color:var(--muted);padding:8px;';
    div.textContent = 'Unknown model';
    frag.appendChild(div);
    return { frag: frag, model: null, cellsByLo: {} };
  }
  if (!model.captured) {
    const div = document.createElement('div');
    div.style.cssText = 'color:var(--muted);padding:8px;';
    div.textContent = model.name + ' — paramLo layout not yet captured.';
    frag.appendChild(div);
    return { frag: frag, model: model, cellsByLo: {} };
  }
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;gap:18px;align-items:flex-start;'
    + 'padding:12px 20px;background:#1e1e1e;border-radius:6px;border:1px solid #555;';
  model.rows.forEach(function(entry) {
    if (entry && entry.rows) {
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;gap:10px;'
        + 'padding:10px 12px;background:#242424;border-radius:5px;border:1px solid #444;';
      if (entry.group) {
        const hdr = document.createElement('div');
        hdr.textContent = entry.group;
        hdr.style.cssText = 'font-size:11px;color:var(--label);text-transform:uppercase;'
          + 'letter-spacing:0.5px;font-weight:bold;';
        box.appendChild(hdr);
      }
      entry.rows.forEach(function(rowCells) { renderDelayRow(rowCells, box); });
      wrapper.appendChild(box);
    } else {
      const col = document.createElement('div');
      col.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
      renderDelayRow(entry, col);
      wrapper.appendChild(col);
    }
  });
  frag.appendChild(wrapper);
  return { frag: frag, model: model, cellsByLo: collectDelayCellRefs(frag, model) };
}

// Same idea as collectFxHostCellRefs — querySelector works on a detached
// fragment, getElementById doesn't. Sync is a single fixed id (Delay has
// exactly one Sync control per model, unlike FX-host's per-paramLo ones).
function collectDelayCellRefs(root, model) {
  const map = {};
  if (!model) return map;
  delayAllCells(model).forEach(function(cell) {
    const loHex = cell.lo.toString(16).padStart(2,'0');
    if (cell.delaySync)   map[cell.lo] = { kind: 'sync',   el: root.querySelector('#delay-sync-select') };
    else if (cell.select) map[cell.lo] = { kind: 'select', el: root.querySelector('#delay-sel-' + loHex) };
    else if (cell.toggle) map[cell.lo] = { kind: 'toggle', el: root.querySelector('#delay-tgl-' + loHex) };
    else map[cell.lo] = {
      kind: 'knob',
      wrap: root.querySelector('#delay-w-' + loHex),
      valEl: root.querySelector('#delay-v-' + loHex)
    };
  });
  return map;
}

// Same per-kind paint logic as updateDelayKnob/updateDelaySync's live
// branches, written against already-resolved refs — see
// paintFxHostCellIntoRefs above for why. affectedByToggle re-render
// (Expanded Delay rescaling the Delay knob) is handled here too so a
// staged build ends up in the exact same state a live update would.
function paintDelayCellIntoRefs(cellsByLo, cell, model, loHex, val) {
  const entry = cellsByLo[cell.lo];
  if (!entry) return;
  if (entry.kind === 'toggle') {
    if (entry.el) {
      const toggleOptions = cell.options || ['Off','On'];
      entry.el.dataset.orig  = model ? delayBaselineSetIfUnset(model.mid, loHex, val) : val;
      entry.el.dataset.value = val;
      entry.el.textContent   = (val === 0) ? toggleOptions[0] : toggleOptions[1];
    }
    if (model && model.rows) {
      delayAllCells(model).forEach(function(c) {
        if (c.affectedByToggle === cell.lo && !c.toggle && !c.select && !c.delaySync) {
          const dEntry = cellsByLo[c.lo];
          if (dEntry && dEntry.wrap && dEntry.valEl) {
            dEntry.valEl.textContent = delayKnobDisplay(c.lo, parseInt(dEntry.wrap.dataset.value) || 0);
          }
        }
      });
    }
    return;
  }
  if (entry.kind === 'select') {
    if (entry.el) {
      let bestIdx = 0, bestDist = Infinity;
      cell.options.forEach(function(opt, i) {
        const d = Math.abs(opt.v127 - val);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      entry.el.value = String(bestIdx);
      syncLoadedMarker(entry.el, 'delay-sel-' + loHex + ':' + (model ? model.mid : ''));
    }
    return;
  }
  if (entry.kind === 'sync') {
    if (entry.el) {
      const idx = syncIndexFromV127(val);
      entry.el.value = String(idx);
      syncLoadedMarker(entry.el, 'delay-sync-select');
    }
    return;
  }
  if (entry.wrap) {
    entry.wrap.dataset.orig  = model ? delayBaselineSetIfUnset(model.mid, loHex, val) : val;
    entry.wrap.dataset.value = val;
    drawKnob(entry.wrap.querySelector('canvas'), val);
  }
  if (entry.valEl) entry.valEl.textContent = delayKnobDisplay(cell.lo, val);
}

// Live entry point — builds and attaches in one step. Used by openDelayPanel
// (nothing to preserve, the panel is opening fresh either way).
function renderDelayKnobs(mid) {
  const container = document.getElementById('delay-knob-row');
  if (!container) return;
  const built = buildDelayPanel(mid);
  container.innerHTML = '';
  container.appendChild(built.frag);
}

// Attaches an already-built, already-populated fragment in one shot — old
// panel fully visible right up until this call, new one fully visible
// immediately after.
function swapInDelayPanel(frag) {
  const container = document.getElementById('delay-knob-row');
  if (!container) return;
  container.innerHTML = '';
  container.appendChild(frag);
}

// Display string for a DELAY knob value. cell.display can be a function
// (one per knob, its own real formula) or BBD Delay's remaining legacy
// string flag ('delayTen' — its own Delay knob moved to a function,
// 2026-08-27, to be Expanded Delay-toggle-aware like EP Tape Echo's).
function delayKnobDisplay(paramLo, val) {
  const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
  const model = delayBlk ? DELAY_MODEL_BY_MID[delayBlk.modelId] : null;
  if (!model || !model.rows) return valDisplay(val);
  const cells = delayAllCells(model);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.lo !== paramLo) continue;
    if (typeof cell.display === 'function') return cell.display(val);
    if (cell.display === 'delayTen') return (val / 127 * 10).toFixed(1);
  }
  return valDisplay(val);
}

function updateDelayKnob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const model = DELAY_MODEL_BY_MID[(currentChain.find(function(b) { return b.slotId === SLOT_DELAY; }) || {}).modelId];
  let cell = null;
  if (model && model.rows) {
    delayAllCells(model).forEach(function(c) { if (c.lo === paramLo) cell = c; });
  }

  // No-blank model-change swap (2026-09-03) — while a replacement panel is
  // being built off-DOM, redirect its own paramLos to it instead of the
  // live (soon to be replaced) panel. See the delayPendingBuild header
  // comment above (buildDelayPanel) for the full mechanism.
  if (delayPendingBuild && cell) {
    paintDelayCellIntoRefs(delayPendingBuild.cellsByLo, cell, delayPendingBuild.model, loHex, val);
    if (delayArrivalGate) delayArrivalGate.markSeen(paramLo);
    return;
  }

  if (cell && cell.toggle) {
    const btn = document.getElementById('delay-tgl-' + loHex);
    if (btn) {
      const toggleOptions = cell.options || ['Off','On'];
      btn.dataset.orig  = model ? delayBaselineSetIfUnset(model.mid, loHex, val) : val;
      btn.dataset.value = val;
      deferDelayPaintOrRun(function() { btn.textContent = (val === 0) ? toggleOptions[0] : toggleOptions[1]; });
    }
    // Re-render any knob whose display formula depends on THIS toggle
    // (Expanded Delay rescaling the Delay knob's ms range, 2026-08-27) —
    // the knob's own raw value hasn't moved, but what it MEANS has, so
    // its readout needs refreshing even without a drag.
    if (model && model.rows) {
      delayAllCells(model).forEach(function(c) {
        if (c.affectedByToggle === paramLo && !c.toggle && !c.select && !c.delaySync) {
          const dLoHex = c.lo.toString(16).padStart(2,'0');
          const dWrap  = document.getElementById('delay-w-' + dLoHex);
          const dValEl = document.getElementById('delay-v-' + dLoHex);
          if (dWrap && dValEl) {
            deferDelayPaintOrRun(function() {
              dValEl.textContent = delayKnobDisplay(c.lo, parseInt(dWrap.dataset.value) || 0);
            });
          }
        }
      });
    }
    if (delayArrivalGate) delayArrivalGate.markSeen(paramLo);
    return;
  }
  if (cell && cell.select) {
    // Nearest-match, same as FX-host's cell.select — an unexpected raw
    // value still lands on the closest labeled option.
    const sel = document.getElementById('delay-sel-' + loHex);
    if (sel) {
      let bestIdx = 0, bestDist = Infinity;
      cell.options.forEach(function(opt, i) {
        const d = Math.abs(opt.v127 - val);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      deferDelayPaintOrRun(function() {
        sel.value = String(bestIdx);
        syncLoadedMarker(sel, 'delay-sel-' + loHex + ':' + (model ? model.mid : ''));
      });
    }
    if (delayArrivalGate) delayArrivalGate.markSeen(paramLo);
    return;
  }
  const wrap  = document.getElementById('delay-w-' + loHex);
  const valEl = document.getElementById('delay-v-' + loHex);
  if (wrap) {
    wrap.dataset.orig  = model ? delayBaselineSetIfUnset(model.mid, loHex, val) : val;
    wrap.dataset.value = val;
    // drawKnob's own self-guard only knows about the MAIN nav buffer
    // (navPaintDeferred, ui.js) — this panel's buffer is a separate flag,
    // so the canvas paint needs its own explicit defer here too, not just
    // the value text below.
    deferDelayPaintOrRun(function() { drawKnob(wrap.querySelector('canvas'), val); });
  }
  if (valEl) deferDelayPaintOrRun(function() { valEl.textContent = delayKnobDisplay(paramLo, val); });
  if (delayArrivalGate) delayArrivalGate.markSeen(paramLo);
}

// Sync isn't a knob — just move the dropdown. No baseline/red-state
// tracking (R3) for it: it's a discrete selector, not a continuous value
// that can drift from a loaded patch by a small amount.
// Takes a v127 value (0-127), same as every other Sync readout in the
// app (ui.js's updateSyncReadout) — NOT a zone index. Quantises locally
// via the standard syncIndexFromV127. No baseline/red-state tracking
// (R3): it's a discrete selector, not a continuous value that can drift
// from a loaded patch by a small amount.
function updateDelaySync(val) {
  // Same no-blank-swap redirect as updateDelayKnob above — Sync is always
  // paramLo 0x05 (the fixed convention applyDelayModelCache etc. already
  // use for it).
  if (delayPendingBuild) {
    let syncCell = null;
    if (delayPendingBuild.model && delayPendingBuild.model.rows) {
      delayAllCells(delayPendingBuild.model).forEach(function(c) { if (c.delaySync) syncCell = c; });
    }
    if (syncCell) paintDelayCellIntoRefs(delayPendingBuild.cellsByLo, syncCell, delayPendingBuild.model, '05', val);
    if (delayArrivalGate) delayArrivalGate.markSeen(0x05);
    return;
  }
  const sel = document.getElementById('delay-sync-select');
  if (!sel) return;
  const idx = syncIndexFromV127(val);
  deferDelayPaintOrRun(function() {
    sel.value = String(idx);
    // Flat key, no model in it — SYNC_DIVISIONS is the same 14-zone list
    // regardless of which DELAY model is open, so there's no cross-model
    // meaning collision the way there is for delay-sel's Feedback Mode.
    syncLoadedMarker(sel, 'delay-sync-select');
  });
  if (delayArrivalGate) delayArrivalGate.markSeen(0x05);
}

// Snapshot every current paramLo value for `mid` (a DELAY model's base
// mid) into delayModelCache, from whatever the panel is showing right now
// — user-edited or still hardware's own defaults, doesn't matter, it's
// "what this model looked like when we left it". Call BEFORE switching the
// Model dropdown away from it.
function saveDelayModelCache(mid) {
  const model = DELAY_MODEL_BY_MID[mid];
  if (!model || !model.rows) return;
  const snap = {};
  delayAllCells(model).forEach(function(cell) {
    const loHex = cell.lo.toString(16).padStart(2,'0');
    let val;
    if (cell.toggle) {
      const btn = document.getElementById('delay-tgl-' + loHex);
      val = btn ? (parseInt(btn.dataset.value) || 0) : undefined;
    } else if (cell.delaySync) {
      const sel = document.getElementById('delay-sync-select');
      val = sel ? syncV127FromIndex(parseInt(sel.value) || 0) : undefined;
    } else if (cell.select) {
      const sel = document.getElementById('delay-sel-' + loHex);
      const opt = sel ? cell.options[parseInt(sel.value)] : null;
      val = opt ? opt.v127 : undefined;
    } else {
      const wrap = document.getElementById('delay-w-' + loHex);
      val = wrap ? parseInt(wrap.dataset.value) : undefined;
    }
    if (val !== undefined && !isNaN(val)) snap[cell.lo] = val;
  });
  delayModelCache[mid] = snap;
}

// Restore a cached model's values onto both the panel and the live
// hardware block (auditioning a cached model means the rack must actually
// carry those values, not just the screen). Returns false if nothing was
// ever cached for `mid` (first visit this patch), so the caller falls back
// to querying hardware's own defaults.
function applyDelayModelCache(mid) {
  const snap = delayModelCache[mid];
  if (!snap) return false;
  Object.keys(snap).forEach(function(loStr, i) {
    const lo = parseInt(loStr, 10);
    const val = snap[loStr];
    setTimeout(function() {
      if (lo === 0x05) { if (typeof updateDelaySync === 'function') updateDelaySync(val); }
      else if (typeof updateDelayKnob === 'function') updateDelayKnob(lo, val);
      if (bridgeMidiReady && typeof sendDelayParamWrite === 'function') sendDelayParamWrite(lo, val);
    }, i * 20);
  });
  appLog('applyDelayModelCache: restored ' + Object.keys(snap).length + ' params for mid=0x'
    + mid.toString(16).padStart(2,'0'));
  return true;
}

function clearDelayModelCache() { delayModelCache = {}; }

// Read-or-establish a per-model baseline value — mirrors fxBaselineSetIfUnset
// (ui.js) but keyed by (model mid, paramLo) instead of just (slotId,
// paramLo), since DELAY needs one fixed reference PER MODEL, not one for
// the whole slot that a model switch is allowed to disturb.
function delayBaselineSetIfUnset(mid, loHex, val) {
  if (!delayModelBaseline[mid]) delayModelBaseline[mid] = {};
  if (delayModelBaseline[mid][loHex] === undefined) delayModelBaseline[mid][loHex] = val;
  return delayModelBaseline[mid][loHex];
}

function clearDelayModelBaseline() { delayModelBaseline = {}; }

function refreshDelayPanelAfterChainMap() {
  if (!delayPanelOpen) return;
  const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
  if (!delayBlk) return;
  const model = DELAY_MODEL_BY_MID[delayBlk.modelId];
  const sel = document.getElementById('delay-model-select');
  if (delayModelSwitchPending) {
    // This chain-map reply is confirming OUR OWN dropdown-initiated switch
    // (flag set in the change handler, index.html). The dropdown already
    // shows the new value, so a sel.value/model.mid comparison can't detect
    // this case — the flag is the only reliable signal.
    delayModelSwitchPending = false;
    if (sel && model) sel.value = String(model.mid);
    // No-blank swap (2026-09-03) — build the replacement panel off-DOM and
    // populate it (cache-apply, or a live query burst if nothing cached)
    // while the OLD one stays fully visible; swap only once populated. See
    // the delayPendingBuild header comment (buildDelayPanel) above.
    const dseq1 = ++delayBuildSeq;
    const dbuilt1 = buildDelayPanel(delayBlk.modelId);
    delayPendingBuild = { seq: dseq1, cellsByLo: dbuilt1.cellsByLo, model: dbuilt1.model };
    // NO baseline clear here (removed 2026-09-01) — the red/green reference
    // is per-model (delayModelBaseline) and must survive a switch; only a
    // real patch nav or Save resets it. See state.js for the full rationale.
    // delayPendingBuild stays assigned to THIS build (dseq1) from here on,
    // whichever path below populates it — never reassigned or nulled out
    // in between, so a NEWER refresh (superseding this one before it
    // finishes) can safely overwrite it and this one's own eventual
    // completion callback (checking .seq === dseq1) correctly no-ops
    // instead of clobbering the newer build.
    const cacheSnap = delayModelCache[model.mid];
    if (cacheSnap && Object.keys(cacheSnap).length) {
      delayArrivalGate = makeArrivalGate(Object.keys(cacheSnap).map(Number), 1000, function() {
        if (delayPendingBuild && delayPendingBuild.seq === dseq1) {
          delayPendingBuild = null;
          delayArrivalGate = null;
          swapInDelayPanel(dbuilt1.frag);
        }
      });
      applyDelayModelCache(model.mid);
    } else {
      setTimeout(function() {
        if (!(delayPendingBuild && delayPendingBuild.seq === dseq1)) return;   // superseded during the 150ms wait
        delayArrivalGate = makeArrivalGate(model.paramLos, 1500, function() {
          if (delayPendingBuild && delayPendingBuild.seq === dseq1) {
            delayPendingBuild = null;
            delayArrivalGate = null;
            swapInDelayPanel(dbuilt1.frag);
          }
        });
        requestDelayParams();
      }, 150);
    }
    appLog('refreshDelayPanelAfterChainMap: own switch confirmed, mid=0x'
      + delayBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  if (sel && model && parseInt(sel.value) !== model.mid) {
    // Dropdown stale for some other reason (e.g. panel opened fresh on a
    // patch whose Delay model differs from whatever the dropdown last
    // showed) — no cache to trust here, just resync to hardware truth. THE
    // common path for an ordinary patch nav landing on a different Delay
    // model — same no-blank staged build+swap as above, always via the
    // query burst (never a cache hit here).
    sel.value = String(model.mid);
    syncLoadedMarker(sel, 'delay-model-select');
    const dseq2 = ++delayBuildSeq;
    const dbuilt2 = buildDelayPanel(delayBlk.modelId);
    delayPendingBuild = { seq: dseq2, cellsByLo: dbuilt2.cellsByLo, model: dbuilt2.model };
    setTimeout(function() {
      delayArrivalGate = makeArrivalGate(model.paramLos, 1500, function() {
        if (delayPendingBuild && delayPendingBuild.seq === dseq2) {
          delayPendingBuild = null;
          delayArrivalGate = null;
          swapInDelayPanel(dbuilt2.frag);
        }
      });
      requestDelayParams();
    }, 150);
    appLog('refreshDelayPanelAfterChainMap: dropdown resync, mid=0x'
      + delayBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  // Plain same-model refresh — no DOM rebuild, just buffer the incoming
  // values into one flush instead of trickling (2026-09-03) — this is the
  // "brief -- on the value text" Charlie reported within the same Delay
  // model.
  setTimeout(function() {
    if (model && model.captured) {
      delayPaintDeferred = true; delayPendingPaints = [];
      delayArrivalGate = makeArrivalGate(model.paramLos, 1500, flushDelayPaint);
    }
    requestDelayParams();
  }, 150);
  appLog('refreshDelayPanelAfterChainMap: mid=0x' + delayBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + delayBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── DELAY knob drag — delegated, keyed on data-delay-lo ──
// R7 — Delay (lo 0x04) is Sync-driven, same family as amp Tremolo Speed
// and DELAY's own Sync (paramLo 0x05) overwriting it. CORRECTED
// 2026-08-02 (live test): a local-only UI clear is NOT enough — same as
// Speed, the rack refuses a Delay write while Sync is on a division
// unless we EXPLICITLY send the Sync-off write first (sendDelayParamWrite
// (0x05, 0)), then the knob's own value. The earlier build only mirrored
// OFF in the dropdown without sending anything, which is why the knob
// looked cleared but the hardware never actually moved ("knob not free").
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;
  var delaySyncClearedThisDrag = false;

  function clearDelaySyncIfNeeded() {
    if (delaySyncClearedThisDrag) return;
    delaySyncClearedThisDrag = true;
    var sel = document.getElementById('delay-sync-select');
    if (sel && sel.value !== '0') {
      if (typeof updateDelaySync === 'function') updateDelaySync(0);
      if (bridgeMidiReady && typeof sendDelayParamWrite === 'function') {
        sendDelayParamWrite(0x05, 0);
        appLog('Delay moved while Sync was engaged — clearing Sync to OFF first (the rack refuses the write otherwise)');
      }
    }
  }

  document.addEventListener('mousedown', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-delay-lo]');
    if (!wrap) return;
    activeParamLo = parseInt(wrap.dataset.delayLo, 16);
    if (isNaN(activeParamLo)) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    delaySyncClearedThisDrag = false;   // one Sync clear per drag, not per mousemove
    delayDragLo = activeParamLo;        // guard — see state.js; skip broadcast repaints of this paramLo until mouseup
    if (activeParamLo === 0x04) clearDelaySyncIfNeeded();
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; delayDragLo = -1; return; }
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    updateDelayKnob(activeParamLo, val);
    // Snapshot before queuing — R6, drag-queue race (Sec 20A).
    var lo = activeParamLo;
    if (bridgeMidiReady) queueKnobSend('delay:' + lo, function(v) { sendDelayParamWrite(lo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; delayDragLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; delayDragLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-delay-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.delayLo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    updateDelayKnob(paramLo, val);
    if (paramLo === 0x04) {
      delaySyncClearedThisDrag = false;
      clearDelaySyncIfNeeded();
    }
    if (bridgeMidiReady) queueKnobSend('delay:' + paramLo, function(v) { sendDelayParamWrite(paramLo, v); }, val);
  });
})();

// ════════════════════════════════════════════════════════════════════
// FX-HOST EFFECT PANEL — shared engine, parameterized by slot id
// (2026-08-01 refactor; see Primer Status line + Session Log 2026-08-01
// "REFACTOR FIRST"). FX1 was the first GENERIC HOST SLOT built (the model
// dropdown lists every mid seen in the hardware's own dropdown, but only
// models with captured===true — see FX1_MODELS, protocol.js — have real
// paramLos/rows; the rest render a "not yet captured" placeholder). FX2 is
// confirmed to host the identical model family, and MOD hosts 6 of the 10 —
// rather than copy-pasting this whole panel per slot (which is exactly what
// happened to DIST/REVERB/WAH/VOL/FX1 and tripled two bug fixes on
// 2026-07-30), every function below is parameterized by slotId and keys off
// the single openFxHostSlot state var (state.js) instead of a hardcoded
// SLOT_FX1/fx1PanelOpen. Only one FX-host slot is ever open at a time, so
// they all share ONE physical panel (#panel-fxhost, index.html) and ONE set
// of control ids — no per-slot DOM prefix needed, the previous slot's
// controls are torn down before the next slot's are rendered.
// A future FX2/MOD caller's ENTIRE hook into this engine is: (1) a
// chain-open dispatch branch (index.html) calling openFxHostPanel(SLOT_FX2)
// / openFxHostPanel(SLOT_MOD), and (2) for MOD, a FX_HOST_ALLOWED_MIDS entry
// (protocol.js) filtering the model dropdown to its known subset. No new
// render/update/drag/query/send functions, no new DOM.
// Cell kinds beyond knob (DIST's only kind): toggle (VOL Taper pattern),
// sync (reuses SYNC_DIVISIONS / syncIndexFromV127 / syncV127FromIndex, the
// SAME 14-zone table the amp Tremolo Sync uses, just at this model's own
// paramLo instead of 0x12 and against the open slot's own handle instead of
// currentParamHi), slider, select, bandColor — see renderFxHostCell.
// Knob IDs: fxhost-w-{loHex} / fxhost-v-{loHex}, keyed by paramLo.
// ════════════════════════════════════════════════════════════════════

// Resolve the currently-open FX-host slot's model from the chain map.
// slotId defaults to openFxHostSlot so existing single-arg call sites (drag/
// dblclick handlers, update-from-hardware) don't need to thread it through.
function currentFxHostModel(slotId) {
  if (slotId === undefined) slotId = openFxHostSlot;
  if (slotId === null) return null;
  const blk = currentChain.find(b => b.slotId === slotId);
  if (!blk) return null;
  return FX1_MODEL_BY_MID[blk.modelId] || null;
}

// Build the model dropdown for the given slot, filtered per
// FX_HOST_ALLOWED_MIDS (protocol.js) — null/absent entry means unfiltered
// (FX1's own behaviour today). Order matches FX1_MODELS array order, same
// as the dropdown this replaces.
function populateFxHostModelSelect(slotId) {
  const sel = document.getElementById('fxhost-model-select');
  if (!sel) return;
  const allowed = FX_HOST_ALLOWED_MIDS[slotId];
  sel.innerHTML = '';
  FX1_MODELS.forEach(function(m) {
    if (allowed && allowed.indexOf(m.mid) === -1) return;
    const opt = document.createElement('option');
    opt.value = String(m.mid);
    opt.textContent = m.name;
    sel.appendChild(opt);
  });
}

function openFxHostPanel(slotId) {
  openFxHostSlot = slotId;
  const titleEl = document.getElementById('fxhost-title');
  if (titleEl) titleEl.textContent = SLOT_ID_TO_NAME[slotId] || 'FX';
  populateFxHostModelSelect(slotId);
  const blk = currentChain.find(b => b.slotId === slotId);
  if (!blk) {
    document.getElementById('fxhost-knob-row').innerHTML =
      '<div style="color:var(--muted);padding:8px;">Chain map not yet received — navigate to a patch first.</div>';
    appLog('openFxHostPanel: no block in chain map yet for slot=0x' + slotId.toString(16).padStart(2,'0'));
    return;
  }
  // Resolve through the model, not the raw wire mid — a model can report a
  // different mid depending on mono/stereo chain state (see FX1_MODELS
  // header, protocol.js), and the dropdown only has ONE option per model.
  const sel = document.getElementById('fxhost-model-select');
  const openModel = FX1_MODEL_BY_MID[blk.modelId];
  // Keyed per slotId, not just the dropdown id — FX1/FX2/MOD share this one
  // <select>, so each slot needs its own "loaded" reference.
  if (sel && openModel) { sel.value = String(openModel.mid); syncLoadedMarker(sel, 'fxhost-model-select:' + slotId); }
  renderFxHostKnobs(blk.modelId);
  // Buffered (2026-09-03) — nothing to preserve on a fresh open (blank is
  // fine), but incoming values should land in one flush, tracked by actual
  // arrival rather than "the send loop finished" (see makeArrivalGate).
  if (openModel && openModel.captured) {
    fxHostPaintDeferred = true; fxHostPendingPaints = [];
    fxHostArrivalGate = makeArrivalGate(openModel.paramLos, 1500, flushFxHostPaint);
  }
  requestFxHostParams(slotId);
  appLog('openFxHostPanel: slot=0x' + slotId.toString(16).padStart(2,'0')
    + ' mid=0x' + blk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + blk.handle.toString(16).padStart(2,'0').toUpperCase());
}

function closeFxHostPanel() {
  openFxHostSlot = null;
  // Drop any in-flight no-blank build for the panel being closed — nothing
  // wrong with letting it finish and swap into a closed panel (harmless,
  // just wasted), but no reason to let it either. bumping fxHostBuildSeq
  // means even if a pending completion callback is still waiting, its seq
  // check will fail.
  fxHostPendingBuild = null;
  fxHostArrivalGate = null;
  fxHostBuildSeq++;
}

// ── GROUPED LAYOUT (added 2026-07-31 for MultiChorus/Dynamic-Delay-shaped
// models) — Avid boxes some FX1 models' controls into labeled sub-panels
// (e.g. MultiChorus's CHORUS box holding Low Cut/Width, MOD box holding Pre
// Delay/Waveform) rather than one flat knob row. A row entry in a model's
// `rows` array can now be EITHER the original flat form — an array of cells
// — OR a box object `{group:'CHORUS'?, rows:[[cells...], ...]}` (label
// optional — an unlabeled box still stacks its rows, e.g. MultiChorus's
// Rate-above-Depth column), rendered as its own bordered sub-box nested
// inside the panel's outer wrapper. Existing flat-row models (DIST/REVERB/
// WAH/VOL/C1 Chorus/Dyn3/
// Flanger/Graphic EQ/Gray Compressor) are untouched — a plain array is still
// exactly what it always was. Deliberately NOT replicating Avid's tiny
// rotary-switch controls (Waveform Tri/Sine, Feedback Mode Mono/Stereo/
// Cross/Pong) pixel-for-pixel — Tri/Sine is a 2-state cell.toggle (same
// shape as C1 Chorus's Mode), anything with 3+ named positions is the new
// cell.select (a plain dropdown, same spirit as cell.sync but for an
// arbitrary named-position control instead of the Sync/tempo table).

// Flatten every real cell (skipping spacers) across a model's rows,
// INCLUDING cells nested inside group entries. Used by lookups that don't
// care about layout (update-from-hardware, the R7 Sync-interlock helpers) —
// keeps them working unchanged for grouped models with no per-caller edits.
function fxHostAllCells(model) {
  const cells = [];
  model.rows.forEach(function(entry) {
    const rows = entry.rows ? entry.rows : [entry];
    rows.forEach(function(row) { row.forEach(function(c) { if (c) cells.push(c); }); });
  });
  return cells;
}

// Current raw v127 of one FX-host cell, read straight from its DOM —
// blockCacheSave's readValueFn for FX1/FX2/MOD. Branches by cell kind the
// same way updateFxHostKnob does when WRITING a value, so cache/apply stay
// symmetric: sync/select dropdowns store an option index, not a raw value,
// so they're converted back through the same tables used to render them.
function fxHostCellReadValue(cell) {
  const loHex = cell.lo.toString(16).padStart(2,'0');
  if (cell.sync) {
    const sel = document.getElementById('fxhost-sync-' + loHex);
    return sel ? syncV127FromIndex(parseInt(sel.value, 10)) : undefined;
  }
  if (cell.select) {
    const sel = document.getElementById('fxhost-sel-' + loHex);
    const idx = sel ? parseInt(sel.value, 10) : NaN;
    return (!isNaN(idx) && cell.options[idx]) ? cell.options[idx].v127 : undefined;
  }
  if (cell.toggle) {
    const btn = document.getElementById('fxhost-tgl-' + loHex);
    return btn ? parseInt(btn.dataset.value) : undefined;
  }
  const w = document.getElementById('fxhost-w-' + loHex);
  return w ? parseInt(w.dataset.value) : undefined;
}

// Render one cell (knob/toggle/sync/slider/select/spacer) into rowDiv.
// Extracted from renderFxHostKnobs so both a flat row and a group's sub-rows
// call the exact same cell logic — no duplication between the two layouts.
function renderFxHostCell(cell, rowDiv) {
      if (!cell) {
        const sp = document.createElement('div');
        sp.style.cssText = 'width:80px;flex-shrink:0;';
        rowDiv.appendChild(sp);
      } else if (cell.select) {
        // Generic named-position dropdown (added for MultiChorus/Dynamic
        // Delay-shaped models) — same spirit as cell.sync but for an
        // arbitrary small option list instead of the Sync/tempo table.
        // cell.options: [{label, v127}, ...]. Nearest-match on readback so
        // an unexpected raw value still lands on the closest labeled
        // position rather than showing nothing selected.
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const selDiv = document.createElement('div');
        // fxhost-select overrides .ctrl-knob's fixed 88px width — the 118px
        // dropdown otherwise overflows its own container and pokes past
        // the group box border (found on Parametric EQ, 2026-07-31 — same
        // overlap-avoidance class of bug as .eq-slider/.h-slider before).
        selDiv.className = 'ctrl-knob fxhost-select';
        selDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
        const lbl = document.createElement('label');
        lbl.textContent = cell.label;
        const sel = document.createElement('select');
        sel.id = 'fxhost-sel-' + loHex;
        sel.dataset.fxhostLo = loHex;
        sel.style.cssText = 'width:118px;background:#1a1a1a;color:var(--text);'
          + 'border:1px solid var(--border-dim);border-radius:4px;padding:4px 6px;font-size:12px;';
        cell.options.forEach(function(opt, i) {
          const o = document.createElement('option');
          o.value = String(i);
          o.textContent = opt.label;
          sel.appendChild(o);
        });
        // Debounced (2026-09-02, generalized from the Amp Select fix —
        // see queueKnobSend, ui.js) — a held arrow key fires a real
        // 'change' event, and thus a real hardware write, on every
        // repeat with no throttling.
        sel.addEventListener('change', function() {
          const idx = parseInt(this.value, 10);
          if (isNaN(idx) || !cell.options[idx]) return;
          queueKnobSend('fxhost-sel:' + openFxHostSlot + ':' + loHex, function(idx2) {
            const v127 = cell.options[idx2].v127;
            updateFxHostKnob(cell.lo, v127);
            if (bridgeMidiReady) sendFxHostParamWrite(openFxHostSlot, cell.lo, v127);
          }, idx);
        });
        // cell.wrapCycle (Parametric EQ, 7/31/2026 — trial run, Charlie's
        // idea) — a native <select> already cycles on Up/Down arrow while
        // focused, but stops at the ends. This wraps instead (Down on the
        // last option jumps to the first, and vice versa). Opt-in per cell
        // rather than a global dropdown change: Charlie wants to try it on
        // this one panel first before deciding whether to retrofit it to
        // every cell.select/cell.sync dropdown in a later, separate pass.
        if (cell.wrapCycle) {
          sel.addEventListener('keydown', function(e) {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const n = cell.options.length;
            const idx = parseInt(sel.value, 10);
            if (isNaN(idx)) return;
            const next = (e.key === 'ArrowDown') ? (idx + 1) % n : (idx - 1 + n) % n;
            e.preventDefault();
            sel.value = String(next);
            sel.dispatchEvent(new Event('change'));
          });
        }
        selDiv.appendChild(lbl);
        selDiv.appendChild(sel);
        rowDiv.appendChild(selDiv);
      } else if (cell.sync) {
        // Sync selector — dropdown only, no knob (matches the amp Tremolo
        // Sync control, not the REVERB Type knob+dropdown composite).
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const syDiv = document.createElement('div');
        syDiv.className = 'ctrl-knob';
        syDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
        const lbl = document.createElement('label');
        lbl.textContent = cell.label;
        const sel = document.createElement('select');
        sel.id = 'fxhost-sync-' + loHex;
        sel.dataset.fxhostLo = loHex;
        sel.style.cssText = 'width:118px;background:#1a1a1a;color:var(--text);'
          + 'border:1px solid var(--border-dim);border-radius:4px;padding:4px 6px;font-size:12px;';
        SYNC_DIVISIONS.forEach(function(d, i) {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = (i === 0) ? 'OFF' : (d.glyph + '   ' + d.text);
          sel.appendChild(opt);
        });
        // Debounced (2026-09-02, generalized from the Amp Select fix —
        // see queueKnobSend, ui.js) — a held arrow key fires a real
        // 'change' event, and thus a real hardware write, on every
        // repeat with no throttling.
        sel.addEventListener('change', function() {
          const idx = parseInt(this.value, 10);
          if (isNaN(idx)) return;
          queueKnobSend('fxhost-sync:' + openFxHostSlot + ':' + loHex, function(idx2) {
            const v127 = syncV127FromIndex(idx2);
            updateFxHostKnob(cell.lo, v127);
            if (bridgeMidiReady) sendFxHostParamWrite(openFxHostSlot, cell.lo, v127);
          }, idx);
        });
        syDiv.appendChild(lbl);
        syDiv.appendChild(sel);
        rowDiv.appendChild(syDiv);
      } else if (cell.toggle) {
        // Binary toggle cell — same shape as VOL's Taper toggle.
        // val=0 -> options[0], val!=0 -> options[1].
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const tglDiv = document.createElement('div');
        tglDiv.className = 'ctrl-knob';
        tglDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
        const lbl = document.createElement('label');
        lbl.textContent = cell.label;
        const btn = document.createElement('button');
        btn.id = 'fxhost-tgl-' + loHex;
        btn.dataset.value = '0';
        btn.dataset.base = 'fx';
        btn.style.cssText = 'min-width:70px;padding:6px 10px;background:#2a2a2a;'
          + 'border:1px solid #666;border-radius:4px;color:var(--fg);cursor:pointer;font-size:12px;';
        btn.textContent = cell.options[0];
        btn.addEventListener('mouseover', function() { this.style.borderColor = '#aaa'; });
        btn.addEventListener('mouseout',  function() { this.style.borderColor = '#666'; });
        btn.addEventListener('click', function() {
          const cur = parseInt(btn.dataset.value) || 0;
          const newVal = (cur === 0) ? 127 : 0;
          updateFxHostKnob(cell.lo, newVal);
          if (bridgeMidiReady) sendFxHostParamWrite(openFxHostSlot, cell.lo, newVal);
        });
        tglDiv.appendChild(lbl);
        tglDiv.appendChild(btn);
        rowDiv.appendChild(tglDiv);
      } else if (cell.slider) {
        // Vertical fader cell (Graphic EQ) — same .knob-wrap/data-fxhost-lo
        // contract as a knob (the generic FX-host drag/dblclick/scroll
        // handlers below key off that, not the widget shape), just drawn as
        // a vertical groove+thumb with printed calibration numbers
        // (drawEqSlider, ui.js) instead of a rotary arc, with its own base
        // colour (yellow, not FX green). Canvas 74x173 — enlarged ~1/3 and
        // widened for the two tick columns per Charlie's 7/31 request.
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const sliderDiv = document.createElement('div');
        // eq-slider (index.html) overrides the round-knob-sized .ctrl-knob/
        // .knob-wrap boxes to match this control's much taller canvas —
        // see that rule's comment for the overlap bug this fixes.
        sliderDiv.className = 'ctrl-knob eq-slider';
        sliderDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;';
        sliderDiv.innerHTML =
          '<label>' + cell.label + '</label>'
          + '<div class="knob-wrap" id="fxhost-w-' + loHex + '" data-value="64" data-base="eq" data-fxhost-lo="' + loHex + '">'
          + '<canvas class="knob-canvas" width="74" height="173"></canvas></div>'
          + '<span class="knob-val" id="fxhost-v-' + loHex + '">--</span>';
        rowDiv.appendChild(sliderDiv);
        const sWrap = sliderDiv.querySelector('.knob-wrap');
        drawEqSlider(sWrap.querySelector('canvas'), 64, sWrap, cell.min, cell.max, cell.ticks, cell.linear);
      } else {
        // cell.bandColor (Parametric EQ, 7/31/2026) — a fixed per-band
        // pointer accent instead of the usual amber/green base, matching
        // Avid's own LF/LMF/HMF/HF colour coding. Moved onto the tick
        // engine 2026-09-03 along with every other plain knob — no more
        // red-on-change substitute needed on the value readout (that only
        // existed because the old ring engine's red-on-change would have
        // collided with the LF/OUT bands' own red accent; the tick engine
        // has no colour-by-state at all, so the collision is moot).
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const knobDiv = document.createElement('div');
        knobDiv.className = 'ctrl-knob';
        knobDiv.innerHTML =
          '<label>' + cell.label + '</label>'
          + '<div class="knob-wrap" id="fxhost-w-' + loHex + '" data-value="64" data-base="fx" data-fxhost-lo="' + loHex + '" data-style="tick"'
          + (cell.bandColor ? ' data-band-color="' + cell.bandColor + '"' : '') + '>'
          + '<canvas class="knob-canvas" width="70" height="70"></canvas></div>'
          + '<span class="knob-val" id="fxhost-v-' + loHex + '">--</span>';
        rowDiv.appendChild(knobDiv);
        drawKnob(knobDiv.querySelector('canvas'), 64);
      }
}

// Build one flat row (an array of cells) into parentEl.
function renderFxHostRow(rowCells, parentEl) {
  const rowDiv = document.createElement('div');
  rowDiv.style.cssText = 'display:flex;gap:18px;align-items:flex-start;';
  rowCells.forEach(function(cell) { renderFxHostCell(cell, rowDiv); });
  parentEl.appendChild(rowDiv);
}

// Build the control row for the given model mid. Uncaptured models (see
// protocol.js FX1_MODELS) show a placeholder instead of knobs — there is
// nothing to render yet, not a bug.
// Builds a complete FX-host knob row for `mid` into a DETACHED
// DocumentFragment — none of this touches the live #fxhost-knob-row, so
// the currently-visible panel (whatever model it's showing) is completely
// undisturbed while this runs. Used by the no-blank model-change swap
// below (buildFxHostPanel's caller decides when/whether to attach it).
// Exact same cell-building code as before (renderFxHostRow/
// renderFxHostCell, untouched) — only the container changed from the live
// element to a fragment, so nothing about how a model actually renders is
// at risk here.
function buildFxHostPanel(mid) {
  const model = FX1_MODEL_BY_MID[mid];
  const frag = document.createDocumentFragment();
  if (!model) {
    const div = document.createElement('div');
    div.style.cssText = 'color:var(--muted);padding:8px;';
    div.textContent = 'Unknown model';
    frag.appendChild(div);
    return { frag: frag, model: null, cellsByLo: {} };
  }
  if (!model.captured) {
    const div = document.createElement('div');
    div.style.cssText = 'color:var(--muted);padding:8px;';
    div.textContent = model.name + ' — paramLo layout not yet captured.';
    frag.appendChild(div);
    return { frag: frag, model: model, cellsByLo: {} };
  }

  // Extra side padding (2026-07-31, Charlie's Roto Speaker feedback,
  // corrected same day once the Speed dropdown made it symmetric) — a
  // model with few, narrow columns (e.g. Speed/Balance/Type) left the outer
  // columns crammed against the border on BOTH sides, not just one.
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;gap:18px;align-items:flex-start;'
    + 'padding:12px 28px;background:#1e1e1e;border-radius:6px;border:1px solid #555;';

  // Each entry is either a flat row (array of cells — the original shape,
  // rendered straight into the outer wrapper) or a box object
  // {group:'LABEL'?, rows:[[cells...], ...]} — rendered as its own nested
  // box, matching Avid's boxed sub-panels (CHORUS/MOD, DELAY/EQ/ENV MOD,
  // etc. — see the GROUPED LAYOUT comment above renderFxHostCell). The `group`
  // label is OPTIONAL: a box with no label still stacks its own rows
  // vertically (e.g. MultiChorus's Rate-above-Depth and Voices-above-Mix
  // columns, added 2026-07-31) — same nested-box shape, just no header text,
  // so it lines up visually with a labeled box beside it instead of
  // floating at a different baseline. A model can freely mix top-level flat
  // rows with box entries (labeled or not) in the same rows array, in
  // whatever order Avid's layout calls for.
  model.rows.forEach(function(entry) {
    if (entry && entry.rows) {
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;gap:10px;'
        + 'padding:10px 12px;background:#242424;border-radius:5px;border:1px solid #444;';
      if (entry.group) {
        const hdr = document.createElement('div');
        hdr.textContent = entry.group;
        hdr.style.cssText = 'font-size:11px;color:var(--label);text-transform:uppercase;'
          + 'letter-spacing:0.5px;font-weight:bold;';
        box.appendChild(hdr);
      }
      entry.rows.forEach(function(rowCells) { renderFxHostRow(rowCells, box); });
      wrapper.appendChild(box);
    } else {
      // Plain top-level flat row — no box, sits directly in the wrapper.
      const col = document.createElement('div');
      col.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
      renderFxHostRow(entry, col);
      wrapper.appendChild(col);
    }
  });

  frag.appendChild(wrapper);
  return { frag: frag, model: model, cellsByLo: collectFxHostCellRefs(frag, model) };
}

// Finds each cell's actual DOM element WITHIN the (possibly still
// detached) fragment — querySelector works on a detached subtree,
// document.getElementById does not, which is the whole reason this exists
// instead of just reusing updateFxHostKnob's normal lookups. Same
// id-per-kind scheme renderFxHostCell already builds (fxhost-w-/-v- for
// knob+slider, fxhost-tgl- for toggle, fxhost-sel- for select, fxhost-sync-
// for sync), read via the model's own cell list so this can never drift
// from what renderFxHostCell actually built.
function collectFxHostCellRefs(root, model) {
  const map = {};
  if (!model) return map;
  fxHostAllCells(model).forEach(function(cell) {
    const loHex = cell.lo.toString(16).padStart(2,'0');
    if (cell.sync)        map[cell.lo] = { kind: 'sync',   el: root.querySelector('#fxhost-sync-' + loHex) };
    else if (cell.select) map[cell.lo] = { kind: 'select', el: root.querySelector('#fxhost-sel-' + loHex) };
    else if (cell.toggle) map[cell.lo] = { kind: 'toggle', el: root.querySelector('#fxhost-tgl-' + loHex) };
    else map[cell.lo] = {
      kind: cell.slider ? 'slider' : 'knob',
      wrap: root.querySelector('#fxhost-w-' + loHex),
      valEl: root.querySelector('#fxhost-v-' + loHex)
    };
  });
  return map;
}

// Live entry point — builds and attaches in one step, exactly the old
// renderFxHostKnobs behaviour, for callers that don't need the no-blank
// staged swap (openFxHostPanel: nothing to preserve, the panel is opening
// fresh either way).
function renderFxHostKnobs(mid) {
  const container = document.getElementById('fxhost-knob-row');
  if (!container) return;
  const built = buildFxHostPanel(mid);
  container.innerHTML = '';
  container.appendChild(built.frag);
}

// Attaches an already-built, already-populated fragment (buildFxHostPanel)
// in one shot — the OLD panel is fully visible right up until this call,
// then the NEW one is fully visible immediately after. No intermediate
// blank/placeholder state ever reaches the screen.
function swapInFxHostPanel(frag) {
  const container = document.getElementById('fxhost-knob-row');
  if (!container) return;
  container.innerHTML = '';
  container.appendChild(frag);
}

// ── FX-host panel paint buffering (2026-09-03 follow-up to the main-panel
// nav-pull buffering, ui.js) — same idea, a SEPARATE buffer scoped to this
// one panel engine. Charlie's report: with the panel open, a same-model
// patch nav (or a genuine model switch's post-render query burst) still
// repainted each control the instant its own reply landed — "no knob, no
// value except --" trickling in over the query burst, same class of bug
// as the main panel's pre-buffering flash, just not covered by that fix
// (this panel's queries run on their own async cycle — requestFxHostParams,
// fx-transport.js — not inside the main nav pull's own buffer window).
// A dedicated buffer (not the main one) because the two run on independent
// timelines that can overlap; sharing one flag would let either finish
// early and flush the other's still-incomplete paints. requestFxHostParams
// starts it, its own completion flushes it — see fx-transport.js.
var fxHostPaintDeferred = false;
var fxHostPendingPaints = [];
function deferFxHostPaintOrRun(fn) {
  if (fxHostPaintDeferred) { fxHostPendingPaints.push(fn); return; }
  fn();
}
function flushFxHostPaint() {
  fxHostPaintDeferred = false;
  var paints = fxHostPendingPaints;
  fxHostPendingPaints = [];
  paints.forEach(function(fn) { fn(); });
}

// ── No-blank model-change swap (2026-09-03) ─────────────────────────────
// The buffering above stops a SAME-model refresh from trickling values in,
// but a genuine model change still had to blank the visible panel first —
// the old and new models have different control sets, so there was no
// static "relabel in place" option the way the amp tone knobs had.
// Charlie's report pinned this down exactly: switching to a DIFFERENT FX
// panel type mid-nav shows a beat of "no knob, no value except --";
// switching within the SAME panel type never does (it never rebuilds the
// DOM at all).
// Fix: build the replacement panel off-DOM (buildFxHostPanel), let the
// incoming values (cache-apply or a live query burst) land in THAT
// detached copy while the OLD panel stays fully visible and untouched,
// then swap the two in one shot (swapInFxHostPanel) once every value has
// arrived. fxHostPendingBuild is the redirect: while it's set, incoming
// CMD 0x11 replies for this slot (still routed through updateFxHostKnob,
// same as always) paint into the pending build's detached elements
// instead of the live (soon to be replaced) ones. fxHostBuildSeq guards
// against a build being superseded (nav-nav-nav in quick succession) —
// only the build whose seq still matches when its data finishes arriving
// actually gets swapped in; an outdated one is just dropped, never having
// touched the visible page.
var fxHostPendingBuild = null;   // { seq, cellsByLo, model } while one is in flight
// Active arrival gate (makeArrivalGate, defined in the Delay section
// above) for whichever paint/build is currently pending — tracks actual
// reply arrivals rather than "the query burst finished SENDING", which
// (2026-09-03) turned out to be the real cause of an occasional leftover
// 64/placeholder surviving a flush/swap: the last reply or two can still
// be in flight when a paced send loop's own completion fires, especially
// under any load. See the Delay section's makeArrivalGate comment for the
// full story — same fix, applied here too.
var fxHostArrivalGate = null;
var fxHostBuildSeq = 0;

// Same per-kind paint logic as the live branches below, just written
// against already-resolved element refs (a pending build's cellsByLo
// entry) instead of doing a fresh getElementById — see collectFxHostCellRefs
// for why a detached fragment needs this instead of the normal lookup.
// No paint-buffering needed here: nothing in a detached fragment is ever
// visible, so there's no flash to prevent, just plain direct writes.
function paintFxHostCellIntoRefs(entry, cell, model, loHex, val) {
  if (!entry) return;
  if (entry.kind === 'sync') {
    const idx = syncIndexFromV127(val);
    if (entry.el) { entry.el.value = String(idx); syncLoadedMarker(entry.el, 'fxhost-sync:' + openFxHostSlot + ':' + loHex); }
    return;
  }
  if (entry.kind === 'select') {
    if (entry.el) {
      let bestIdx = 0, bestDist = Infinity;
      cell.options.forEach(function(opt, i) {
        const d = Math.abs(opt.v127 - val);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      entry.el.value = String(bestIdx);
      syncLoadedMarker(entry.el, 'fxhost-sel:' + openFxHostSlot + ':' + (model ? model.mid : '') + ':' + loHex);
    }
    return;
  }
  if (entry.kind === 'toggle') {
    if (entry.el) {
      entry.el.dataset.orig  = model ? blockBaselineSetIfUnset(openFxHostSlot, model.mid, loHex, val) : val;
      entry.el.dataset.value = val;
      entry.el.textContent   = (val === 0) ? cell.options[0] : cell.options[1];
    }
    return;
  }
  // knob / slider
  if (entry.wrap) {
    entry.wrap.dataset.orig  = model ? blockBaselineSetIfUnset(openFxHostSlot, model.mid, loHex, val) : val;
    entry.wrap.dataset.value = val;
    if (entry.kind === 'slider') drawEqSlider(entry.wrap.querySelector('canvas'), val, entry.wrap, cell.min, cell.max, cell.ticks, cell.linear);
    else                         drawKnob(entry.wrap.querySelector('canvas'), val);
  }
  if (entry.valEl) {
    entry.valEl.textContent = (cell && typeof cell.display === 'function') ? cell.display(val) : valDisplay(val);
  }
}

// Update a single FX-host control from a broadcast/REQU response or a local
// dropdown/toggle pick. Looks up cell kind (knob/toggle/sync) against the
// current model so the right widget gets updated.
function updateFxHostKnob(paramLo, val) {
  if (fxHostPendingBuild) {
    const loHexPending = paramLo.toString(16).padStart(2,'0');
    let pendingCell = null;
    if (fxHostPendingBuild.model) {
      fxHostAllCells(fxHostPendingBuild.model).forEach(function(c) { if (c.lo === paramLo) pendingCell = c; });
    }
    paintFxHostCellIntoRefs(fxHostPendingBuild.cellsByLo[paramLo], pendingCell, fxHostPendingBuild.model, loHexPending, val);
    if (fxHostArrivalGate) fxHostArrivalGate.markSeen(paramLo);
    return;
  }
  const loHex = paramLo.toString(16).padStart(2,'0');
  const model = currentFxHostModel();
  let cell = null;
  if (model) {
    fxHostAllCells(model).forEach(function(c) { if (c.lo === paramLo) cell = c; });
  }

  if (cell && cell.sync) {
    const idx = syncIndexFromV127(val);
    const sel = document.getElementById('fxhost-sync-' + loHex);
    // Slot-keyed (FX1/FX2/MOD share this one DOM), no mid needed —
    // SYNC_DIVISIONS is the same list regardless of model.
    if (sel) deferFxHostPaintOrRun(function() {
      sel.value = String(idx); syncLoadedMarker(sel, 'fxhost-sync:' + openFxHostSlot + ':' + loHex);
    });
    if (fxHostArrivalGate) fxHostArrivalGate.markSeen(paramLo);
    return;
  }
  if (cell && cell.select) {
    // Nearest-match: an unexpected raw value (rounding, or a position we
    // didn't enumerate) still lands on the closest labeled option rather
    // than leaving the dropdown showing nothing selected.
    const sel = document.getElementById('fxhost-sel-' + loHex);
    if (sel) {
      let bestIdx = 0, bestDist = Infinity;
      cell.options.forEach(function(opt, i) {
        const d = Math.abs(opt.v127 - val);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      // Keyed by slot AND model mid — unlike Sync, cell.select's options
      // are model-specific (e.g. MultiChorus's named positions), so two
      // different models reusing this paramLo must not share a "loaded"
      // reference.
      deferFxHostPaintOrRun(function() {
        sel.value = String(bestIdx);
        syncLoadedMarker(sel, 'fxhost-sel:' + openFxHostSlot + ':' + (model ? model.mid : '') + ':' + loHex);
      });
    }
    if (fxHostArrivalGate) fxHostArrivalGate.markSeen(paramLo);
    return;
  }
  if (cell && cell.toggle) {
    const btn = document.getElementById('fxhost-tgl-' + loHex);
    if (btn) {
      btn.dataset.orig  = model ? blockBaselineSetIfUnset(openFxHostSlot, model.mid, loHex, val) : val;
      btn.dataset.value = val;
      deferFxHostPaintOrRun(function() {
        btn.textContent = (val === 0) ? cell.options[0] : cell.options[1];
      });
    }
    if (fxHostArrivalGate) fxHostArrivalGate.markSeen(paramLo);
    return;
  }

  const wrap  = document.getElementById('fxhost-w-' + loHex);
  const valEl = document.getElementById('fxhost-v-' + loHex);
  if (wrap) {
    // Baseline anchored PER MODEL (blockModelBaseline, generic engine above)
    // so it survives panel close/reopen AND a model switch — same pattern
    // DIST/REVERB/WAH use (2026-09-02, migrated off the old per-slot-only
    // fxBaseline, which reset on every model switch since it had no mid key).
    wrap.dataset.orig  = model ? blockBaselineSetIfUnset(openFxHostSlot, model.mid, loHex, val) : val;
    wrap.dataset.value = val;
    deferFxHostPaintOrRun(function() {
      if (cell && cell.slider) drawEqSlider(wrap.querySelector('canvas'), val, wrap, cell.min, cell.max, cell.ticks, cell.linear);
      else                     drawKnob(wrap.querySelector('canvas'), val);
    });
  }
  if (valEl) {
    deferFxHostPaintOrRun(function() {
      valEl.textContent = (cell && typeof cell.display === 'function') ? cell.display(val) : valDisplay(val);
    });
  }
  if (fxHostArrivalGate) fxHostArrivalGate.markSeen(paramLo);
}

// Re-sync dropdown + controls after a chain map (model may have changed on
// patch nav or via our own model switch), then re-query params. Migrated
// (2026-09-02) onto the generic per-model cache/baseline engine — same
// switch-pending detection and cache-apply-else-query shape as
// refreshDistPanelAfterChainMap/refreshReverbPanelAfterChainMap, just keyed
// by whichever slot is currently open (openFxHostSlot) instead of a fixed
// SLOT_DIST/SLOT_REVERB, since FX1/FX2/MOD all share this one function.
function refreshFxHostPanelAfterChainMap() {
  if (openFxHostSlot === null) return;
  const blk = currentChain.find(b => b.slotId === openFxHostSlot);
  if (!blk) return;
  const slotId = openFxHostSlot;
  // Compare against the RESOLVED model's primary mid, not the raw wire mid
  // — otherwise every mono/stereo toggle looks like a model change (it
  // isn't) and needlessly rebuilds the panel and drops the FX baseline.
  const model = FX1_MODEL_BY_MID[blk.modelId];
  const sel = document.getElementById('fxhost-model-select');
  if (blockModelSwitchPending[slotId]) {
    // This chain-map reply is confirming OUR OWN dropdown-initiated switch
    // (flag set in the change handler, index.html) — same detection DIST/
    // REVERB/DELAY use and for the same reason: the dropdown already shows
    // the new value, so a sel.value/modelId comparison can't tell this case
    // apart from a genuinely different patch that happens to share a model.
    blockModelSwitchPending[slotId] = false;
    if (sel && model) sel.value = String(model.mid);
    // No-blank swap (2026-09-03) — build the replacement panel off-DOM and
    // populate it (cache-apply, or a live query burst if nothing cached)
    // while the OLD one stays fully visible; swap only once populated. See
    // the fxHostPendingBuild header comment above for the full mechanism.
    const seq1 = ++fxHostBuildSeq;
    const built1 = buildFxHostPanel(blk.modelId);
    fxHostPendingBuild = { seq: seq1, cellsByLo: built1.cellsByLo, model: built1.model };
    // NO baseline clear here — the red/green reference is per (slot, model)
    // (blockModelBaseline) and must survive a switch; only a real patch nav
    // or Save resets it (clearBlockModelState).
    // fxHostPendingBuild stays assigned to THIS build (seq1) from here on,
    // whichever path below populates it — never reassigned or nulled out
    // in between, so a NEWER refresh superseding this one before it
    // finishes can safely overwrite it, and this one's own eventual
    // completion callback (checking .seq === seq1) correctly no-ops.
    const applied = model && blockCacheApply(slotId, model.mid, updateFxHostKnob,
      function(lo, val) { sendFxHostParamWrite(slotId, lo, val); });
    if (applied) {
      fxHostPendingBuild = null;
      swapInFxHostPanel(built1.frag);
    } else {
      setTimeout(function() {
        if (!(fxHostPendingBuild && fxHostPendingBuild.seq === seq1)) return;   // superseded during the 150ms wait
        fxHostArrivalGate = makeArrivalGate(model.paramLos, 1500, function() {
          if (fxHostPendingBuild && fxHostPendingBuild.seq === seq1) {
            fxHostPendingBuild = null;
            fxHostArrivalGate = null;
            swapInFxHostPanel(built1.frag);
          }
          // else: superseded by a newer build meanwhile — drop this one,
          // it was never attached to the page.
        });
        requestFxHostParams(slotId);
      }, 150);
    }
    appLog('refreshFxHostPanelAfterChainMap: own switch confirmed, slot=0x' + slotId.toString(16).padStart(2,'0')
      + ' mid=0x' + blk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  if (sel && model && parseInt(sel.value) !== model.mid) {
    // Dropdown stale for some other reason (e.g. panel opened fresh on a
    // patch whose model differs from whatever the dropdown last showed) —
    // no cache to trust here, just resync to hardware truth. THE common
    // path for an ordinary patch nav landing on a different FX model —
    // same no-blank staged build+swap as above, just always via the query
    // burst (never a cache hit here).
    sel.value = String(model.mid);
    syncLoadedMarker(sel, 'fxhost-model-select:' + slotId);
    const seq2 = ++fxHostBuildSeq;
    const built2 = buildFxHostPanel(blk.modelId);
    fxHostPendingBuild = { seq: seq2, cellsByLo: built2.cellsByLo, model: built2.model };
    setTimeout(function() {
      if (!(fxHostPendingBuild && fxHostPendingBuild.seq === seq2)) return;   // superseded during the 150ms wait
      fxHostArrivalGate = makeArrivalGate(model.paramLos, 1500, function() {
        if (fxHostPendingBuild && fxHostPendingBuild.seq === seq2) {
          fxHostPendingBuild = null;
          fxHostArrivalGate = null;
          swapInFxHostPanel(built2.frag);
        }
      });
      requestFxHostParams(slotId);
    }, 150);
    appLog('refreshFxHostPanelAfterChainMap: dropdown resync, slot=0x' + slotId.toString(16).padStart(2,'0')
      + ' mid=0x' + blk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  // Plain same-model refresh — no DOM rebuild, just buffer the incoming
  // values into one flush instead of trickling, tracked by actual arrival
  // (2026-09-03) rather than "the send loop finished" (makeArrivalGate).
  setTimeout(function() {
    if (model && model.captured) {
      fxHostPaintDeferred = true; fxHostPendingPaints = [];
      fxHostArrivalGate = makeArrivalGate(model.paramLos, 1500, flushFxHostPaint);
    }
    requestFxHostParams(slotId);
  }, 150);
  appLog('refreshFxHostPanelAfterChainMap: slot=0x' + slotId.toString(16).padStart(2,'0')
    + ' mid=0x' + blk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + blk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── R7 helpers — shared by the FX-host drag and dblclick handlers below.
// Generic over any future Sync-driven cell (MOD/DELAY etc.), not just
// Chorus/Rate: driven by the model row data (cell.sync / cell.syncDriven,
// protocol.js), not a hardcoded paramLo. ──
function fxHostSyncCellLo(model) {
  var lo = null;
  fxHostAllCells(model).forEach(function(c) { if (c.sync) lo = c.lo; });
  return lo;
}
function fxHostCellIsSyncDriven(model, paramLo) {
  var found = null;
  fxHostAllCells(model).forEach(function(c) { if (c.lo === paramLo) found = c; });
  return !!(found && found.syncDriven);
}
function fxHostCurrentSyncZone(model) {
  var syncLo = fxHostSyncCellLo(model);
  if (syncLo === null) return 0;
  var sel = document.getElementById('fxhost-sync-' + syncLo.toString(16).padStart(2,'0'));
  return sel ? (parseInt(sel.value, 10) || 0) : 0;
}
// Grabbing/restoring a Sync-driven knob clears Sync first, once, mirroring
// the amp Speed/Sync interlock (R7) — hands control back to the user
// exactly like the rack's own front-panel knob, rather than write-guarding
// or greying the knob out (both tried and rejected for the amp case).
function fxHostClearSyncIfDriving(model, paramLo) {
  if (!fxHostCellIsSyncDriven(model, paramLo)) return;
  var syncLo = fxHostSyncCellLo(model);
  if (syncLo === null) return;
  if (fxHostCurrentSyncZone(model) === 0) return;
  updateFxHostKnob(syncLo, 0);
  if (bridgeMidiReady) sendFxHostParamWrite(openFxHostSlot, syncLo, 0);
  appLog('FX-host knob 0x' + paramLo.toString(16).padStart(2,'0') + ' moved while Sync was engaged'
         + ' — clearing Sync to OFF first (the rack does the same)');
}

// ── FX-host knob drag — delegated, keyed on data-fxhost-lo (hex paramLo) ──
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;
  var syncClearedThisFxHostDrag = false;

  document.addEventListener('mousedown', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-fxhost-lo]');
    if (!wrap) return;
    activeParamLo = parseInt(wrap.dataset.fxhostLo, 16);
    if (isNaN(activeParamLo)) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    syncClearedThisFxHostDrag = false;   // one Sync clear per drag, not per mousemove
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    updateFxHostKnob(activeParamLo, val);
    // Snapshot before queuing — see the DIST handler above for why. This is
    // the exact bug that produced paramLo=-1 (byte 0xFF, an illegal SysEx
    // data byte) mid-message and wedged the hardware, 2026-07-30, FX1 Ratio.
    var lo = activeParamLo;
    var slotId = openFxHostSlot;
    var model = currentFxHostModel(slotId);
    if (model && !syncClearedThisFxHostDrag && fxHostCellIsSyncDriven(model, lo) && fxHostCurrentSyncZone(model) !== 0) {
      syncClearedThisFxHostDrag = true;
      fxHostClearSyncIfDriving(model, lo);
    }
    if (bridgeMidiReady) queueKnobSend('fxhost:' + lo, function(v) { sendFxHostParamWrite(slotId, lo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-fxhost-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.fxhostLo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    var slotId = openFxHostSlot;
    var model = currentFxHostModel(slotId);
    if (model) fxHostClearSyncIfDriving(model, paramLo);   // R7 — restore is a knob move too
    updateFxHostKnob(paramLo, val);
    if (bridgeMidiReady) queueKnobSend('fxhost:' + paramLo, function(v) { sendFxHostParamWrite(slotId, paramLo, v); }, val);
  });
})();
