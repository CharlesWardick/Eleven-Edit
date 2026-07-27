// ════════════════════════════════════════════════════════════════════
// FX-TRANSPORT.JS — per-effect-block SEND functions (model change,
// param request, param write), split out of transport.js on 7/27.
//
// WHY THIS FILE EXISTS: transport.js's core (connection, nav pull, the
// generic sendParamWrite/sendHex plumbing) doesn't grow as new effect
// panels are added, but this DOES — every new panel (WAH, MOD, DELAY,
// VOL, FX1, FX2, FX LOOP still to come) adds another three functions
// here in the same DIST/REVERB shape. Keeping that growth in its own
// file means transport.js stays the size it is today no matter how
// many more panels get built; this file is where they land instead.
//
// PATTERN for a new block (copy the DIST functions below):
//   send<Block>ModelChange(newMid) — CMD 0x21 chain rewrite, new mid in
//     the block's own slot, handle=0x00 so firmware reassigns it.
//   request<Block>Params()         — CMD 0x11 REQU per paramLo in the
//     block's current model (from its MODELS table in protocol.js).
//   send<Block>ParamWrite(paramLo, v127) — CMD 0x11 SNDSET on the
//     block's runtime handle from currentChain — never a fixed value.
//
// PURE RELOCATION (7/27): every function below is unchanged from its
// original position in transport.js — same logic, same comments, same
// behaviour. Nothing was rewritten.
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// DIST EFFECT PANEL — CMD 0x11 sends and CMD 0x21 model change
// ════════════════════════════════════════════════════════════════════

// ── Change the DIST block's model — same mechanism as chain reorder:
// send a complete CMD 0x21 with the new mid in the DIST slot and handle=0x00
// (firmware assigns a new handle and broadcasts the updated chain map).
// The existing CMD 0x21 IN handler processes the response and updates
// currentChain, then calls refreshDistPanelAfterChainMap to re-query params.
function sendDistModelChange(newMid) {
  if (!bridgeMidiReady) { appLog('sendDistModelChange: bridge not ready'); return false; }
  if (!currentChainInput || !currentChain.length) {
    appLog('sendDistModelChange: no chain map yet'); return false;
  }
  const b = [0xF0,0x13,0x0B,0x0F,0x00,0x21];
  b.push(SLOT_INPUT, currentChainInput.modelId, currentChainInput.handle);
  for (let i = 0; i < 10; i++) {
    const blk      = currentChain[i];
    const backLink = (i === 0) ? SLOT_INPUT : currentChain[i-1].slotId;
    const mid      = (blk.slotId === SLOT_DIST) ? newMid : blk.modelId;
    const handle   = (blk.slotId === SLOT_DIST) ? 0x00   : blk.handle;
    b.push(backLink, mid, handle);
  }
  b.push(currentChain[9].slotId, 0xF7);
  const hex = b.map(x => x.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  appLog('sendDistModelChange: newMid=0x' + newMid.toString(16).padStart(2,'0').toUpperCase());
  return sendPatchWrite(hex);
}

// ── Query all knob params for the current DIST model from hardware.
// Called on panel open and after model change (once new handle is known).
function requestDistParams() {
  if (!bridgeMidiReady) return;
  const distBlk = currentChain.find(b => b.slotId === SLOT_DIST);
  if (!distBlk) { appLog('requestDistParams: no DIST block in chain'); return; }
  const model = DIST_MODEL_BY_MID[distBlk.modelId];
  if (!model) {
    appLog('requestDistParams: unknown DIST mid=0x' + distBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  const hh = distBlk.handle.toString(16).padStart(2,'0').toUpperCase();
  model.paramLos.forEach(function(lo) {
    sendHex('F0 13 0B 0F 01 11 ' + hh + ' ' + lo.toString(16).padStart(2,'0').toUpperCase() + ' F7');
  });
  appLog('requestDistParams: ' + model.paramLos.length + ' params for ' + model.name + ' handle=0x' + hh);
}

// ── Write one DIST knob value to hardware.
// Uses the DIST block's runtime handle from currentChain — never a fixed value.
function sendDistParamWrite(paramLo, v127) {
  if (!bridgeMidiReady) return false;
  const distBlk = currentChain.find(b => b.slotId === SLOT_DIST);
  if (!distBlk) { appLog('sendDistParamWrite: no DIST block'); return false; }
  const v0  = ((v127 + 64) % 128) & 0x7F;
  const hex = 'F0 13 0B 0F 00 11 '
    + distBlk.handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
  return sendPatchWrite(hex);
}

// ════════════════════════════════════════════════════════════════════
// REVERB EFFECT PANEL — CMD 0x11 sends and CMD 0x21 model change
// Mirror of the DIST panel functions, targeting SLOT_REVERB. Two models
// live here; we send the mono base mid and let the firmware pick the
// variant, exactly as DIST does with its single mid.
// ════════════════════════════════════════════════════════════════════
function sendReverbModelChange(newMid) {
  if (!bridgeMidiReady) { appLog('sendReverbModelChange: bridge not ready'); return false; }
  if (!currentChainInput || !currentChain.length) {
    appLog('sendReverbModelChange: no chain map yet'); return false;
  }
  const b = [0xF0,0x13,0x0B,0x0F,0x00,0x21];
  b.push(SLOT_INPUT, currentChainInput.modelId, currentChainInput.handle);
  for (let i = 0; i < 10; i++) {
    const blk      = currentChain[i];
    const backLink = (i === 0) ? SLOT_INPUT : currentChain[i-1].slotId;
    const mid      = (blk.slotId === SLOT_REVERB) ? newMid : blk.modelId;
    const handle   = (blk.slotId === SLOT_REVERB) ? 0x00   : blk.handle;
    b.push(backLink, mid, handle);
  }
  b.push(currentChain[9].slotId, 0xF7);
  const hex = b.map(x => x.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  appLog('sendReverbModelChange: newMid=0x' + newMid.toString(16).padStart(2,'0').toUpperCase());
  return sendPatchWrite(hex);
}

// Query all knob params for the current REVERB model from hardware.
function requestReverbParams() {
  if (!bridgeMidiReady) return;
  const rvBlk = currentChain.find(b => b.slotId === SLOT_REVERB);
  if (!rvBlk) { appLog('requestReverbParams: no REVERB block in chain'); return; }
  const model = REVERB_MODEL_BY_MID[rvBlk.modelId];
  if (!model) {
    appLog('requestReverbParams: unknown REVERB mid=0x' + rvBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  const hh = rvBlk.handle.toString(16).padStart(2,'0').toUpperCase();
  model.paramLos.forEach(function(lo) {
    sendHex('F0 13 0B 0F 01 11 ' + hh + ' ' + lo.toString(16).padStart(2,'0').toUpperCase() + ' F7');
  });
  appLog('requestReverbParams: ' + model.paramLos.length + ' params for ' + model.name + ' handle=0x' + hh);
}

// Write one REVERB knob value to hardware — same 5-byte value payload as DIST.
function sendReverbParamWrite(paramLo, v127) {
  if (!bridgeMidiReady) return false;
  const rvBlk = currentChain.find(b => b.slotId === SLOT_REVERB);
  if (!rvBlk) { appLog('sendReverbParamWrite: no REVERB block'); return false; }
  const v0  = ((v127 + 64) % 128) & 0x7F;
  const hex = 'F0 13 0B 0F 00 11 '
    + rvBlk.handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00 F7';
  return sendPatchWrite(hex);
}
