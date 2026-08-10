// ════════════════════════════════════════════════════════════════════
// BANK-TRANSFER.JS — "Export All Rigs…" (2026-08-10, switched to the
// recall method same day — see ABANDONED note below).
//
// ABANDONED APPROACH — Avid's own direct by-slot SEND_PATCH query
// (protocol.js reqSendPatchBySlot), no recall, invisible on hardware.
// Decoded from a real Wireshark capture of Avid Editor's own "Save All
// Rigs to Computer" (Session Log 2026-08-10) and looked like a clean win
// over ElevenHack's method — half the round trips, nothing visibly
// changing on the front panel. It was NOT: a live-tested export produced
// files that decode and inspect as perfectly valid (right size, right
// name, right structure) but that Avid Editor's own loader intermittently
// rejects, both individually and as part of a full bank. Root-caused via
// byte-diff against a known-good single-patch manual capture of the same
// slot: cold, un-recalled reads of a slot can hand back stale bytes in at
// least two different places — the "signature/headerCode" field (Tech Ref
// Sec 13) and, separately, the internal name itself (confirmed live:
// "Dumble1" read back as "Dumble", triggering our own collision-suffix
// logic on top of the already-wrong name). Tried inserting a settle delay
// before every query (EXPORT_SETTLE_MS, 60ms) as the first, cheap fix —
// STILL produced a corrupted name on the very next live test. Two failed
// fixes on the same theory (Primer's own rule) means the real cause is
// that a recall is genuinely required to get self-consistent data, not a
// timing issue a longer delay would eventually paper over.
// Charlie's own read, and a plausible one: ElevenHack's author was
// clearly capable of building the invisible by-slot method and likely
// tried it — landing on the slower, visible, recall-per-slot walk anyway
// suggests he hit this exact wall first. reqSendPatchBySlot is left in
// protocol.js, unused, with its own pointer to this note — in case the
// real fix (recall-free reads that are ALSO reliable) turns out to exist
// and someone wants to pick this back up.
//
// CURRENT APPROACH — same recall-per-slot mechanism as the existing
// (hidden) Scan Bank feature above in capture-scan.js: CMD 0x03/0xC0
// recall -> settle -> REQU_SEND_PATCH. Reuses capture-scan.js's own
// scanSlot() directly rather than duplicating it — same proven, live-
// tested mechanism, one implementation. Visibly walks slots on the front
// panel, same as ElevenHack; the "invisible" property is gone, but the
// data is trustworthy. Still real gains over full ElevenHack/EHB: no
// separate name query per slot (the name comes from the SEND_PATCH body,
// same as before), and the collision-suffix / zip / XML pieces built this
// session are all format work, independent of which wire method reads
// the data — none of that needed to change.
// ════════════════════════════════════════════════════════════════════

let exportChosenDir = null;

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
  // Mutual exclusion with Scan Bank — both now go through scanSlot()'s
  // shared pendingScanSlot/pendingScanResolve pair, so running both at
  // once would have one steal the other's replies.
  if (exportInProgress || scanInProgress || !bridgeMidiReady) return;
  exportInProgress = true;
  exportCancelRequested = false;
  const startSlot = currentSlot; // return here when done, like Scan Bank does

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

    const result = await scanSlot(slot);
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
  goToSlot(startSlot); // return to wherever the user actually was, like Scan Bank

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
  const btn        = document.getElementById('btn-export-all-rigs');
  const modal      = document.getElementById('bank-export-modal');
  const input      = document.getElementById('bank-export-input');
  const dirtyModal = document.getElementById('export-dirty-modal');
  if (!btn || !modal || !input) return;

  function openNameModal() {
    input.value = '';
    modal.classList.add('open');
    setTimeout(function() { input.focus(); }, 50);
  }

  btn.addEventListener('click', function() {
    if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }
    // Export walks away from and back to the current slot (recall-based,
    // 2026-08-10) — it restores the right SLOT NUMBER when done, but a
    // recall always reloads a slot's last-SAVED content, so any live,
    // unsaved knob edits on the current patch have nowhere to be restored
    // from and are gone the moment the walk recalls the next slot. There
    // is no way around this on real hardware (same true of Scan Bank, or
    // any recall-based walk) — the best we can do is warn before it
    // happens instead of surprising Charlie with "the dials changed"
    // after the fact (his own 2026-08-10 report).
    const saveBtn = document.getElementById('btn-save-menu');
    if (saveBtn && saveBtn.classList.contains('green') && dirtyModal) {
      dirtyModal.classList.add('open');
      return; // openNameModal() fires from the Continue button instead
    }
    openNameModal();
  });

  if (dirtyModal) {
    document.getElementById('export-dirty-cancel').addEventListener('click', function() {
      dirtyModal.classList.remove('open');
    });
    document.getElementById('export-dirty-continue').addEventListener('click', function() {
      dirtyModal.classList.remove('open');
      openNameModal();
    });
    dirtyModal.addEventListener('click', function(e) {
      if (e.target === dirtyModal) dirtyModal.classList.remove('open');
    });
  }

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
