/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// RIG-BALANCE.JS — Rig Balancing (level-matching) mode. 2026-08-31.
// Full spec: docs/RigBalancing_Brief.txt.
//
// THE CORE IDEA: the Eleven Rack front panel's Rig Balancing ("hold edits
// across nav, commit on exit") is a RACK SCREEN MODE — there is no MIDI
// command to enter it. Over the bridge every nav is a real patch recall that
// RESETS any unsaved Rig Vol back to the stored value. So this app BUFFERS the
// edits itself (rigBalBuffer, state.js) and commits only the dirty ones on
// exit. That buffer is what enables the ABORT (Discard All) the rack/Avid lack.
//
// Live Rig Vol here is sent RAW (B0 11 xx via sendHex) — NOT through sendCC/
// sendPatchWrite, which would light the normal per-patch SAVE dirty latch
// (PER_PATCH_CCS = [17], transport.js). Buffer-and-defer is the whole point,
// so the mode must never touch the app's normal save/dirty path while walking.
// ════════════════════════════════════════════════════════════════════

// How long to wait after a recall for the CMD 0x07 Rig Vol broadcast to land
// (handleRigVolumeBroadcast writes rig-vol-wrap.dataset.value). Polled, capped.
var RB_READ_TIMEOUT = 1200;
var RB_POLL_STEP    = 40;
// Small settle between the commit steps of Save Changed (recall -> CC -> save).
var RB_COMMIT_SETTLE = 250;

var rigBalKnobInited = false;
var rigBalBusy = false;   // true during a pre-scan or a commit run — blocks input

// ── Raw, NON-dirtying CC17 (Rig Vol) live send. Deliberately bypasses
//    sendCC/sendPatchWrite so the normal SAVE dirty latch never arms.
function rbSendRigVolRaw(v127) {
  if (!bridgeMidiReady) return;
  var hex = 'B0 11 ' + v127.toString(16).padStart(2, '0').toUpperCase();
  sendHex(hex);
}

// ── Recall a slot and read back the STORED Rig Vol the recall resets to.
//    A recall ALWAYS resets to the stored value, so the post-nav 0x07
//    broadcast is the true baseline — perfect moment to record it. Returns
//    the v127 (0-127) or null if no broadcast arrived in time.
async function rbNavAndReadStored(slot) {
  var wrap = document.getElementById('rig-vol-wrap');
  if (wrap) wrap.dataset.value = '';   // sentinel — broadcast will refill it
  rbNavPending = true;
  goToSlot(slot);
  var waited = 0;
  while (waited < RB_READ_TIMEOUT) {
    await sleep(RB_POLL_STEP);
    waited += RB_POLL_STEP;
    if (wrap && wrap.dataset.value !== '' && wrap.dataset.value !== undefined) {
      await sleep(120);   // let the recall's own 0x07 burst finish before edits count
      rbNavPending = false;
      return parseInt(wrap.dataset.value);
    }
  }
  rbNavPending = false;
  return null;
}

// ── Build the responsive flow grid: 104 self-labeling cells in slot order
//    (A1 A2 A3 A4 B1 …). No A-Z/1-4 framing — each cell carries its own id.
//    The CSS grid (index.html) auto-fills as many columns as the window allows,
//    so one markup is dense full-screen and readable in a small window; a
//    left-to-right-then-down read is the sequential walk order at any width.
(function buildRigBalGrid() {
  var grid = document.getElementById('rigbal-grid');
  if (!grid) return;
  for (var slot = 0; slot <= MAX_SLOT; slot++) {
    var cell = document.createElement('div');
    cell.className = 'rb-cell unknown';
    cell.dataset.slot = slot;
    var inner = document.createElement('div');
    inner.className = 'rb-cell-inner';
    var idEl = document.createElement('span');
    idEl.className = 'rb-id'; idEl.textContent = slotLabel(slot);
    var nameEl = document.createElement('span');
    nameEl.className = 'rb-name';
    var dbEl = document.createElement('span');
    dbEl.className = 'rb-db'; dbEl.textContent = '—';
    inner.appendChild(idEl); inner.appendChild(nameEl); inner.appendChild(dbEl);
    cell.appendChild(inner);
    cell.addEventListener('click', (function(s) {
      return function() { if (!rigBalBusy) rbSelectSlot(s); };
    })(slot));
    grid.appendChild(cell);
  }
})();

function rbCell(slot) {
  return document.querySelector('#rigbal-grid .rb-cell[data-slot="' + slot + '"]');
}

// ── Paint one row's name + dB + state class from current buffer/known maps.
function rbRefreshCell(slot) {
  var td = rbCell(slot);
  if (!td) return;
  var nameEl = td.querySelector('.rb-name');
  var dbEl   = td.querySelector('.rb-db');
  nameEl.textContent = (patchNameCache[slot] !== undefined && patchNameCache[slot] !== '')
    ? patchNameCache[slot] : '—';

  var dirty = (rigBalBuffer[slot] !== undefined);
  var known = (rigBalKnown[slot] !== undefined);
  var v = dirty ? rigBalBuffer[slot] : (known ? rigBalKnown[slot] : null);
  dbEl.textContent = (v !== null) ? rbDbText(slot, v) : '—';

  td.classList.toggle('dirty', dirty);
  td.classList.toggle('known', !dirty && known);
  td.classList.toggle('unknown', !dirty && !known);
  td.classList.toggle('current', slot === rigBalSelected);
}

function rbRefreshAll() {
  for (var s = 0; s <= MAX_SLOT; s++) rbRefreshCell(s);
}

// ── Bind the shared knob to a slot's value and update the header readout.
function rbBindKnob(slot) {
  var wrap = document.getElementById('rigbal-knob-wrap');
  if (!wrap) return;
  var dirty = (rigBalBuffer[slot] !== undefined);
  var v = dirty ? rigBalBuffer[slot]
                : (rigBalKnown[slot] !== undefined ? rigBalKnown[slot] : 64);
  wrap.dataset.value = v;
  // Baseline tick / double-click revert target = the slot's FIRST-seen value
  // (rigBalOrig), set once and never overwritten so revert works on every
  // revisit. Drawn ONLY once that real value is known — on a first visit the
  // pre-read bind leaves it blank (no tick) so there's no centre-fallback tick
  // that flashes then jumps when the readback lands (2026-08-31, Charlie).
  if (rigBalOrig[slot] !== undefined) wrap.dataset.orig = rigBalOrig[slot];
  else wrap.dataset.orig = '';   // suppresses the tick until the real value is read
  drawKnob(wrap.querySelector('canvas'), v);
  document.getElementById('rigbal-knob-val').textContent =
    (rigBalKnown[slot] !== undefined || dirty) ? rbDbText(slot, v) : '--';
  document.getElementById('rigbal-knob-sel').textContent = slotLabel(slot);
}

// ── Select a row: real recall so it plays, record the stored baseline, then
//    re-apply any pending edit live so what you HEAR is your edit-in-progress.
async function rbSelectSlot(slot) {
  if (rigBalBusy) return;
  // Clicking the row that's already selected does nothing — no redundant recall/
  // re-read (that was the knob-tick blink Charlie saw on a second click).
  if (slot === rigBalSelected) return;
  rigBalSelected = slot;
  rbRefreshAll();               // move the 'current' highlight immediately
  rbBindKnob(slot);

  var stored = await rbNavAndReadStored(slot);
  if (stored !== null) {
    if (rigBalOrig[slot] === undefined) rigBalOrig[slot] = stored;   // first-seen, immutable
    // Only trust the recall's reset value as the current baseline when the row
    // is NOT dirty — a dirty row we're about to re-assert would poison it.
    if (rigBalBuffer[slot] === undefined) rigBalKnown[slot] = stored;
    else if (rigBalKnown[slot] === undefined) rigBalKnown[slot] = stored;
  }

  // Re-assert a pending edit so it's audible on land (recall reset it away).
  rbAssert(slot);

  if (slot === rigBalSelected) { rbBindKnob(slot); rbRefreshCell(slot); }
}

// ── Knob turned: update the selected row's buffer + dB + dirty marker and
//    send CC17 RAW (live, non-saving). Reverting to the stored value clears
//    dirty (e.g. double-click).
function rbKnobChanged(v127) {
  if (rigBalBusy) return;   // ignore knob input during the pre-scan / commit run
  var slot = rigBalSelected;
  if (slot === null || slot === undefined) return;
  delete rigBalBufferRaw[slot];          // app-knob edits are 0-127 (CC17)
  var stored = rigBalKnown[slot];
  if (stored !== undefined && v127 === stored) {
    delete rigBalBuffer[slot];          // back to stored — no longer dirty
  } else {
    rigBalBuffer[slot] = v127;
  }
  document.getElementById('rigbal-knob-val').textContent = rbDbText(slot, v127);
  rbRefreshCell(slot);
  rbSendRigVolRaw(v127);
}

function rbDirtyList() {
  return Object.keys(rigBalBuffer).map(Number).sort(function(a, b) { return a - b; });
}

// ── ENTRY ───────────────────────────────────────────────────────────────
function rbOpenEntry() {
  if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }
  // Stop the auto-roll the moment Rig Balancing is opened — consistent with
  // Load/Import/Export, which stop on click (2026-09-08, Charlie's call). This
  // rbEnter's own stop below stays as a harmless backstop.
  if (typeof stopRollerForBankOp === 'function') stopRollerForBankOp('Rig Balancing');
  // Build 61: no Quick/Detail chooser any more — the silent full read is fast
  // (~16s for 104), so the mode opens straight into it.
  rbEnter();
}

async function rbEnter() {

  // Stop any auto-roll first — same guard the other bank ops use — so a roll
  // can't fire navs into the middle of the balance walk.
  if (typeof stopRollerForBankOp === 'function') stopRollerForBankOp('Rig Balancing');

  rigBalActive = true;
  rigBalReturnSlot = (typeof currentSlot !== 'undefined') ? currentSlot : 0;
  rigBalSelected = null;
  rigBalKnown = {};
  rigBalOrig = {};
  rigBalBuffer = {};
  rigBalBufferRaw = {};
  rigBalExactDb = {};
  rigBalStoredRaw = {};

  if (!rigBalKnobInited) {
    initKnob('rigbal-knob-wrap', 'rigbal-knob-val', valRigVol, rbKnobChanged);
    rigBalKnobInited = true;
  }

  document.getElementById('rigbal-overlay').classList.add('open');
  rbRefreshAll();
  appLog('Rig Balancing: entered from ' + slotLabel(rigBalReturnSlot));

  await rbDetailPrescan();
}

// ── DETAIL pre-scan: SILENT read of all 104 (build 60) so every dB is populated
//    without walking the rack — the front panel stays on the current patch.
// Grey out + block the shared knob while the pre-scan is running, so it's
// visibly "not ready yet" and can't be grabbed before there's a selected row.
function rbSetKnobBusyUI(busy) {
  var wrap = document.getElementById('rigbal-knob-wrap');
  if (wrap) { wrap.style.pointerEvents = busy ? 'none' : ''; wrap.style.opacity = busy ? '0.35' : ''; }
  var sel = document.getElementById('rigbal-knob-sel');
  if (sel && busy) sel.textContent = 'scanning…';
}

// ── Silent (no-recall) read of a slot's STORED Rig Vol, straight from the patch
//    body — no recall, the front panel never moves. Tech Ref Sec 14 lists the
//    RVol KEY at 0x28; the signed-LE32 VALUE is the 4 bytes after it (0x2C), same
//    key+4 layout as To Amp. Scaling = the rack's own: the top 7 bits of the
//    offset int32, floor((raw + 2^31) / 2^25) — matched the recall broadcast on
//    104/104 slots (build 59 verify, 2026-09-24); gateRawToV127's rounding was
//    one step low on 10. Returns v127 (0-127) or null.
async function rbReadStoredSilent(slot) {
  var res = await readSlotBodySilent(slot);
  if (!res || !res.body) return null;
  var raw = readSignedLE32(res.body, 0x2C);
  if (raw === null || raw === undefined) return null;
  rigBalExactDb[slot] = rigVolDbFromRaw(raw);   // build 75: exact rack readout
  rigBalStoredRaw[slot] = raw;
  return Math.floor((raw + 2147483648) / 33554432);
}
// Exact stored dB per slot (full precision, build 75). Shown whenever the slot
// is at its stored value; an edit (0-127 knob) shows the knob's own value.
var rigBalExactDb = {};
var rigBalStoredRaw = {};   // stored full-precision value per slot (silent read)
// Full-precision edit per slot (build 78) — set when the edit came from the
// RACK's own Rig Vol knob (finer than the app's 0-127), committed exactly via
// the full set 00 07 [5 bytes] (proven build 77: rack applies + echoes 02 07).
var rigBalBufferRaw = {};
var rbNavPending = false;   // true while a recall is landing — its 0x07 is NOT an edit

function rbSendRigVolFull(raw) {
  if (!bridgeMidiReady) return;
  sendHex('F0 13 0B 0F 00 07 ' + encodeFull32Hex(raw) + ' F7');
}
// Re-assert a slot's pending edit: exact if it came from the rack, else CC17.
function rbAssert(slot) {
  if (rigBalBufferRaw[slot] !== undefined) rbSendRigVolFull(rigBalBufferRaw[slot]);
  else if (rigBalBuffer[slot] !== undefined) rbSendRigVolRaw(rigBalBuffer[slot]);
}

// Rack front-panel Rig Vol turned while Rig Balancing is open (called from
// handleRigVolumeBroadcast, sysex-handler.js). Treated exactly like an app-knob
// edit on the selected row. Ignored while a recall lands, a scan/commit runs, or
// no row is selected. Our own sends echo back here too — harmless (same value).
function rbRackKnob(v127, raw) {
  if (!rigBalActive || rigBalBusy || rbNavPending) return;
  var slot = rigBalSelected;
  if (slot === null || slot === undefined || raw === null) return;
  if (rigBalStoredRaw[slot] !== undefined && raw === rigBalStoredRaw[slot]) {
    delete rigBalBuffer[slot]; delete rigBalBufferRaw[slot];
  } else {
    rigBalBuffer[slot] = v127; rigBalBufferRaw[slot] = raw;
  }
  var wrap = document.getElementById('rigbal-knob-wrap');
  if (wrap) { wrap.dataset.value = v127; drawKnob(wrap.querySelector('canvas'), v127); }
  document.getElementById('rigbal-knob-val').textContent = rbDbText(slot, v127);
  rbRefreshCell(slot);
}

function rbDbText(slot, v) {
  if (rigBalBufferRaw[slot] !== undefined) return fmtDb1(rigVolDbFromRaw(rigBalBufferRaw[slot]));
  if (rigBalBuffer[slot] === undefined && rigBalExactDb[slot] !== undefined
      && rigBalKnown[slot] !== undefined && v === rigBalKnown[slot]) {
    return fmtDb1(rigBalExactDb[slot]);
  }
  return valRigVol(v);
}

async function rbDetailPrescan() {
  rigBalBusy = true;
  rbSetKnobBusyUI(true);
  setStatus('Rig Balancing: scanning all 104 rigs…');
  for (var slot = 0; slot <= MAX_SLOT; slot++) {
    if (!rigBalActive) { rigBalBusy = false; rbSetKnobBusyUI(false); return; }   // bailed out mid-scan
    var stored = await rbReadStoredSilent(slot);
    if (stored !== null) {
      rigBalKnown[slot] = stored;
      if (rigBalOrig[slot] === undefined) rigBalOrig[slot] = stored;
    }
    rbRefreshCell(slot);
    setStatus('Rig Balancing: reading ' + slotLabel(slot) + ' (' + (slot + 1) + '/104)…');
  }
  rigBalBusy = false;
  rbSetKnobBusyUI(false);
  setStatus('Rig Balancing: scan complete');
  rbSelectSlot(rigBalReturnSlot);
}

// ── EXIT ────────────────────────────────────────────────────────────────
// Three-way: SAVE CHANGED / DISCARD ALL both route through a confirm whose
// Cancel returns to the list still editing (the brief's third option).
var rbPendingAction = null;

function rbShowConfirm(msg, action) {
  rbPendingAction = action;
  document.getElementById('rigbal-confirm-msg').innerHTML = msg;
  document.getElementById('rigbal-confirm').classList.add('open');
}
function rbHideConfirm() {
  rbPendingAction = null;
  document.getElementById('rigbal-confirm').classList.remove('open');
}

function rbRequestSave() {
  var dirty = rbDirtyList();
  if (dirty.length === 0) { rbShowConfirm('No changes to save.<br>Close Rig Balancing?', 'close'); return; }
  var ids = dirty.map(slotLabel).join(', ');
  rbShowConfirm(
    'Save <b>' + dirty.length + '</b> changed rig' + (dirty.length === 1 ? '' : 's') +
    ' to the rack?<br><span style="color:#999;font-size:12px;">' + ids + '</span>' +
    '<br><br><span style="color:#999;font-size:12px;">Each is a real slot save with a brief audio blip.</span>',
    'save');
}
function rbRequestDiscard() {
  var dirty = rbDirtyList();
  if (dirty.length === 0) { rbCloseMode(); return; }
  rbShowConfirm(
    'Discard <b>' + dirty.length + '</b> edit' + (dirty.length === 1 ? '' : 's') +
    ' and save nothing?<br><span style="color:#999;font-size:12px;">This cannot be undone.</span>',
    'discard');
}

async function rbConfirmOk() {
  var action = rbPendingAction;
  rbHideConfirm();
  if (action === 'save')         await rbCommitAndClose();
  else if (action === 'discard') rbCloseMode();      // buffer thrown away in close
  else if (action === 'close')   rbCloseMode();
}

// ── COMMIT (Save Changed): for each dirty slot, recall -> raw CC17 buffered
//    value -> Save to Rack to the SAME slot (reuses saveCurrentPatchToSlot,
//    user-slot-guarded). Steps through them one by one like the front panel.
async function rbCommitAndClose() {
  var dirty = rbDirtyList();
  rigBalBusy = true;
  appLog('Rig Balancing: committing ' + dirty.length + ' changed rigs');
  for (var i = 0; i < dirty.length; i++) {
    var slot = dirty[i];
    setStatus('Rig Balancing: saving ' + slotLabel(slot) + ' (' + (i + 1) + '/' + dirty.length + ')…');
    await rbNavAndReadStored(slot);            // load the patch onto hardware
    rbAssert(slot);                            // assert the edited Rig Vol (exact if from the rack)
    await sleep(RB_COMMIT_SETTLE);
    var nm = (patchNameCache[slot] !== undefined) ? patchNameCache[slot] : undefined;
    await saveCurrentPatchToSlot(nm, slot);    // commit whole patch back to same slot
    await sleep(RB_COMMIT_SETTLE);
    rigBalKnown[slot] = rigBalBuffer[slot];    // committed value is the new stored baseline
    if (rigBalBufferRaw[slot] !== undefined) {
      rigBalStoredRaw[slot] = rigBalBufferRaw[slot];
      rigBalExactDb[slot] = rigVolDbFromRaw(rigBalBufferRaw[slot]);
    } else {
      delete rigBalStoredRaw[slot]; delete rigBalExactDb[slot];
    }
    delete rigBalBuffer[slot];
    delete rigBalBufferRaw[slot];
    rbRefreshCell(slot);
  }
  rigBalBusy = false;
  appLog('Rig Balancing: commit complete');
  rbCloseMode();
}

// ── Close: drop the buffer, leave the mode, land back on the entry patch.
function rbCloseMode() {
  rigBalActive = false;
  rigBalBusy = false;
  rigBalBuffer = {};
  rigBalSelected = null;
  rbHideConfirm();
  document.getElementById('rigbal-overlay').classList.remove('open');
  if (rigBalReturnSlot !== null && typeof goToSlot === 'function') {
    goToSlot(rigBalReturnSlot);
  }
  setStatus('Rig Balancing: closed');
}

// ── Keyboard nav within the list (sequential; tune live).
document.addEventListener('keydown', function(e) {
  if (!rigBalActive || rigBalBusy) return;
  if (document.getElementById('rigbal-confirm').classList.contains('open')) {
    if (e.key === 'Escape') { rbHideConfirm(); e.preventDefault(); }
    return;
  }
  var sel = (rigBalSelected === null) ? rigBalReturnSlot : rigBalSelected;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    if (sel < MAX_SLOT) rbSelectSlot(sel + 1); e.preventDefault();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    if (sel > 0) rbSelectSlot(sel - 1); e.preventDefault();
  } else if (e.key === 'Escape') {
    rbRequestDiscard(); e.preventDefault();
  }
});

// ── Wire buttons.
(function wireRigBalance() {
  var byId = function(id) { return document.getElementById(id); };
  if (byId('btn-rig-balance')) byId('btn-rig-balance').addEventListener('click', rbOpenEntry);
  if (byId('rigbal-save'))    byId('rigbal-save').addEventListener('click', rbRequestSave);
  if (byId('rigbal-discard')) byId('rigbal-discard').addEventListener('click', rbRequestDiscard);
  if (byId('rigbal-cancel'))  byId('rigbal-cancel').addEventListener('click', rbRequestDiscard);
  if (byId('rigbal-confirm-ok')) byId('rigbal-confirm-ok').addEventListener('click', rbConfirmOk);
  if (byId('rigbal-confirm-no')) byId('rigbal-confirm-no').addEventListener('click', rbHideConfirm);
})();

