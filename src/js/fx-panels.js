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
    // Snapshot before queuing — see the DIST handler above for why (a
    // closure over the shared activeParamLo can fire after mouseup resets
    // it to -1, sending a malformed paramLo byte).
    var lo = activeParamLo;
    if (bridgeMidiReady) queueKnobSend('reverb:' + lo, function(v) { sendReverbParamWrite(lo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-reverb-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.reverbLo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    updateReverbKnob(paramLo, val);
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
  if (sel) sel.value = String(wahBlk.modelId);
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
          + '<div class="knob-wrap" id="wah-w-' + loHex + '" data-value="64" data-base="fx" data-wah-lo="' + loHex + '">'
          + '<canvas class="knob-canvas" width="80" height="80"></canvas></div>'
          + '<span class="knob-val" id="wah-v-' + loHex + '">--</span>';
        rowDiv.appendChild(knobDiv);
        drawKnob(knobDiv.querySelector('canvas'), 64);
      }
    });

    wrapper.appendChild(rowDiv);
  });

  container.appendChild(wrapper);
}

function updateWahKnob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const wrap  = document.getElementById('wah-w-' + loHex);
  const valEl = document.getElementById('wah-v-' + loHex);
  if (wrap) {
    wrap.dataset.orig  = fxBaselineSetIfUnset(SLOT_WAH, loHex, val);
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
  if (sel && model && parseInt(sel.value) !== model.mid) {
    sel.value = String(model.mid);
    renderWahKnobs(wahBlk.modelId);
    clearFxBaselineForSlot(SLOT_WAH);
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
          + '<div class="knob-wrap" id="vol-w-' + loHex + '" data-value="64" data-base="fx" data-vol-lo="' + loHex + '">'
          + '<canvas class="knob-canvas" width="80" height="80"></canvas></div>'
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
        + '<div class="knob-wrap" id="fxloop-w-' + loHex + '" data-value="64" data-base="fx" data-fxloop-lo="' + loHex + '">'
        + '<canvas class="knob-canvas" width="80" height="80"></canvas></div>'
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
  if (sel && model) sel.value = String(model.mid);   // base mid identifies the model
  renderDelayKnobs(delayBlk.modelId);
  requestDelayParams();
  appLog('openDelayPanel: mid=0x' + delayBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + delayBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

function closeDelayPanel() {
  delayPanelOpen = false;
}

function renderDelayKnobs(mid) {
  const container = document.getElementById('delay-knob-row');
  if (!container) return;
  const model = DELAY_MODEL_BY_MID[mid];
  if (!model) {
    container.innerHTML = '<div style="color:var(--muted);padding:8px;">Unknown model</div>';
    return;
  }
  if (!model.captured) {
    container.innerHTML = '<div style="color:var(--muted);padding:8px;">'
      + model.name + ' — paramLo layout not yet captured.</div>';
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
        // Sync — plain named-position dropdown, no paired knob (wide
        // 28-bit wire encoding, not a draggable v127 control).
        const syDiv = document.createElement('div');
        syDiv.className = 'ctrl-knob';
        syDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
        const lbl = document.createElement('label');
        lbl.textContent = cell.label;
        let opts = '';
        SYNC_DIVISIONS.forEach(function(z, i) { opts += '<option value="' + i + '">' + z.text + '</option>'; });
        syDiv.innerHTML = '';
        syDiv.appendChild(lbl);
        const sel = document.createElement('select');
        sel.id = 'delay-sync-select';
        sel.style.cssText = 'width:112px;background:#1a1a1a;color:var(--text);'
          + 'border:1px solid var(--border-dim);border-radius:4px;padding:4px 6px;font-size:12px;';
        sel.innerHTML = opts;
        sel.addEventListener('change', function() {
          const idx = parseInt(this.value, 10);
          if (isNaN(idx)) return;
          updateDelaySync(idx);
          if (bridgeMidiReady && typeof sendDelaySyncWrite === 'function') sendDelaySyncWrite(idx);
        });
        syDiv.appendChild(sel);
        rowDiv.appendChild(syDiv);
      } else {
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const knobDiv = document.createElement('div');
        knobDiv.className = 'ctrl-knob';
        knobDiv.innerHTML =
          '<label>' + cell.label + '</label>'
          + '<div class="knob-wrap" id="delay-w-' + loHex + '" data-value="64" data-base="fx" data-delay-lo="' + loHex + '">'
          + '<canvas class="knob-canvas" width="80" height="80"></canvas></div>'
          + '<span class="knob-val" id="delay-v-' + loHex + '">--</span>';
        rowDiv.appendChild(knobDiv);
        drawKnob(knobDiv.querySelector('canvas'), 64);
      }
    });

    wrapper.appendChild(rowDiv);
  });

  container.appendChild(wrapper);
}

// Display string for a DELAY knob value — the four 0-10 knobs (Input,
// Feedback, Depth, Mix) are plain linear one-decimal; Delay itself is
// 32-400 ms, also plain linear (see protocol.js header for why only
// byte0 is used).
function delayKnobDisplay(paramLo, val) {
  const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
  const model = delayBlk ? DELAY_MODEL_BY_MID[delayBlk.modelId] : null;
  if (!model || !model.rows) return valDisplay(val);
  for (let r = 0; r < model.rows.length; r++) {
    const row = model.rows[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell || cell.lo !== paramLo) continue;
      if (cell.display === 'delayTen') return (val / 127 * 10).toFixed(1);
      if (cell.display === 'delayMs')  return (32 + val / 127 * (400 - 32)).toFixed(0) + ' ms';
    }
  }
  return valDisplay(val);
}

function updateDelayKnob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const model = DELAY_MODEL_BY_MID[(currentChain.find(function(b) { return b.slotId === SLOT_DELAY; }) || {}).modelId];
  var isToggle = false, toggleOptions = ['Off','On'];
  if (model && model.rows) {
    model.rows.forEach(function(row) {
      row.forEach(function(cell) {
        if (cell && cell.lo === paramLo && cell.toggle) {
          isToggle = true;
          if (cell.options) toggleOptions = cell.options;
        }
      });
    });
  }
  if (isToggle) {
    const btn = document.getElementById('delay-tgl-' + loHex);
    if (btn) {
      btn.dataset.orig  = fxBaselineSetIfUnset(SLOT_DELAY, loHex, val);
      btn.dataset.value = val;
      btn.textContent   = (val === 0) ? toggleOptions[0] : toggleOptions[1];
    }
    return;
  }
  const wrap  = document.getElementById('delay-w-' + loHex);
  const valEl = document.getElementById('delay-v-' + loHex);
  if (wrap) {
    wrap.dataset.orig  = fxBaselineSetIfUnset(SLOT_DELAY, loHex, val);
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
  }
  if (valEl) valEl.textContent = delayKnobDisplay(paramLo, val);
}

// Sync isn't a knob — just move the dropdown. No baseline/red-state
// tracking (R3) for it: it's a discrete selector, not a continuous value
// that can drift from a loaded patch by a small amount.
function updateDelaySync(zoneIdx) {
  const sel = document.getElementById('delay-sync-select');
  if (sel) sel.value = String(zoneIdx);
}

function refreshDelayPanelAfterChainMap() {
  if (!delayPanelOpen) return;
  const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
  if (!delayBlk) return;
  const model = DELAY_MODEL_BY_MID[delayBlk.modelId];
  const sel = document.getElementById('delay-model-select');
  if (sel && model && parseInt(sel.value) !== model.mid) {
    sel.value = String(model.mid);
    renderDelayKnobs(delayBlk.modelId);   // model actually changed — rebuild controls
    clearFxBaselineForSlot(SLOT_DELAY);   // new model = new reference point
  }
  setTimeout(requestDelayParams, 150);
  appLog('refreshDelayPanelAfterChainMap: mid=0x' + delayBlk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + delayBlk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── DELAY knob drag — delegated, keyed on data-delay-lo ──
// R7 — Delay (lo 0x04) is Sync-driven, same family as amp Tremolo Speed
// and DELAY's own Sync (paramLo 0x05) overwriting it. UNLIKE Tremolo,
// Charlie confirmed the rack ITSELF already clears Sync to OFF the moment
// the Delay/Rate knob is touched (no explicit clear write needed here) —
// so this only mirrors that locally in the Sync dropdown for immediate
// feedback; the next live broadcast is still the source of truth.
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;
  var delaySyncClearedThisDrag = false;

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
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    updateDelayKnob(activeParamLo, val);
    if (activeParamLo === 0x04 && !delaySyncClearedThisDrag) {
      delaySyncClearedThisDrag = true;
      if (typeof updateDelaySync === 'function') updateDelaySync(0);
    }
    // Snapshot before queuing — R6, drag-queue race (Sec 20A).
    var lo = activeParamLo;
    if (bridgeMidiReady) queueKnobSend('delay:' + lo, function(v) { sendDelayParamWrite(lo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-delay-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.delayLo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    updateDelayKnob(paramLo, val);
    if (paramLo === 0x04 && typeof updateDelaySync === 'function') updateDelaySync(0);
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
  if (sel && openModel) sel.value = String(openModel.mid);
  renderFxHostKnobs(blk.modelId);
  requestFxHostParams(slotId);
  appLog('openFxHostPanel: slot=0x' + slotId.toString(16).padStart(2,'0')
    + ' mid=0x' + blk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + blk.handle.toString(16).padStart(2,'0').toUpperCase());
}

function closeFxHostPanel() {
  openFxHostSlot = null;
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
        sel.addEventListener('change', function() {
          const idx = parseInt(this.value, 10);
          if (isNaN(idx) || !cell.options[idx]) return;
          const v127 = cell.options[idx].v127;
          updateFxHostKnob(cell.lo, v127);
          if (bridgeMidiReady) sendFxHostParamWrite(openFxHostSlot, cell.lo, v127);
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
        sel.addEventListener('change', function() {
          const idx = parseInt(this.value, 10);
          if (isNaN(idx)) return;
          const v127 = syncV127FromIndex(idx);
          updateFxHostKnob(cell.lo, v127);
          if (bridgeMidiReady) sendFxHostParamWrite(openFxHostSlot, cell.lo, v127);
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
        // accent instead of the usual green FX base, matching Avid's own
        // LF/LMF/HMF/HF colour coding. See knobColor (ui.js) for why the
        // arc itself never turns red for these — "changed" shows on the
        // value-text readout below instead (updateFxHostKnob's bandColor
        // branch), since some bands are already red/amber by design.
        const loHex = cell.lo.toString(16).padStart(2,'0');
        const knobDiv = document.createElement('div');
        knobDiv.className = 'ctrl-knob';
        knobDiv.innerHTML =
          '<label>' + cell.label + '</label>'
          + '<div class="knob-wrap" id="fxhost-w-' + loHex + '" data-value="64" data-base="fx" data-fxhost-lo="' + loHex + '"'
          + (cell.bandColor ? ' data-band-color="' + cell.bandColor + '"' : '') + '>'
          + '<canvas class="knob-canvas" width="80" height="80"></canvas></div>'
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
function renderFxHostKnobs(mid) {
  const container = document.getElementById('fxhost-knob-row');
  if (!container) return;
  const model = FX1_MODEL_BY_MID[mid];
  if (!model) {
    container.innerHTML = '<div style="color:var(--muted);padding:8px;">Unknown model</div>';
    return;
  }
  if (!model.captured) {
    container.innerHTML = '<div style="color:var(--muted);padding:8px;">'
      + model.name + ' — paramLo layout not yet captured.</div>';
    return;
  }
  container.innerHTML = '';

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

  container.appendChild(wrapper);
}

// Update a single FX-host control from a broadcast/REQU response or a local
// dropdown/toggle pick. Looks up cell kind (knob/toggle/sync) against the
// current model so the right widget gets updated.
function updateFxHostKnob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const model = currentFxHostModel();
  let cell = null;
  if (model) {
    fxHostAllCells(model).forEach(function(c) { if (c.lo === paramLo) cell = c; });
  }

  if (cell && cell.sync) {
    const idx = syncIndexFromV127(val);
    const sel = document.getElementById('fxhost-sync-' + loHex);
    if (sel) sel.value = String(idx);
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
      sel.value = String(bestIdx);
    }
    return;
  }
  if (cell && cell.toggle) {
    const btn = document.getElementById('fxhost-tgl-' + loHex);
    if (btn) {
      btn.dataset.orig  = fxBaselineSetIfUnset(openFxHostSlot, loHex, val);
      btn.dataset.value = val;
      btn.textContent   = (val === 0) ? cell.options[0] : cell.options[1];
    }
    return;
  }

  const wrap  = document.getElementById('fxhost-w-' + loHex);
  const valEl = document.getElementById('fxhost-v-' + loHex);
  if (wrap) {
    wrap.dataset.orig  = fxBaselineSetIfUnset(openFxHostSlot, loHex, val);
    wrap.dataset.value = val;
    if (cell && cell.slider) drawEqSlider(wrap.querySelector('canvas'), val, wrap, cell.min, cell.max, cell.ticks, cell.linear);
    else                     drawKnob(wrap.querySelector('canvas'), val);
  }
  if (valEl) {
    valEl.textContent = (cell && typeof cell.display === 'function') ? cell.display(val) : valDisplay(val);
    // cell.bandColor knobs (Parametric EQ) never turn their arc red on
    // change (see knobColor, ui.js) since the arc's fixed accent colour
    // would collide with red-on-change for the LF/OUT bands. The value
    // readout carries the "changed" signal instead.
    if (cell && cell.bandColor) {
      const changed = wrap && wrap.dataset.orig !== undefined && wrap.dataset.orig !== ''
        && parseInt(wrap.dataset.orig) !== val;
      valEl.style.color = changed ? KNOB_COLORS.red : '';
      valEl.style.fontWeight = changed ? 'bold' : '';
    }
  }
}

// Re-sync dropdown + controls after a chain map (model may have changed on
// patch nav or via our own model switch), then re-query params.
function refreshFxHostPanelAfterChainMap() {
  if (openFxHostSlot === null) return;
  const blk = currentChain.find(b => b.slotId === openFxHostSlot);
  if (!blk) return;
  // Compare against the RESOLVED model's primary mid, not the raw wire mid
  // — otherwise every mono/stereo toggle looks like a model change (it
  // isn't) and needlessly rebuilds the panel and drops the FX baseline.
  const sel = document.getElementById('fxhost-model-select');
  const refreshModel = FX1_MODEL_BY_MID[blk.modelId];
  if (sel && refreshModel && parseInt(sel.value) !== refreshModel.mid) {
    sel.value = String(refreshModel.mid);
    renderFxHostKnobs(blk.modelId);
    clearFxBaselineForSlot(openFxHostSlot);
  }
  const slotId = openFxHostSlot;
  setTimeout(function() { requestFxHostParams(slotId); }, 150);
  appLog('refreshFxHostPanelAfterChainMap: slot=0x' + openFxHostSlot.toString(16).padStart(2,'0')
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
