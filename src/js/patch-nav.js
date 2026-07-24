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
    // Absolute-slot recall, as used by the Avid editor.
    hex = 'F0 13 0B 0F 00 02 00 ' + hh(slot) + ' F7';
    how = 'SYSEX recall';
  } else {
    hex = 'C0 ' + hh(slot);
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
    for (let i = 0; i <= MAX_SLOT; i++) {
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = slotLabel(i);
      sel.appendChild(opt);
    }
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
