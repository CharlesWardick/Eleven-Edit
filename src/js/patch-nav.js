// ════════════════════════════════════════════════════════════════════
// PATCH-NAV.JS — patch navigation and auto-roll.
// ════════════════════════════════════════════════════════════════════

// Patch recall method. Set to false to fall back to Program Change.
var USE_SYSEX_RECALL = true;

async function sendPC(slot) {
  if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }

  var hh = v => v.toString(16).padStart(2,'0').toUpperCase();
  var hex, how;

  if (USE_SYSEX_RECALL) {
    // Absolute-slot recall, as used by the Avid editor. The byte before the
    // raw slot is the space flag (0=user A1-Z4, 1=factory a1-z4, confirmed
    // 2026-08-28 via capture) — was hardcoded 0x00 before factory patches
    // were addressable at all.
    const sr = slotToSpaceRaw(slot);
    hex = 'F0 13 0B 0F 00 02 ' + hh(sr.space) + ' ' + hh(sr.rawSlot) + ' F7';
    how = 'SYSEX recall';
  } else {
    // Program Change is 7-bit (0-127) and can't address the full 0-207
    // range — this fallback predates factory-patch support and was never
    // extended to it; USE_SYSEX_RECALL stays true for anything past Z4.
    hex = 'C0 ' + hh(Math.min(slot, 127));
    how = 'PC';
  }

  if (sendHex(hex)) {
    monitorLog('OUT', how + ' → ' + slot + ' (' + slotLabel(slot) + ')');
    setStatus('→ ' + slotLabel(slot));
  }
}

function populateRangeSelects() {
  ['range-from', 'range-to'].forEach((id, idx) => {
    const sel = document.getElementById(id);
    sel.innerHTML = '';
    for (let i = 0; i <= MAX_NAV_SLOT; i++) {
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = slotLabel(i);
      sel.appendChild(opt);
    }
    // Default range stays USER-only (A1-Z4) — factory browsing/auto-advance
    // is opt-in via these same selects, not the out-of-the-box default.
    sel.value = idx === 0 ? 0 : MAX_SLOT;
  });
  updateRangeLabel();
}

function getRangeFrom() { return parseInt(document.getElementById('range-from').value); }
function getRangeTo()   { return parseInt(document.getElementById('range-to').value);   }

function updateRangeLabel() {
  const lo = Math.min(getRangeFrom(), getRangeTo());
  const hi = Math.max(getRangeFrom(), getRangeTo());
  document.getElementById('range-active').textContent = slotLabel(lo) + ' — ' + slotLabel(hi);
}

document.getElementById('range-from').addEventListener('change', updateRangeLabel);
document.getElementById('range-to').addEventListener('change',   updateRangeLabel);

function goToSlot(slot) {
  lastNavTime = performance.now();
  paramSettleBaseline = {};
  // Bug Report #2 follow-up (2026-08-11): a patch recall turns the tuner
  // off on hardware and shows the next patch's details in its place —
  // confirmed, deterministic behaviour, the same thing Avid's own editor
  // mimics locally instead of waiting for a broadcast. We otherwise leave
  // tunerOn stale (still showing ON) until/unless a CC 69 broadcast happens
  // to arrive, which a nav doesn't reliably produce. Mimic it directly here
  // rather than waiting — same "predict what the confirmed hardware
  // behaviour will be" logic as the roller's own pause gates, just applied
  // to a display value instead of the roll.
  if (tunerOn) {
    tunerOn = false;
    document.getElementById('btn-tuner').classList.remove('on');
    appLog('Tuner OFF — patch change (mimicked, matches Avid editor behaviour)');
  }
  updateDisplay(slot);
  sendPC(slot);
  clearStaleReadoutsOnNav();
  requestPatchStateAfterNav();
}

function stepNav(dir) {
  stopAuto();
  const lo = Math.min(getRangeFrom(), getRangeTo());
  const hi = Math.max(getRangeFrom(), getRangeTo());
  let next = currentSlot + dir;
  if (next > hi) next = lo;
  if (next < lo) next = hi;
  goToSlot(next);
}

document.getElementById('btn-prev').addEventListener('click', () => stepNav(-1));
document.getElementById('btn-next').addEventListener('click', () => stepNav(1));

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp')   { e.preventDefault(); stepNav(1);  }
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowDown') { e.preventDefault(); stepNav(-1); }
  if (e.key === ' ') { e.preventDefault(); if (autoTimer || autoPaused) togglePause(); else startAuto(); }
  if (e.key === '+' || e.key === '=') applyZoom(0.1);
  if (e.key === '-' || e.key === '_') applyZoom(-0.1);
});

// ════════════════════════════════════════════════════════════════════
// AUTO-ADVANCE
// ════════════════════════════════════════════════════════════════════
function getInterval() { return parseInt(document.getElementById('interval-select').value) * 1000; }

function autoStep() {
  const lo = Math.min(getRangeFrom(), getRangeTo());
  const hi = Math.max(getRangeFrom(), getRangeTo());
  let next = currentSlot + 1;
  if (next > hi) next = lo;
  goToSlot(next);
}

function scheduleNext() {
  const remaining = getInterval() - autoElapsed;
  autoTimer = setTimeout(() => {
    autoStep(); autoElapsed = 0; autoStartTime = performance.now(); scheduleNext();
  }, Math.max(200, remaining));
}

function startProgressRAF() {
  cancelAnimationFrame(autoRafId);
  const tick = () => {
    if (autoPaused || !autoStartTime) return;
    const elapsed = autoElapsed + (performance.now() - autoStartTime);
    const interval = getInterval();
    document.getElementById('progress-bar').style.width = Math.min(elapsed/interval*100,100) + '%';
    document.getElementById('progress-label').textContent = Math.max(0,(interval-elapsed)/1000).toFixed(1) + 's';
    autoRafId = requestAnimationFrame(tick);
  };
  autoRafId = requestAnimationFrame(tick);
}

function startAuto() {
  if (!midiOutName) { setStatus('Select primary output first'); return; }
  const lo = Math.min(getRangeFrom(), getRangeTo());
  const hi = Math.max(getRangeFrom(), getRangeTo());
  // After Stop (or at launch), always jump to FROM regardless of current slot.
  // After Pause/Resume, currentSlot is left alone — Resume continues from where paused.
  if (wasStopped || currentSlot < lo || currentSlot > hi) goToSlot(lo);
  wasStopped = false;
  autoElapsed = 0; autoPaused = false; autoStartTime = performance.now();
  scheduleNext(); startProgressRAF();
  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-start').classList.add('running');
  document.getElementById('btn-start').textContent = '▶ RUNNING';
  document.getElementById('btn-pause').disabled = false;
  document.getElementById('btn-stop').disabled  = false;
  setStatus('Rolling ' + slotLabel(lo) + '→' + slotLabel(hi) + ' every ' + (getInterval()/1000) + 's');
  appLog('Auto-advance started: ' + slotLabel(lo) + '→' + slotLabel(hi));
}

function togglePause() {
  if (autoPaused) {
    autoPaused = false; autoStartTime = performance.now();
    scheduleNext(); startProgressRAF();
    document.getElementById('btn-pause').textContent = '⏸ PAUSE';
    document.getElementById('btn-pause').classList.remove('paused');
    setStatus('Resumed');
  } else {
    autoPaused = true; autoElapsed += performance.now() - autoStartTime;
    clearTimeout(autoTimer); autoTimer = null; cancelAnimationFrame(autoRafId);
    document.getElementById('btn-pause').textContent = '▶ RESUME';
    document.getElementById('btn-pause').classList.add('paused');
    setStatus('Paused');
  }
}

function stopAuto() {
  clearTimeout(autoTimer); cancelAnimationFrame(autoRafId);
  autoTimer = null; autoRafId = null; autoPaused = false; autoElapsed = 0; autoStartTime = null;
  wasStopped = true;
  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-start').classList.remove('running');
  document.getElementById('btn-start').textContent = '▶ START';
  document.getElementById('btn-pause').disabled = true;
  document.getElementById('btn-pause').classList.remove('paused');
  document.getElementById('btn-pause').textContent = '⏸ PAUSE';
  document.getElementById('btn-stop').disabled  = true;
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('progress-label').textContent = '—';
}

document.getElementById('btn-start').addEventListener('click', startAuto);
document.getElementById('btn-pause').addEventListener('click', togglePause);
document.getElementById('btn-stop').addEventListener('click',  stopAuto);

// ════════════════════════════════════════════════════════════════════
// ROLLER SAFETY GATES — TFX/Bank ops (2026-08-11, Bug Report #1 follow-up)
// ════════════════════════════════════════════════════════════════════
// SAVE (software) — mimics the confirmed HW-save pause: pauses the instant
// the user commits to saving, unconditionally (not gated on the patch
// being dirty, and not waiting to see whether a save actually lands) —
// Charlie's own call. A pause, not a stop: Resume picks the roll back up
// exactly where it was, same as every other pause trigger.
function pauseRollerForSave() {
  if (autoStartTime === null || autoPaused) return;
  togglePause();
  appLog('Roller paused — SAVE initiated by user');
}

// Tuner (2026-08-11 extension) — same shape as pauseRollerForSave. Called
// from handleTunerCC (ui.js) only on the confirmed ON transition, not on
// the local click, matching that function's own "wait for hardware, don't
// trust our own click assumption" contract.
function pauseRollerForTuner() {
  if (autoStartTime === null || autoPaused) return;
  togglePause();
  appLog('Roller paused — tuner engaged');
}

// Load TFX / Export All Rigs / Import Rigs — these drive their OWN slot
// navigation (bank-wide walks, or a raw memory write with no fixed slot),
// which directly conflicts with the roller's — Charlie's call was the
// simple fix (option "a"): force a full STOP, not a pause, since Resume
// afterward wouldn't mean anything (the roller's position/context is
// stale once one of these has run). Gated on "armed" (autoStartTime !==
// null) rather than strictly "running", so a paused-but-armed roller also
// gets stopped, not left in a stale paused state.
function stopRollerForBankOp(reason) {
  if (autoStartTime === null) return;
  stopAuto();
  appLog('Auto-advance stopped — ' + reason);
  setStatus('Auto-advance stopped — ' + reason);
}

// ════════════════════════════════════════════════════════════════════
// TUNER
// ════════════════════════════════════════════════════════════════════
document.getElementById('btn-tuner').addEventListener('click', () => {
  // Request the opposite of whatever we last confirmed — the actual UI
  // update happens in handleTunerCC() once the hardware confirms it,
  // not here. Keeps one single source of truth for the state, whether
  // it changed from here, the physical button, or Avid.
  sendCC(CC_TUNER, tunerOn ? 0 : 127);
});

// ════════════════════════════════════════════════════════════════════
// MONITOR
// ════════════════════════════════════════════════════════════════════
