/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// FACTORY-DUMP.JS — TEMPORARY dev tool (build 159, feature/rig-browser).
// Header FAC button: walks all 104 FACTORY slots (a1-z4) with a visible
// recall (the silent by-slot read only reaches user space), pulls each body
// (REQU_SEND_PATCH, same capture path as Scan Bank), and writes them as a
// normal bank export (folder + zip). Used once to build the factory catalog
// that ships with EE. Remove before merge / finalize.
// ════════════════════════════════════════════════════════════════════
function facReadSlot(slot) {
  return new Promise(function(resolve) {
    var sr = slotToSpaceRaw(slot), hh = function(v) { return v.toString(16).padStart(2, '0').toUpperCase(); };
    sendHex('F0 13 0B 0F 00 02 ' + hh(sr.space) + ' ' + hh(sr.rawSlot) + ' F7');
    setTimeout(function() {
      pendingScanSlot = slot;
      pendingScanResolve = resolve;
      sendHex(REQU_SEND_PATCH);
      setTimeout(function() {
        if (pendingScanResolve === resolve) { pendingScanResolve = null; pendingScanSlot = null; resolve(null); }
      }, SCAN_RESPONSE_TIMEOUT_MS * 2);
    }, SCAN_SETTLE_MS * 2);
  });
}

async function exportFactoryRigs() {
  if (scanInProgress || exportInProgress || !bridgeMidiReady) return;
  var dir = await window.electronAPI.chooseExportDir();
  if (!dir || !dir.ok) return;
  scanInProgress = true;                       // also pauses the background catalog
  var startSlot = currentSlot, entries = [], seen = {}, failed = 0;
  var overlay = document.getElementById('scan-overlay');
  if (overlay) overlay.classList.add('open');
  appLog('Factory export started -> ' + dir.dir);
  for (var slot = MAX_SLOT + 1; slot <= MAX_NAV_SLOT; slot++) {
    if (scanCancelRequested) break;
    if (typeof scanProgressUpdate === 'function') scanProgressUpdate(slot, MAX_SLOT + 1, MAX_NAV_SLOT, null);
    var res = null;
    for (var a = 0; a < 3 && !res; a++) res = await facReadSlot(slot);
    if (!res || !res.body) { failed++; appLog('Factory export: ' + slotLabel(slot) + ' — no response'); continue; }
    var name = extractNameFromBody(res.body) || '-unused-';
    var safe = name.replace(/[\\/:*?"<>|]/g, '_'), c = seen[safe] || 0; seen[safe] = c + 1;
    entries.push({ bank: slotLabel(slot), filename: (c ? safe + '-' + c : safe) + '.tfx', bodyArray: Array.from(res.body) });
    appLog('Factory export: ' + slotLabel(slot) + ' = "' + name + '"');
  }
  scanCancelRequested = false;
  if (overlay) overlay.classList.remove('open');
  scanInProgress = false;
  goToSlot(startSlot);
  if (!entries.length) { setStatus('Factory export: nothing captured'); return; }
  var r = await window.electronAPI.exportBank(dir.dir, 'Factory', entries);
  var msg = (r && r.ok) ? ('Factory export done — ' + entries.length + ' patches' + (failed ? ', ' + failed + ' failed' : '') + ' → ' + r.zipPath)
                        : ('Factory export write failed: ' + (r ? r.error : 'unknown'));
  appLog(msg); setStatus(msg);
  if (typeof showModalMessage === 'function') showModalMessage('Factory Export', rbEsc ? rbEsc(msg) : msg);
}
(function() {
  var b = document.getElementById('btn-facdump');
  if (b) b.addEventListener('click', exportFactoryRigs);
})();
