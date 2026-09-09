/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
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
//
// "Import Rigs…" (2026-08-10) — the mirror-image write side, deliberately
// built with Avid's own no-recall by-slot method, NOT the recall-based
// walk export ended up needing. A write has no "stale cold read" to
// worry about — you're setting data, not depending on hardware to hand
// back something fresh — and every one of Charlie's live tests of Avid's
// OWN Load All Rigs worked cleanly, including correctly refreshing the
// separate name-index the export saga turned up. If a live test of THIS
// finds the same kind of corruption export did, treat it exactly the
// same way: one settle-delay attempt, then switch to the recall-based
// Load TFX + Save-to-slot sequence (Sec 15/16) per XML entry if that
// doesn't hold up either — don't just keep raising the delay.
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

// ── SILENT read of one slot's body (2026-09-08) — Avid's no-recall by-slot
// query, request->reply lock-step. Sends reqSendPatchBySlot(slot) and awaits
// the matching 12 00 [slot] reply (resolved by handlePatchBySlotReply only when
// the slot byte matches). No settle timer — the reply IS the sync. If a reply
// doesn't arrive within the window, re-request the SAME slot up to
// SILENT_READ_MAX_ATTEMPTS before giving up and returning null. Nothing here
// navigates the rack, so the user's current patch and any unsaved edits are
// left untouched. Returns { body, slotNum } or null. ──
function readSlotBodySilent(slot) {
  return new Promise((resolve) => {
    let done = false;
    let attempt = 0;
    function finish(res) { if (!done) { done = true; resolve(res); } }
    function fire() {
      attempt++;
      pendingSilentSlot = slot;
      pendingSilentResolve = finish;
      sendHex(reqSendPatchBySlot(slot));
      setTimeout(() => {
        if (done) return;
        // Clear our stale pending before deciding, so a late straggler for this
        // slot is dropped by the handler rather than resolving a retry.
        if (pendingSilentResolve === finish) { pendingSilentResolve = null; pendingSilentSlot = null; }
        if (attempt < SILENT_READ_MAX_ATTEMPTS) fire();
        else finish(null);
      }, SILENT_READ_TIMEOUT_MS);
    }
    fire();
  });
}

// ── PRIMARY export path (2026-09-08): silent, no-recall, no front-panel walk.
// Same downstream format work as the visible walk (name disambiguation, entries
// list, exportBank IPC) — only the READ mechanism differs. The old audible
// recall walk is kept below as exportAllRigsVisible for fallback. ──
async function exportAllRigsSilent(bankName, targetDir) {
  if (exportInProgress || scanInProgress || !bridgeMidiReady) return;
  exportInProgress = true;
  exportCancelRequested = false;

  const overlay = document.getElementById('scan-overlay');
  if (overlay) overlay.classList.add('open');
  appLog('Bank export started (silent, no-recall): "' + bankName + '" -> ' + targetDir);

  // Same first-occurrence-plain / repeat-gets-"-N" filename convention as the
  // visible walk (matches Avid's own export naming).
  const seen = {};
  const entries = [];
  let failed = 0;

  for (let slot = 0; slot <= MAX_SLOT; slot++) {
    if (exportCancelRequested) { appLog('Bank export cancelled at slot ' + slot); break; }
    exportProgressUpdate(slot, null);

    const result = await readSlotBodySilent(slot);
    if (!result) {
      failed++;
      exportProgressUpdate(slot, 'no response');
      appLog('Bank export (silent): slot ' + slot + ' (' + slotLabel(slot) + ') — no response after retries, skipped');
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
  // No goToSlot() restore needed — silent export never moved the rack.

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

// The button calls this; it now delegates to the silent path. The visible walk
// (exportAllRigsVisible) stays available as a fallback if silent ever proves
// unreliable on some machine.
async function exportAllRigs(bankName, targetDir) {
  return exportAllRigsSilent(bankName, targetDir);
}

// ── FALLBACK: the original audible recall-per-slot walk (2026-08-10). Kept
// intact in case the silent path needs to be reverted on some hardware. NOT
// wired to any button while silent is primary. ──
async function exportAllRigsVisible(bankName, targetDir) {
  // Mutual exclusion with Scan Bank — both go through scanSlot()'s
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
    if (typeof stopRollerForBankOp === 'function') stopRollerForBankOp('Export All Rigs');
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

// ════════════════════════════════════════════════════════════════════
// IMPORT RIGS — see file header above for the approach/rationale.
// ════════════════════════════════════════════════════════════════════

let importInProgress = false;

function importProgressUpdate(i, total, bank, status) {
  const el = document.getElementById('scan-progress-text');
  if (el) el.textContent = 'Importing ' + (i + 1) + ' / ' + total + '  —  ' + bank + (status ? '  (' + status + ')' : '');
  const bar = document.getElementById('scan-progress-bar');
  if (bar) bar.style.width = (((i + 1) / total) * 100).toFixed(1) + '%';
}

// A successful slot write (CMD 0x00) is SILENT on this rack — it echoes the
// patch back as a bulk broadcast, not a clean 02 03 accept (only the single
// Load TFX 00 01 write gets that). So import can only detect FAILURE: the rack
// rejects a bad body with CMD 0x78 within ~1s. Wait that window; if no 0x78
// arrived, treat the write as accepted. (Proven in v1.4.74/.75, which caught
// the real bad patches correctly; the v1.4.76 "wait for accept" attempt broke
// good imports because there is no accept to wait for.)
const IMPORT_REJECT_MS = 1000;

// Returns 'ok' | 'rejected' | 'skipped'.
async function importSlotEntry(entry) {
  const slot = slotNumFromLabel(entry.bank);
  if (slot < 0) { appLog('Import: unrecognized bank label "' + entry.bank + '" — skipped'); return 'skipped'; }

  const body = new Uint8Array(entry.body);
  const name = extractNameFromBody(body) || entry.filename.replace(/\.tfx$/i, '');
  const slotHex = slot.toString(16).padStart(2,'0').toUpperCase();

  const rejectsBefore = rackBadPatchCount;

  // 1. Bulk write directly to this slot (Avid's own mechanism, no recall,
  // no separate commit step — see file header).
  const encoded = encode7bit(body);
  const hexBulk = 'F0 13 0B 0F 00 00 ' + slotHex + ' '
    + encoded.map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ')
    + ' F7';
  sendHex(hexBulk);

  // 2. Watch for a rejection during the window. No 0x78 => accepted.
  await sleep(IMPORT_REJECT_MS);
  if (rackBadPatchCount > rejectsBefore) return 'rejected';

  // 3. Name write — only after the body was accepted. Routes through the
  // existing CMD 0x04 handler (handlePatchNameEnumReply, sysex-handler.js),
  // which harmlessly also refreshes patchNameCache for the Jump List.
  sendHex('F0 13 0B 0F 00 04 00 ' + slotHex + ' ' + asciiToHexBytes(name) + ' 00 F7');
  await sleep(150);
  return 'ok';
}

function cancelBankImport() {
  importCancelRequested = true;
}

async function importRigs(entries) {
  if (importInProgress || exportInProgress || scanInProgress || !bridgeMidiReady) return;
  importInProgress = true;
  importCancelRequested = false;

  const overlay = document.getElementById('scan-overlay');
  if (overlay) overlay.classList.add('open');
  appLog('Import Rigs started: ' + entries.length + ' entries');

  let done = 0;
  const rejected = [];     // slots the rack rejected (bad patch data)
  let cancelled = false;
  let bailedWin11 = false; // aborted early: the whole machine is rejecting uploads
  let consecReject = 0;
  // Abort when the failures stop looking like a few bad patches and start
  // looking like the Windows 11 MIDI-stack corrupting EVERY large upload.
  // Two triggers, because per-slot verdict timing can occasionally mis-attribute
  // a rejection as an "ok", breaking a pure consecutive run:
  //   (a) 6 rejects in a row, OR
  //   (b) once enough have been attempted, a heavy majority rejected.
  const CONSEC_REJECT_ABORT = 6;
  const RATIO_MIN_ATTEMPTS  = 8;
  const RATIO_ABORT         = 0.6;

  for (let i = 0; i < entries.length; i++) {
    if (importCancelRequested) { cancelled = true; appLog('Import cancelled by user at entry ' + (i + 1)); break; }
    const entry = entries[i];
    importProgressUpdate(i, entries.length, entry.bank, null);
    const result = await importSlotEntry(entry);
    if (result === 'ok') {
      done++;
      consecReject = 0;
    } else if (result === 'rejected') {
      rejected.push({ bank: entry.bank, filename: entry.filename });
      appLog('Import: ' + entry.bank + ' "' + entry.filename + '" REJECTED by rack (bad patch data)');
      consecReject++;
    }
    // 'skipped' (bad bank label) already logged in importSlotEntry.

    const attemptedSoFar = done + rejected.length;
    if (consecReject >= CONSEC_REJECT_ABORT ||
        (attemptedSoFar >= RATIO_MIN_ATTEMPTS && rejected.length >= attemptedSoFar * RATIO_ABORT)) {
      bailedWin11 = true;
      appLog('Import aborted — ' + rejected.length + ' of ' + attemptedSoFar
           + ' rejected (Windows 11 MIDI-stack pattern: uploads are being corrupted)');
      break;
    }
  }

  if (overlay) overlay.classList.remove('open');
  importInProgress = false;
  requestPatchStateAfterNav(); // in case currentSlot was one of the ones just overwritten

  // Decide the story from the PATTERN of rejections (see handleRackDialog):
  // many/all rejected while attempted => almost certainly the Windows 11 MIDI
  // stack corrupting large SysEx; a few => genuinely bad patches in the bank.
  const attempted = (cancelled || bailedWin11) ? (done + rejected.length) : entries.length;
  const looksLikeWin11 = bailedWin11 || (rejected.length >= 5 && rejected.length >= Math.ceil(attempted * 0.5));

  let msg;
  if (bailedWin11 || looksLikeWin11) {
    msg = 'Import stopped — the rack is rejecting uploads. This is the Windows 11 '
        + 'MIDI-stack bug corrupting large uploads, not your patches. Nothing could '
        + 'be reliably written. Use Windows 10 or an un-updated Windows 11.';
  } else if (cancelled) {
    msg = 'Import cancelled — ' + done + ' of ' + entries.length + ' written'
        + (rejected.length ? ', ' + rejected.length + ' rejected' : '');
  } else if (looksLikeWin11) {
    msg = 'Import failed — ' + rejected.length + ' of ' + attempted + ' patches rejected. '
        + 'This pattern points to the Windows 11 MIDI-stack bug, not the patches. '
        + 'See the User Manual (Windows 11 note).';
  } else if (rejected.length) {
    msg = 'Import complete — ' + done + ' of ' + entries.length + ' written; '
        + rejected.length + ' rejected by the rack (bad patch data).';
  } else {
    msg = 'Import complete — ' + done + ' of ' + entries.length + ' patch(es) written';
  }

  appLog('Import Rigs finished: ' + done + ' / ' + entries.length + ' written'
       + (rejected.length ? ', ' + rejected.length + ' rejected [' + rejected.map(r => r.bank).join(', ') + ']' : '')
       + (cancelled ? ' (cancelled)' : ''));
  setStatus(msg);
  // Any accepted patch proves this machine's MIDI stack handles large uploads —
  // auto-disable the Windows 11 warning (Gate and Wait self-heal).
  if (done > 0 && typeof win11GateNoteUploadSuccess === 'function') win11GateNoteUploadSuccess();
  showImportResults(done, entries.length, rejected, cancelled, looksLikeWin11);
}

// Reuse the import-confirm modal to show the end-of-run summary, so the user
// gets an unmissable list of which slots were rejected (rather than only a
// status line that scrolls away).
// Generic modal reuse: repurpose the import-confirm modal to show a titled
// message with a single Close button. Used for import results AND single Load
// TFX failures, so an error is a modal the user must dismiss rather than a
// status line that a background name-scan can overwrite a moment later.
function showModalMessage(title, bodyHtml) {
  const modal = document.getElementById('import-confirm-modal');
  const list  = document.getElementById('import-confirm-list');
  const okBtn = document.getElementById('import-confirm-ok');
  const cancelBtn = document.getElementById('import-confirm-cancel');
  const warning = document.getElementById('import-confirm-warning');
  const titleEl = document.getElementById('import-confirm-title');
  if (!modal || !list) return;
  if (warning) warning.style.display = 'none';
  if (titleEl) titleEl.textContent = title;
  list.innerHTML = bodyHtml;
  if (okBtn) okBtn.style.display = 'none';
  if (cancelBtn) cancelBtn.textContent = 'Close';
  modal.classList.add('open');
}

function showImportResults(done, total, rejected, cancelled, looksLikeWin11) {
  const list  = document.getElementById('import-confirm-list');
  if (!list) return;

  let html;
  if (looksLikeWin11) {
    // The whole machine is rejecting uploads — the "done" count is not
    // trustworthy here (a late rejection can be mis-read as a success), so do
    // NOT present it as patches successfully written.
    html = '<div style="color:var(--red);margin-bottom:8px;">'
      + 'Upload failed — the rack rejected the patches and the import was stopped after '
      + (done + rejected.length) + ' attempt(s).</div>'
      + '<div style="color:var(--red);margin-bottom:8px;">This is the Windows&nbsp;11 '
      + 'MIDI-stack bug corrupting large uploads — <b>not your patches</b>. On this machine '
      + 'no bank or patch can be reliably written. The same bank imports fine on '
      + 'Windows&nbsp;10 or an un-updated Windows&nbsp;11. See the User Manual.</div>'
      + '<div style="color:#b3b3b3;">Your slots were not reliably changed, and any '
      + '&ldquo;Bad Patch Data&rdquo; message on the rack&rsquo;s front panel is non-fatal — '
      + 'it clears as soon as you change patches.</div>';
  } else {
    html = '<div style="color:var(--text);margin-bottom:8px;">'
      + (cancelled ? 'Import cancelled. ' : 'Import finished. ')
      + done + ' of ' + total + ' patch(es) written.</div>';
    if (rejected.length) {
      html += '<div style="color:var(--red);margin-bottom:8px;">'
        + rejected.length + ' rejected by the rack (bad patch data):<br>'
        + rejected.map(r => r.bank + ' — ' + r.filename).join('<br>')
        + '</div>';
      html += '<div style="color:#b3b3b3;">These patches are corrupt in the '
        + 'source bank (they fail on any system) and were skipped. The rest imported '
        + 'normally.</div>';
      // Reassurance about what a rejection actually left behind.
      html += '<div style="color:#b3b3b3;margin-top:8px;">'
        + 'The rejected slot(s) still hold their <b>previous</b> patch — nothing was '
        + 'overwritten there. Any &ldquo;Bad Patch Data&rdquo; message on the rack&rsquo;s '
        + 'front panel is non-fatal and clears as soon as you change patches.'
        + '</div>';
    }
  }
  showModalMessage('Import Rigs', html);
}

// ── Button + confirm modal wiring ──
// Validate-up-front, decide-once (2026-08-10, Charlie's call): main.js's
// read-import-bank checks every entry before anything touches hardware
// and hands back BOTH the importable list and the problem list, so this
// can show the complete picture in one prompt — skip the bad ones and
// import the rest, or cancel outright — rather than either silently
// stopping partway (Avid's own behaviour) or blocking everything over
// one bad file (this app's own first cut at Import Rigs, same day).
(function() {
  const btn     = document.getElementById('btn-import-rigs');
  const modal   = document.getElementById('import-confirm-modal');
  const list    = document.getElementById('import-confirm-list');
  const okBtn   = document.getElementById('import-confirm-ok');
  if (!btn) return;

  let pendingEntries = null;

  btn.addEventListener('click', function() {
    // Windows 11 upload pre-gate ("Gate and Wait") fronts the whole flow.
    if (typeof win11PreGate === 'function') win11PreGate(runImportFlow);
    else runImportFlow();
  });

  async function runImportFlow() {
    if (typeof stopRollerForBankOp === 'function') stopRollerForBankOp('Import Rigs');
    if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }
    const srcResult = await window.electronAPI.chooseImportSource();
    if (!srcResult || !srcResult.ok) return; // cancelled

    setStatus('Reading bank…');
    const readResult = await window.electronAPI.readImportBank(srcResult.path);
    if (!readResult || !readResult.ok) {
      setStatus('Import failed: ' + (readResult ? readResult.error : 'unknown'));
      appLog('Import Rigs: read failed — ' + (readResult ? readResult.error : 'unknown'));
      return;
    }

    const valid    = readResult.valid || [];
    const problems = readResult.problems || [];
    const source   = readResult.source || {};
    pendingEntries = valid;

    // Provenance line — which program wrote this bank. Only Eleven Edit exports
    // (2026-09-08+) carry the stamp; everything else (Avid, ElevenHack, the old
    // bank manager, hand-crafted) shows "unknown" — absence is NOT proof of Avid.
    let sourceLine;
    if (source.generator) {
      const dt = source.exported ? source.exported.replace('T',' ').replace(/\.\d+Z$/,' UTC').replace('Z',' UTC') : '';
      sourceLine = 'Source: ' + source.generator + (source.version ? ' v' + source.version : '')
                 + (dt ? ' · exported ' + dt : '');
    } else {
      sourceLine = 'Source: unknown (no Eleven Edit stamp)';
    }

    if (!modal || !list) {
      // No confirm modal in this build — go straight through with whatever's valid.
      if (valid.length) importRigs(valid);
      return;
    }

    let html = '<div style="color:var(--muted);margin-bottom:6px;font-size:12px;">'
      + sourceLine + '</div>';
    html += '<div style="color:var(--text);margin-bottom:8px;">Will import '
      + valid.length + ' patch(es): ' + (valid.length ? valid.map(e => e.bank).join(', ') : '(none)')
      + '</div>';
    if (problems.length) {
      html += '<div style="color:var(--red);">Skipping ' + problems.length
        + ' missing/invalid patch(es):<br>'
        + problems.map(p => p.bank + ' — ' + p.filename + ' (' + p.reason + ')').join('<br>')
        + '</div>';
    }
    list.innerHTML = html;

    // Reset to CONFIRM mode (showImportResults may have left it in results mode:
    // warning hidden, OK hidden, Cancel relabelled "Close").
    const cancelBtn = document.getElementById('import-confirm-cancel');
    const warning   = document.getElementById('import-confirm-warning');
    const titleEl   = document.getElementById('import-confirm-title');
    if (titleEl) titleEl.textContent = 'Import Rigs';
    if (warning) warning.style.display = '';
    if (cancelBtn) cancelBtn.textContent = 'Cancel';
    if (okBtn) {
      okBtn.style.display = '';
      okBtn.textContent = valid.length ? 'Import ' + valid.length : 'Nothing to Import';
      okBtn.disabled = !valid.length;
      okBtn.style.opacity = valid.length ? '' : '0.5';
    }
    modal.classList.add('open');
  }

  // The import shares the Scan/Export overlay's Cancel button (btn-scan-skip);
  // each operation's loop only reads its own cancel flag, so wiring all three
  // to the one button is harmless (mirrors cancelBankExport).
  const importSkipBtn = document.getElementById('btn-scan-skip');
  if (importSkipBtn) importSkipBtn.addEventListener('click', cancelBankImport);

  if (modal) {
    document.getElementById('import-confirm-cancel').addEventListener('click', function() {
      modal.classList.remove('open');
      pendingEntries = null;
    });
    if (okBtn) okBtn.addEventListener('click', function() {
      modal.classList.remove('open');
      if (pendingEntries && pendingEntries.length) importRigs(pendingEntries);
      pendingEntries = null;
    });
    modal.addEventListener('click', function(e) {
      if (e.target === modal) { modal.classList.remove('open'); pendingEntries = null; }
    });
  }
})();
