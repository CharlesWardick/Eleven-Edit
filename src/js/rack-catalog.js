/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// RACK-CATALOG.JS — per-slot {name, amp, cab, mic, rig vol} for every USER
// slot (A1-Z4), feeding the Rig Browser and Rig Balancing.
//
// build 226 — ON DEMAND ONLY. The old background walker (build 151) re-read
// every slot each session while EE was idle; reading slots in the background
// makes the rack itself randomly change LIVE-patch settings (Amp Out, WAH
// Position — proven 2026-10-01; Avid never reads in the background), which
// needed a pile of workarounds. Also dropped: the localStorage copy — USER
// space can change outside EE at any time, so a saved copy is never trusted.
//
// Now: the first time per session that the Rig Browser or Rig Balancing opens,
// rackCatalogEnsure() reads all 104 slots back-to-back (silent by-slot read,
// never navigates) behind the progress overlay, with Cancel. After that the
// catalog is kept current by saves/imports EE makes (rackCatalogPut), and
// Export All Rigs fills it as a side effect. While any build/export read is in
// flight the param guard (sysex-handler.js) restores rack self-changes.
// Factory space comes from the shipped FACTORY_CATALOG, never read.
// ════════════════════════════════════════════════════════════════════

var rackCatalog = { slots: {} };   // slot -> {n, amp, cab, mic, rv, t}
var rcFresh = {};                  // slots read or updated THIS session
var rcBuilding = false, rcCancel = false;
var rcLastReadEnd = 0;             // end time of the last silent read (param guard)
var RC_GUARD_MS = 3000;

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
  if (typeof rigBrowserRefresh === 'function') rigBrowserRefresh();
  appLog('Rack catalog: ' + slotLabel(slot) + ' = "' + e.n + '" amp=' + e.amp + ' cab=' + e.cab + ' mic=' + e.mic);
}
function rackCatalogCount() {
  var n = 0; for (var s = 0; s <= MAX_SLOT; s++) if (rcFresh[s]) n++; return n;
}

// ── Param guard window. True while a silent slot read (catalog build, Export
// All Rigs) is in flight or just finished — the rack's self-changes to the
// live patch happen only then. EE is blocked behind the overlay, so any live
// param change in this window is the rack glitch (or a front-panel touch).
var rcSilentReading = 0;
function rcNoteSilentRead(active) {
  rcSilentReading += active ? 1 : -1;
  if (rcSilentReading < 0) rcSilentReading = 0;
  if (!active) rcLastReadEnd = performance.now();
}
function rcParamGuardActive() {
  return rcSilentReading > 0 || (rcLastReadEnd > 0 && performance.now() - rcLastReadEnd < RC_GUARD_MS);
}

// ── Build the catalog for this session if it isn't complete. Resolves true
// when every user slot has been read, false if cancelled/unavailable.
async function rackCatalogEnsure() {
  if (rackCatalogCount() > MAX_SLOT) return true;
  if (rcBuilding) return false;
  if (typeof bridgeMidiReady === 'undefined' || !bridgeMidiReady) {
    if (typeof setStatus === 'function') setStatus('Rig catalog: rack not connected');
    return false;
  }
  rcBuilding = true; rcCancel = false;
  var ov = document.getElementById('scan-overlay');
  var ovTitle = ov ? ov.querySelector('h3') : null;
  var ovText = document.getElementById('scan-progress-text');
  var ovBar = document.getElementById('scan-progress-bar');
  var ovCancel = document.getElementById('btn-scan-skip');
  var oldTitle = ovTitle ? ovTitle.textContent : '';
  if (ovTitle) ovTitle.textContent = 'Reading Rigs — please leave the rack alone';
  if (ovCancel) ovCancel.style.display = '';
  if (ov) ov.classList.add('open');
  appLog('Rack catalog: building (on demand)');
  var t0 = performance.now();
  for (var slot = 0; slot <= MAX_SLOT && !rcCancel; slot++) {
    if (ovText) ovText.textContent = 'Reading slot ' + (slot + 1) + ' / ' + (MAX_SLOT + 1) + '  —  ' + slotLabel(slot);
    if (ovBar) ovBar.style.width = (((slot + 1) / (MAX_SLOT + 1)) * 100).toFixed(1) + '%';
    if (rcFresh[slot]) continue;
    var res = null;
    try { res = await readSlotBodySilent(slot); } catch (e) { appLog('Rack catalog read error: ' + e.message); }
    if (res && res.body) rackCatalogPut(slot, res.body);
    else { rcFresh[slot] = true; appLog('Rack catalog: ' + slotLabel(slot) + ' — no response, skipped this session'); }
    await new Promise(function(r) { setTimeout(r, EXPORT_SLOT_GAP_MS); });   // Win11 MIDI settle (see Export)
  }
  if (ov) ov.classList.remove('open');
  if (ovTitle) ovTitle.textContent = oldTitle;
  rcBuilding = false;
  var done = rackCatalogCount() > MAX_SLOT;
  appLog('Rack catalog: ' + (done ? 'all ' + (MAX_SLOT + 1) + ' user slots read in ' + ((performance.now() - t0) / 1000).toFixed(1) + 's'
                                  : 'build cancelled at ' + rackCatalogCount() + ' of ' + (MAX_SLOT + 1)));
  if (typeof rigBrowserRefresh === 'function') rigBrowserRefresh();
  return done;
}

(function rackCatalogInit() {
  var c = document.getElementById('btn-scan-skip');
  if (c) c.addEventListener('click', function() { if (rcBuilding) rcCancel = true; });
  try { localStorage.removeItem('rackCatalog'); } catch (e) {}   // build 226: drop the old saved copy
})();
