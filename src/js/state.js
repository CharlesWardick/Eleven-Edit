/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// STATE.JS — all shared mutable state, declared in one place so it's
// obvious what's global. Loaded FIRST — everything else references these.
// Not true encapsulation (plain <script> tags all share one global scope,
// same as before this split) — this is organization for readability, not
// a module system. See README_FIRST.txt for why.
// ════════════════════════════════════════════════════════════════════

let midiOutName  = '';
let currentSlot  = 0;
let currentPatchName = '';
let tunerOn      = false;
let monitorOpen  = false;
let zoomFactor   = 1.0;

// ── Bank scan — walk every slot on our own terms, build a local
// reference (amp/gate/name per slot), instead of relying on a live pull
// landing correctly in the moment. See README for the reasoning. ──
let bankCache            = {};   // slotNum -> {ampKey, threshV, releaseV, signature, scannedAt}
let scanInProgress       = false;
let scanCancelRequested  = false;
let pendingScanSlot      = null;
let pendingScanResolve   = null;
const SCAN_SETTLE_MS           = 200;  // wait after navigating, before requesting patch data — was 400 (a
                                        // guessed "safe" number from when Scan Bank was first built, never
                                        // revisited), lowered 2026-08-10 at Charlie's request now that Export
                                        // All Rigs actually exercises this path in production. Still 2x
                                        // NAV_RECALL_SETTLE (100ms, transport.js — the value ordinary patch
                                        // nav has proven reliable everywhere else), not equal to it, since
                                        // this hasn't been live-tested yet at the lower number. NEXT: if a
                                        // live full-bank walk stays clean at 200, this could plausibly drop
                                        // toward 100 too — but don't lower it again without a live check
                                        // (Primer's "two failed fixes" lesson applies to timing changes too).
const SCAN_RESPONSE_TIMEOUT_MS = 1200; // how long to wait for a response before giving up on a slot and moving on

// ── Bank export ("Export All Rigs…") — walks all 104 slots via the SAME
// recall-based mechanism as Scan Bank above (scanSlot(), capture-scan.js),
// so it shares pendingScanSlot/pendingScanResolve rather than duplicating
// them. An earlier, no-recall approach (Avid's own direct by-slot query)
// was tried and abandoned same day — see bank-transfer.js's file header
// and Session Log 2026-08-10 for why. Only state left to track here is
// the export-specific progress/cancel flags. ──
let exportInProgress      = false;
let exportCancelRequested = false;

// ── SILENT bank export (2026-09-08) — the primary export path now walks all
// 104 slots via Avid's own no-recall by-slot query (reqSendPatchBySlot,
// protocol.js: F0 13 0B 0F 01 00 [slot]), NOT the audible recall walk. The
// abandoned 2026-08-10 attempt at this failed only because it fired without
// waiting for each reply; a fresh Avid capture (2026-09-08) proved Avid does
// strict request->reply LOCK-STEP and its reply (12 00 [slot] ...) echoes the
// slot number, so it is self-identifying and needs no settle timer — the reply
// itself is the sync. A body-diff proved the silent read is byte-identical to a
// recall read. These track the single outstanding request; the reply handler
// (handlePatchBySlotReply, sysex-handler.js) resolves ONLY when the reply's
// slot byte matches pendingSilentSlot, so a straggler can never be mis-filed
// (the exact failure mode the anonymous cmd 0x01 recall reply allowed). ──
let pendingSilentSlot     = null;
let pendingSilentResolve  = null;
const SILENT_READ_TIMEOUT_MS  = 2000; // per-attempt wait for a 12 00 reply before retrying (generous for a slow PC)
const SILENT_READ_MAX_ATTEMPTS = 3;   // re-request a silent slot this many times before giving up on it

// ── Bank import ("Import Rigs…") cancel flag + rack-rejection signal.
// importCancelRequested is set by the shared overlay Cancel button and read
// by the importRigs loop (bank-transfer.js), mirroring the export pattern.
// rackBadPatchCount is a monotonic counter bumped by handleRackDialog
// (sysex-handler.js) every time the rack throws "Bad Patch Data" (CMD 0x78).
// The import loop snapshots it before each write and re-checks after, so it
// can attribute a rejection to the exact slot it just wrote (2026-09-05). ──
let importCancelRequested = false;
let rackBadPatchCount     = 0;
// Bumped by handleSaveRigResponse when the rack ACCEPTS a write (02 03 01 01).
// Paired with rackBadPatchCount so a write can wait for accept-or-reject.
let rackPatchAckCount     = 0;

// ── Jump List "by name" view (2026-08-03) — patch-name cache keyed by slot.
// Deliberately SESSION-ONLY, never written to settings.json: if the app
// isn't running while a patch gets renamed or a whole bank gets swapped in,
// there is no way to know that happened, so a name persisted from a PRIOR
// session could show something that no longer matches the rack — worse
// than showing nothing. Populated fresh by a lightweight CMD 0x04 sweep
// once per bridge connect (scanPatchNames, capture-scan.js), then kept
// live: any save from ANY source (this app, the front panel, or Avid)
// broadcasts a CMD 0x04 echo we already listen for elsewhere
// (handlePatchNameEnumReply, sysex-handler.js), and our OWN saves
// (saveCurrentPatchToSlot, capture-scan.js) update it directly since we
// already know the new name at that moment, no round-trip needed.
let patchNameCache          = {};   // slotNum -> name string
let patchNameScanInProgress = false;

let autoTimer     = null;
let autoRafId     = null;
let autoStartTime = null;
let autoElapsed   = 0;
let autoPaused    = false;
let wasStopped    = true; // true at launch and after Stop — forces jump to FROM on next Start
// Timestamp (performance.now()) of the most recent slot navigation — lets the
// roller tell a genuine user edit's dirty-flag broadcast apart from the
// hardware's own settle/query traffic right after a recall lands on an
// already-dirty slot (2026-08-11 false-pause bug). null until the first nav.
let lastNavTime   = null;
// Last CMD 0x11 FORMAT-A value seen per "instId:paramLo" since the last nav
// (cleared in goToSlot). Lets the roller's pause-on-edit tell the hardware's
// own settle-broadcast (repeats the patch's stored value, unchanged) apart
// from a genuine touch (value actually differs) WITHOUT a time guard — see
// handleParamReadback's Format-A branch, sysex-handler.js.
let paramSettleBaseline = {};

// ── Gate CC table — per amp model (CC for Threshold, CC for Release) ──
// NOTE (7/9/2026): sl100drive/crunch/clean's thresh/release CCs were
// confirmed SWAPPED by direct testing — the SW Threshold knob was
// actually moving the real hardware's Release, and vice versa. Fixed
// below. Different amp families here use genuinely different CC pairs
// (not one universal pair), so this swap is NOT assumed to apply to any
// other entry — those remain as originally researched, unverified
// against real hardware. If another amp shows the same crossed behavior,
// fix that specific entry the same way, don't assume the whole table.
// ── Chain map state (CMD 0x21) ──
// Slot IDs are fixed per block type in every patch — Tech Ref Sec 4.
const SLOT_AMP = 0x00, SLOT_LOOP = 0x01, SLOT_VOL = 0x02, SLOT_WAH = 0x03,
      SLOT_MOD = 0x04, SLOT_REVERB = 0x05, SLOT_DELAY = 0x06, SLOT_DIST = 0x07,
      SLOT_FX1 = 0x08, SLOT_FX2 = 0x09, SLOT_INPUT = 0x0B;

const SLOT_ID_TO_NAME = {
  0x00: 'AMP', 0x01: 'LOOP',  0x02: 'VOL',   0x03: 'WAH',
  0x04: 'MOD', 0x05: 'REVERB',0x06: 'DELAY', 0x07: 'DIST',
  0x08: 'FX1', 0x09: 'FX2',   0x0B: 'INPUT'
};

// Slot ID -> the suffix used in the chain row element ids (chain-xxx / copen-xxx).
// AMP-CAB is deliberately absent: it is one block drawn as a stacked pair with
// its own markup, and is handled separately everywhere.
const SLOT_ID_TO_DOM = {
  0x01: 'fxloop', 0x02: 'vol',   0x03: 'wah',  0x04: 'mod',
  0x05: 'reverb', 0x06: 'delay', 0x07: 'dist', 0x08: 'fx1', 0x09: 'fx2'
};

// Full chain in left-to-right order, rebuilt from every CMD 0x21.
// Each entry: { position, slotId, name, modelId, handle }
// Not yet consumed by the UI — foundation for the chain row, per-block
// bypass and reorder. Handles change on patch load, stereo/mono toggle and
// (for affected blocks only) reorder, so never cache these across events.
let currentChain = [];
let currentChainInput = null;   // { slotId, modelId, handle } for the input block

// DELAY MODEL CACHE — per-patch, per-model in-app memory of paramLo values
// (Charlie's 2026-09-01 request). Keyed by a model's base mid (DELAY_MODELS'
// own `mid` field), value is {paramLo: v127}. Lets switching the DELAY
// Model dropdown restore what you had dialed in on a model instead of
// showing hardware's own factory defaults each time, and keeps that memory
// while navigating to other FX blocks and back. Cleared ONLY on a real
// patch nav (handleSlotConfirm) — never on panel close or model switch.
let delayModelCache = {};

// DELAY MODEL BASELINE — the red/green "unchanged" reference point, kept
// SEPARATE from delayModelCache above and NEVER touched by a model switch
// (Charlie's 2026-09-01 finding: the first version re-anchored this on
// every switch, so a knob went green the instant you left/returned to a
// model even though it had genuinely been changed since the patch loaded —
// "the last change becomes the new normal" instead of showing drift from
// what was actually loaded/saved). Keyed the same way as delayModelCache
// (a model's base mid -> {paramLo: v127}), but set ONCE per model per
// patch-load — the first real value ever seen for that paramLo this
// patch-load, whether that's the genuinely loaded/saved value (the model
// active at load) or hardware's own first-visit defaults (a model reached
// only by switching) — and held fixed after that. Cleared on a real patch
// nav (handleSlotConfirm, same point as delayModelCache) AND on an actual
// Save commit (handleBulkTfxData's isSave branch, alongside the existing
// clearFxBaselines() call for every other effect panel) — a save makes the
// current state the new "unchanged" reference, same as everywhere else.
let delayModelBaseline = {};

// Set true right when the Model dropdown itself sends a model-change write;
// consumed by refreshDelayPanelAfterChainMap so it can tell "this chain-map
// reply is confirming MY OWN switch" apart from any other reason the chain
// map got re-sent. Needed because the dropdown's displayed value already
// matches the new model the instant it's clicked, so comparing sel.value
// to the confirmed model (the old detection) is always a no-op mismatch
// for a user-driven switch — it only ever caught an externally-stale
// dropdown, never the case this cache exists for.
let delayModelSwitchPending = false;

// GENERIC PER-BLOCK MODEL CACHE/BASELINE ENGINE (2026-09-01) — the shape
// DELAY's own delayModelCache/delayModelBaseline/delayModelSwitchPending
// (above) proved out live, generalized for reuse on any OTHER multi-model
// block from here on (DIST first, per Session Log 2026-09-01 "shared
// cache/baseline engine" design decision). DELAY itself stays on its own
// bespoke variables — proven, not worth the risk of migrating.
// Both keyed slotId -> mid -> {paramLo: v127}.
let blockModelCache = {};
let blockModelBaseline = {};
// slotId -> bool, same role as delayModelSwitchPending but per-block.
let blockModelSwitchPending = {};
// slotId -> sequence number, bumped on every blockCacheApply call for that
// slot (2026-09-02) — its own staggered per-paramLo writes (setTimeout,
// fx-panels.js) check this before firing, so a SECOND cache-apply for the
// same slot (a rapid re-switch before the first one's stagger finished)
// invalidates the first one's still-pending writes instead of letting both
// interleave and stomp each other. Caught live: rapid-fire Amp Select
// switching produced a live broadcast trail showing the SAME tone knob
// (Treble) landing on three different values in under a second, one of
// them from an amp that was no longer even selected.
let blockCacheApplySeq = {};

// AMP CACHE — PATCH-LOAD SNAPSHOT (2026-09-03, Charlie's own design) — the
// TRUE first real hardware reading of every "everything else" amp-block
// control (Bright/Sync/Tremolo/Amp Out/Gate Thresh/Gate Release/Cab/Mic/
// Axis/Speaker Breakup — everything in ampNonToneCells, ui.js, i.e. every
// cached amp cell EXCEPT the tone knobs), captured ONCE per patch-load
// before any amp switching or editing can contaminate it. Keyed by paramLo
// hex string (flat — these controls are amp-independent, unlike
// blockModelCache/blockModelBaseline which are keyed per amp too). Used to
// seed a never-before-visited amp's brand-new drawer with the genuine
// original patch state instead of whatever the shared hardware bin
// currently shows (which could already be a DIFFERENT amp's edit) — see
// the CMD 0x0F echo handler, sysex-handler.js. Same "first reading wins"
// shape as blockBaselineSetIfUnset, just without the per-amp dimension.
let ampPatchLoadSnapshot = {};
function ampPatchLoadSnapshotSetIfUnset(loHex, val) {
  if (ampPatchLoadSnapshot[loHex] === undefined) ampPatchLoadSnapshot[loHex] = val;
  return ampPatchLoadSnapshot[loHex];
}

// "Loaded" option marker (2026-09-02) — key -> value a PERSISTENT dropdown
// (one whose <select> element is never torn down, only its .value changed)
// showed right after the current patch loaded. See syncLoadedMarker/
// markLoadedOption, ui.js. Cleared on every real patch nav
// (clearStaleReadoutsOnNav, capture-scan.js), same as every other per-load
// reference point in this file.
let dropdownLoadedValue = {};

// REVERB's Type sub-cache key for whatever Type the current patch actually
// LOADED with (e.g. "40-t0" for Echo Room) — set once, the first real
// hardware reading of Type this patch-load, never touched again until a
// real nav/save (2026-09-01, Charlie's own design call). A never-visited
// Type seeds itself from THIS key's own baseline, not from whatever the
// Type being left currently shows — so every unvisited Type looks
// identical to how the patch loaded, regardless of edits made to other
// Types in between. null until that first reading lands.
let reverbLoadTypeKey = null;

// Bypass state per block, keyed by SLOT ID (stable across patches).
// true = active, false = bypassed, undefined = not yet known.
// AMP-CAB is one block with TWO independent flags, so it gets two entries:
//   blockBypass[SLOT_AMP]  — the amp   (CMD 0x11 paramLo 0x06)
//   cabBypassActive        — the cab   (CMD 0x11 paramLo 0x14)
// Every other block uses paramLo 0x01 on its own handle.
let blockBypass = {};
let cabBypassActive;            // undefined until read from hardware
// Global cabinet bypass (CMD 0x38, "Cab Always Off") — GLOBAL, not per-patch.
// undefined until a 0x38 broadcast/readback is seen; true = global bypass on
// (cab forced off on hardware regardless of the patch's own cab bypass). The
// chain row's CAB block defers to this so it never shows a cab the rack isn't
// producing (2026-08-30).
let globalCabBypass;
// Set true when the user clears Global Cab Off via the modal's "Yes"; the 0x38
// clear echo then re-asserts the per-patch cab (mirrors Avid, so the cab returns
// instantly instead of on the next nav). Guards against re-asserting on a
// front-panel global clear (which the rack handles itself). 2026-08-30.
let pendingCabReassert = false;
// RESO (CMD 0x3F) — GLOBAL amp-out pre-cab resonance/impedance sim, on/off.
// undefined until known. It has no confirmed read (Avid never queries it); the
// 01 3F connect query is an experiment to see if the rack answers anyway. State
// is otherwise adopt-broadcast-only (0x3F on change). 2026-08-30.
let resoState;
// FX Loop routing (CMD 0x3C) — GLOBAL, not per-patch. -1 = unknown until the
// 01 3C connect query's reply (or a 02 3C broadcast) is seen. Values:
// 0=Mono L, 1=Mono/Stereo, 2=Stereo. Shown as a picker on the FX Loop panel;
// like the other globals it must NOT light the SAVE latch. 2026-08-30.
// True-Z (input impedance, CMD 0x34) — PER-PATCH. -1 = unknown until read.
// Canonical value (Auto stored as 0x7F). See protocol.js TRUEZ_OPTIONS.
let trueZ = -1;

let fxLoopRouting = -1;
// Output mode (CMD 0x35) — GLOBAL, not per-patch. -1 = unknown until the 01 35
// connect query's reply (or a 02 35 broadcast) is seen. Values: 0=DAW,
// 1=Mirror, 2=Rig Output, 3=Split In/Out. This DECODES CMD 0x35, previously
// listed as an undecoded/"Dummy" command. Shown as a picker; like the other
// globals it must NOT light the SAVE latch. 2026-08-30.
let outputMode = -1;

// Bypass paramLo values — Tech Ref Sec 3.
const BYPASS_PARAMLO_BLOCK = 0x01;   // every non-amp chain block
const BYPASS_PARAMLO_AMP   = 0x06;
const BYPASS_PARAMLO_CAB   = 0x14;
// v0 encoding for bypass: active vs bypassed.
const BYPASS_V0_ACTIVE   = 0x40;
const BYPASS_V0_BYPASSED = 0x3F;

let currentParamHi = -1;  // amp block's handle, derived from currentChain (slot 0x00)
let currentAmpKey  = null;
let currentAmpName = null;

// ── Amp Controls tone-knob reorder (2026-08-03) ──
// Per-amp custom knob display order, keyed by ampKey -> array of paramLo in
// the order the user dragged them to. Loaded from settings.json at app-init
// (before the first tone-knob paint of the session — see app-init.js) so a
// saved order is what's drawn on the very first render, never a default
// order that then jumps to the preferred one. Amps with no entry here just
// use AMP_TONE_PARAMS' own table order (see getOrderedToneKnobs, protocol.js).
let toneKnobOrderPrefs = {};
// Amp panel numeric readout visibility — global app preference, not
// per-patch (2026-09-05). 0 = show all (default), 1 = hide tone-stack
// numbers, 2 = also hide Row 1 (Gate/To Amp/Volumes) numbers.
let numberDisplayMode = 0;
// Re-arms LOCKED on every launch (not persisted) — a deliberate extra guard
// against an accidental drag during ordinary knob use, on top of the label
// being the only drag handle (the knob itself still just turns).
let toneRowLocked = true;

// Save sequence detection
let saveSequenceDetected = false;
let saveSequenceSlot     = -1;
let saveSequenceTimer    = null;
// true when armed by a real hardware front-panel save (handleSaveArm),
// false when armed by our own software Save to Rack (armSaveSequence
// called directly from saveCurrentPatchToSlot, capture-scan.js). Both take
// the same isSave recovery path in handleBulkTfxData, but the auto-TFX
// filename (2026-08-29, Charlie's A/B/C save simplification) depends on
// which one it was — only the hardware case gets the "_manual" suffix.
let saveSequenceIsHardware = false;

// Bulk state
let captureCount = 0;


// 7 o'clock start (225° from top going clockwise), 270° sweep, 80px
// ════════════════════════════════════════════════════════════════════
let logsEnabled = false;
let hasReceivedAmpOutValue = false;

// ── Push decoded Amp Out into the knob UI ──
let ampSelectSyncing = false; // guards against the sync below re-triggering a send

const BRIDGE_URL = 'ws://localhost:57121';
let bridgeWs        = null;
let bridgeReady      = false;   // socket open
let bridgeMidiReady  = false;   // socket open AND ports connected
let bridgePorts      = [];      // last port list from bridge
let bridgeReconnectTimer = null;
let bridgeInIdx  = null;
let bridgeOutIdx = null;

// Force a jump to A1 on the very FIRST connect of a session only — gives
// a predictable, known starting state (both hardware and software agree
// on A1) without re-disrupting things on every later reconnect (manual
// port change, bridge restart). Forcing it unconditionally on every
// connect was the earlier behavior that caused an unwanted patch jump
// whenever you just switched MIDI ports — this is the narrower version
// that gets the predictability back without reintroducing that bug.
let hasCompletedInitialConnect = false;

// Startup-only connect gate (like Avid's) — armed once per launch/retry
// cycle in initMIDI(), cleared the moment 'connected' arrives. Never
// re-armed after the first successful connect (mid-session drops are the
// status-bar indicator + retry button's job, not this modal's).
let startupGateTimer = null;
// Default 15s (was 5s). A slow machine — old CPU, spun-down platter disk —
// can take well over 5s just to launch Java, start the bridge, and let
// Windows enumerate the USB-MIDI ports, so the old 5s budget fired the
// "rack not found" gate prematurely on hardware that WOULD have connected a
// moment later. The only cost of the longer wait is that a genuinely
// rack-less PC takes 15s (not 5s) to reach the "not found" message, and it
// can't run the app anyway. `let` (not const) so /T<seconds> can widen it
// further at launch — see applyStartupTimeoutOverride (transport.js).
let STARTUP_GATE_TIMEOUT_MS = 15000;

// Splash reveal readiness — the main window stays hidden behind the splash
// until BOTH the first chain map and the first post-nav param pull have
// landed at least once (their replies received, not just requested — see
// checkInitialPopulateReady in transport.js). appRevealed guards against
// firing electronAPI.appReady() more than once (chain map/nav pulls repeat
// on every later patch change).
let initialChainMapDone = false;
let initialNavPullDone  = false;
let appRevealed         = false;

// Firmware identity check (2026-08-28) — a standard MIDI Universal SysEx
// Identity Request/Reply, confirmed via a cold-start Wireshark capture to
// report the firmware build as plain ASCII in its last 4 bytes ("0157" =
// Build 0.1.5.7, the only firmware Eleven Edit has ever been built/tested
// against). Gates the startup reveal alongside the chain-map/nav-pull
// checks — HARDWARE SAFETY, not cosmetics: CMD 0x37 (To Amp Source) is
// confirmed to brick the rack on assert, and this app has no way to know
// what an untested older firmware's memory layout looks like for any
// command it sends. FAILS CLOSED: no reply within the timeout, or any
// reply that doesn't match exactly, blocks the reveal — see
// checkInitialPopulateReady/armFirmwareCheckTimeout (transport.js).
const EXPECTED_FIRMWARE_BUILD    = '0157';
// Must match main.js's MIN_JAVA_MAJOR_VERSION — display-only value, the
// actual enforcement runs main-process-side before the bridge ever spawns.
const MIN_JAVA_VERSION_DISPLAY   = 25;
// Default 10s (was 4s) — same slow-machine reasoning as the connect gate
// above: on a sluggish box the rack's identity reply can lag, and failing
// closed too early would block the reveal on hardware that's simply slow,
// not wrong. `let` so /T<seconds> can widen it too (transport.js).
let FIRMWARE_CHECK_TIMEOUT_MS  = 10000;
let firmwareCheckDone   = false;
let firmwareVersionSeen = null;   // the ASCII string actually reported, or null if no reply arrived
let firmwareOk          = false;
let firmwareCheckTimer  = null;

let pendingManualCapture = false;

// Stereo/Mono state — null=unknown, true=Mono, false=Stereo
// Read from TFX on patch load and from CMD 0x0D live broadcast.
let currentMonoState = null;

// Master (Main) output volume — CMD 0x36 outSel 0x00. null until first
// readback (query reply or live broadcast).
let currentMasterVol = null;
// Headphones output volume — CMD 0x36 outSel 0x01, same encoding/scale as Main.
// null until first readback. 2026-08-31.
let currentPhonesVol = null;

// Master Mute state — CMD 0x3B. Query form CONFIRMED 2026-08-31 (01 3B [ch]);
// these are read on connect via sendMuteQuery so the buttons reflect real state
// (they still fall back to false until the reply/broadcast lands).
let muteMainState   = false;
let mutePhonesState = false;

// ── RIG BALANCING (2026-08-31) — level-matching mode state. See rig-balance.js
// and docs/RigBalancing_Brief.txt. The app BUFFERS every edit itself (the front
// panel's "hold edits, commit on exit" is a rack SCREEN MODE with no MIDI entry
// — over the bridge every nav resets unsaved Rig Vol), so we keep the pending
// edits here and commit only the dirty ones on Save Changed. Discard = drop the
// buffer (the abort the rack/Avid lack).
let rigBalActive     = false;   // mode open?
let rigBalSelected   = null;    // unified slot (0-103) of the selected/playing row
let rigBalReturnSlot = null;    // slot we entered from — landed back on exit
let rigBalKnown      = {};      // slot -> last-seen stored v127 Rig Vol (0-127), read on visit/pre-walk
let rigBalOrig       = {};      // slot -> FIRST-seen v127, set once and never overwritten — the
                                //   double-click "revert to original" target, stable across revisits
let rigBalBuffer     = {};      // slot -> pending edited v127 (DIRTY set); commit only these

// DIST panel open flag — controls whether CMD 0x11 DIST broadcasts update
// the panel knobs. False when the panel is hidden (no-op updates).
let distPanelOpen = false;

// REVERB panel open flag — same role as distPanelOpen, for the REVERB slot.
let reverbPanelOpen = false;

// WAH panel open flag — same role as distPanelOpen, for the WAH slot.
let wahPanelOpen = false;

// VOL panel open flag — same role as distPanelOpen, for the VOL slot.
let volPanelOpen = false;

// FX LOOP panel open flag — same role as distPanelOpen, for the LOOP slot.
let fxLoopPanelOpen = false;

// DELAY panel open flag — same role as distPanelOpen, for the DELAY slot.
let delayPanelOpen = false;

// DELAY knob currently being dragged (paramLo, -1 if none) — same role as
// toAmp1Dragging/toAmp2Dragging (ui.js): the CMD 0x11 readback handler
// skips repainting THIS paramLo while it's the active drag target, so a
// broadcast racing the drag can't visually stomp on it. Added specifically
// because clearing Sync (paramLo 0x05) on Delay-knob touch (R7) sends a
// real hardware write mid-drag, which can trigger a near-immediate
// broadcast — without this guard that broadcast could repaint the knob to
// a transitional value while the user's own drag is still moving it
// (2026-08-02, diagnosed but not yet live-tested).
let delayDragLo = -1;

// R9 for the amp TONE knobs (2026-08-31) — same read-side guard as delayDragLo,
// for the amp block's own knobs. paramLo currently being value-dragged, or -1.
// The amp Speed knob (paramLo 0x11) clears Sync (R7) mid-drag, whose broadcast
// reply can repaint Speed to a transitional value while the drag is still
// moving it (the "SYNC OFF KNOB JUMP", Tech Ref Sec 20A R9). Speed was the
// original R7 control but never got the R9 read-side guard the Delay/FX-host
// Sync knobs did — CONFIRMED reproducible live by Charlie 2026-08-31.
let toneValueDragLo = -1;

// FX-HOST panel open state — replaces a separate fx1PanelOpen/fx2PanelOpen/
// modPanelOpen trio (2026-08-01 refactor). FX1/FX2/MOD share one engine and
// one physical panel (fx-panels.js, index.html #panel-fxhost), so only one
// of them can ever be open at a time — this single slot id IS the "is a
// panel open, and which one" state, same role distPanelOpen/etc. play for
// their own single-slot families. null = no FX-host panel open; otherwise
// SLOT_FX1 / SLOT_FX2 / SLOT_MOD.
let openFxHostSlot = null;

// ── Amp Select receipt counter.
// Incremented every time a CMD 0x11 paramLo 0x0F (Amp Select) reply is
// processed. The post-nav pull waits for this to advance before building the
// tone-knob query list, because that list is per-amp: if it is built while
// currentAmpKey still holds the PREVIOUS patch's amp, the wrong paramLo set
// gets queried. Observed 2026-07-22 — navigating 800 EchoScream -> Bassguy 59
// queried lead800's knobs, so Vol Norm (0x08) was never read and 0x09 came
// back unroutable. A fixed sleep could not fix this reliably; waiting on the
// actual reply can.
var ampSelectRxSeq = 0;

// ── Chain map receipt counter.
// Incremented once a CMD 0x21 chain map has been fully applied, meaning
// currentChain and currentParamHi are valid. The post-nav pull waits on this
// before issuing any amp-block query, because addressing a stale paramHi
// queries the wrong block entirely.
var chainMapRxSeq = 0;
