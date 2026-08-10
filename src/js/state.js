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
const SCAN_SETTLE_MS           = 400;  // wait after navigating, before requesting patch data — TUNE THIS if slots keep timing out
const SCAN_RESPONSE_TIMEOUT_MS = 1200; // how long to wait for a response before giving up on a slot and moving on

// ── Bank export (2026-08-10) — direct by-slot SEND_PATCH query (Avid's own
// "Save All Rigs" mechanism, no recall — see bank-transfer.js). Same
// early-exit pattern as the scan vars above, own pending state so an export
// and a bank scan can never cross-consume each other's replies. ──
let exportInProgress      = false;
let exportCancelRequested = false;
let pendingExportSlot     = null;
let pendingExportResolve  = null;
const EXPORT_RESPONSE_TIMEOUT_MS = 1200; // same budget as SCAN_RESPONSE_TIMEOUT_MS

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

// Bypass state per block, keyed by SLOT ID (stable across patches).
// true = active, false = bypassed, undefined = not yet known.
// AMP-CAB is one block with TWO independent flags, so it gets two entries:
//   blockBypass[SLOT_AMP]  — the amp   (CMD 0x11 paramLo 0x06)
//   cabBypassActive        — the cab   (CMD 0x11 paramLo 0x14)
// Every other block uses paramLo 0x01 on its own handle.
let blockBypass = {};
let cabBypassActive;            // undefined until read from hardware

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
// Re-arms LOCKED on every launch (not persisted) — a deliberate extra guard
// against an accidental drag during ordinary knob use, on top of the label
// being the only drag handle (the knob itself still just turns).
let toneRowLocked = true;

// Save sequence detection
let saveSequenceDetected = false;
let saveSequenceSlot     = -1;
let saveSequenceTimer    = null;

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
const STARTUP_GATE_TIMEOUT_MS = 5000;

// Splash reveal readiness — the main window stays hidden behind the splash
// until BOTH the first chain map and the first post-nav param pull have
// landed at least once (their replies received, not just requested — see
// checkInitialPopulateReady in transport.js). appRevealed guards against
// firing electronAPI.appReady() more than once (chain map/nav pulls repeat
// on every later patch change).
let initialChainMapDone = false;
let initialNavPullDone  = false;
let appRevealed         = false;

let pendingManualCapture = false;

// Stereo/Mono state — null=unknown, true=Mono, false=Stereo
// Read from TFX on patch load and from CMD 0x0D live broadcast.
let currentMonoState = null;

// Master (Main) output volume — CMD 0x36 outSel 0x00. null until first
// readback (query reply or live broadcast).
let currentMasterVol = null;

// Master Mute state — CMD 0x3B. No query form exists (Tech Ref Sec 18/C13),
// so these start false ("unmuted") and only change on an actual send/echo —
// same known limitation as the Input Selector not reflecting live state on
// connect.
let muteMainState   = false;
let mutePhonesState = false;

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
