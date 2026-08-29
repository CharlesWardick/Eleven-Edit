// ════════════════════════════════════════════════════════════════════
// SYSEX-HANDLER.JS — parseSysEx, the central dispatcher for every
// incoming SysEx message from the bridge. Large and central enough to
// get its own file rather than living inside protocol.js or
// transport.js — it calls into both, plus ui.js and capture-scan.js.
//
// STRUCTURE (reorganized 7/27): parseSysEx is now a thin dispatcher —
// it validates the header, then hands off to one handleXxx(data)
// function per CMD byte. Each handler is self-contained and can be
// read start to finish without the other 14 command types in the way.
// No behaviour changed in this pass; every branch, guard and early
// return was moved verbatim into its own function.
// ════════════════════════════════════════════════════════════════════

// Self-heal state for the amp-handle resync (see handleParamReadback's
// instId-mismatch branch).
var _handleMismatchCount    = 0;
var _lastHandleResyncMs     = 0;
var HANDLE_RESYNC_THRESHOLD = 5;      // consecutive unknown-handle broadcasts
var HANDLE_RESYNC_COOLDOWN  = 2000;   // ms between resync attempts

async function parseSysEx(data) {
  if (data.length < 6) return;
  // MIDI Universal SysEx Identity Reply (2026-08-28, firmware check) — a
  // completely different prefix (F0 7E, not Avid's F0 13 0B), so it has
  // to be caught before the Avid-only guard below would otherwise
  // silently drop it.
  if (data[0] === 0xF0 && data[1] === 0x7E) return handleIdentityReply(data);
  if (data[0] !== 0xF0 || data[1] !== 0x13 || data[2] !== 0x0B ||
      (data[3] !== 0x0F && data[3] !== 0x0E)) return;

  const cmd = data[5];

  // ── DIAGNOSTIC — amp paramLo investigation, 2026-07-22.
  // Raw-dump, in full and undecoded, any response whose CMD is in
  // PROBE_DUMP_CMDS. Runs before normal dispatch and changes nothing else;
  // messages that already have a handler still reach it as usual.
  if (typeof PROBE_DUMP_CMDS !== 'undefined' && PROBE_DUMP_CMDS.indexOf(cmd) !== -1) {
    appLog('PROBE resp CMD 0x' + cmd.toString(16).padStart(2,'0').toUpperCase() +
           '  len=' + data.length + 'b  ' +
           Array.from(data).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' '));
  }

  switch (cmd) {
    case 0x00:
    case 0x01: return handleBulkTfxData(data, cmd);
    case 0x04: return handleCmd04(data);
    case 0x02: return handleSlotConfirm(data);
    case 0x03: return handleSaveRigResponse(data);
    case 0x05: return handlePatchName(data);
    case 0x21: return handleChainMap(data);
    case 0x07: return handleRigVolumeBroadcast(data);
    case 0x40: return handleTunerBroadcast(data);
    case 0x0D: return handleMonoBroadcast(data);
    case 0x50: return handleRigTempoBroadcast(data);
    case 0x36: return handleToAmpVolumeBroadcast(data);
    case 0x3B: return handleMasterMuteBroadcast(data);
    case 0x3A: return handleToAmpSourceQueryResp(data);
    case 0x37: return handleToAmpSourceBroadcast(data);
    case 0x3D: return handleInputSelectorBroadcast(data);
    case 0x11: return handleParamReadback(data);
  }
  // Fell through — no case above claimed this CMD (every case returns, so
  // reaching here means none matched). Added 2026-08-11 for the Save to
  // Different Slot investigation: a front-panel "save to a different slot"
  // may use a command this app has never seen, and until now anything
  // outside PROBE_DUMP_CMDS was silently dropped with no log at all — a
  // real risk of missing exactly the evidence this investigation needs.
  // Safe to leave in permanently: a no-op for every command already
  // handled above (they all return before reaching this line).
  appLog('UNHANDLED CMD 0x' + cmd.toString(16).padStart(2,'0').toUpperCase() +
         '  len=' + data.length + 'b  ' +
         Array.from(data).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' '));
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x00 / 0x01 — Bulk TFX data
// ════════════════════════════════════════════════════════════════════
// CMD 0x00 — Bulk TFX data, spontaneous ASYNC broadcast (hardware save,
//   bank load). HAS a slot-number byte at data[6]; payload starts at 7.
// CMD 0x01 — Bulk TFX data, RESP to our own REQU SEND_PATCH. Confirmed
//   via real captured bytes (7/9/2026) that this does NOT have a slot-
//   number byte the way CMD 0x00 does — its payload starts ONE BYTE
//   EARLIER, at position 6. Decoding this with the CMD 0x00 layout
//   (payload at 7) silently fails to find anything, every time — this
//   was the actual reason our own on-demand pulls never updated amp/
//   gate, even after the REQU byte-format fix. Since this is a direct
//   response to something we asked for, treat it as being about
//   whatever slot we already believe we're on — no separate slot
//   number to check against.
//
// Bank load: CMD 0x04 for slot N arrives AFTER CMD 0x00 for slot N
//            so CMD 0x04 arms saveSequence, then CMD 0x00 for slot N+1 arrives
//            We detect this by checking if the slot in CMD 0x00 matches saveSequenceSlot
// Hardware save: CMD 0x04 for slot N, then CMD 0x00 for same slot N
async function handleBulkTfxData(data, cmd) {
  const isReqResp    = (cmd === 0x01);
  const slotNum       = isReqResp ? currentSlot : (data.length > 6 ? data[6] : currentSlot);
  const slotName      = slotLabel(slotNum);
  const payloadStart  = isReqResp ? 6 : 7;
  const payloadEnd    = data[data.length - 1] === 0xF7 ? data.length - 1 : data.length;
  const payload       = Array.from(data).slice(payloadStart, payloadEnd);

  if (payload.length < 100) {
    appLog('Bulk payload too small (' + payload.length + 'b) — ignored');
    return;
  }

  // Check if this is a hardware save — slot must match the armed save slot
  const isSave = saveSequenceDetected && (slotNum === saveSequenceSlot);
  appLog('Bulk data: ' + data.length + 'b slot=' + slotNum + ' (' + slotName + ') saveSeq=' + saveSequenceDetected + ' saveSlot=' + saveSequenceSlot + ' isSave=' + isSave);

  // Decode once, share with amp-key and gate decoding below
  const body = decode7bit(new Uint8Array(payload));
  appLog('Bulk body decoded: payload=' + payload.length + 'b body=' + body.length + 'b');

  // ── Bank scan (or Export All Rigs, which reuses the same scanSlot())
  // waiting on this exact slot? Hand it the decoded data directly and
  // stop here — scan mode has its own progress UI and doesn't want this
  // also thrashing the normal live display.
  // isReqResp (cmd 0x01) replies carry NO slot number on the wire — the
  // slotNum above is only a GUESS, taken from currentSlot, which itself
  // only updates when a SEPARATE "slot confirmed" broadcast (CMD 0x02)
  // happens to have already landed. That's a race between two independent
  // messages, not a guarantee — found live 2026-08-10 (Charlie: full
  // exports coming back with ~50 of 104 slots missing, present both
  // before and after a settle-time change, so not a timing-margin issue,
  // a genuine race in matching logic that's been here as long as
  // scanSlot() has, just never exercised at real scale before Export All
  // Rigs). FIX: for isReqResp specifically, trust pendingScanResolve
  // unconditionally instead of gating on the currentSlot guess — nothing
  // else sends a bare REQU_SEND_PATCH while a scan/export has one
  // in flight, so if pendingScanResolve is set, this IS that reply,
  // regardless of whether the confirm broadcast has landed yet. Resolve
  // with pendingScanSlot (the slot we actually asked for), not the
  // possibly-stale slotNum guess. CMD 0x00 broadcasts DO carry a real
  // slot byte on the wire, so those keep the exact match. ──
  if (pendingScanResolve && (isReqResp || slotNum === pendingScanSlot)) {
    const resolve = pendingScanResolve;
    const matchedSlot = pendingScanSlot;
    pendingScanResolve = null;
    pendingScanSlot = null;
    resolve({ body: body, slotNum: matchedSlot });
    return;
  }

  if (isSave) {
    // ── SAVE (hardware front-panel OR software Save to Rack — see
    // armSaveSequence): capture TFX to disk ──
    const isHardwareSave = saveSequenceIsHardware;
    saveSequenceDetected = false;
    saveSequenceSlot = -1;
    saveSequenceIsHardware = false;
    if (saveSequenceTimer) { clearTimeout(saveSequenceTimer); saveSequenceTimer = null; }

    captureCount++;
    appLog('Save confirmed — capturing TFX slot ' + slotNum + ' (' + slotName + ')');

    if (autoStartTime !== null && !autoPaused) {
      togglePause();
      appLog('Roller paused — hardware save detected (bulk broadcast matched armed save slot)');
    }

    // Discrete controls (cab/mic, mono) are safe to apply from the body.
    const ampInfo = decodeAmpKey(body);
    const ampChanged = !!(ampInfo && ampInfo.key && ampInfo.key !== currentAmpKey);
    // Only re-render the amp when it ACTUALLY changed — setCurrentAmp ->
    // updateToneKnobs blanks the tone row to "--"/midpoint, so calling it on a
    // same-amp save would wipe the live tone values (regression 7/27).
    if (ampChanged) setCurrentAmp(ampInfo.key);
    updateCabMicReadouts(decodeCabMicValues(body));
    updateMonoIndicator(decodeMonoStereo(body));
    // Continuous red-tracked knobs (gate, amp out, tone, To-Amp vols) already
    // show the correct LIVE 0-127 values. Re-decoding them from the body rounds
    // a high-res int32 via gateRawToV127 and can land one unit off the live
    // value — the harmless difference our pixel-perfect red flags as phantom
    // red / the Save-to-Rack flash. So repaint them ONLY when there is no live
    // truth to preserve: the amp was just re-rendered (blanked), or the legacy
    // bulk-on-nav mode (nothing live-populated them). (7/27)
    if (ampChanged || REQUEST_BULK_ON_NAV) {
      updateGateReadout(decodeGateValues(body, ampInfo ? ampInfo.markerPos : null));
      updateAmpOutReadout(decodeAmpOutValue(body, ampInfo ? ampInfo.markerPos : null));
      updateToneReadouts(decodeToneKnobValues(body, ampInfo ? ampInfo.markerPos : null, ampInfo ? ampInfo.key : null), ampInfo ? ampInfo.key : null);
      updateToAmpVolumeReadouts(decodeToAmpVolumes(body));
    }
    captureKnobBaselines();   // saved values are the new "unchanged" baseline
    clearFxBaselines();       // effect truth is now the saved state:
    rebaselineOpenFxPanel();  //   re-anchor an open panel, others on next open
    if (typeof clearPatchDirty === 'function') clearPatchDirty();  // saved = clean
    // A save makes the rack re-instantiate the patch and REASSIGN block
    // handles, so currentParamHi (and the effect handles) are now stale —
    // SW knob writes would hit the old amp handle and appear dead until a HW
    // knob turn triggers the self-heal. Re-read the chain map now to refresh
    // all handles (and currentChain / bypass / effect panels) proactively.
    // SETTLE DELAY (found 2026-08-29, Charlie's own isolating test — same-
    // slot save corrupts the chain on the next FX-host model change,
    // different-slot save never does): a save to a DIFFERENT slot gets
    // bailed out by handleSlotConfirm's own full resync (clearStaleReadoutsOnNav
    // + requestPatchStateAfterNav), which ALWAYS waits NAV_RECALL_SETTLE
    // before querying anything — because the hardware genuinely needs that
    // settle time to finish reinstantiating the patch. That resync only
    // fires when the confirmed slot actually differs from currentSlot
    // (handleSlotConfirm's own guard), so a same-slot save never gets it —
    // this REQU_CHAIN_MAP was firing with NO settle delay at all, unlike
    // every other post-commit/post-nav re-read in the app. If hardware
    // hasn't finished reassigning handles yet, the reply this elicits (and
    // therefore currentChain) can be stale, and an FX-host model change
    // built from that stale chain writes wrong handles for the other 9
    // blocks — a plausible mechanism for the corruption, not yet proven
    // but matching every observation so far.
    if (typeof REQU_CHAIN_MAP !== 'undefined') {
      await sleep(NAV_RECALL_SETTLE);
      appLog('Post-save: re-reading chain map to refresh reassigned block handles');
      sendHex(REQU_CHAIN_MAP);
    }
    // 2026-08-29 (Charlie's call, scaling Save back to Avid's simple A/B/C
    // model): this branch is now reached by BOTH a real hardware
    // front-panel save AND a software Save to Rack (armSaveSequence is
    // called from both places — see its own comment). Only the hardware
    // case gets the "_manual" suffix; Save to Rack's own free capture (this
    // is the SAME capture, not a second pull) gets the plain name. Save to
    // Disk is unrelated to this branch entirely (pendingManualCapture below).
    // incrementIfExists on BOTH — a real save shouldn't silently clobber an
    // earlier capture of the same name any more than Save to Disk or a
    // hardware save does (found 2026-08-29: Save to Rack was overwriting
    // on every repeat save while the other two paths correctly incremented
    // — an oversight in the naming-swap fix, not an intentional split).
    const captureName = (currentPatchName || 'patch').replace(/[\\/:*?"<>|]/g, '_').substring(0,24)
      + (isHardwareSave ? '_manual' : '');
    try {
      const result = await window.electronAPI.saveTfx(captureName, payload, { incrementIfExists: true });
      if (result && result.ok) {
        document.getElementById('capture-info').innerHTML =
          'Captures this session: <span>' + captureCount + '</span> — last: ' + result.filename;
        appLog('TFX saved: ' + result.path);
      } else {
        document.getElementById('capture-info').textContent = 'TFX save failed: ' + (result ? result.error : 'unknown');
        appLog('TFX save failed: ' + (result ? result.error : 'unknown'));
      }
    } catch(e) {
      appLog('TFX save error: ' + e.message);
    }

  } else {
    // ── NOT A SAVE: bank load / navigation sync / manual capture ──
    // Only apply this if it matches currentSlot — currentSlot is
    // always correctly pre-aligned before any SEND_PATCH request goes
    // out now (goToSlot sets it immediately for both first-connect and
    // normal nav, the CMD 0x02 handler sets it for hardware-initiated
    // nav), so a plain exact match is both safe and correct everywhere.
    // This also protects against a stale response from an older
    // request arriving late during fast navigation and yanking the
    // display backward.
    if (slotNum === currentSlot) {
      const ampInfo = decodeAmpKey(body);
      const ampChanged = !!(ampInfo && ampInfo.key && ampInfo.key !== currentAmpKey);
      // Only re-render the amp if it actually changed (setCurrentAmp blanks the
      // tone row); otherwise leave the live knobs untouched.
      if (ampChanged) setCurrentAmp(ampInfo.key);
      updateCabMicReadouts(decodeCabMicValues(body));
      updateMonoIndicator(decodeMonoStereo(body));
      // Don't repaint the continuous red-tracked knobs from the body unless the
      // amp was just re-rendered or we're in legacy bulk-on-nav — they already
      // show the live 0-127 values, and a body re-decode rounds one unit off,
      // which shows as phantom red (the Save-to-Disk "knobs stay red" case). (7/27)
      if (ampChanged || REQUEST_BULK_ON_NAV) {
        updateGateReadout(decodeGateValues(body, ampInfo ? ampInfo.markerPos : null));
        updateAmpOutReadout(decodeAmpOutValue(body, ampInfo ? ampInfo.markerPos : null));
        updateToneReadouts(decodeToneKnobValues(body, ampInfo ? ampInfo.markerPos : null, ampInfo ? ampInfo.key : null), ampInfo ? ampInfo.key : null);
        updateToAmpVolumeReadouts(decodeToAmpVolumes(body));
      }
      // NOTE: do NOT re-baseline knob colours here. This branch is a generic
      // readback of the CURRENT buffer — it fires on manual "Capture Now" and
      // on Save-to-Disk, where the buffer may be dirty. Re-baselining would
      // wrongly turn red knobs amber. Baselines are set only on a true patch
      // load (end of the nav pull) and on a rack commit (save paths).
    } else {
      appLog('Bulk response for slot ' + slotNum + ' ignored — stale (currentSlot now ' + currentSlot + ')');
    }

    // Manual "Capture Current Patch Now" / Save to Disk — save this pull to
    // disk even though it's not a hardware-detected save. 2026-08-29
    // (Charlie's A/B/C save simplification): plain name now, no "_manual"
    // suffix — that suffix moved to mark a real hardware front-panel save
    // instead (see the isSave branch above). This branch is reached by the
    // debug "Capture Current Patch" button and by Save to Disk, both
    // deliberate, user-named pulls, not a hardware event.
    if (pendingManualCapture) {
      pendingManualCapture = false;
      const captureName = (currentPatchName || 'patch').replace(/[\\/:*?"<>|]/g, '_').substring(0,24);
      try {
        const result = await window.electronAPI.saveTfx(captureName, payload, { incrementIfExists: true });
        if (result && result.ok) {
          appLog('Manual capture saved: ' + result.path);
          setStatus('Captured: ' + result.filename);
          document.getElementById('capture-info').innerHTML =
            'Manual capture saved — last: ' + result.filename;
        } else {
          appLog('Manual capture failed: ' + (result ? result.error : 'unknown'));
          setStatus('Manual capture failed: ' + (result ? result.error : 'unknown'));
        }
      } catch(e) { appLog('Manual capture error: ' + e.message); }
    }

    // Reset any armed save sequence since this bulk is for a different slot
    if (saveSequenceDetected && slotNum !== saveSequenceSlot) {
      saveSequenceDetected = false;
      saveSequenceSlot = -1;
      if (saveSequenceTimer) { clearTimeout(saveSequenceTimer); saveSequenceTimer = null; }
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x04 — Save slot/name confirmation
// ════════════════════════════════════════════════════════════════════
// CMD 0x04 carries THREE different things depending on what triggered it,
// not two as originally assumed:
//   - the save-sequence "arm" broadcast (short — data[7]=raw armed slot,
//     no embedded name) — handleSaveArm. Never actually confirmed against a
//     real front-panel save (see below) — may be a bank-load-only signal.
//   - a patch-name query reply / our own bank-index write's echo (Jump List
//     "by name" scan, our own Save-to-Rack step 3) — [00][slot][name][00],
//     ends right after ONE null terminator — handlePatchNameEnumReply.
//   - a REAL HARDWARE FRONT-PANEL SAVE confirmation — found 2026-08-29
//     (Charlie: two live front-panel save presses, TFX auto-capture never
//     fired either time). Wire-identical to the name-reply format for its
//     first bytes ([00][slot][name]) but padded well past the name's null
//     terminator (~41 bytes total for "Driftwood Purple" vs 26 for the
//     plain echo/scan-reply of the identical name) — presumably a fuller
//     "slot committed" structure, not just a name echo. The original
//     length>10-vs-short split completely missed this: a real hardware
//     save's CMD 0x04 is LONG (has a name), same bucket as a name reply,
//     so handleSaveArm was never reached by an actual front-panel save —
//     hardware-save auto-capture may never have worked via this signal in
//     the app's history. Distinguish by how much padding follows the name's
//     null terminator: a plain echo/scan-reply ends within a byte or two of
//     it; a real save pads much further out.
function handleCmd04(data) {
  if (data.length > 10) return handlePatchNameEnumReply(data);
  return handleSaveArm(data);
}

// Jump List "by name" scan reply (2026-08-03) — CONFIRMED LIVE same day
// (Charlie's first test + session log). data[6] is the SPACE (0x00=user,
// 0x01=factory — NOT a bank number), data[7] is the FULL raw slot 0-103
// within that space (NOT slot%4) — see sendPatchNameQuery, transport.js,
// for the full story of the first (wrong) version of this addressing.
// The name decode itself (offset 8 to the null terminator) was correct
// from the start — real capture text matched perfectly, only the
// space/slot math was wrong.
function handlePatchNameEnumReply(data) {
  try {
    const space = data[6], rawSlot = data[7];
    if (space !== 0x00 && space !== 0x01) return;
    if (rawSlot < 0 || rawSlot > 103) return;
    // Factory names (2026-08-28) — RETRACTS the earlier "this app only
    // tracks user A1-Z4, factory deliberately never shown" call
    // (2026-08-03 Primer entry): now that factory patches are navigable
    // (Stage 1) and have their own Jump List side (Stage 2), a blank
    // factory grid would be pointless. Stored at the unified slot index
    // (protocol.js spaceRawToSlot) alongside user names in the same cache.
    const slot = spaceRawToSlot(space, rawSlot);
    let end = 8;
    while (end < data.length && data[end] !== 0x00) end++;
    const name = Array.from(data.slice(8, end)).map(b => String.fromCharCode(b)).join('').trim();
    patchNameCache[slot] = name;
    appLog('Patch name scan: ' + slotLabel(slot) + ' = "' + name + '"');
    if (typeof refreshNamedMatrixSlot === 'function') refreshNamedMatrixSlot(slot);
    // REAL HARDWARE FRONT-PANEL SAVE detection (found 2026-08-29) — a plain
    // name echo/scan-reply ends within a byte or two of the terminator
    // found above (just the terminator + F7). A genuine front-panel save's
    // CMD 0x04 pads well past it (~15+ extra bytes, confirmed against a
    // live capture of two real hardware save presses). Only a real save
    // (not a name query) should arm the save sequence — space must be user
    // (0x00): hardware saves are never a factory address (see HARDWARE
    // SAFETY, Tech Ref Sec 15).
    if (space === 0x00 && (data.length - end) > 4) {
      armSaveSequence(rawSlot, 'CMD 0x04 broadcast (padded/hardware save)', true);
    }
  } catch(e) { appLog('handlePatchNameEnumReply error: ' + e.message); }
}

function handleSaveArm(data) {
  if (data.length < 8) return;
  armSaveSequence(data[7], 'CMD 0x04 broadcast', true);
}

// Shared arming logic — sets the window that lets the NEXT matching bulk
// broadcast (CMD 0x00, same slot) be treated as a save instead of an
// ordinary nav/bank-load bulk (see handleBulkTfxData's isSave check above).
// A real front-panel save arms itself via the hardware's own short CMD 0x04
// broadcast (handleSaveArm). A SOFTWARE-initiated Save to Rack/Disk
// (saveCurrentPatchToSlot, capture-scan.js) never receives that broadcast —
// the only CMD 0x04 traffic it sees is the long, name-bearing echo of its
// own bank-index write, which handleCmd04 correctly routes to
// handlePatchNameEnumReply instead (it IS a name reply, not an arm signal).
// Left alone, that meant every software save's own mid-save bulk broadcast
// fell through to the "NOT A SAVE" branch, silently skipping the post-save
// chain-map refresh + bypass requery that branch is responsible for —
// exactly the "chain row dead after Save" bug (found 2026-08-29): stale
// block handles and stale blockBypass entries (esp. AMP, which always
// shows 'unknown' from a bulk decode alone — see updateCabMicReadouts)
// survive a hardware handle-reassignment because nothing ever refreshed
// them. Fix: saveCurrentPatchToSlot arms this directly for its own target
// slot before it sends anything, so ITS bulk broadcast is recognized too.
function armSaveSequence(armed_slot, source, isHardware) {
  appLog((source || 'software save') + ' — arming save sequence for slot ' + armed_slot + ' (' + slotLabel(armed_slot) + ')');
  saveSequenceDetected = true;
  saveSequenceSlot = armed_slot;
  saveSequenceIsHardware = !!isHardware;
  if (saveSequenceTimer) clearTimeout(saveSequenceTimer);
  saveSequenceTimer = setTimeout(function() {
    saveSequenceDetected = false;
    saveSequenceSlot = -1;
    saveSequenceIsHardware = false;
    saveSequenceTimer = null;
    appLog('Save sequence timeout — reset');
  }, 5000);
}

// ════════════════════════════════════════════════════════════════════
// MIDI UNIVERSAL SYSEX IDENTITY REPLY — firmware check (2026-08-28)
// F0 7E <deviceId> 06 02 <mfrId> <family LSB><family MSB>
// <member LSB><member MSB> <software revision, 4 bytes> F7
// Confirmed via a cold-start Wireshark capture: the software-revision
// bytes are plain ASCII spelling out the build number ("0157" = Build
// 0.1.5.7) — a genuine, standard MIDI mechanism entirely separate from
// Avid's own proprietary 13 0B 0F command set, which is why it had never
// been noticed in three unknown-command hunts before this one. See
// HARDWARE SAFETY / checkInitialPopulateReady (transport.js) for why
// this gates the startup reveal.
// ════════════════════════════════════════════════════════════════════
function handleIdentityReply(data) {
  try {
    if (data.length < 9 || data[3] !== 0x06 || data[4] !== 0x02) return;
    const revBytes = data.slice(data.length - 5, data.length - 1); // 4 bytes before F7
    const revString = Array.from(revBytes).map(b => String.fromCharCode(b)).join('');
    firmwareVersionSeen = revString;
    firmwareOk = (revString === EXPECTED_FIRMWARE_BUILD);
    firmwareCheckDone = true;
    clearTimeout(firmwareCheckTimer);
    appLog('Firmware identity reply: build "' + revString + '"' +
           (firmwareOk ? ' (matches expected ' + EXPECTED_FIRMWARE_BUILD + ')'
                       : ' — DOES NOT MATCH expected ' + EXPECTED_FIRMWARE_BUILD));
    if (typeof checkInitialPopulateReady === 'function') checkInitialPopulateReady();
  } catch(e) { appLog('handleIdentityReply error: ' + e.message); }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x02 — Current rig number (slot confirmation)
// ════════════════════════════════════════════════════════════════════
function handleSlotConfirm(data) {
  if (data.length < 8) return;
  // data[6] = space (0=user A1-Z4, 1=factory a1-z4), data[7] = raw slot
  // 0-103 within that space — confirmed 2026-08-28 via a Wireshark capture
  // of the Avid Editor crossing Z4->a1->a2->back (Session Log). RETRACTS
  // the earlier "data[6]=bank, data[7]=num, slot=bank*4+num for a save
  // commit echo" theory: that was never actually confirmed outside bank A,
  // where it's indistinguishable from the space+slot reading (space is
  // always 0 there either way) — the same kind of untested-outside-bank-A
  // guess that caused the CMD 0x04 addressing bug (Sec 24, 2026-08-03).
  // If a save-commit echo on a non-A user bank ever mis-navigates, this is
  // the first place to check.
  const confirmed = spaceRawToSlot(data[6], data[7]);
  if (confirmed !== currentSlot) {
    currentSlot = confirmed;
    const el = document.getElementById('slot-display');
    el.textContent = slotLabel(confirmed);
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 80);
    document.getElementById('slot-num').textContent = 'Slot ' + confirmed;
    if (typeof updateNavDisplay === 'function') updateNavDisplay(confirmed);
    appLog('Slot confirmed: ' + confirmed + ' (' + slotLabel(confirmed) + ')');
    if (!scanInProgress && !exportInProgress) {
      // Fires for ANY slot change — our own PC send or the hardware's
      // own front panel nav — so patch name/amp/rig vol stay in sync
      // either way. Skipped during a bank scan OR a bank export (2026-
      // 08-10 — both drive their own navigation via scanSlot and already
      // have an explicit SEND_PATCH in flight for each slot; this would
      // just race it AND repaint every knob/panel 104 times in a few
      // seconds for no reason, which is what made the walk look like it
      // was "dimming"/flickering the whole main screen, per Charlie's
      // 2026-08-10 report).
      clearStaleReadoutsOnNav();
      requestPatchStateAfterNav();
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Roller pause-on-edit — shared by the CMD 0x03 dirty-flag trigger and
// the CMD 0x11 param-change trigger (see both call sites for why two
// independent signals are needed, not just the dirty flag alone).
// ════════════════════════════════════════════════════════════════════
function maybePauseRollerOnEdit(reason, skipSettleGuard) {
  if (autoStartTime === null || autoPaused) return;
  const sinceNav = lastNavTime === null ? Infinity : (performance.now() - lastNavTime);
  if (!skipSettleGuard && sinceNav < ROLLER_NAV_SETTLE_GUARD) return;
  togglePause();
  appLog('Roller paused — control edited during roll (' + reason + ', ' +
         Math.round(sinceNav) + 'ms after last nav)');
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x03 — Save rig response
// ════════════════════════════════════════════════════════════════════
// data[7] is a per-slot DIRTY flag (0x01 = that slot has unsaved edits
// pending, 0x00 = clean) — see Tech Ref Sec 4 ("CMD 0x03 dirty flag").
// PAUSE-ON-EDIT (intended feature): the roller pauses when the flag flips
// to dirty, since that's exactly what happens the instant a user touches
// any control (bass, vol, etc.) mid-roll — confirmed working before
// 2026-08-11.
// PAUSE-ON-SAVE (separate, confirmed feature) is handled elsewhere — see
// handleBulkTfxData's isSave branch, armed by the real CMD 0x04 + CMD 0x00
// same-slot save sequence.
// THE 2026-08-11 BUG: CMD 0x03 also fires as a normal side effect of plain
// CMD 0x02 slot navigation (Tech Ref Sec 6 — "the hardware echoes the
// requested slot in both the 0x03 and 0x02 announcements"), including the
// settle/query traffic right after the roller's OWN auto-advance recall.
// Landing on a slot that was already dirty from earlier editing (this
// session or a previous one) then broadcasts data[7]=0x01 with no user
// having touched anything, and used to falsely pause the roll. FIX: only
// treat the dirty flag as a real edit once the post-recall settle window
// (ROLLER_NAV_SETTLE_GUARD, transport.js) has passed — a genuine user
// touch during that early window is rare and, if missed, will still catch
// the NEXT edit; a false pause on every dirty slot happened every time.
function handleSaveRigResponse(data) {
  appLog('CMD 0x03 response: ' + Array.from(data).map(b=>b.toString(16).padStart(2,'0')).join(' '));
  if (data.length >= 8 && data[7] === 0x01) {
    maybePauseRollerOnEdit('CMD 0x03 dirty flag');
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x05 — Patch name
// ════════════════════════════════════════════════════════════════════
function handlePatchName(data) {
  const bytes = [];
  for (let i = 6; i < data.length - 1; i++) {
    if (data[i] === 0) break;
    bytes.push(data[i]);
  }
  const name = bytes.map(b => String.fromCharCode(b)).join('');
  if (name) {
    // Same guard as R9 elsewhere in this app (a broadcast readback must not
    // fight an in-progress user edit) — if a local rename (startPatchNameEdit,
    // index.html) is mid-edit, this broadcast would otherwise both crash on
    // a null nameEl (the span is temporarily replaced by the edit input) AND
    // silently overwrite the pending rename with hardware's own value.
    if (document.getElementById('patch-name-edit')) return;
    currentPatchName = name;
    const nameEl = document.getElementById('patch-name');
    if (nameEl) { nameEl.textContent = name; nameEl.classList.add('live'); }
    setStatus(slotLabel(currentSlot) + ' — ' + name);
    appLog('Patch name: "' + name + '"');
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x21 — Chain map
// ════════════════════════════════════════════════════════════════════
// Message: F0 13 0B 0F [dir] 21 [11 triplets] [trailing] F7   (41 bytes)
// Triplet = [backLink][mid][handle], 3 bytes each, starting at data[6].
//
// The FIRST byte is a BACK-LINK holding the PREVIOUS block's slot ID —
// it is not a type tag. Slot IDs are recovered by shifting:
//     slotId(triplet N) = backLink(triplet N+1)
//     slotId(last)      = trailing byte
// Triplet 0 is the input block (slot 0x0B), not a chain block.
//
// Slot IDs are FIXED per block type in every patch (Tech Ref Sec 4):
//   0x00 AMP-CAB  0x03 WAH   0x06 DELAY  0x09 FX2
//   0x01 LOOP     0x04 MOD   0x07 DIST   0x0B INPUT
//   0x02 VOL      0x05 REVERB 0x08 FX1
//
// HISTORY — this handler previously searched for a first byte of 0x07 and
// treated that triplet as the amp, on the belief that the field was a type
// tag and 0x07 meant "amp". Because 0x07 is DIST's slot ID, that actually
// found "the block AFTER dist". It agreed with the amp only on patches
// where the amp immediately follows the distortion — true of the small set
// of test patches, false for 11 of 14 real patches checked on 2026-07-19.
// On the rest it addressed FX2, LOOP or REVERB, so every amp write (tone,
// gate, amp out, cab, mic, amp select) went to the wrong block and every
// incoming amp broadcast was discarded as "not ours".
function handleChainMap(data) {
  const TRIPLETS = 11;
  const base = 6;
  if (data.length < base + TRIPLETS * 3 + 2) {
    appLog('CMD 0x21: short chain map (' + data.length + 'b), ignored');
    return;
  }

  const trip = [];
  for (let n = 0; n < TRIPLETS; n++) {
    const i = base + n * 3;
    trip.push({ backLink: data[i], mid: data[i+1], handle: data[i+2] });
  }
  const trailing = data[base + TRIPLETS * 3];

  // Recover each triplet's own slot ID from the following triplet's back-link.
  const slotIds = [];
  for (let n = 0; n < TRIPLETS; n++) {
    slotIds.push(n < TRIPLETS - 1 ? trip[n+1].backLink : trailing);
  }

  // Chain blocks are triplets 1..10; triplet 0 is the input block.
  currentChain = [];
  for (let n = 1; n < TRIPLETS; n++) {
    currentChain.push({
      position: n,                       // 1..10, left to right
      slotId:   slotIds[n],
      name:     SLOT_ID_TO_NAME[slotIds[n]] || ('slot0x' + slotIds[n].toString(16)),
      modelId:  trip[n].mid,             // effect model — see Tech Ref Sec 23
      handle:   trip[n].handle           // instId for CMD 0x11 on this block
    });
  }
  currentChainInput = { slotId: slotIds[0], modelId: trip[0].mid, handle: trip[0].handle };

  // Amp handle = the block whose slot ID is 0x00. Position independent.
  const ampBlock = currentChain.find(b => b.slotId === SLOT_AMP);
  if (ampBlock) {
    currentParamHi = ampBlock.handle;
    appLog('CMD 0x21 chain: ' + currentChain.map(b => b.name).join(' > '));
    appLog('CMD 0x21 AMP paramHi: 0x' + currentParamHi.toString(16).padStart(2,'0').toUpperCase()
           + ' (chain position ' + ampBlock.position + ')');
    syncAmpSelectDropdown(currentAmpKey);
    // The TFX carries no amp-bypass key, so ask the hardware directly.
    // Handles are only valid once the chain map has arrived, which is now.
    renderChainRow();          // reorder slots, hover text, stereo connectors
    requestAllBypass();        // AFTER the row exists — needs currentChain populated
    // If DIST panel is open, update its dropdown/knobs with the new handle
    if (typeof refreshDistPanelAfterChainMap === 'function') refreshDistPanelAfterChainMap();
    if (typeof refreshReverbPanelAfterChainMap === 'function') refreshReverbPanelAfterChainMap();
    if (typeof refreshWahPanelAfterChainMap === 'function') refreshWahPanelAfterChainMap();
    if (typeof refreshVolPanelAfterChainMap === 'function') refreshVolPanelAfterChainMap();
    if (typeof refreshFxLoopPanelAfterChainMap === 'function') refreshFxLoopPanelAfterChainMap();
    if (typeof refreshDelayPanelAfterChainMap === 'function') refreshDelayPanelAfterChainMap();
    if (typeof refreshFxHostPanelAfterChainMap === 'function') refreshFxHostPanelAfterChainMap();
    // Release the post-nav pull's wait: currentParamHi and currentChain are
    // now valid, so amp-block queries can safely be addressed.
    chainMapRxSeq++;
    initialChainMapDone = true;
    checkInitialPopulateReady();
  } else {
    // Should not happen — every rig has an amp block.
    appLog('CMD 0x21: no AMP block (slot 0x00) found in chain map, paramHi unchanged');
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x07 — Rig Volume hardware knob broadcast
// ════════════════════════════════════════════════════════════════════
function handleRigVolumeBroadcast(data) {
  const v0  = data[6];
  const val = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);
  const wrap = document.getElementById('rig-vol-wrap');
  if (wrap) {
    wrap.dataset.value = val;
    drawKnob(wrap.querySelector('canvas'), val);
    document.getElementById('rig-vol-val').textContent = valRigVol(val);
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x40 — Tuner state broadcast
// ════════════════════════════════════════════════════════════════════
// F0 13 0B 0F 02 40 [state] F7 — confirmed 7/15/2026 from session log
// data[6]=0x01 = tuner ON, data[6]=0x00 = tuner OFF
// Hardware never echoes CC 69 back — it responds with this SysEx instead.
function handleTunerBroadcast(data) {
  if (data.length < 7) return;
  handleTunerCC(data[6] === 0x01 ? 127 : 0);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x0D — Stereo/Mono echo/broadcast
// ════════════════════════════════════════════════════════════════════
// Hardware echo after SW send is always 02 0D 01 regardless of direction —
// not a reliable state indicator. Suppress it for one cycle after a SW send.
// Unsolicited front-panel broadcasts are passed through normally.
function handleMonoBroadcast(data) {
  if (suppressMonoEcho) {
    suppressMonoEcho = false;
    appLog('CMD 0x0D echo suppressed (SW send in progress)');
    return;
  }
  const val = (data.length >= 9) ? data[7] : data[6];
  const isMono = (val === 0x01);
  updateMonoIndicator(isMono);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x50 — Rig tempo
// ════════════════════════════════════════════════════════════════════
// Broadcast on every tempo change (front panel, Avid editor, or our own send
// echoed back) and also the reply to REQU_TEMPO_READ.
// Format: F0 13 0B 0F [dir] 50 d1 d2 d3 d4 F7 — four SIX-bit digits of the
// microseconds-per-beat value. dir is 0x02 for a broadcast and 0x12 for the
// reply to our query; both mean the same thing here.
// See protocol.js rigTempoDecodeUs for the encoding and why it is not the
// 7-bit format used elsewhere.
function handleRigTempoBroadcast(data) {
  if (data.length < 10) return;
  const us  = rigTempoDecodeUs(data[6], data[7], data[8], data[9]);
  const bpm = rigTempoUsToBpm(us);
  if (bpm !== null) updateTempoDisplay(bpm);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x36 — To Amp / Master volume hardware knob broadcast
// ════════════════════════════════════════════════════════════════════
// Format: F0 13 0B 0F 02 36 [slot] [v0] 00 00 00 00 F7
// slot: 0x00=Main (Master), 0x02=ToAmp1, 0x03=ToAmp2. v0 = raw 0x00–0x7F
// (no formula). ToAmp1/2 confirmed 7/17/2026 from HW knob capture; Main
// added 7/29/2026 from Master_Volume_Mute_Phones_Capture.pcapng.
// Drag flags (toAmp1Dragging / toAmp2Dragging) suppress display update
// while user is actively dragging the SW knob.
function handleToAmpVolumeBroadcast(data) {
  if (data.length < 8) return;
  const slot = data[6];
  const v0   = data[7];
  const val  = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);
  if (slot === 0x00) {
    appLog('CMD 0x36 Master volume: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' (' + valToMasterVol(val) + ')');
    updateMasterVolDisplay(val);
  } else if (slot === 0x02) {
    appLog('CMD 0x36 ToAmp1 volume: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' (' + valToAmpVol(val) + ')');
    if (!toAmp1Dragging) {
      const wrap = document.getElementById('toamp1-vol-wrap');
      if (wrap) {
        wrap.dataset.value = val;
        drawKnob(wrap.querySelector('canvas'), val);
        document.getElementById('toamp1-vol-val').textContent = valToAmpVol(val);
      }
    }
  } else if (slot === 0x03) {
    appLog('CMD 0x36 ToAmp2 volume: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' (' + valToAmpVol(val) + ')');
    if (!toAmp2Dragging) {
      const wrap = document.getElementById('toamp2-vol-wrap');
      if (wrap) {
        wrap.dataset.value = val;
        drawKnob(wrap.querySelector('canvas'), val);
        document.getElementById('toamp2-vol-val').textContent = valToAmpVol(val);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x3B — Master Mute (Main / Phones) broadcast
// ════════════════════════════════════════════════════════════════════
// Format: F0 13 0B 0F [dir] 3B [channel] [state] F7 (9 bytes)
// channel: MUTE_CH_MAIN (0x00) / MUTE_CH_PHONES (0x01).
// state: 0x00 = unmuted, 0x01 = muted.
// Confirmed 7/29/2026 (Master_Volume_Mute_Phones_Capture.pcapng) — fires on
// our own SW send's HW echo the same as every other confirmed send/echo
// command here, so this one handler keeps the mute buttons lit correctly
// whether the change came from us, the front panel, or the Avid editor.
function handleMasterMuteBroadcast(data) {
  if (data.length < 8) return;
  const channel = data[6];
  const muted   = data[7] === 0x01;
  appLog('CMD 0x3B mute: channel=' + (channel === MUTE_CH_MAIN ? 'Main' : 'Phones') + ' muted=' + muted);
  updateMuteButton(channel, muted);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x3A — To Amp source query response
// ════════════════════════════════════════════════════════════════════
// Format: F0 13 0B 0F 12 3A 07 [slot] [currentVal] F7  (10 bytes)
// data[6]=0x07, data[7]=slot, data[8]=currentVal
// Fires after our CMD 0x3A REQU. If a pendingToAmpSource matches this
// slot, send the queued CMD 0x37 now that HW has confirmed readiness.
// Confirmed 7/17/2026 — Avid always queries before writing; skipping caused assert.
function handleToAmpSourceQueryResp(data) {
  if (data.length < 10) return;
  const slot = data[7];
  const currentVal = data[8];
  appLog('CMD 0x3A ToAmp' + (slot === 0x00 ? '1' : '2') + ' source query resp: currentVal=0x' + currentVal.toString(16).padStart(2,'0').toUpperCase());
  if (pendingToAmpSource !== null && pendingToAmpSource.slot === slot) {
    const pending = pendingToAmpSource;
    pendingToAmpSource = null;
    appLog('CMD 0x3A response received — now sending CMD 0x37 slot=0x' + pending.slot.toString(16).padStart(2,'0') + ' val=0x' + pending.val.toString(16).padStart(2,'0'));
    sendToAmpSource(pending.slot, pending.val);
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x37 — To Amp source broadcast
// ════════════════════════════════════════════════════════════════════
// Format: F0 13 0B 0F 02 37 07 [slot] [val] F7
// slot: 0x00=ToAmp1, 0x01=ToAmp2.
// val:  0x00=Rig Input, 0x01=Amp Input, 0x02=Amp Output, 0x03=Rig Output.
// Confirmed 7/17/2026 from Avid editor capture.
function handleToAmpSourceBroadcast(data) {
  if (data.length < 9) return;
  const slot = data[6];
  const val  = data[7];
  const selId = (slot === 0x00) ? 'toamp1-src' : (slot === 0x01) ? 'toamp2-src' : null;
  if (selId) {
    const sel = document.getElementById(selId);
    if (sel) sel.value = String(val);
    appLog('CMD 0x37 ToAmp' + (slot+1) + ' source: val=0x' + val.toString(16).padStart(2,'0').toUpperCase());
  }
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x3D — Input selector broadcast
// ════════════════════════════════════════════════════════════════════
function handleInputSelectorBroadcast(data) {
  const inputVal = data[6];
  appLog('CMD 0x3D input selector: 0x' + inputVal.toString(16).padStart(2,'0').toUpperCase());
  setInputButtons(inputVal);
}

// ════════════════════════════════════════════════════════════════════
// CMD 0x11 — Parameter readback
// ════════════════════════════════════════════════════════════════════
// Two formats on the MIDI layer:
// FORMAT A — ASYNC broadcasts: data[6]=instId, data[7]=paramLo, data[8]=v0
// FORMAT B — RESP to explicit REQU: data[6]=0x04, data[7]=instId, data[8]=paramLo, data[9]=v0
function handleParamReadback(data) {
  if (data.length < 9) return;

  // ── BYPASS ROUTING — handled for EVERY block, not just the amp. Must run
  // before the amp-only instId guard further down, and before FORMAT A/B are
  // otherwise decoded, since bypass has its own instId/paramLo/v0 reading
  // that covers both formats itself.
  if (routeBypassMessage(data)) return;

  // FORMAT B check
  if (data[6] === 0x04 && currentParamHi >= 0 && data[7] === currentParamHi && data.length >= 10) {
    routeFormatBAmpMessage(data);
    return;
  }

  const instId  = data[6];
  const paramLo = data[7];
  const v0      = data[8];
  const val     = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);

  // FORMAT A is a spontaneous ASYNC broadcast — i.e. a real control just
  // changed on hardware (front panel or Avid editor), unlike FORMAT B above
  // which is only ever a reply to a REQU we ourselves sent. That makes this
  // the direct "something was touched" signal, independent of the CMD 0x03
  // dirty flag's own edge-only broadcast behaviour (see handleSaveRigResponse):
  // the dirty flag only announces the FIRST edit after a save/recall — a
  // second control touched later in the same roll leaves the flag already at
  // 1 with nothing new to announce, so relying on CMD 0x03 alone silently
  // swallows every edit after the first one caught (found live 2026-08-11,
  // via Charlie's resume-then-touch-again test). Catching it here as well
  // closes that gap.
  //
  // BUT a flat post-nav TIME guard (like CMD 0x03 uses) is wrong here: the
  // hardware's own settling-into-the-recalled-patch process ALSO broadcasts
  // real FORMAT A messages for every tone/amp param (seen live, each value
  // announced twice, back to back, right after "Nav pull complete") — using
  // elapsed-time-since-nav to tell that apart from a genuine quick touch cost
  // a real edit right after landing on a slot (Charlie's "happened twice,
  // can't reproduce" report — a knob drag ~2s after nav lost the race against
  // a 2000ms guard). VALUE COMPARISON instead of timing: paramSettleBaseline
  // (state.js) remembers the last value seen for each instId/paramLo since
  // the last nav (cleared in goToSlot). The settle broadcasts repeat the SAME
  // value (that's the patch's actual stored value, announced, not changed) —
  // only a value that DIFFERS from what was already seen this nav means the
  // control's position actually moved, which is what "touched" means. No
  // time window needed or used here.
  const settleKey = instId + ':' + paramLo;
  const prevVal = paramSettleBaseline[settleKey];
  paramSettleBaseline[settleKey] = val;
  if (prevVal !== undefined && prevVal !== val) {
    maybePauseRollerOnEdit('CMD 0x11 param change (0x' + paramLo.toString(16).padStart(2,'0') +
      ' ' + prevVal + '->' + val + ')', /*skipSettleGuard*/ true);
  }

  // ── DIST parameter routing — handled before the amp-only instId guard
  // so DIST broadcasts (different handle) are not silently discarded.
  // Only route when the DIST panel is open; no-op otherwise.
  if (distPanelOpen) {
    const distBlk = currentChain.find(b => b.slotId === SLOT_DIST);
    if (distBlk && instId === distBlk.handle) {
      if (paramLo === 0x02 || paramLo === 0x03 || paramLo === 0x04 || paramLo === 0x05) {
        if (typeof updateDistKnob === 'function') updateDistKnob(paramLo, val);
        appLog('CMD 0x11 DIST paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── REVERB parameter routing — same shape as DIST above. paramLo 0x05
  // is the Eleven SR Type control; updateReverbKnob also moves the Type
  // dropdown to the nearest zone for it.
  if (reverbPanelOpen) {
    const rvBlk = currentChain.find(b => b.slotId === SLOT_REVERB);
    if (rvBlk && instId === rvBlk.handle) {
      if (paramLo >= 0x02 && paramLo <= 0x06) {
        if (typeof updateReverbKnob === 'function') updateReverbKnob(paramLo, val);
        appLog('CMD 0x11 REVERB paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── WAH parameter routing — same shape as DIST/REVERB.
  // 0x02 = Position (user knob). 0x03 = internal model flag broadcast
  // on model change — absorbed here so it doesn't hit the mismatch handler.
  if (wahPanelOpen) {
    const wahBlk = currentChain.find(b => b.slotId === SLOT_WAH);
    if (wahBlk && instId === wahBlk.handle) {
      if (paramLo === 0x02) {
        if (typeof updateWahKnob === 'function') updateWahKnob(paramLo, val);
        appLog('CMD 0x11 WAH paramLo=0x02 val=' + val);
        return;
      }
      if (paramLo === 0x03) {
        appLog('CMD 0x11 WAH paramLo=0x03 (model flag) val=' + val + ' — absorbed');
        return;
      }
    }
  }

  // ── VOL parameter routing — same shape as DIST/REVERB.
  if (volPanelOpen) {
    const volBlk = currentChain.find(b => b.slotId === SLOT_VOL);
    if (volBlk && instId === volBlk.handle) {
      if (paramLo >= 0x02 && paramLo <= 0x04) {
        if (typeof updateVolKnob === 'function') updateVolKnob(paramLo, val);
        appLog('CMD 0x11 VOL paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── FX LOOP parameter routing — same shape as VOL.
  if (fxLoopPanelOpen) {
    const loopBlk = currentChain.find(b => b.slotId === SLOT_LOOP);
    if (loopBlk && instId === loopBlk.handle) {
      if (paramLo >= 0x02 && paramLo <= 0x04) {
        if (typeof updateFxLoopKnob === 'function') updateFxLoopKnob(paramLo, val);
        appLog('CMD 0x11 FX LOOP paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── DELAY parameter routing — same shape as VOL/FX LOOP. paramLo 0x05
  // (Sync) is the SAME plain single-byte `val` every other Sync control
  // uses (amp Tremolo, FX1 C1 Chorus) — retracted 2026-08-02's wide
  // 28-bit raw-extraction misread; see protocol.js's DELAY SYNC comment.
  if (delayPanelOpen) {
    const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
    if (delayBlk && instId === delayBlk.handle) {
      if (paramLo === 0x05) {
        if (typeof updateDelaySync === 'function') updateDelaySync(val);
        appLog('CMD 0x11 DELAY Sync val=' + val + ' -> zone ' + syncIndexFromV127(val));
        return;
      }
      if (paramLo >= 0x02 && paramLo <= 0x0D) {
        // Drag guard (state.js delayDragLo) — same pattern as To Amp 1/2
        // (ui.js toAmp1Dragging/toAmp2Dragging): skip repainting THIS
        // paramLo while it's the user's active drag target, so a
        // broadcast racing the drag (e.g. the Sync-clear write on Delay
        // knob touch, R7) can't visually stomp on it mid-drag.
        if (paramLo === delayDragLo) {
          appLog('CMD 0x11 DELAY paramLo=0x' + paramLo.toString(16).padStart(2,'0')
            + ' val=' + val + ' — skipped, actively dragging');
          return;
        }
        if (typeof updateDelayKnob === 'function') updateDelayKnob(paramLo, val);
        appLog('CMD 0x11 DELAY paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // ── FX-HOST parameter routing (2026-08-01 refactor) — one generic block
  // for every GENERIC HOST SLOT (FX1/FX2/MOD), replacing what used to be an
  // FX1-only copy (same shape would otherwise get pasted again for FX2 and
  // MOD). openFxHostSlot (state.js) is which slot's panel is open, if any —
  // only one can be open at a time. The paramLo range routed here is
  // whichever model is currently loaded in that slot (see FX1_MODELS in
  // protocol.js, the shared model table every host slot reads from).
  // Uncaptured models simply have an empty paramLos list, so nothing routes
  // for them yet — no crash, no-op.
  if (openFxHostSlot !== null) {
    const fxHostBlk = currentChain.find(b => b.slotId === openFxHostSlot);
    if (fxHostBlk && instId === fxHostBlk.handle) {
      const fxHostModel = FX1_MODEL_BY_MID[fxHostBlk.modelId];
      if (fxHostModel && fxHostModel.paramLos.indexOf(paramLo) !== -1) {
        if (typeof updateFxHostKnob === 'function') updateFxHostKnob(paramLo, val);
        appLog('CMD 0x11 FX-HOST slot=0x' + openFxHostSlot.toString(16).padStart(2,'0')
          + ' paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  // instId matches currentParamHi (runtime handle from chain map)
  if (instId !== currentParamHi || currentParamHi < 0) {
    appLog('CMD 0x11 instId=0x' + instId.toString(16).padStart(2,'0') +
      ' — does not match currentParamHi=0x' + (currentParamHi<0?'(none)':currentParamHi.toString(16).padStart(2,'0')) + ', ignored');
    // SELF-HEAL (item, 7/26): a run of mismatches means the rack reassigned the
    // amp's handle (e.g. after a flood) and is broadcasting from one we no
    // longer recognise — the "knobs go dead both ways" state. Re-read the chain
    // map once to re-establish currentParamHi, debounced so a burst triggers a
    // single resync, not a storm. The throttle above should prevent the flood
    // that gets us here; this is the safety net if one ever slips through.
    _handleMismatchCount++;
    var _nowMs = Date.now();
    if (_handleMismatchCount >= HANDLE_RESYNC_THRESHOLD &&
        (_nowMs - _lastHandleResyncMs) > HANDLE_RESYNC_COOLDOWN) {
      _lastHandleResyncMs = _nowMs;
      _handleMismatchCount = 0;
      appLog('Self-heal: ' + HANDLE_RESYNC_THRESHOLD + '+ broadcasts for an unknown handle — re-reading chain map to resync');
      if (typeof REQU_CHAIN_MAP !== 'undefined') sendHex(REQU_CHAIN_MAP);
    }
    return;
  }
  _handleMismatchCount = 0;   // a match means we are back in sync

  routeAmpBlockParam(paramLo, v0, val);
}

// ── Bypass routing helper for handleParamReadback ──
// paramLo 0x01 = block bypass   0x06 = amp bypass   0x14 = cab bypass
// v0 0x40 = active, 0x3F = bypassed
//
// HANDLE GUARD (added 7/22): amp-bypass (0x06) and cab-bypass (0x14) are
// only meaningful on the AMP block's handle. Other blocks reuse paramLo
// 0x06 for their own parameters — e.g. Eleven SR REVERB Pre-Delay is
// paramLo 0x06 on the reverb handle. Without this guard a Pre-Delay turn
// was read as an amp-bypass event (and its readback was swallowed here
// instead of reaching the reverb knob). So 0x06/0x14 only count as bypass
// when they arrive on currentParamHi; anything else falls through to the
// per-block routing below. Same bug family as the 0x04-handle case:
// a value that is a control code in one context is plain data in another.
//
// FORMAT B DETECTION NOTE: Format B has 0x04 as a literal marker byte at
// data[6], NOT a handle. However, a block's runtime handle CAN legitimately
// be 0x04 (e.g. MOD in certain chain orders), producing a Format A response
// that starts with the same byte. Disambiguate by checking whether 0x04
// exists as a real handle in currentChain — if it does, data[6] IS the
// handle and this is Format A.
//
// Returns true if this message was a bypass message and has been fully
// handled (caller should stop dispatching); false otherwise.
function routeBypassMessage(data) {
  let bInst, bLo, bV0;
  const handleAtData6 = currentChain.find(x => x.handle === data[6]);
  if (data[6] === 0x04 && !handleAtData6 && data.length >= 10) { // FORMAT B
    bInst = data[7]; bLo = data[8]; bV0 = data[9];
  } else {                                                         // FORMAT A
    bInst = data[6]; bLo = data[7]; bV0 = data[8];
  }
  const isAmpBypassMsg = (bLo === BYPASS_PARAMLO_AMP || bLo === BYPASS_PARAMLO_CAB)
                         && bInst === currentParamHi;
  const isBlockBypassMsg = (bLo === BYPASS_PARAMLO_BLOCK);
  if (!isAmpBypassMsg && !isBlockBypassMsg) return false;

  const isActive = (bV0 !== BYPASS_V0_BYPASSED);
  const blk = currentChain.find(x => x.handle === bInst);
  const who = blk ? blk.name : ('handle 0x' + bInst.toString(16).padStart(2,'0'));

  if (bLo === BYPASS_PARAMLO_CAB) {
    cabBypassActive = isActive;
    updateCabBypassDisplay(isActive);
    appLog('Bypass: CAB -> ' + (isActive ? 'ACTIVE' : 'BYPASSED'));
  } else if (bLo === BYPASS_PARAMLO_AMP) {
    blockBypass[SLOT_AMP] = isActive;
    updateAmpBypassDisplay(isActive);
    appLog('Bypass: AMP -> ' + (isActive ? 'ACTIVE' : 'BYPASSED'));
  } else if (blk) {
    blockBypass[blk.slotId] = isActive;
    refreshBlockBypassDisplays();
    appLog('Bypass: ' + who + ' -> ' + (isActive ? 'ACTIVE' : 'BYPASSED'));
  } else {
    appLog('Bypass: unknown ' + who + ' (not in chain map), state not stored');
  }
  return true;
}

// ── FORMAT B (explicit-query-response) routing for the amp block only.
// paramLo 0x06 / 0x14 (amp / cab bypass) are handled by routeBypassMessage
// above, for every handle — they never reach here.
function routeFormatBAmpMessage(data) {
  const paramLo = data[8];
  const v0      = data[9];
  const val     = (v0 >= 0x40) ? (v0 - 0x40) : (v0 + 64);
  appLog('CMD 0x11 FORMAT-B paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' v0=0x' + v0.toString(16).padStart(2,'0'));
  if (paramLo === 0x15) { const idx = CAB_V0_TO_INDEX[v0]; if (idx !== undefined) updateCabTypeDisplay(idx); return; }
  if (paramLo === 0x16) { const idx = MIC_V0_TO_INDEX[v0]; if (idx !== undefined) updateMicTypeDisplay(idx); return; }
  if (paramLo === 0x17) { updateAxisDisplay(v0 === 0x3F); return; }
  if (paramLo === 0x18) { updateBreakupDisplay(val); return; }
  appLog('CMD 0x11 FORMAT-B unhandled paramLo=0x' + paramLo.toString(16).padStart(2,'0'));
}

// ── Amp-block (FORMAT A, on currentParamHi) paramLo dispatch — cab/mic,
// gate, amp out, bright, amp select, sync/tremolo, and the tone knobs.
// paramLo 0x06 / 0x14 (amp / cab bypass) are handled by routeBypassMessage
// above — they never reach here.
function routeAmpBlockParam(paramLo, v0, val) {
  if (paramLo === 0x15) {
    const idx = CAB_V0_TO_INDEX[v0];
    if (idx !== undefined) updateCabTypeDisplay(idx);
    else appLog('CMD 0x11 cab type unknown v0=0x' + v0.toString(16).padStart(2,'0'));
    return;
  }
  if (paramLo === 0x16) {
    const idx = MIC_V0_TO_INDEX[v0];
    if (idx !== undefined) updateMicTypeDisplay(idx);
    else appLog('CMD 0x11 mic type unknown v0=0x' + v0.toString(16).padStart(2,'0'));
    return;
  }
  if (paramLo === 0x17) { updateAxisDisplay(v0 === 0x3F); return; }
  if (paramLo === 0x18) { updateBreakupDisplay(val); return; }

  // paramLo 0x04 = Gate Threshold
  if (paramLo === 0x04) {
    const wrap = document.getElementById('gate-thresh-wrap');
    if (wrap) {
      wrap.dataset.value = val;
      drawKnob(wrap.querySelector('canvas'), val);
      document.getElementById('gate-thresh-val').textContent = valGateThresh(val);
    }
    return;
  }

  // paramLo 0x05 = Gate Release
  if (paramLo === 0x05) {
    const wrap = document.getElementById('gate-release-wrap');
    if (wrap) {
      wrap.dataset.value = val;
      drawKnob(wrap.querySelector('canvas'), val);
      document.getElementById('gate-release-val').textContent = valGateRelease(val);
    }
    return;
  }

  // paramLo 0x0E = Bright toggle
  if (paramLo === 0x0E) {
    updateBrightReadout(val);
    return;
  }

  // paramLo 0x03 = Amp Out
  if (paramLo === 0x03) {
    updateAmpOutReadout(val);
    return;
  }

  // paramLo 0x0F = Amp Select — raw v0, not scaled
  if (paramLo === 0x0F) {
    // Signal the post-nav pull that amp identity has landed, BEFORE any
    // early return below, so a value we cannot match still releases the
    // wait rather than stalling it to timeout.
    ampSelectRxSeq++;
    const match = AMP_SELECT_BY_V0[v0];
    if (match) {
      appLog('Amp Select readback: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' -> ' + match.label);
      if (match.key !== currentAmpKey) {
        setCurrentAmp(match.key);
        // setCurrentAmp -> updateToneKnobs has just relabelled the tone
        // stack and blanked every knob to "--". The stored values are
        // still in the rack (amp params are per SLOT, not per model), so
        // ask for them back. Without this the knobs sit at "--" forever,
        // which is the whole reason this call exists. See
        // requestAmpBlockParamsAfterAmpChange in transport.js.
        //
        // Deliberately fires on ANY amp identity change, whether the user
        // picked it in our dropdown, changed it on the rack's front panel,
        // or the Avid editor changed it — all three arrive here the same
        // way. The post-nav pull sets it too, but that path re-queries
        // everything itself a moment later, and the sequence guard means
        // the later of the two simply supersedes this one.
        if (typeof requestAmpBlockParamsAfterAmpChange === 'function') {
          requestAmpBlockParamsAfterAmpChange();
        }
      }
    } else {
      appLog('Amp Select readback: v0=0x' + v0.toString(16).padStart(2,'0').toUpperCase() + ' — no matching entry');
    }
    return;
  }

  // paramLo 0x12 = Sync selector, 0x13 = Tremolo on/off.
  // Both confirmed 7/23/2026. They are amp-block parameters and only reach
  // here on the amp handle, so no extra gating is needed — but they must be
  // routed BEFORE the tone-knob loop, because Sync is a 'selector' entry in
  // AMP_TONE_PARAMS and would otherwise fall through to "unhandled paramLo".
  if (paramLo === 0x12) { updateSyncReadout(val); return; }
  if (paramLo === 0x13) { updateTremReadout(val); return; }

  // Tone knobs — route by paramLo against current amp's AMP_TONE_PARAMS,
  // in the amp's current SCREEN order (getOrderedToneKnobs, protocol.js —
  // respects a saved reorder, defaults to table order otherwise).
  // A live tone-row reorder drag has its own speculative preview on screen
  // right now (wireToneKnobDrag, ui.js) — a hardware broadcast racing that
  // must not fight it; the drag's own end-of-drag repaint re-syncs for real.
  if (currentAmpKey && !toneDragActive) {
    const knobs = getOrderedToneKnobs(currentAmpKey);
    for (let i = 0; i < knobs.length; i++) {
      if (paramLo === knobs[i].lo) {
        const wrap = document.getElementById('tone-w' + i);
        if (wrap) {
          wrap.dataset.value = val;
          drawKnob(wrap.querySelector('canvas'), val);
          document.getElementById('tone-v' + i).textContent = valDisplay(val);
        }
        appLog('CMD 0x11 tone ' + knobs[i].label + ' paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
        return;
      }
    }
  }

  appLog('CMD 0x11 unhandled paramLo=0x' + paramLo.toString(16).padStart(2,'0') + ' val=' + val);
}

// Open captures folder
document.getElementById('btn-open-captures').addEventListener('click', async function() {
  try {
    const dir = await window.electronAPI.getCapturesDir();
    await window.electronAPI.openPath(dir);
    appLog('Opened captures folder: ' + dir);
  } catch(e) {
    appLog('Open folder error: ' + e.message);
  }
});

document.getElementById('btn-change-captures').addEventListener('click', async function() {
  try {
    const result = await window.electronAPI.chooseCapturesDir();
    if (result && result.ok) {
      document.getElementById('capture-path').textContent = 'Folder: ' + result.dir;
      setStatus('Captures folder changed');
      appLog('Captures folder changed to: ' + result.dir);
    }
  } catch(e) {
    appLog('Change captures folder error: ' + e.message);
  }
});

document.getElementById('btn-reset-captures').addEventListener('click', async function() {
  try {
    const result = await window.electronAPI.resetCapturesDir();
    if (result && result.ok) {
      document.getElementById('capture-path').textContent = 'Folder: ' + result.dir;
      setStatus('Captures folder reset to default');
      appLog('Captures folder reset to default: ' + result.dir);
    }
  } catch(e) {
    appLog('Reset captures folder error: ' + e.message);
  }
});

document.getElementById('btn-open-log').addEventListener('click', async function() {
  try {
    const logPath = await window.electronAPI.getLogPath();
    // Derive folder by stripping filename from path
    const logDir = logPath.substring(0, Math.max(logPath.lastIndexOf('\\'), logPath.lastIndexOf('/') ));
    await window.electronAPI.openPath(logDir);
    appLog('Opened log folder: ' + logDir);
  } catch(e) {
    appLog('Open log folder error: ' + e.message);
  }
});

// ════════════════════════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════════════════════════
