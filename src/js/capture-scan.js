// ════════════════════════════════════════════════════════════════════
// CAPTURE-SCAN.JS — TFX capture (manual + hardware-save-triggered) and
// the Scan Bank feature.
// ════════════════════════════════════════════════════════════════════

function captureCurrentPatchNow() {
  if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }
  pendingManualCapture = true;
  setStatus('Capturing current patch from hardware...');
  appLog('Manual capture requested — REQU SEND_PATCH');
  sendHex(REQU_SEND_PATCH);
  // Safety net — if nothing comes back within 4s, don't leave the flag
  // stuck silently swallowing a later real hardware save.
  setTimeout(function() {
    if (pendingManualCapture) {
      pendingManualCapture = false;
      appLog('Manual capture: no response received within 4s — giving up');
      setStatus('Capture failed — no response from hardware. Check MIDI Monitor.');
    }
  }, 4000);
}
document.getElementById('btn-capture-now').addEventListener('click', captureCurrentPatchNow);
document.getElementById('btn-scan-bank').addEventListener('click', function() {
  if (scanInProgress) return;
  scanBank(0, 103);
});
document.getElementById('btn-scan-skip').addEventListener('click', cancelBankScan);

// ── Bridge-driven readback — we can request current state directly now
// One-time-per-connect setup queries only — CURR_RIG (confirm) and
// CHAIN_MAP (needed for ampInstanceId, so the live CMD 0x11 gate/amp-out
// handler actually accepts incoming broadcasts). Deliberately does NOT
// also request SEND_PATCH/PATCH_NAME/RIG_VOL here anymore — it used to,
// but that duplicated exactly what the caller's own goToSlot(0) (first
// connect) or normal per-nav refresh already requests through the safe,
// strict-matched path below. Two requests for the same thing in close
// succession, with this one blindly trusting whatever came back, is
// exactly what caused the display to show a stale slot (A3) even after
// the hardware had already moved to A1 — the second, unconditionally-
// trusted response just arrived late and overwrote the correct one.
function scanSlot(slotNum) {
  return new Promise((resolve) => {
    sendHex('C0 ' + slotNum.toString(16).padStart(2,'0').toUpperCase());
    setTimeout(() => {
      pendingScanSlot = slotNum;
      pendingScanResolve = resolve;
      sendHex(REQU_SEND_PATCH);
      setTimeout(() => {
        // Still waiting on this exact slot after the timeout? Give up on
        // it and move on — don't leave the scan stuck on one bad slot.
        if (pendingScanResolve === resolve) {
          pendingScanResolve = null;
          pendingScanSlot = null;
          resolve(null);
        }
      }, SCAN_RESPONSE_TIMEOUT_MS);
    }, SCAN_SETTLE_MS);
  });
}

function scanProgressUpdate(slot, from, to, status) {
  const el = document.getElementById('scan-progress-text');
  if (el) el.textContent = 'Slot ' + (slot - from + 1) + ' / ' + (to - from + 1) + '  —  ' + slotLabel(slot) + (status ? '  (' + status + ')' : '');
  const bar = document.getElementById('scan-progress-bar');
  if (bar) bar.style.width = (((slot - from + 1) / (to - from + 1)) * 100).toFixed(1) + '%';
}

async function scanBank(fromSlot, toSlot) {
  if (scanInProgress || !bridgeMidiReady) return;
  scanInProgress = true;
  scanCancelRequested = false;
  const startSlot = currentSlot; // return here when done

  const overlay = document.getElementById('scan-overlay');
  if (overlay) overlay.classList.add('open');
  appLog('Bank scan started: slots ' + fromSlot + '-' + toSlot);

  let scanned = 0, unchanged = 0, failed = 0;

  for (let slot = fromSlot; slot <= toSlot; slot++) {
    if (scanCancelRequested) { appLog('Bank scan cancelled at slot ' + slot); break; }
    scanProgressUpdate(slot, fromSlot, toSlot, null);

    const result = await scanSlot(slot);
    if (!result) {
      failed++;
      scanProgressUpdate(slot, fromSlot, toSlot, 'no response');
      appLog('Bank scan: slot ' + slot + ' — no response, skipped');
      continue;
    }

    const sig = readSignedLE32(result.body, SIGNATURE_BODY_OFFSET);
    const prior = bankCache[slot];
    if (prior && prior.signature === sig) {
      unchanged++;
      prior.scannedAt = Date.now();
      continue; // content unchanged since last scan — nothing to re-decode
    }

    const ampInfo = decodeAmpKey(result.body);
    const gate    = decodeGateValues(result.body, ampInfo ? ampInfo.markerPos : null);
    // Patch name isn't in this same bulk body at a fixed offset the way
    // gate/rig-vol are — reuse the confirmed live broadcast (CMD 0x05)
    // path instead by requesting it separately would slow the scan down
    // further, so for now the scan stores what SEND_PATCH actually gives
    // us (amp + gate) and leaves name as whatever the app already knows
    // from the last time this slot's name was seen live, if ever.
    bankCache[slot] = {
      ampKey: ampInfo ? ampInfo.key : null,
      threshV: gate ? gate.threshV : null,
      releaseV: gate ? gate.releaseV : null,
      signature: sig,
      scannedAt: Date.now(),
    };
    scanned++;
  }

  try {
    await window.electronAPI.saveBankCache(bankCache);
    appLog('Bank scan: cache saved to disk');
  } catch(e) { appLog('Bank scan: cache save failed — ' + e.message); }

  if (overlay) overlay.classList.remove('open');
  scanInProgress = false;
  appLog('Bank scan finished — scanned=' + scanned + ' unchanged=' + unchanged + ' failed=' + failed);
  setStatus('Bank scan complete — ' + scanned + ' updated, ' + unchanged + ' unchanged, ' + failed + ' no response');

  // Return to wherever the user actually was
  goToSlot(startSlot);
}

function cancelBankScan() {
  scanCancelRequested = true;
}

// ── Jump List "by name" scan (2026-08-03) ──
// Lightweight, read-only sweep of all 104 slots' NAMES ONLY via CMD 0x04's
// REQU form (sendPatchNameQuery, transport.js) — no patch recall, no
// navigation, unlike the (currently hidden) Scan Bank feature above. Fires
// once per bridge connect (transport.js handleBridgeMsg 'connected' case);
// results land asynchronously in patchNameCache (state.js) via
// handlePatchNameEnumReply (sysex-handler.js) as each reply arrives — this
// function just paces out the 104 requests, it doesn't wait for or match
// individual replies the way scanSlot (above) has to for the heavy scan.
const NAME_SCAN_GAP_MS = 20;   // ms between queries — read-only, can be brisk
async function scanPatchNames() {
  if (patchNameScanInProgress || !bridgeMidiReady) return;
  patchNameScanInProgress = true;
  appLog('Patch name scan (Jump List) started — 104 slots, read-only');
  for (let slot = 0; slot <= 103; slot++) {
    if (!bridgeMidiReady) break;   // dropped mid-scan — stop, don't flood a dead socket
    sendPatchNameQuery(slot);   // spaceIdx defaults to 0 (user) — see sendPatchNameQuery, transport.js
    await new Promise(r => setTimeout(r, NAME_SCAN_GAP_MS));
  }
  patchNameScanInProgress = false;
  appLog('Patch name scan: all 104 requests sent (replies arrive asynchronously)');
}

// Called immediately on a confirmed slot change, before the REQU responses
// above come back — the old amp/gate/rig-vol readouts are for the
// previous patch, so show "unknown" rather than a confidently wrong number.
// Gate/Amp Out have no confirmed per-parameter REQU (see README), so their
// readouts only self-correct once a live hardware knob turn broadcasts a
// real value — they intentionally stay at "--" until that happens.
function clearStaleReadoutsOnNav() {
  document.getElementById('rig-vol-val').textContent = '--';
  document.getElementById('amp-out-val').textContent = '--';
  document.getElementById('gate-thresh-val').textContent = '--';
  document.getElementById('gate-release-val').textContent = '--';
  // Item A: a full patch change forgets every knob's "changed" state; the new
  // patch re-baselines. Main knobs re-baseline at the end of the nav pull;
  // effect knobs re-baseline on next panel open — so drop the whole store here.
  if (typeof clearFxBaselines === 'function') clearFxBaselines();
  // Also drop the OLD patch's main-knob baseline right now, so the incoming
  // values paint plain amber during the pull instead of flashing red until the
  // end-of-pull snapshot runs.
  if (typeof clearMainKnobBaselines === 'function') clearMainKnobBaselines();
  // Item: a fresh patch is clean — reset the SAVE-button dirty latch.
  if (typeof clearPatchDirty === 'function') clearPatchDirty();
}

// ════════════════════════════════════════════════════════════════════
// LOAD TFX / SAVE TO SLOT — confirmed 7/11/2026 via a real Wireshark
// capture of Avid Editor doing exactly this (loading "64 Lux" into
// memory). Two independent operations, matching Avid's own model:
//   - Load: writes patch content into the hardware's active buffer.
//     Memory only — does NOT touch any slot until Save is used.
//   - Save: commits WHATEVER is currently active to the current slot —
//     works the same whether that content got there via Load, or via
//     live tweaking/rolling a patch you're already sitting on.
// Checked against the real capture: a software-initiated Save does NOT
// accidentally trigger the existing hardware-save auto-export/capture
// detection — the message order is genuinely different (this sequence's
// own CMD 0x04 echo arrives AFTER the bulk broadcast, not before, so it
// never arms saveSequenceDetected the way a real front-panel save does).
// ════════════════════════════════════════════════════════════════════

function asciiToHexBytes(str) {
  return Array.from(str).map(c => (c.charCodeAt(0) & 0x7F).toString(16).padStart(2,'0').toUpperCase()).join(' ');
}

async function loadTfxFromDisk() {
  if (typeof stopRollerForBankOp === 'function') stopRollerForBankOp('Load TFX');
  if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }
  try {
    setStatus('Choose a TFX file...');
    const result = await window.electronAPI.loadTfxDialog();
    if (!result || result.canceled) { setStatus('Load TFX cancelled'); return; }
    if (!result.ok) {
      setStatus('Load TFX failed: ' + result.error);
      appLog('Load TFX failed: ' + result.error);
      return;
    }

    const body = result.body;
    const name = extractNameFromBody(body) || result.filename.replace(/\.tfx$/i, '');
    appLog('Loading TFX: ' + result.filename + ' (' + body.length + ' bytes) -> "' + name + '"');
    setStatus('Loading ' + name + '...');

    // 1. Bulk patch write — same 7-bit encoding we already trust for
    // reading, confirmed as the correct INVERSE against real Avid
    // traffic (see encode7bit in protocol.js)
    const encoded = encode7bit(body);
    const hexBulk = 'F0 13 0B 0F 00 01 '
      + encoded.map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ')
      + ' F7';
    sendHex(hexBulk);
    await sleep(300);

    // 2. Name write — separate step, matching the confirmed capture
    sendHex('F0 13 0B 0F 00 05 ' + asciiToHexBytes(name) + ' 00 F7');

    currentPatchName = name;
    const nameEl = document.getElementById('patch-name');
    if (nameEl) { nameEl.textContent = name; nameEl.classList.add('live'); }

    // Refresh amp/gate/amp-out readback now that new content is loaded —
    // same pull we already trust from every other navigation.
    await sleep(300);
    requestPatchStateAfterNav();

    setStatus('Loaded "' + name + '" — memory only, not saved to any slot yet');
    // Loaded content is uncommitted, so the patch is dirty — light SAVE.
    if (typeof markPatchDirty === 'function') markPatchDirty();
    appLog('Load complete: ' + name);
  } catch(e) {
    appLog('Load TFX error: ' + e.message);
    setStatus('Load TFX error: ' + e.message);
  }
}

async function saveCurrentPatchToSlot(nameOverride) {
  if (!bridgeMidiReady) { setStatus('Bridge MIDI not connected'); return; }
  const name = ((nameOverride || currentPatchName || 'Untitled').substring(0, 16)).trim();
  const slot = currentSlot;
  const bank = Math.floor(slot / 4);
  const num  = slot % 4;
  const slotHex = slot.toString(16).padStart(2,'0').toUpperCase();
  const bankHex = bank.toString(16).padStart(2,'0').toUpperCase();
  const numHex  = num.toString(16).padStart(2,'0').toUpperCase();
  const nameHex = asciiToHexBytes(name);

  // Update global and display so TFX capture picks up the new name
  currentPatchName = name;
  const nameEl = document.getElementById('patch-name');
  if (nameEl) { nameEl.textContent = name; nameEl.classList.add('live'); }

  // Jump List "by name" view (2026-08-03) — we already know the new name at
  // the moment WE save it, so update the cache directly rather than waiting
  // for the CMD 0x04 echo (handlePatchNameEnumReply, sysex-handler.js) to
  // round-trip back. Session-only cache (state.js) — never written to disk.
  patchNameCache[slot] = name;
  if (typeof refreshNamedMatrixSlot === 'function') refreshNamedMatrixSlot(slot);

  appLog('Saving current patch to ' + slotLabel(slot) + ' as "' + name + '"');
  setStatus('Saving to ' + slotLabel(slot) + '...');

  // 1. Name write
  sendHex('F0 13 0B 0F 00 05 ' + nameHex + ' 00 F7');
  await sleep(150);

  // 2. Dirty flag — CMD 0x03 uses the raw slot number, NOT bank/num split
  sendHex('F0 13 0B 0F 00 03 ' + slotHex + ' 00 F7');
  await sleep(150);

  // 3. Bank-index name entry write — CMD 0x04 DOES use bank/num split
  sendHex('F0 13 0B 0F 00 04 ' + bankHex + ' ' + numHex + ' ' + nameHex + ' 00 F7');
  await sleep(150);

  // 4. Commit trigger — confirmed from real Avid capture: uses 00 + raw
  // slot number, NOT bank/num split (unlike CMD 0x04 above). Getting
  // this wrong sends the hardware to the factory preset area — confirmed
  // by testing: B1 with [01][00] → hardware jumped to factory a1.
  sendHex('F0 13 0B 0F 00 02 00 ' + slotHex + ' F7');

  setStatus('Saved to ' + slotLabel(slot));
  appLog('Save commit sent for ' + slotLabel(slot));
}

// Save to Rack + auto-capture TFX to disk in one operation.
// Commits to current slot with the supplied name, then pulls SEND_PATCH
// back from hardware and writes it to the captures folder. The name
// update happens before capture so the TFX filename matches the slot.
async function saveToRackAndDisk(name) {
  await saveCurrentPatchToSlot(name);
  // A rack commit makes the slot match the buffer, so the current values ARE
  // the new saved truth: re-baseline knobs (main + effect) and clear dirty.
  // Save-to-Disk does NOT call this, so after a disk-only save the knobs stay
  // red and SAVE stays green — the patch is still unsaved to the rack.
  if (typeof captureKnobBaselines === 'function') captureKnobBaselines();  // main knobs -> amber
  if (typeof clearFxBaselines === 'function') { clearFxBaselines(); rebaselineOpenFxPanel(); }
  if (typeof clearPatchDirty === 'function') clearPatchDirty();   // saved = clean
  // Short settle before pulling SEND_PATCH — hardware needs to finish
  // the commit sequence before we read back what is now in the slot.
  await sleep(500);
  captureCurrentPatchNow();
}

document.getElementById('btn-load-tfx').addEventListener('click', loadTfxFromDisk);
document.getElementById('btn-save-slot').addEventListener('click', function() { saveCurrentPatchToSlot(); });
