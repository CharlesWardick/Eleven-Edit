/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// RACK-CATALOG.JS — per-slot {name, amp, cab, mic} for every USER slot
// (A1-Z4), feeding the Rig Browser (build 151, feature/rig-browser).
//
// Source: the same silent by-slot read Export All uses (readSlotBodySilent,
// bank-transfer.js) — never navigates the rack. Decoded with the same keys
// the live patch load uses (sld6 amp, sldK cab, sldL mic — decodeAmpKey /
// decodeCabMicValues, protocol.js), done quietly here (no per-call logging).
//
// Kept in localStorage ('rackCatalog') so it shows instantly next launch.
// USER space can change while EE is closed, so every session re-reads each
// slot once in the BACKGROUND: one slot at a time, only while EE is idle
// (no clicks/keys for a moment, no nav, export, import, roller, Rig Balance),
// yielding immediately when the user acts. Saves EE sees in between (Save to
// Rack, front-panel save echo, Import, Jump List drag-drop) update the slot
// directly (rackCatalogPut).
//
// Background reading only (build 155 dropped the Off/At-startup options).
// Factory space is NOT covered yet — the silent read only addresses A1-Z4.
// ════════════════════════════════════════════════════════════════════

var RC_VERSION = 1;
var RC_IDLE_MS = 2000;       // quiet time after the last click/key/wheel before a read
var RC_NAV_QUIET_MS = 4000;  // quiet time after a patch nav
var RC_TICK_MS = 500;        // how often the walker checks for idle
var RC_START_DELAY_MS = 8000;// after the app is revealed, before the first read

var rackCatalog = { v: RC_VERSION, slots: {} };   // slot -> {n, amp, cab, mic, t}
var rcFresh = {};            // slots read or updated THIS session
var rcLastInput = 0, rcMouseDown = false, rcReading = false, rcTimer = null, rcStartAt = 0;
var rcDoneLogged = false;

function rcLoad() {
  try {
    var o = JSON.parse(localStorage.getItem('rackCatalog') || 'null');
    if (o && o.v === RC_VERSION && o.slots) rackCatalog = o;
  } catch (e) {}
}
function rcSave() { try { localStorage.setItem('rackCatalog', JSON.stringify(rackCatalog)); } catch (e) {} }

// Quiet decode of one body -> entry, or null if it doesn't look like a patch.
function rcKey(body, s) {
  var k0 = s.charCodeAt(3), k1 = s.charCodeAt(2), k2 = s.charCodeAt(1), k3 = s.charCodeAt(0);
  for (var i = 0; i < body.length - 7; i++) {
    if (body[i] === k0 && body[i+1] === k1 && body[i+2] === k2 && body[i+3] === k3) {
      return (body[i+4] | (body[i+5] << 8) | (body[i+6] << 16) | (body[i+7] << 24));
    }
  }
  return null;
}
function rackCatalogEntryFromBody(body) {
  if (!body || body.length < 100) return null;
  var ampId = rcKey(body, 'sld6'), cabRaw = rcKey(body, 'sldK'), mic = rcKey(body, 'sldL');
  var cabIdx = (cabRaw !== null && CAB_RAW_TO_INDEX[cabRaw] !== undefined) ? CAB_RAW_TO_INDEX[cabRaw] : null;
  return {
    n:   extractNameFromBody(body) || '',
    amp: (ampId !== null && AMP_ID_TO_KEY[ampId >>> 0]) || null,
    cab: cabIdx !== null ? CAB_TYPE_LIST[cabIdx].name : null,
    mic: (mic !== null && mic >= 0 && mic < MIC_TYPE_NAMES.length) ? MIC_TYPE_NAMES[mic] : null,
    rv:  (body.length > 0x2F) ? readSignedLE32(body, 0x2C) : null,   // build 161: stored Rig Vol (raw int32) for Rig Balancing
    t:   Date.now()
  };
}

// Live upkeep hook — call with a slot and the body the rack now holds there.
function rackCatalogPut(slot, body) {
  if (slot < 0 || slot > MAX_SLOT) return;
  var e = rackCatalogEntryFromBody(body instanceof Uint8Array ? body : new Uint8Array(body));
  if (!e) return;
  rackCatalog.slots[slot] = e;
  rcFresh[slot] = true;
  rcSave();
  if (typeof rigBrowserRefresh === 'function') rigBrowserRefresh();
  appLog('Rack catalog: ' + slotLabel(slot) + ' = "' + e.n + '" amp=' + e.amp + ' cab=' + e.cab + ' mic=' + e.mic);
}
function rackCatalogCount() {
  var n = 0; for (var s = 0; s <= MAX_SLOT; s++) if (rcFresh[s]) n++; return n;
}

function rcBusy() {
  var now = performance.now();
  if (typeof bridgeMidiReady === 'undefined' || !bridgeMidiReady) return 'no-midi';
  if (typeof appRevealed !== 'undefined' && !appRevealed) return 'startup';
  if (!rcStartAt) rcStartAt = now + RC_START_DELAY_MS;   // first tick after reveal
  if (now < rcStartAt) return 'start-delay';
  if (rcMouseDown || now - rcLastInput < RC_IDLE_MS) return 'user';
  if (typeof lastNavTime !== 'undefined' && lastNavTime !== null && now - lastNavTime < RC_NAV_QUIET_MS) return 'nav';
  if (typeof exportInProgress !== 'undefined' && exportInProgress) return 'export';
  if (typeof importInProgress !== 'undefined' && importInProgress) return 'import';
  if (typeof scanInProgress !== 'undefined' && scanInProgress) return 'scan';
  if (typeof patchNameScanInProgress !== 'undefined' && patchNameScanInProgress) return 'names';
  if (typeof pendingSilentResolve !== 'undefined' && pendingSilentResolve) return 'silent-read';
  if (typeof pendingManualCapture !== 'undefined' && pendingManualCapture) return 'capture';
  if (typeof rigBalActive !== 'undefined' && rigBalActive) return 'rig-balance';
  if (typeof autoStartTime !== 'undefined' && autoStartTime !== null && !autoPaused) return 'roller';
  return null;
}

// ── TEMP DIAG (build 222): Amp Out jump during cache build. Remember the last
// few catalog reads + each slot's own Amp Out, so an unsolicited rack change
// can be compared against the slot just read. REMOVE once root-caused. ──
var rcDiagReads = [];
function rcDiagAmpOutDb(body) {
  try {
    var b = body instanceof Uint8Array ? body : new Uint8Array(body);
    var ai = decodeAmpKey(b);
    if (!ai || ai.markerPos == null) return '?';
    var raw = readSignedLE32(b, ai.markerPos + AMP_OUT_OFFSET_FROM_AMP + 4);
    return (raw === null) ? '?' : ampOutTextFromFrac(fracFromRaw(raw));
  } catch (e) { return '?'; }
}
function rcDiagNoteRead(slot, body) {
  rcDiagReads.push({ slot: slot, t: performance.now(), ao: rcDiagAmpOutDb(body) });
  if (rcDiagReads.length > 4) rcDiagReads.shift();
}
function rcDiagSummary() {
  var now = performance.now();
  return rcDiagReads.map(function(r) {
    return slotLabel(r.slot) + ' AO=' + r.ao + ' (' + Math.round(now - r.t) + 'ms ago)';
  }).join(' | ');
}

async function rcTick() {
  rcTimer = null;
  if (!rcReading && !rcBusy()) {
    var slot = -1;
    for (var s = 0; s <= MAX_SLOT; s++) if (!rcFresh[s]) { slot = s; break; }
    if (slot < 0) {
      if (!rcDoneLogged) { rcDoneLogged = true; appLog('Rack catalog: all ' + (MAX_SLOT + 1) + ' user slots read this session'); }
      return;   // done for this session; live upkeep takes over
    }
    rcReading = true;
    try {
      var res = await readSlotBodySilent(slot);
      if (res && res.body) { rackCatalogPut(slot, res.body); rcDiagNoteRead(slot, res.body); }
      else { rcFresh[slot] = true; if (typeof rigBrowserRefresh === 'function') rigBrowserRefresh(); appLog('Rack catalog: ' + slotLabel(slot) + ' — no response, skipped this session'); }
    } catch (e) { appLog('Rack catalog read error: ' + e.message); }
    rcReading = false;
    await new Promise(function(r) { setTimeout(r, EXPORT_SLOT_GAP_MS); });
  }
  rcTimer = setTimeout(rcTick, RC_TICK_MS);
}

function rackCatalogStart() {
  if (rcTimer) return;
  rcTimer = setTimeout(rcTick, RC_TICK_MS);
}

(function rackCatalogInit() {
  rcLoad();
  ['mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function(t) {
    window.addEventListener(t, function() { rcLastInput = performance.now(); if (t === 'mousedown') rcMouseDown = true; }, true);
  });
  window.addEventListener('mouseup', function() { rcMouseDown = false; rcLastInput = performance.now(); }, true);
  window.addEventListener('blur', function() { rcMouseDown = false; });
  // Walker checks readiness itself (MIDI up, app revealed) — just keep it ticking.
  rackCatalogStart();
})();
