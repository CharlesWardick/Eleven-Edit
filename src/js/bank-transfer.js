// ════════════════════════════════════════════════════════════════════
// BANK-TRANSFER.JS — "Export All Rigs…" (2026-08-10). Walks all 104 slots
// using Avid Editor's own direct by-slot SEND_PATCH query (protocol.js
// reqSendPatchBySlot) — no recall, nothing visible on hardware, unlike
// ElevenHack's method (Sec 17 / the existing Scan Bank feature above in
// capture-scan.js, which this deliberately does NOT reuse or touch).
// Filesystem work (TFX/XML/zip writing) lives in main.js — this file only
// walks the wire and hands it already-decoded slot data.
// See Session Log 2026-08-10 for the capture this is built from.
// ════════════════════════════════════════════════════════════════════

let exportChosenDir = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exportSlotBody(slot) {
  // Settle gap BEFORE the query, not after the reply — see EXPORT_SETTLE_MS
  // (state.js) for why. Cheap either way at 60ms, but "before" means the
  // very first slot gets the same gap as every other one, not a free pass.
  await sleep(EXPORT_SETTLE_MS);
  return new Promise((resolve) => {
    pendingExportSlot = slot;
    pendingExportResolve = resolve;
    sendHex(reqSendPatchBySlot(slot));
    setTimeout(() => {
      if (pendingExportResolve === resolve) {
        pendingExportResolve = null;
        pendingExportSlot = null;
        resolve(null);
      }
    }, EXPORT_RESPONSE_TIMEOUT_MS);
  });
}

function exportProgressUpdate(slot, status) {
  const el = document.getElementById('scan-progress-text');
  if (el) el.textContent = 'Exporting slot ' + (slot + 1) + ' / 104  —  ' + slotLabel(slot) + (status ? '  (' + status + ')' : '');
  const bar = document.getElementById('scan-progress-bar');
  if (bar) bar.style.width = (((slot + 1) / 104) * 100).toFixed(1) + '%';
}

function cancelBankExport() {
  exportCancelRequested = true;
}

async function exportAllRigs(bankName, targetDir) {
  if (exportInProgress || !bridgeMidiReady) return;
  exportInProgress = true;
  exportCancelRequested = false;

  const overlay = document.getElementById('scan-overlay');
  if (overlay) overlay.classList.add('open');
  appLog('Bank export started: "' + bankName + '" -> ' + targetDir);

  // First occurrence of a name gets the plain filename; every repeat gets
  // a "-N" suffix in encounter order — confirmed against a real Avid
  // export (Session Log 2026-08-10): "-unused-.tfx", "-unused-1.tfx",
  // "-unused-2.tfx", ... same convention, so a mixed EHB/Avid workflow
  // never looks unfamiliar.
  const seen = {};
  const entries = [];
  let failed = 0;

  for (let slot = 0; slot <= MAX_SLOT; slot++) {
    if (exportCancelRequested) { appLog('Bank export cancelled at slot ' + slot); break; }
    exportProgressUpdate(slot, null);

    const result = await exportSlotBody(slot);
    if (!result) {
      failed++;
      exportProgressUpdate(slot, 'no response');
      appLog('Bank export: slot ' + slot + ' — no response, skipped');
      continue;
    }

    const name = extractNameFromBody(result.body) || '-unused-';
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    const count = seen[safeName] || 0;
    seen[safeName] = count + 1;
    const filename = (count === 0 ? safeName : safeName + '-' + count) + '.tfx';

    entries.push({ bank: slotLabel(slot), filename: filename, bodyArray: Array.from(result.body) });
  }

  if (overlay) overlay.classList.remove('open');
  exportInProgress = false;

  if (!entries.length) {
    setStatus('Bank export: nothing captured');
    appLog('Bank export: nothing captured (0 of 104 slots responded)');
    return;
  }

  setStatus('Bank export: writing ' + entries.length + ' file(s)…');
  try {
    const res = await window.electronAPI.exportBank(targetDir, bankName, entries);
    if (res && res.ok) {
      appLog('Bank export saved: ' + res.dir + ' + ' + res.zipPath);
      setStatus('Bank export complete — ' + res.count + ' patch(es)' + (failed ? ', ' + failed + ' no response' : ''));
    } else {
      appLog('Bank export write failed: ' + (res ? res.error : 'unknown'));
      setStatus('Bank export failed: ' + (res ? res.error : 'unknown'));
    }
  } catch(e) {
    appLog('Bank export write error: ' + e.message);
    setStatus('Bank export error: ' + e.message);
  }
}

// ── Button + modal wiring ──
(function() {
  const btn      = document.getElementById('btn-export-all-rigs');
  const modal    = document.getElementById('bank-export-modal');
  const input    = document.getElementById('bank-export-input');
  if (!btn || !modal || !input) return;

  btn.addEventListener('click', function() {
    if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }
    input.value = '';
    modal.classList.add('open');
    setTimeout(function() { input.focus(); }, 50);
  });

  document.getElementById('bank-export-cancel').addEventListener('click', function() {
    modal.classList.remove('open');
  });

  async function doExportOk() {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    modal.classList.remove('open');

    const dirResult = await window.electronAPI.chooseExportDir();
    if (!dirResult || !dirResult.ok) return; // cancelled or failed silently — no folder chosen
    exportChosenDir = dirResult.dir;

    exportAllRigs(name, exportChosenDir);
  }
  document.getElementById('bank-export-ok').addEventListener('click', doExportOk);

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  { doExportOk(); }
    if (e.key === 'Escape') { modal.classList.remove('open'); }
  });

  modal.addEventListener('click', function(e) {
    if (e.target === modal) modal.classList.remove('open');
  });

  // Shares the Scan Bank overlay's Cancel button — harmless when the other
  // operation isn't running, since each cancel flag is only read by its
  // own loop.
  const skipBtn = document.getElementById('btn-scan-skip');
  if (skipBtn) skipBtn.addEventListener('click', cancelBankExport);
})();
