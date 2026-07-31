// ════════════════════════════════════════════════════════════════════
// FX-PANELS.JS — per-effect-panel UI (open/close, render knobs, update
// from hardware, chain-map refresh, drag handling), split out of ui.js
// on 7/27.
//
// WHY THIS FILE EXISTS: ui.js's core (knob-drawing primitives, the tempo
// clock, the chain row, general readouts) doesn't grow as new effect
// panels are added, but this DOES — every new panel (WAH, MOD, DELAY,
// VOL, FX1, FX2, FX LOOP still to come) adds another open/render/update/
// refresh/drag set here in the same DIST/REVERB shape. Keeping that
// growth in its own file means ui.js stays the size it is today no
// matter how many more panels get built; this file is where they land
// instead.
//
// PATTERN for a new block (copy the FX1 functions below, not DIST/REVERB/
// WAH/VOL — see 2026-07-30 note below for why. REVERB's typeControl selector
// cell and ms/unit display are still worth copying on top of the FX1
// pattern, for blocks that need them):
//   open<Block>Panel() / close<Block>Panel()
//   render<Block>Knobs(mid)              — build the knob row DOM
//   update<Block>Knob(paramLo, val)      — apply one CMD 0x11 value
//   refresh<Block>PanelAfterChainMap()   — re-sync model + re-query
//   a delegated drag handler keyed on a data-<block>-lo attribute
//   a scroll-wheel branch in ui.js's shared wheel listener (search
//     "SCROLL WHEEL on tone / DIST / REVERB knobs") — copy the FX1 branch
//   a branch in rebaselineOpenFxPanel() (ui.js) so save-then-green works
//
// PURE RELOCATION (7/27): every function below is unchanged from its
// original position in ui.js — same logic, same comments, same
// behaviour. Nothing was rewritten.
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
//   (2) THE 9.9 BUG — see fx-transport.js header / sendFx1ParamWrite for
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
// FX1 EFFECT PANEL
// FX1 is a GENERIC HOST SLOT — the model dropdown lists every mid seen in
// the hardware's own FX1 dropdown (Session Log 2026-07-30), but only
// models with captured===true (see FX1_MODELS, protocol.js) have real
// paramLos/rows; the rest render a "not yet captured" placeholder instead
// of knobs. Otherwise a mirror of the DIST panel, plus two cell kinds
// DIST doesn't need:
//   - toggle cell (cell.toggle)  — copied from the VOL Taper pattern
//   - sync cell   (cell.sync)    — a dropdown reusing SYNC_DIVISIONS /
//     syncIndexFromV127 / syncV127FromIndex (protocol.js), the SAME
//     14-zone table the amp Tremolo Sync uses, just at this model's own
//     paramLo instead of 0x12 and against the FX1 block's own handle
//     instead of currentParamHi.
// Knob IDs: fx1-w-{loHex} / fx1-v-{loHex}, keyed by paramLo.
// ════════════════════════════════════════════════════════════════════

function currentFx1Model() {
  const fx1Blk = currentChain.find(b => b.slotId === SLOT_FX1);
  if (!fx1Blk) return null;
  return FX1_MODEL_BY_MID[fx1Blk.modelId] || null;
}

function openFx1Panel() {
  fx1PanelOpen = true;
  const fx1Blk = currentChain.find(b => b.slotId === SLOT_FX1);
  if (!fx1Blk) {
    document.getElementById('fx1-knob-row').innerHTML =
      '<div style="color:var(--muted);padding:8px;">Chain map not yet received — navigate to a patch first.</div>';
    appLog('openFx1Panel: no FX1 block in chain map yet');
    return;
  }
  // Resolve through the model, not the raw wire mid — a model can report a
  // different mid depending on mono/stereo chain state (see FX1_MODELS
  // header, protocol.js), and the dropdown only has ONE option per model.
  const sel = document.getElementById('fx1-model-select');
  const openModel = FX1_MODEL_BY_MID[fx1Blk.modelId];
  if (sel && openModel) sel.value = String(openModel.mid);
  renderFx1Knobs(fx1Blk.modelId);
  requestFx1Params();
  appLog('openFx1Panel: mid=0x' + fx1Blk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + fx1Blk.handle.toString(16).padStart(2,'0').toUpperCase());
}

function closeFx1Panel() {
  fx1PanelOpen = false;
}

// Build the control row for the given model mid. Uncaptured models (see
// protocol.js FX1_MODELS) show a placeholder instead of knobs — there is
// nothing to render yet, not a bug.
function renderFx1Knobs(mid) {
  const container = document.getElementById('fx1-knob-row');
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
        sel.id = 'fx1-sync-' + loHex;
        sel.dataset.fx1Lo = loHex;
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
          updateFx1Knob(cell.lo, v127);
          if (bridgeMidiReady) sendFx1ParamWrite(cell.lo, v127);
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
        btn.id = 'fx1-tgl-' + loHex;
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
          updateFx1Knob(cell.lo, newVal);
          if (bridgeMidiReady) sendFx1ParamWrite(cell.lo, newVal);
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
          + '<div class="knob-wrap" id="fx1-w-' + loHex + '" data-value="64" data-base="fx" data-fx1-lo="' + loHex + '">'
          + '<canvas class="knob-canvas" width="80" height="80"></canvas></div>'
          + '<span class="knob-val" id="fx1-v-' + loHex + '">--</span>';
        rowDiv.appendChild(knobDiv);
        drawKnob(knobDiv.querySelector('canvas'), 64);
      }
    });

    wrapper.appendChild(rowDiv);
  });

  container.appendChild(wrapper);
}

// Update a single FX1 control from a broadcast/REQU response or a local
// dropdown/toggle pick. Looks up cell kind (knob/toggle/sync) against the
// current model so the right widget gets updated.
function updateFx1Knob(paramLo, val) {
  const loHex = paramLo.toString(16).padStart(2,'0');
  const model = currentFx1Model();
  let cell = null;
  if (model) {
    model.rows.forEach(function(row) {
      row.forEach(function(c) { if (c && c.lo === paramLo) cell = c; });
    });
  }

  if (cell && cell.sync) {
    const idx = syncIndexFromV127(val);
    const sel = document.getElementById('fx1-sync-' + loHex);
    if (sel) sel.value = String(idx);
    return;
  }
  if (cell && cell.toggle) {
    const btn = document.getElementById('fx1-tgl-' + loHex);
    if (btn) {
      btn.dataset.orig  = fxBaselineSetIfUnset(SLOT_FX1, loHex, val);
      btn.dataset.value = val;
      btn.textContent   = (val === 0) ? cell.options[0] : cell.options[1];
    }
    return;
  }

  const wrap  = document.getElementById('fx1-w-' + loHex);
  const valEl = document.getElementById('fx1-v-' + loHex);
  if (wrap) {
    wrap.dataset.orig  = fxBaselineSetIfUnset(SLOT_FX1, loHex, val);
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
  }
  if (valEl) valEl.textContent = (cell && typeof cell.display === 'function') ? cell.display(val) : valDisplay(val);
}

// Re-sync dropdown + controls after a chain map (model may have changed on
// patch nav or via our own model switch), then re-query params.
function refreshFx1PanelAfterChainMap() {
  if (!fx1PanelOpen) return;
  const fx1Blk = currentChain.find(b => b.slotId === SLOT_FX1);
  if (!fx1Blk) return;
  // Compare against the RESOLVED model's primary mid, not the raw wire mid
  // — otherwise every mono/stereo toggle looks like a model change (it
  // isn't) and needlessly rebuilds the panel and drops the FX baseline.
  const sel = document.getElementById('fx1-model-select');
  const refreshModel = FX1_MODEL_BY_MID[fx1Blk.modelId];
  if (sel && refreshModel && parseInt(sel.value) !== refreshModel.mid) {
    sel.value = String(refreshModel.mid);
    renderFx1Knobs(fx1Blk.modelId);
    clearFxBaselineForSlot(SLOT_FX1);
  }
  setTimeout(requestFx1Params, 150);
  appLog('refreshFx1PanelAfterChainMap: mid=0x' + fx1Blk.modelId.toString(16).padStart(2,'0')
    + ' handle=0x' + fx1Blk.handle.toString(16).padStart(2,'0').toUpperCase());
}

// ── R7 helpers — shared by the FX1 drag and dblclick handlers below.
// Generic over any future Sync-driven cell (MOD/DELAY etc.), not just
// Chorus/Rate: driven by the model row data (cell.sync / cell.syncDriven,
// protocol.js), not a hardcoded paramLo. ──
function fx1SyncCellLo(model) {
  var lo = null;
  model.rows.forEach(function(row) { row.forEach(function(c) { if (c && c.sync) lo = c.lo; }); });
  return lo;
}
function fx1CellIsSyncDriven(model, paramLo) {
  var found = null;
  model.rows.forEach(function(row) { row.forEach(function(c) { if (c && c.lo === paramLo) found = c; }); });
  return !!(found && found.syncDriven);
}
function fx1CurrentSyncZone(model) {
  var syncLo = fx1SyncCellLo(model);
  if (syncLo === null) return 0;
  var sel = document.getElementById('fx1-sync-' + syncLo.toString(16).padStart(2,'0'));
  return sel ? (parseInt(sel.value, 10) || 0) : 0;
}
// Grabbing/restoring a Sync-driven knob clears Sync first, once, mirroring
// the amp Speed/Sync interlock (R7) — hands control back to the user
// exactly like the rack's own front-panel knob, rather than write-guarding
// or greying the knob out (both tried and rejected for the amp case).
function fx1ClearSyncIfDriving(model, paramLo) {
  if (!fx1CellIsSyncDriven(model, paramLo)) return;
  var syncLo = fx1SyncCellLo(model);
  if (syncLo === null) return;
  if (fx1CurrentSyncZone(model) === 0) return;
  updateFx1Knob(syncLo, 0);
  if (bridgeMidiReady) sendFx1ParamWrite(syncLo, 0);
  appLog('FX1 knob 0x' + paramLo.toString(16).padStart(2,'0') + ' moved while Sync was engaged'
         + ' — clearing Sync to OFF first (the rack does the same)');
}

// ── FX1 knob drag — delegated, keyed on data-fx1-lo (hex paramLo) ──
(function() {
  var dragging = false, startY = 0, startVal = 0, activeWrap = null, activeParamLo = -1;
  var syncClearedThisFx1Drag = false;

  document.addEventListener('mousedown', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-fx1-lo]');
    if (!wrap) return;
    activeParamLo = parseInt(wrap.dataset.fx1Lo, 16);
    if (isNaN(activeParamLo)) return;
    activeWrap = wrap;
    startVal = (wrap.dataset.value !== undefined && wrap.dataset.value !== '') ? parseInt(wrap.dataset.value) : 64;
    startY = e.clientY;
    dragging = true;
    syncClearedThisFx1Drag = false;   // one Sync clear per drag, not per mousemove
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    if (e.buttons === 0) { dragging = false; activeWrap = null; return; }
    var val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    updateFx1Knob(activeParamLo, val);
    // Snapshot before queuing — see the DIST handler above for why. This is
    // the exact bug that produced paramLo=-1 (byte 0xFF, an illegal SysEx
    // data byte) mid-message and wedged the hardware, 2026-07-30, FX1 Ratio.
    var lo = activeParamLo;
    var model = currentFx1Model();
    if (model && !syncClearedThisFx1Drag && fx1CellIsSyncDriven(model, lo) && fx1CurrentSyncZone(model) !== 0) {
      syncClearedThisFx1Drag = true;
      fx1ClearSyncIfDriving(model, lo);
    }
    if (bridgeMidiReady) queueKnobSend('fx1:' + lo, function(v) { sendFx1ParamWrite(lo, v); }, val);
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeParamLo = -1; });
  window.addEventListener('blur', function() { dragging = false; activeWrap = null; activeParamLo = -1; });

  document.addEventListener('dblclick', function(e) {
    var wrap = e.target.closest('.knob-wrap[data-fx1-lo]');
    if (!wrap) return;
    var paramLo = parseInt(wrap.dataset.fx1Lo, 16);
    if (isNaN(paramLo)) return;
    // R8 — restore to the load baseline (R3's dataset.orig), not a fixed
    // centre value.
    var val = (wrap.dataset.orig !== undefined && wrap.dataset.orig !== '') ? parseInt(wrap.dataset.orig) : 64;
    var model = currentFx1Model();
    if (model) fx1ClearSyncIfDriving(model, paramLo);   // R7 — restore is a knob move too
    updateFx1Knob(paramLo, val);
    if (bridgeMidiReady) queueKnobSend('fx1:' + paramLo, function(v) { sendFx1ParamWrite(paramLo, v); }, val);
  });
})();
