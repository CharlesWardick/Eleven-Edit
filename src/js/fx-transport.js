// ════════════════════════════════════════════════════════════════════
// FX-TRANSPORT.JS — per-effect-block SEND functions (model change,
// param request, param write), split out of transport.js on 7/27.
//
// WHY THIS FILE EXISTS: transport.js's core (connection, nav pull, the
// generic sendParamWrite/sendHex plumbing) doesn't grow as new effect
// panels are added, but this DOES — every DISTINCT model family (WAH,
// DELAY, VOL, DIST, REVERB, FX LOOP) adds another three functions here in
// the same DIST/REVERB shape. Keeping that growth in its own file means
// transport.js stays the size it is today no matter how many more panels
// get built; this file is where they land instead.
// GENERIC HOST SLOTS (FX1/FX2/MOD) are the exception — they share ONE
// function set (send/requestFxHost...), parameterized by slot id, not a
// new triple per slot. See the FX-HOST EFFECT PANEL section below.
//
// PATTERN for a genuinely new model family (copy the DIST functions, not
// the FX-host ones below — a new generic host slot is a config hook into
// the shared engine, not a new copy of this pattern):
//   send<Block>ModelChange(newMid) — CMD 0x21 chain rewrite, new mid in
//     the block's own slot, handle=0x00 so firmware reassigns it.
//   request<Block>Params()         — CMD 0x11 REQU per paramLo in the
//     block's current model (from its MODELS table in protocol.js).
//   send<Block>ParamWrite(paramLo, v127) — CMD 0x11 SNDSET on the
//     block's runtime handle from currentChain — never a fixed value.
//     MUST include the endpoint-sentinel tail logic (see
//     sendFxHostParamWrite) — a flat 00 00 00 00 tail is THE 9.9 BUG (a
//     knob can't hold its true min/max). Do not copy the plain-tail version.
//
// PURE RELOCATION (7/27): every function below is unchanged from its
// original position in transport.js — same logic, same comments, same
// behaviour. Nothing was rewritten. (FX1's functions were later replaced by
// the shared FX-host engine on 2026-08-01 — see that section below; this
// note describes the file's original 7/27 split, not FX1's code today.)
//
// 2026-07-30 — THE 9.9 BUG, retrofitted to all five panels that existed at
// the time (DIST/REVERB/WAH/VOL/FX1). Endpoint sentinels are now MANDATORY
// for every new send<Block>ParamWrite — see sendFxHostParamWrite for the
// pattern and the Session Log for the full incident (a related closure bug
// in the same family of code briefly hung the rack — see fx-panels.js
// header for the drag-handler half of that fix, also now mandatory).
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
// THE 9.9 BUG — see sendFxHostParamWrite for the full explanation. Endpoint
// sentinels so every DIST knob can actually hold its true min/max.
function sendDistParamWrite(paramLo, v127) {
  if (!bridgeMidiReady) return false;
  const distBlk = currentChain.find(b => b.slotId === SLOT_DIST);
  if (!distBlk) { appLog('sendDistParamWrite: no DIST block'); return false; }
  let tail;
  if (v127 >= 127)     { tail = '3F 7F 7F 7F 0F'; }
  else if (v127 <= 0)  { tail = '40 00 00 00 00'; }
  else {
    const v0 = ((v127 + 64) % 128) & 0x7F;
    tail = v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00';
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + distBlk.handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + tail + ' F7';
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
// THE 9.9 BUG — see sendFxHostParamWrite for the full explanation. Endpoint
// sentinels so every REVERB knob can hold its true min/max. This is also
// what was capping Pre-Delay at ~198ms instead of 200ms — its display is
// just val/127*200, so once val can genuinely reach 127 the display reaches
// the true endpoint too. No separate fix needed for Pre-Delay itself.
function sendReverbParamWrite(paramLo, v127) {
  if (!bridgeMidiReady) return false;
  const rvBlk = currentChain.find(b => b.slotId === SLOT_REVERB);
  if (!rvBlk) { appLog('sendReverbParamWrite: no REVERB block'); return false; }
  let tail;
  if (v127 >= 127)     { tail = '3F 7F 7F 7F 0F'; }
  else if (v127 <= 0)  { tail = '40 00 00 00 00'; }
  else {
    const v0 = ((v127 + 64) % 128) & 0x7F;
    tail = v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00';
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + rvBlk.handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + tail + ' F7';
  return sendPatchWrite(hex);
}

// ════════════════════════════════════════════════════════════════════
// WAH EFFECT PANEL — CMD 0x11 sends and CMD 0x21 model change
// Two models: Shine Wah (0x23) and Black Wah (0x24). Mirror of DIST.
// ════════════════════════════════════════════════════════════════════
function sendWahModelChange(newMid) {
  if (!bridgeMidiReady) { appLog('sendWahModelChange: bridge not ready'); return false; }
  if (!currentChainInput || !currentChain.length) {
    appLog('sendWahModelChange: no chain map yet'); return false;
  }
  const b = [0xF0,0x13,0x0B,0x0F,0x00,0x21];
  b.push(SLOT_INPUT, currentChainInput.modelId, currentChainInput.handle);
  for (let i = 0; i < 10; i++) {
    const blk      = currentChain[i];
    const backLink = (i === 0) ? SLOT_INPUT : currentChain[i-1].slotId;
    const mid      = (blk.slotId === SLOT_WAH) ? newMid : blk.modelId;
    const handle   = (blk.slotId === SLOT_WAH) ? 0x00   : blk.handle;
    b.push(backLink, mid, handle);
  }
  b.push(currentChain[9].slotId, 0xF7);
  const hex = b.map(x => x.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  appLog('sendWahModelChange: newMid=0x' + newMid.toString(16).padStart(2,'0').toUpperCase());
  return sendPatchWrite(hex);
}

function requestWahParams() {
  if (!bridgeMidiReady) return;
  const wahBlk = currentChain.find(b => b.slotId === SLOT_WAH);
  if (!wahBlk) { appLog('requestWahParams: no WAH block in chain'); return; }
  const model = WAH_MODEL_BY_MID[wahBlk.modelId];
  if (!model) {
    appLog('requestWahParams: unknown WAH mid=0x' + wahBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  const hh = wahBlk.handle.toString(16).padStart(2,'0').toUpperCase();
  model.paramLos.forEach(function(lo) {
    sendHex('F0 13 0B 0F 01 11 ' + hh + ' ' + lo.toString(16).padStart(2,'0').toUpperCase() + ' F7');
  });
  appLog('requestWahParams: ' + model.paramLos.length + ' params for ' + model.name + ' handle=0x' + hh);
}

// THE 9.9 BUG — see sendFxHostParamWrite for the full explanation. Endpoint
// sentinels so Position can actually hold its true min/max on hardware.
function sendWahParamWrite(paramLo, v127) {
  if (!bridgeMidiReady) return false;
  const wahBlk = currentChain.find(b => b.slotId === SLOT_WAH);
  if (!wahBlk) { appLog('sendWahParamWrite: no WAH block'); return false; }
  let tail;
  if (v127 >= 127)     { tail = '3F 7F 7F 7F 0F'; }
  else if (v127 <= 0)  { tail = '40 00 00 00 00'; }
  else {
    const v0 = ((v127 + 64) % 128) & 0x7F;
    tail = v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00';
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + wahBlk.handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + tail + ' F7';
  return sendPatchWrite(hex);
}

// ════════════════════════════════════════════════════════════════════
// VOL EFFECT PANEL — CMD 0x11 sends and CMD 0x21 model change
// One user-facing model; firmware picks mono (0x2B) or stereo (0x2C).
// sendVolModelChange is kept for pattern consistency and patch-slot
// writes (e.g. if the user were to swap the model mid externally).
// ════════════════════════════════════════════════════════════════════
function sendVolModelChange(newMid) {
  if (!bridgeMidiReady) { appLog('sendVolModelChange: bridge not ready'); return false; }
  if (!currentChainInput || !currentChain.length) {
    appLog('sendVolModelChange: no chain map yet'); return false;
  }
  const b = [0xF0,0x13,0x0B,0x0F,0x00,0x21];
  b.push(SLOT_INPUT, currentChainInput.modelId, currentChainInput.handle);
  for (let i = 0; i < 10; i++) {
    const blk      = currentChain[i];
    const backLink = (i === 0) ? SLOT_INPUT : currentChain[i-1].slotId;
    const mid      = (blk.slotId === SLOT_VOL) ? newMid : blk.modelId;
    const handle   = (blk.slotId === SLOT_VOL) ? 0x00   : blk.handle;
    b.push(backLink, mid, handle);
  }
  b.push(currentChain[9].slotId, 0xF7);
  const hex = b.map(x => x.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  appLog('sendVolModelChange: newMid=0x' + newMid.toString(16).padStart(2,'0').toUpperCase());
  return sendPatchWrite(hex);
}

function requestVolParams() {
  if (!bridgeMidiReady) return;
  const volBlk = currentChain.find(b => b.slotId === SLOT_VOL);
  if (!volBlk) { appLog('requestVolParams: no VOL block in chain'); return; }
  const model = VOL_MODEL_BY_MID[volBlk.modelId];
  if (!model) {
    appLog('requestVolParams: unknown VOL mid=0x' + volBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  const hh = volBlk.handle.toString(16).padStart(2,'0').toUpperCase();
  model.paramLos.forEach(function(lo) {
    sendHex('F0 13 0B 0F 01 11 ' + hh + ' ' + lo.toString(16).padStart(2,'0').toUpperCase() + ' F7');
  });
  appLog('requestVolParams: ' + model.paramLos.length + ' params for ' + model.name + ' handle=0x' + hh);
}

// THE 9.9 BUG — see sendFxHostParamWrite for the full explanation. Endpoint
// sentinels so Volume/Min Vol can actually hold their true min/max.
function sendVolParamWrite(paramLo, v127) {
  if (!bridgeMidiReady) return false;
  const volBlk = currentChain.find(b => b.slotId === SLOT_VOL);
  if (!volBlk) { appLog('sendVolParamWrite: no VOL block'); return false; }
  let tail;
  if (v127 >= 127)     { tail = '3F 7F 7F 7F 0F'; }
  else if (v127 <= 0)  { tail = '40 00 00 00 00'; }
  else {
    const v0 = ((v127 + 64) % 128) & 0x7F;
    tail = v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00';
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + volBlk.handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + tail + ' F7';
  return sendPatchWrite(hex);
}

// ════════════════════════════════════════════════════════════════════
// FX LOOP EFFECT PANEL — CMD 0x11 sends only. One shared parameter set
// (Send/Return/Mix) across all 7 routing-variant mids (Tech Ref Sec 23);
// the variant itself is firmware-picked from chain/stereo context, not
// user-selectable, so there is no model-change function here (unlike
// VOL/DIST/REVERB, which keep one for pattern consistency).
// ════════════════════════════════════════════════════════════════════
function requestFxLoopParams() {
  if (!bridgeMidiReady) return;
  const loopBlk = currentChain.find(b => b.slotId === SLOT_LOOP);
  if (!loopBlk) { appLog('requestFxLoopParams: no FX LOOP block in chain'); return; }
  const model = FXLOOP_MODEL_BY_MID[loopBlk.modelId];
  if (!model) {
    appLog('requestFxLoopParams: unknown FX LOOP mid=0x' + loopBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  const hh = loopBlk.handle.toString(16).padStart(2,'0').toUpperCase();
  model.paramLos.forEach(function(lo) {
    sendHex('F0 13 0B 0F 01 11 ' + hh + ' ' + lo.toString(16).padStart(2,'0').toUpperCase() + ' F7');
  });
  appLog('requestFxLoopParams: ' + model.paramLos.length + ' params for ' + model.name + ' handle=0x' + hh);
}

// THE 9.9 BUG — see sendFxHostParamWrite for the full explanation. Endpoint
// sentinels so Send/Return/Mix can actually hold their true min/max, same
// tail logic as sendVolParamWrite, confirmed against the capture's sentinel
// frames (3F 7F 7F 7F) at every knob's top endpoint.
function sendFxLoopParamWrite(paramLo, v127) {
  if (!bridgeMidiReady) return false;
  const loopBlk = currentChain.find(b => b.slotId === SLOT_LOOP);
  if (!loopBlk) { appLog('sendFxLoopParamWrite: no FX LOOP block'); return false; }
  let tail;
  if (v127 >= 127)     { tail = '3F 7F 7F 7F 0F'; }
  else if (v127 <= 0)  { tail = '40 00 00 00 00'; }
  else {
    const v0 = ((v127 + 64) % 128) & 0x7F;
    tail = v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00';
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + loopBlk.handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + tail + ' F7';
  return sendPatchWrite(hex);
}

// ════════════════════════════════════════════════════════════════════
// DELAY EFFECT PANEL — CMD 0x11 sends and CMD 0x21 model change
// One user-facing model (BBD Delay); firmware picks mono (0x1E) or
// stereo (0x1F). sendDelayModelChange kept for pattern consistency, same
// reason as VOL/FX LOOP.
// ════════════════════════════════════════════════════════════════════
function sendDelayModelChange(newMid) {
  if (!bridgeMidiReady) { appLog('sendDelayModelChange: bridge not ready'); return false; }
  if (!currentChainInput || !currentChain.length) {
    appLog('sendDelayModelChange: no chain map yet'); return false;
  }
  const b = [0xF0,0x13,0x0B,0x0F,0x00,0x21];
  b.push(SLOT_INPUT, currentChainInput.modelId, currentChainInput.handle);
  for (let i = 0; i < 10; i++) {
    const blk      = currentChain[i];
    const backLink = (i === 0) ? SLOT_INPUT : currentChain[i-1].slotId;
    const mid      = (blk.slotId === SLOT_DELAY) ? newMid : blk.modelId;
    const handle   = (blk.slotId === SLOT_DELAY) ? 0x00   : blk.handle;
    b.push(backLink, mid, handle);
  }
  b.push(currentChain[9].slotId, 0xF7);
  const hex = b.map(x => x.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  appLog('sendDelayModelChange: newMid=0x' + newMid.toString(16).padStart(2,'0').toUpperCase());
  return sendPatchWrite(hex);
}

function requestDelayParams() {
  if (!bridgeMidiReady) return;
  const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
  if (!delayBlk) { appLog('requestDelayParams: no DELAY block in chain'); return; }
  const model = DELAY_MODEL_BY_MID[delayBlk.modelId];
  if (!model) {
    appLog('requestDelayParams: unknown DELAY mid=0x' + delayBlk.modelId.toString(16).padStart(2,'0'));
    return;
  }
  const hh = delayBlk.handle.toString(16).padStart(2,'0').toUpperCase();
  model.paramLos.forEach(function(lo) {
    sendHex('F0 13 0B 0F 01 11 ' + hh + ' ' + lo.toString(16).padStart(2,'0').toUpperCase() + ' F7');
  });
  appLog('requestDelayParams: ' + model.paramLos.length + ' params for ' + model.name + ' handle=0x' + hh);
}

// THE 9.9 BUG — endpoint sentinels, same tail logic as sendVolParamWrite/
// sendFxLoopParamWrite. Covers every DELAY paramLo EXCEPT Sync (0x05),
// which has its own wide 28-bit encoding and its own send function below —
// do not route Sync through this one.
function sendDelayParamWrite(paramLo, v127) {
  if (!bridgeMidiReady) return false;
  const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
  if (!delayBlk) { appLog('sendDelayParamWrite: no DELAY block'); return false; }
  let tail;
  if (v127 >= 127)     { tail = '3F 7F 7F 7F 0F'; }
  else if (v127 <= 0)  { tail = '40 00 00 00 00'; }
  else {
    const v0 = ((v127 + 64) % 128) & 0x7F;
    tail = v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00';
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + delayBlk.handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + tail + ' F7';
  return sendPatchWrite(hex);
}

// DELAY Sync (paramLo 0x05) — WIDE 28-bit encoding with what looks like a
// real SysEx checksum trailing byte, not the standard endpoint-sentinel
// tail. Uses the EXACT captured 5-byte tail per zone (DELAY_SYNC_TAIL_HEX,
// protocol.js) rather than computing one. zoneIdx is a SYNC_DIVISIONS
// index (0=OFF..13=1/16 triplet). OFF's tail is UNCONFIRMED (provisional).
function sendDelaySyncWrite(zoneIdx) {
  if (!bridgeMidiReady) return false;
  const delayBlk = currentChain.find(b => b.slotId === SLOT_DELAY);
  if (!delayBlk) { appLog('sendDelaySyncWrite: no DELAY block'); return false; }
  const tail = DELAY_SYNC_TAIL_HEX[zoneIdx] || DELAY_SYNC_TAIL_HEX[0];
  const hex = 'F0 13 0B 0F 00 11 '
    + delayBlk.handle.toString(16).padStart(2,'0').toUpperCase() + ' 05 '
    + tail + ' F7';
  appLog('sendDelaySyncWrite: zone=' + zoneIdx);
  return sendPatchWrite(hex);
}

// ════════════════════════════════════════════════════════════════════
// FX-HOST EFFECT PANEL — CMD 0x11 sends and CMD 0x21 model change
// Shared engine (2026-08-01 refactor) for every GENERIC HOST SLOT
// (FX1/FX2/MOD — see fx-panels.js's FX-HOST EFFECT PANEL header for the
// full rationale). Was three near-identical function sets in the making
// (FX1 built 2026-07-30, FX2/MOD were about to copy it); now each one
// takes the slot id as its first argument and resolves the chain block
// through that, instead of a hardcoded SLOT_FX1. Mirror of the DIST panel
// functions otherwise — newMid can be any model from FX1_MODELS (still
// the shared model table name — see protocol.js), not one family, but the
// model-change mechanism (rewrite the block's mid, handle=0x00 so firmware
// reassigns it) is identical.
// ════════════════════════════════════════════════════════════════════
function sendFxHostModelChange(slotId, newMid) {
  if (!bridgeMidiReady) { appLog('sendFxHostModelChange: bridge not ready'); return false; }
  if (!currentChainInput || !currentChain.length) {
    appLog('sendFxHostModelChange: no chain map yet'); return false;
  }
  const b = [0xF0,0x13,0x0B,0x0F,0x00,0x21];
  b.push(SLOT_INPUT, currentChainInput.modelId, currentChainInput.handle);
  for (let i = 0; i < 10; i++) {
    const blk      = currentChain[i];
    const backLink = (i === 0) ? SLOT_INPUT : currentChain[i-1].slotId;
    const mid      = (blk.slotId === slotId) ? newMid : blk.modelId;
    const handle   = (blk.slotId === slotId) ? 0x00   : blk.handle;
    b.push(backLink, mid, handle);
  }
  b.push(currentChain[9].slotId, 0xF7);
  const hex = b.map(x => x.toString(16).padStart(2,'0').toUpperCase()).join(' ');
  appLog('sendFxHostModelChange: slot=0x' + slotId.toString(16).padStart(2,'0')
    + ' newMid=0x' + newMid.toString(16).padStart(2,'0').toUpperCase());
  return sendPatchWrite(hex);
}

// Query all knob params for the given slot's current model from hardware.
function requestFxHostParams(slotId) {
  if (!bridgeMidiReady) return;
  const blk = currentChain.find(b => b.slotId === slotId);
  if (!blk) { appLog('requestFxHostParams: no block in chain for slot=0x' + slotId.toString(16).padStart(2,'0')); return; }
  const model = FX1_MODEL_BY_MID[blk.modelId];
  if (!model || !model.captured) {
    appLog('requestFxHostParams: mid=0x' + blk.modelId.toString(16).padStart(2,'0')
      + (model ? ' (' + model.name + ') not yet captured' : ' unknown'));
    return;
  }
  const hh = blk.handle.toString(16).padStart(2,'0').toUpperCase();
  model.paramLos.forEach(function(lo) {
    sendHex('F0 13 0B 0F 01 11 ' + hh + ' ' + lo.toString(16).padStart(2,'0').toUpperCase() + ' F7');
  });
  appLog('requestFxHostParams: ' + model.paramLos.length + ' params for ' + model.name + ' handle=0x' + hh);
}

// Write one FX-host control value to hardware — same 5-byte value payload as DIST.
// ── THE "9.9 BUG" — endpoint sentinels on writes (same fix as the amp
// Tremolo Speed knob, transport.js sendParamWrite, 7/23/2026). A CMD 0x11
// value is five 7-bit bytes, not one: v1..v4 are the LOW-ORDER bits of the
// same quantity. Sending v0 with 00 00 00 00 asks for the BOTTOM of that
// step — fine for byte-quantised controls, but anything with real sub-step
// precision (Speed there; Chorus/Rate/Depth here, confirmed live by Charlie
// 2026-07-30 — dial to 10, HW settles at 9.9) reports back one tick low.
// Fix: special-case the true endpoints with sentinel tail bytes instead of
// always sending the raw v0 with a zero tail.
function sendFxHostParamWrite(slotId, paramLo, v127) {
  if (!bridgeMidiReady) return false;
  const blk = currentChain.find(b => b.slotId === slotId);
  if (!blk) { appLog('sendFxHostParamWrite: no block for slot=0x' + slotId.toString(16).padStart(2,'0')); return false; }
  let tail;
  if (v127 >= 127)     { tail = '3F 7F 7F 7F 0F'; }
  else if (v127 <= 0)  { tail = '40 00 00 00 00'; }
  else {
    const v0 = ((v127 + 64) % 128) & 0x7F;
    tail = v0.toString(16).padStart(2,'0').toUpperCase() + ' 00 00 00 00';
  }
  const hex = 'F0 13 0B 0F 00 11 '
    + blk.handle.toString(16).padStart(2,'0').toUpperCase() + ' '
    + paramLo.toString(16).padStart(2,'0').toUpperCase() + ' '
    + tail + ' F7';
  return sendPatchWrite(hex);
}
