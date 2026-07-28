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
// PATTERN for a new block (copy the DIST functions below — REVERB adds
// the optional linked dropdown+knob "selector" cell and a ms/unit
// display on top of the plain DIST pattern, for blocks that need one):
//   open<Block>Panel() / close<Block>Panel()
//   render<Block>Knobs(mid)              — build the knob row DOM
//   update<Block>Knob(paramLo, val)      — apply one CMD 0x11 value
//   refresh<Block>PanelAfterChainMap()   — re-sync model + re-query
//   a delegated drag handler keyed on a data-<block>-lo attribute
//
// PURE RELOCATION (7/27): every function below is unchanged from its
// original position in ui.js — same logic, same comments, same
// behaviour. Nothing was rewritten.
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
