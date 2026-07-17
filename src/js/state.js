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
let currentParamHi = -1;  // runtime paramHi from CMD 0x21 chain map (typeA=0x07 third byte)
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
