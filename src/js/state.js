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
let bankCache            = {};   // slotNum -> {name, ampKey, threshV, releaseV, signature, scannedAt}
let scanInProgress       = false;
let scanCancelRequested  = false;
let pendingScanSlot      = null;
let pendingScanResolve   = null;
const SCAN_SETTLE_MS           = 400;  // wait after navigating, before requesting patch data — TUNE THIS if slots keep timing out
const SCAN_RESPONSE_TIMEOUT_MS = 1200; // how long to wait for a response before giving up on a slot and moving on

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

// ── Last post-nav pull measurements, shown in the timing panel.
var lastNavPullMs = 0;
var lastNavPullQueries = 0;
