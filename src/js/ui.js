// ════════════════════════════════════════════════════════════════════
// UI.JS — knob rendering, value formatting, enable/disable state,
// display updates. Everything that touches the DOM to show something,
// as opposed to transport.js (sends/receives) or protocol.js (decodes).
// ════════════════════════════════════════════════════════════════════

function drawKnob(canvas, value127) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w/2, cy = h/2, r = (w-6)/2;

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
    ctx.strokeStyle = '#e0a020'; ctx.lineWidth = 5; ctx.lineCap = 'round';
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
  ctx.fillStyle = '#e0a020'; ctx.fill();
  ctx.restore();
}

function valDisplay(v127) { return (v127/127*10).toFixed(1); }

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

// Amp Out Level: 0-127 maps -60dB to +18dB
function valAmpOut(v127) {
  const db = -60 + (v127 / 127) * 78;
  return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
}

// To Amp 1/2 Volume: 0-127 maps -12dB to +12dB. v0=0x00 = MUTE.
// Confirmed from Avid editor display 7/17/2026.
function valToAmpVol(v127) {
  if (v127 === 0) return 'MUTE';
  const db = -12 + (v127 / 127) * 24;
  return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
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
    val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    wrap.dataset.value = val;
    drawKnob(canvas, val);
    if (valSpan) valSpan.textContent = dispFn(val);
    if (onChangeCB) onChangeCB(val);
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  wrap.addEventListener('dblclick', () => {
    val = 64; wrap.dataset.value = 64;
    drawKnob(canvas, val); if (valSpan) valSpan.textContent = dispFn(val);
    if (onChangeCB) onChangeCB(64);
  });
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    val = parseInt(wrap.dataset.value) || 0;
    val = Math.max(0, Math.min(127, val - Math.sign(e.deltaY)));
    wrap.dataset.value = val;
    drawKnob(canvas, val); if (valSpan) valSpan.textContent = dispFn(val);
    if (onChangeCB) onChangeCB(val);
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
  const hasToggle = ap && ap.knobs && ap.knobs.some(k => k.type === 'toggle' && k.label === 'Bright');
  const btn = document.getElementById('btn-bright');
  if (btn) btn.style.display = hasToggle ? '' : 'none';
  const row = document.getElementById('amp-toggles-row');
  if (row) row.style.display = hasToggle ? 'flex' : 'none';
  if (!hasToggle) { brightOn = false; }
}

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
  const arrows = Array.from(strip.querySelectorAll('.chain-arr'));
  const hint   = strip.querySelector('.chain-drag-hint');
  const mono   = document.getElementById('mono-indicator');

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
  if (hint) strip.appendChild(hint);
  if (mono) strip.appendChild(mono);

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
    e.preventDefault();
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !activeWrap) return;
    const val = Math.max(0, Math.min(127, Math.round(startVal + (startY - e.clientY))));
    activeWrap.dataset.value = val;
    drawKnob(activeWrap.querySelector('canvas'), val);
    const vEl = document.getElementById('tone-v' + activeIdx);
    if (vEl) vEl.textContent = valDisplay(val);
    const ap = currentAmpKey ? AMP_TONE_PARAMS[currentAmpKey] : null;
    if (ap && currentParamHi >= 0) {
      const knobs = ap.knobs.filter(k => k.type === 'knob');
      if (activeIdx < knobs.length) sendParamWrite(knobs[activeIdx].lo, val);
    }
  });

  window.addEventListener('mouseup', function() { dragging = false; activeWrap = null; activeIdx = -1; });

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
      if (idx < knobs.length) sendParamWrite(knobs[idx].lo, 64);
    }
  });
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
