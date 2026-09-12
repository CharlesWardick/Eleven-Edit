/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { exec, execFile, spawn } = require('child_process');

// EXPERIMENTAL, 2026-08-03: Charlie reported a separate dark flash, sized
// like the main window, appearing BEFORE the splash on a cold start only
// (never on an immediate relaunch) — real PC, not the VM white-flash issue
// above. Best-guess cause: Windows' own "ghost window" launch feedback
// (Explorer/DWM showing a placeholder sized like the app's last window
// when it takes a moment to launch), not Chromium — that would explain
// both why it's sized like the MAIN window specifically (that's the
// window Windows remembers) and the cold/warm timing (a cold start gives
// Windows enough of a gap to decide to show it). setAppUserModelId can
// help Windows correctly associate the process instead of guessing/
// ghosting. Cheap to try, easy to revert if it makes no difference —
// unlike the /NOGPU fix above, this one is UNVERIFIED, not confirmed.
app.setAppUserModelId('com.charleswardick.eleveneedit');

// ════════════════════════════════════════════════════════════════════
// /NOGPU — optional startup flag, same pattern as /LOGS below.
// Forces Chromium to render in software instead of via the GPU. Added
// 2026-08-03 for Charlie's VM shortcuts: a white flash at the splash->main
// reveal turned out to be a known, years-old, unfixed Chromium/Electron
// compositor bug specific to virtualized/software GPU rendering — never
// happens on real hardware, only VMs. disableHardwareAcceleration() takes
// the whole rendering pipeline off the GPU compositor path that has the
// bug, so it shouldn't apply the same way. MUST be called before
// app.whenReady() (before any window/GPU-process work starts). App-wide —
// only add /NOGPU to shortcuts that actually need it (VM shortcuts), not
// the real-hardware one, since forcing software rendering has some
// performance cost even though it's likely small for this simple 2D UI.
// ════════════════════════════════════════════════════════════════════
if (process.argv.some(a => a.toLowerCase() === '/nogpu')) {
  app.disableHardwareAcceleration();
}

// ════════════════════════════════════════════════════════════════════
// STARTUP TIMEOUT OVERRIDE — /T<seconds>
// A slow machine (old CPU, spun-down platter disk) can take longer than
// the default startup budget to launch Java, start the bridge, and let
// Windows enumerate the USB-MIDI ports — so the "Eleven Rack not found"
// gate fires even though the rack WOULD appear a moment later. /T<seconds>
// widens BOTH startup timers (the connect gate and the firmware check).
// No flag = the built-in defaults in state.js (already generous). Clamped
// to a sane 3–120s range. Read back in preload.js -> transport.js.
// e.g.  ElevenEdit.exe /T30
// ════════════════════════════════════════════════════════════════════
let startupTimeoutSec = null;
(function () {
  const hit = process.argv.map(a => /^\/t(\d{1,3})$/i.exec(a)).find(Boolean);
  if (hit) {
    let n = parseInt(hit[1], 10);
    if (n < 3)   n = 3;
    if (n > 120) n = 120;
    startupTimeoutSec = n;
  }
})();

// ════════════════════════════════════════════════════════════════════
// SINGLE INSTANCE LOCK
// ════════════════════════════════════════════════════════════════════
const gotLock = app.requestSingleInstanceLock();
// app.quit() alone only SCHEDULES a quit — it does not stop the rest of this
// script from running synchronously. Without the return, a second launch
// still reached app.whenReady() -> launchBridge() -> killOrphanedBridgeProcesses(),
// which force-kills ANY ElevenRackBridge.jar process (by design, to clean up
// a stale one from a crashed prior session) — including the FIRST, already-
// running instance's bridge, right before the second instance itself quit.
// That's what caused the "brief splash flash, then the running instance's
// bridge connection dies" symptom Charlie found 2026-08-03, introduced (or
// exposed — the lock existed before) around the same time as the startup
// gate. Bailing out here means the second instance's window/bridge/splash
// code never runs at all.
if (!gotLock) { app.quit(); return; }

app.on('second-instance', function() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ════════════════════════════════════════════════════════════════════
// RigRoller+ is always Mode 3 (hybrid). No mode selector.
// ════════════════════════════════════════════════════════════════════
const startupMode = 3;
ipcMain.handle('get-startup-mode', function() { return startupMode; });
ipcMain.handle('get-app-version', function() { return app.getVersion(); });

// ── Windows 11 "new MIDI stack" detection (Phase B, "Gate and Wait") ──
// The new in-box Windows MIDI Services stack corrupts the large SysEx a patch
// upload needs (see docs). Detect it the same way Microsoft's own checker does:
// wdmaud2.drv registered in Drivers32. Present => this PC MAY have the broken
// stack, so the renderer arms a pre-upload warning. Windows-only; anything else
// (incl. Win10) resolves false and the gate stays dormant.
function detectNewMidiStack() {
  return new Promise(function(resolve) {
    if (process.platform !== 'win32') { resolve(false); return; }
    // wdmaud2.drv is the DATA of one of the midi/midi1..midi9 VALUES under
    // Drivers32 (Microsoft's own layout), NOT a value named "wdmaud2.drv".
    // So dump the whole key and look for wdmaud2.drv anywhere in the output —
    // the same thing Microsoft's midicheckservice reports.
    execFile('reg', ['query',
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Drivers32'],
      function(err, stdout) {
        resolve(!err && /wdmaud2\.drv/i.test(stdout || ''));
      });
  });
}
ipcMain.handle('get-midi-stack-status', async function() {
  const newStack = await detectNewMidiStack();
  const warnDisabled = storeGet('win11UploadWarnDisabled', false);
  const startupAck = storeGet('win11StartupNoticeAck', false);
  logWrite('MIDI stack check: newStack=' + newStack + ', uploadWarnDisabled=' + warnDisabled + ', startupAck=' + startupAck);
  return { newStack: newStack, permanentlyDisabled: !!warnDisabled, startupAck: !!startupAck };
});
ipcMain.handle('set-win11-upload-warn-disabled', function(e, val) {
  storeSet('win11UploadWarnDisabled', !!val);
  logWrite('Win11 upload warning permanently ' + (val ? 'DISABLED' : 're-enabled') + ' by user/auto');
  return true;
});
ipcMain.handle('set-win11-startup-ack', function() {
  storeSet('win11StartupNoticeAck', true);
  return true;
});

// ════════════════════════════════════════════════════════════════════
// SESSION LOG
// ════════════════════════════════════════════════════════════════════
let logStream = null;
let logPath   = null;
const logsEnabled = process.argv.some(a => a.toLowerCase() === '/logs');

function initLog() {
  if (!logsEnabled) return;
  try {
    const userDataPath = app.getPath('userData');
    const logsDir = path.join(userDataPath, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    const now = new Date();
    const stamp = now.getFullYear()
      + '-' + String(now.getMonth()+1).padStart(2,'0')
      + '-' + String(now.getDate()).padStart(2,'0')
      + '-' + String(now.getHours()).padStart(2,'0')
      + String(now.getMinutes()).padStart(2,'0')
      + String(now.getSeconds()).padStart(2,'0');
    logPath = path.join(logsDir, 'session-' + stamp + '.log');
    logStream = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });
    logStream.on('error', function(e) { console.error('Log stream error:', e.message); logStream = null; });
    // Bug Report #2 (2026-08-11): this app was spun off RigRollerPlus's
    // core, and the log banner kept that name/no version long after the
    // rename to Eleven Edit — confusing when cross-referencing a log
    // against which build produced it. app.getVersion() reads package.json
    // (bumped every session per Primer convention), so this banner is
    // always the actual running build, not a string someone has to remember
    // to update by hand.
    logWrite('=== Eleven Edit (v' + app.getVersion() + ') Session Start ' +
      now.toLocaleString() + ' ===');
    logWrite('Log: ' + logPath);
    logWrite('userData: ' + userDataPath);
    console.log('Log file: ' + logPath);
  } catch(e) {
    console.error('Log init failed:', e.message);
  }
}

function logWrite(line) {
  if (!logsEnabled || !logStream || logStream.destroyed) return;
  try {
    const ts = new Date().toLocaleTimeString('en-US', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const entry = '[' + ts + '] ' + line + '\n';
    logStream.write(entry);
    console.log(entry.trim());
  } catch(e) { console.error('logWrite error:', e.message); }
}

function logClose() {
  if (!logsEnabled) return;
  try {
    logWrite('=== Eleven Edit Session End ===');
    if (logStream && !logStream.destroyed) { logStream.end(); }
    logStream = null;
  } catch(e) {}
}

ipcMain.handle('get-log-path',   function() { return logPath || ''; });
ipcMain.handle('get-logs-enabled', function() { return logsEnabled; });
ipcMain.handle('log-write', function(e, line) { logWrite(line); return true; });

// ════════════════════════════════════════════════════════════════════
// SETTINGS PERSISTENCE
// ════════════════════════════════════════════════════════════════════
function getStorePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function storeGet(key, defaultVal) {
  try {
    const p = getStorePath();
    if (!fs.existsSync(p)) return defaultVal;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return key in data ? data[key] : defaultVal;
  } catch(e) { return defaultVal; }
}

function storeSet(key, value) {
  try {
    const p = getStorePath();
    let data = {};
    if (fs.existsSync(p)) data = JSON.parse(fs.readFileSync(p, 'utf8'));
    data[key] = value;
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch(e) { logWrite('Store write error: ' + e.message); }
}

// ════════════════════════════════════════════════════════════════════
// TFX FILE SAVE
// Bulk SysEx payload is 7-bit encoded — must decode before writing.
// After decode, prepend the 56-byte TFX file header.
// ════════════════════════════════════════════════════════════════════

// Returns configured captures dir if set and still valid, else default
function getCapturesDir() {
  const custom = storeGet('capturesDir', null);
  if (custom && fs.existsSync(custom)) return custom;
  const defaultDir = path.join(app.getPath('userData'), 'captures');
  if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });
  return defaultDir;
}

// 7-bit decode — verified 7/12/2026, aligned with protocol.js version
// (confirmed byte-exact against AE/EH gold standard files).
// Previous version had a stale savePos variable and produced truncated
// output (~890 bytes instead of the correct 968). This version matches
// the protocol.js implementation exactly, ported to Node Buffer.
function decode7bit(encoded) {
  const len = encoded.length;
  const res = Buffer.alloc(len);
  let begin = 0, shift = 1, i = 0;
  for (; begin + i < len - 1; i++) {
    res[i] = (((encoded[begin + i] & 0xFF) << shift) & 0xFF)
           + (((encoded[begin + i + 1] & 0xFF) >>> (7 - shift)) & 0xFF);
    res[i] &= 0xFF;
    shift++;
    if (shift === 8) { shift = 1; begin++; }
  }
  res[i] = ((encoded[len - 1] & 0xFF) << shift) & 0xFF;
  // Correct output length: each group of 8 encoded bytes -> 7 decoded bytes.
  // Partial group of r encoded bytes -> r-1 decoded bytes. The post-loop
  // final byte is spurious when the last group is partial (len%8 != 0).
  const outLen = (len % 8 === 0) ? (len / 8) * 7
                                  : Math.floor(len / 8) * 7 + (len % 8) - 1;
  return res.slice(0, outLen);
}

ipcMain.handle('save-tfx', function(e, rigName, dataArray, opts) {
  try {
    const tfxDir = getCapturesDir();
    const incrementIfExists = !!(opts && opts.incrementIfExists);

    const safeName = (rigName || 'capture').replace(/[\\/:*?"<>|]/g, '_').substring(0, 32);
    let fname = safeName + '.tfx';
    let fpath = path.join(tfxDir, fname);

    // Hardware-save captures intentionally overwrite (same patch name =
    // latest state of that patch, by design). Manual "Capture Current
    // Patch Now" captures opt into auto-increment instead, since a
    // research session often wants several distinct captures of the
    // same patch name without clobbering the previous one.
    if (incrementIfExists && fs.existsSync(fpath)) {
      let n = 2;
      while (fs.existsSync(fpath)) {
        fname = safeName + ' (' + n + ').tfx';
        fpath = path.join(tfxDir, fname);
        n++;
      }
    }

    // Step 1: decode 7-bit encoded bulk payload
    const encoded = Buffer.from(dataArray);
    logWrite('TFX: encoded payload ' + encoded.length + ' bytes');
    const body = decode7bit(encoded);
    logWrite('TFX: decoded body ' + body.length + ' bytes');

    // Step 2: build 56-byte TFX header
    // Format: [4 bytes filesize][4 zeros][16 bytes magic][32 zeros]
    const fileSize = 56 + body.length;
    const header = Buffer.alloc(56, 0);
    header[0] = (fileSize >>> 24) & 0xFF;
    header[1] = (fileSize >>> 16) & 0xFF;
    header[2] = (fileSize >>> 8)  & 0xFF;
    header[3] =  fileSize         & 0xFF;
    // Magic string: DigiElvRELVhRig  (ELV = correct for current firmware)
    const magic = 'DigiElvRELVhRig ';
    for (let i = 0; i < 16; i++) header[8 + i] = magic.charCodeAt(i);

    // Step 3: write header + decoded body
    const out = Buffer.concat([header, body]);
    fs.writeFileSync(fpath, out);

    logWrite('TFX saved: ' + fpath + ' (' + out.length + ' bytes, body=' + body.length + ')');
    return { ok: true, path: fpath, filename: fname, dir: tfxDir };
  } catch(e) {
    logWrite('TFX save error: ' + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-captures-dir', function() {
  return getCapturesDir();
});

// ════════════════════════════════════════════════════════════════════
// BANK EXPORT — "Export All Rigs…" (2026-08-10). Renderer walks all 104
// slots via the direct by-slot SEND_PATCH query (protocol.js
// reqSendPatchBySlot / bank-transfer.js) and hands this ONE call the
// already-decoded body for every slot plus the disambiguated filename it
// picked; this handler does the filesystem work only — build each TFX
// (same header logic as save-tfx above), write the loose files + the XML
// map into a subfolder, then zip that subfolder (buildZip, zip-writer.js
// — dependency-free, real DEFLATE via zlib). Per Charlie's call: keep
// BOTH the loose folder and the .zip, don't clean up after zipping.
// ════════════════════════════════════════════════════════════════════
const { buildZip } = require('./src/js/zip-writer.js');

ipcMain.handle('choose-export-dir', async function() {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose Folder for Bank Export',
      defaultPath: getCapturesDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    return { ok: true, dir: result.filePaths[0] };
  } catch(e) {
    logWrite('Choose export dir error: ' + e.message);
    return { ok: false, error: e.message };
  }
});

function buildTfxBuffer(bodyArray) {
  const body = Buffer.from(bodyArray);
  const fileSize = 56 + body.length;
  const header = Buffer.alloc(56, 0);
  header[0] = (fileSize >>> 24) & 0xFF;
  header[1] = (fileSize >>> 16) & 0xFF;
  header[2] = (fileSize >>> 8)  & 0xFF;
  header[3] =  fileSize         & 0xFF;
  const magic = 'DigiElvRELVhRig ';
  for (let i = 0; i < 16; i++) header[8 + i] = magic.charCodeAt(i);
  return Buffer.concat([header, body]);
}

function xmlEscape(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// entries: [{ bank: 'A1', filename: 'Above Symmetry.tfx', bodyArray: [...] }, ...]
// bodyArray is the ALREADY-DECODED body (protocol.js decode7bit ran in the
// renderer as part of the export walk — no point decoding twice).
ipcMain.handle('export-bank', function(e, folder, bankName, entries) {
  try {
    const safeBankName = (bankName || 'Bank').replace(/[\\/:*?"<>|]/g, '_').substring(0, 48);
    const bankDir = path.join(folder, safeBankName);
    if (!fs.existsSync(bankDir)) fs.mkdirSync(bankDir, { recursive: true });

    const zipEntries = [];
    const xmlRows = [];
    for (const entry of entries) {
      const tfxBuf = buildTfxBuffer(entry.bodyArray);
      fs.writeFileSync(path.join(bankDir, entry.filename), tfxBuf);
      zipEntries.push({ name: entry.filename, data: tfxBuf });
      xmlRows.push(
        '        <patch>\n' +
        '            <bank type_="string">"' + xmlEscape(entry.bank) + '"</bank>\n' +
        '            <file type_="string">"' + xmlEscape(entry.filename) + '"</file>\n' +
        '        </patch>'
      );
    }
    // Stamp the producing build into the manifest (2026-09-08) so an export
    // folder is self-identifying — which Eleven Edit version wrote it, and when.
    // A sibling of <patch_list>, so parseBankXml (which only scans <patch>
    // blocks for bank+file) ignores it on import; purely informational.
    const genTag =
      '    <generator type_="string">"Eleven Edit"</generator>\n' +
      '    <generator_version type_="string">"' + xmlEscape(app.getVersion()) + '"</generator_version>\n' +
      '    <exported_utc type_="string">"' + xmlEscape(new Date().toISOString()) + '"</exported_utc>\n';
    const xml =
      '<?xml version="1.0"?>\n' +
      '<eleven>\n' +
      '    <hardware type_="string">"Eleven Rack"</hardware>\n' +
      genTag +
      '    <patch_list>\n' +
      xmlRows.join('\n') + '\n' +
      '    </patch_list>\n' +
      '</eleven>\n';
    const xmlName = safeBankName + '.xml';
    fs.writeFileSync(path.join(bankDir, xmlName), xml, 'utf8');
    zipEntries.push({ name: xmlName, data: Buffer.from(xml, 'utf8') });

    const zipPath = path.join(folder, safeBankName + '.zip');
    fs.writeFileSync(zipPath, buildZip(zipEntries));

    logWrite('Bank export complete: ' + entries.length + ' slots -> ' + bankDir + ' + ' + zipPath);
    return { ok: true, dir: bankDir, xmlPath: path.join(bankDir, xmlName), zipPath: zipPath, count: entries.length };
  } catch(e) {
    logWrite('Bank export error: ' + e.message);
    return { ok: false, error: e.message };
  }
});

// ════════════════════════════════════════════════════════════════════
// BANK IMPORT — "Import Rigs…" (2026-08-10). Avid's own direct by-slot
// WRITE mechanism (decoded from the Wireshark capture, same session) —
// no recall needed. Unlike the export side, a write has no "stale cold
// read" failure mode to worry about (see bank-transfer.js and Session
// Log 2026-08-10 for the export saga this deliberately does NOT repeat),
// and every one of Charlie's live tests of Avid's OWN Load All Rigs
// worked cleanly — real evidence for trying this method here, not just
// an assumption.
// Charlie's own framing (2026-08-10): Avid "blindly reads the XML and if
// it can't find a patch or read a patch it ABORTS" — matched here by
// validating every referenced file exists and has a real TFX header
// BEFORE any hardware write happens, all-or-nothing. Only the XML's own
// entries are ever touched — this is deliberately NOT "always all 104"
// the way export is; a 25-entry XML writes exactly those 25 slots.
// ════════════════════════════════════════════════════════════════════

ipcMain.handle('choose-import-source', async function() {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Rigs — Choose Bank XML or ZIP',
      defaultPath: getCapturesDir(),
      filters: [
        { name: 'Bank XML or ZIP', extensions: ['xml', 'zip'] },
        { name: 'Bank XML', extensions: ['xml'] },
        { name: 'Bank ZIP', extensions: ['zip'] },
      ],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    return { ok: true, path: result.filePaths[0] };
  } catch(e) {
    logWrite('Choose import source error: ' + e.message);
    return { ok: false, error: e.message };
  }
});

// Deliberately NOT a general-purpose XML parser — this only understands
// the one fixed shape both Avid's own export and our own Export All Rigs
// produce: repeated <patch><bank type_="string">"X1"</bank><file
// type_="string">"name.tfx"</file></patch> blocks. Regex is safe here
// because we control (or have fully reverse-engineered) every producer
// of this format; a real parser would be overkill for one known shape.
function parseBankXml(xmlText) {
  const entries = [];
  const patchRe = /<patch>([\s\S]*?)<\/patch>/g;
  let m;
  while ((m = patchRe.exec(xmlText)) !== null) {
    const block = m[1];
    const bankM = /<bank[^>]*>"([^"]*)"<\/bank>/.exec(block);
    const fileM = /<file[^>]*>"([^"]*)"<\/file>/.exec(block);
    if (bankM && fileM) entries.push({ bank: bankM[1], filename: fileM[1] });
  }
  return entries;
}

function validTfxBody(raw) {
  if (raw.length < 56 || raw.toString('ascii', 8, 24).indexOf('DigiElv') !== 0) return null;
  return raw.slice(56);
}

// Structural sanity check on a decoded patch body (2026-09-05). The magic-only
// check above catches a wrong FILE type but passes structurally-corrupt patches
// (truncated, missing the amp block) that the rack then rejects at write time
// with "Bad Patch Data" (CMD 0x78). Real-world banks from random sources across
// the Eleven Rack's whole history are full of these, so catch the detectable
// ones up front and list them as skipped, rather than firing a doomed write.
// Returns a reason string if the body looks corrupt, else null.
//   NOTE: this cannot catch EVERY bad patch (the rack's full acceptance rules /
//   checksum are undocumented) — subtler corruption still surfaces at runtime
//   and is handled by the import loop's per-slot rejection reporting. This only
//   removes the gross, provably-broken ones before they ever reach the rack.
function tfxStructuralProblem(body) {
  if (body.length < 256) return 'patch data too small (truncated)';
  // Amp-model marker: the 'sld6'/'6dls' key is stored byte-reversed in the body
  // and is present in every valid patch. Its absence means the amp section
  // (and usually much more) is missing — e.g. a runt/truncated capture.
  const hasKey = (k) => body.indexOf(Buffer.from(k.split('').reverse().join(''), 'ascii')) !== -1;
  if (!hasKey('6dls') && !hasKey('sld6')) return 'incomplete patch (no amp block)';
  return null;
}

// sourcePath ends in .xml (loose folder, sibling files on disk) or .zip
// (everything — the XML and every referenced TFX — inside the archive,
// 2026-08-10). VALIDATE UP FRONT, DECIDE ONCE (2026-08-10, revised same
// day at Charlie's request) — NOT all-or-nothing, and NOT Avid's own
// behaviour either (Avid writes progressively until it hits a bad file,
// then silently stops mid-bank with no clear record of what did or
// didn't land). This checks every entry before anything touches
// hardware and returns BOTH lists — `valid` (ready to write) and
// `problems` (missing or malformed, with why) — so the renderer can show
// Charlie the complete picture in one prompt and let him choose skip-
// and-continue or cancel, rather than either silently stopping partway
// (Avid) or blocking the whole import over one bad file (the previous
// version of this handler).
ipcMain.handle('read-import-bank', function(e, sourcePath) {
  try {
    const isZip = /\.zip$/i.test(sourcePath);
    let xmlText, lookupBody;

    if (isZip) {
      const { readZip } = require('./src/js/zip-writer.js');
      const zipEntries = readZip(fs.readFileSync(sourcePath));
      const xmlEntry = zipEntries.find((z) => /\.xml$/i.test(z.name));
      if (!xmlEntry) return { ok: false, error: 'No .xml file found inside this zip.' };
      xmlText = xmlEntry.data.toString('utf8');
      const byName = {};
      for (const z of zipEntries) byName[z.name] = z.data;
      lookupBody = (filename) => (byName[filename] !== undefined ? byName[filename] : null);
    } else {
      xmlText = fs.readFileSync(sourcePath, 'utf8');
      const folder = path.dirname(sourcePath);
      lookupBody = (filename) => {
        // Path-traversal guard: an untrusted bank XML must not reach outside its own folder.
        if (/[\\/]/.test(filename) || filename.includes('..')) return null;
        const fpath = path.join(folder, filename);
        return fs.existsSync(fpath) ? fs.readFileSync(fpath) : null;
      };
    }

    const parsed = parseBankXml(xmlText);
    if (!parsed.length) {
      return { ok: false, error: 'No <patch> entries found in this XML — is it a bank export file?' };
    }

    // Provenance: the generator stamp Eleven Edit writes on export (2026-09-08).
    // Absent on Avid exports, ElevenHack banks, our old bank-manager, and any
    // hand-crafted file — so absence means "unknown", NOT "Avid".
    const tagVal = (t) => { const m = new RegExp('<'+t+'[^>]*>"([^"]*)"</'+t+'>').exec(xmlText); return m ? m[1] : null; };
    const source = {
      generator: tagVal('generator'),
      version:   tagVal('generator_version'),
      exported:  tagVal('exported_utc'),
    };

    const valid = [];
    const problems = [];
    for (const p of parsed) {
      const raw = lookupBody(p.filename);
      if (raw === null) { problems.push({ bank: p.bank, filename: p.filename, reason: 'file not found' }); continue; }
      const body = validTfxBody(raw);
      if (!body) { problems.push({ bank: p.bank, filename: p.filename, reason: 'not a valid TFX file' }); continue; }
      const structProblem = tfxStructuralProblem(body);
      if (structProblem) { problems.push({ bank: p.bank, filename: p.filename, reason: structProblem }); continue; }
      valid.push({ bank: p.bank, filename: p.filename, body: Array.from(body) });
    }

    logWrite('Import bank read: ' + valid.length + ' valid, ' + problems.length + ' problem(s) from ' + sourcePath
      + (source.generator ? ' [' + source.generator + (source.version ? ' v' + source.version : '') + ']' : ' [source unknown]'));
    return { ok: true, valid: valid, problems: problems, source: source };
  } catch(e) {
    logWrite('Read import bank error: ' + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('load-tfx-dialog', async function() {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: 'Load TFX Patch',
      defaultPath: getCapturesDir(),
      filters: [{ name: 'TFX Patch', extensions: ['tfx'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const fpath = result.filePaths[0];
    const raw = fs.readFileSync(fpath);

    // Only files WE saved are supported for now — same 56-byte header,
    // same magic string, every time (see save-tfx above). A file from
    // a different source (Avid's own export, an old library file) may
    // use a different header entirely — deliberately not guessed at
    // here, scoped out for a safer first version.
    if (raw.length < 56) {
      return { ok: false, error: 'File too short to be a valid TFX (need at least 56 bytes)' };
    }
    const magic = raw.toString('ascii', 8, 24);
    if (magic.indexOf('DigiElv') !== 0) {
      return { ok: false, error: 'This file doesn\'t look like one captured by this app (missing expected header). Loading files from other sources isn\'t supported yet.' };
    }

    // Same structural pre-flight the bank importer runs — catch a grossly
    // corrupt patch (truncated / no amp block) here too, before it is ever
    // sent to the rack, rather than only discovering it from the rack's
    // runtime "Bad Patch Data" rejection.
    const bodyBuf = raw.slice(56);
    const structProblem = tfxStructuralProblem(bodyBuf);
    if (structProblem) {
      logWrite('TFX load refused (structural): ' + fpath + ' — ' + structProblem);
      return { ok: false, error: 'This patch looks corrupt (' + structProblem + ') and would be rejected by the rack. Not sent.' };
    }

    const body = Array.from(bodyBuf);
    logWrite('TFX loaded for upload: ' + fpath + ' (' + raw.length + ' bytes, body=' + body.length + ')');
    return { ok: true, path: fpath, filename: path.basename(fpath), body: body };
  } catch(e) {
    logWrite('TFX load error: ' + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('choose-captures-dir', async function() {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose TFX Captures Folder',
      defaultPath: getCapturesDir(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const chosen = result.filePaths[0];
    storeSet('capturesDir', chosen);
    logWrite('Captures dir changed to: ' + chosen);
    return { ok: true, dir: chosen };
  } catch(e) {
    logWrite('Choose captures dir error: ' + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('browse-avid-dir', async function() {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      // Renamed 7/28 — this no longer has to be a live Avid Editor install;
      // the plan is for whatever reads this folder to search it recursively
      // for the Avid plugin structure rather than assume one exact depth, so
      // a copied-out subset of the install still works. That loader is not
      // built yet — this is just the folder picker + rename.
      title: 'Choose Avid Graphics Folder',
      defaultPath: storeGet('avidDir', 'C:\\Program Files'),
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const chosen = result.filePaths[0];
    storeSet('avidDir', chosen);
    logWrite('Avid dir set to: ' + chosen);
    return { ok: true, dir: chosen };
  } catch(e) {
    logWrite('Browse avid dir error: ' + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-avid-dir', function() {
  return storeGet('avidDir', '');
});

// ════════════════════════════════════════════════════════════════════
// AVID GRAPHICS FOLDER SCANNER
// Recursive on purpose (Session Log 7/28, "FOLDER-DEPTH DECISION"): the
// chosen folder may be a live Avid Editor install, or just a copied-out
// subset of one at any depth, so this walks everything under it rather
// than assuming one fixed layout. Confirmed real-install layout (Charlie's
// 11R_Image_Paths.txt, 3934 lines / 3623 PNGs, 7/28):
//   <PluginFamily>.aaxplugin\Contents\Resources\Images\<Name>.png
// Depth elsewhere in the tree (Resources root, XML, etc.) is not scanned
// for images — only that Images subfolder of an .aaxplugin bundle counts.
// ════════════════════════════════════════════════════════════════════
const AAXPLUGIN_SUFFIX = '.aaxplugin';

function walkForAaxImages(dir, families, depth) {
  if (depth > 12) return; // sane recursion guard, not a real-world limit
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return; // unreadable dir (permissions, junction loop, etc.) — skip it
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (!ent.isDirectory()) continue;
    if (ent.name.toLowerCase().endsWith(AAXPLUGIN_SUFFIX)) {
      // Real folder name confirmed 7/29/2026 from Charlie's actual install
      // listing (11R_Image_Paths.txt): "Eleven <Family> UI.aaxplugin", e.g.
      // "Eleven Distortion UI.aaxplugin" — kept as-is (not stripped/guessed)
      // so it matches CHAIN_BLOCK_FAMILY_BY_MID (chain-graphics.js) exactly.
      const family = ent.name.slice(0, -AAXPLUGIN_SUFFIX.length);
      const imagesDir = path.join(full, 'Contents', 'Resources', 'Images');
      let pngs = [];
      try {
        pngs = fs.readdirSync(imagesDir)
          .filter(f => f.toLowerCase().endsWith('.png'));
      } catch (e) {
        // No Images subfolder at the expected depth — leave family unlisted
        // rather than guess another depth.
      }
      if (pngs.length) {
        if (!families[family]) families[family] = { dir: imagesDir, files: [] };
        families[family].files.push(...pngs);
      }
      // An .aaxplugin bundle's own internals aren't searched further.
      continue;
    }
    walkForAaxImages(full, families, depth + 1);
  }
}

ipcMain.handle('scan-avid-graphics', function(e, rootDir) {
  try {
    const dir = rootDir || storeGet('avidDir', '');
    if (!dir || !fs.existsSync(dir)) {
      // Was silent before 2026-07-31 — the ONLY reason the intermittent
      // "chain row graphics missing on load" bug (Session Log) had no trace
      // in the logs at all. Log every failure path now, not just the catch.
      logWrite('Avid graphics scan failed: folder not set or does not exist'
        + (dir ? (' (' + dir + ')') : ''));
      return { ok: false, error: 'Folder not set or does not exist' };
    }
    const families = {}; // familyName -> { dir: imagesDirPath, files: [png basenames] }
    walkForAaxImages(dir, families, 0);
    let total = 0;
    Object.keys(families).forEach(f => { total += families[f].files.length; });
    logWrite('Avid graphics scan: ' + Object.keys(families).length
      + ' plugin folder(s), ' + total + ' PNG(s), root=' + dir);
    return { ok: true, root: dir, families: families, totalCount: total };
  } catch (e) {
    logWrite('Avid graphics scan error: ' + e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-logs-dir', function() {
  return path.join(app.getPath('userData'), 'logs');
});

ipcMain.handle('reset-captures-dir', function() {
  try {
    storeSet('capturesDir', null);
    const dir = getCapturesDir();
    logWrite('Captures dir reset to default: ' + dir);
    return { ok: true, dir: dir };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// User manual — same dev-vs-packaged path pattern as findBridgeJar (jar
// sits next to main.js in dev, in process.resourcesPath once packaged).
// Opens with the OS's own default handler for .txt (Notepad, etc.) via
// shell.openPath — never a browser, never a network fetch, per Charlie's
// own "I hate having to go online for a manual" stance.
ipcMain.handle('open-user-manual', function() {
  const candidates = [
    path.join(process.resourcesPath || '', 'UserManual.txt'),
    path.join(__dirname, 'UserManual.txt'),
  ];
  const manualPath = candidates.find(function(p) { return p && fs.existsSync(p); });
  if (!manualPath) {
    logWrite('open-user-manual: UserManual.txt not found — checked resourcesPath and app dir');
    return { ok: false, error: 'UserManual.txt not found' };
  }
  try {
    const { shell } = require('electron');
    shell.openPath(manualPath);
    logWrite('Opened user manual: ' + manualPath);
    return { ok: true };
  } catch(err) {
    logWrite('open-user-manual error: ' + err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('open-path', function(e, dirPath) {
  try {
    const { shell } = require('electron');
    shell.openPath(dirPath);
    logWrite('Opened path: ' + dirPath);
    return { ok: true };
  } catch(err) {
    logWrite('open-path error: ' + err.message);
    return { ok: false, error: err.message };
  }
});

// ════════════════════════════════════════════════════════════════════
// JAVA BRIDGE PROCESS
// ElevenRackBridge.jar handles ALL MIDI transport (CC/PC/SysEx, both
// directions) over ws://localhost:57121. The renderer connects to that
// WebSocket directly — main.js's only job here is to find a JRE, launch
// the jar as a child process, log its output, and clean it up on quit.
// ════════════════════════════════════════════════════════════════════
let mainWindow    = null;
let bridgeProc    = null;
let bridgeJarPath = null;
let bridgeStatus  = { launched: false, error: null, jarPath: null };

// Minimum Java major version (2026-09-05, real hardware testing — see
// Tech Ref ENVIRONMENT / Change Log 2026-09-05). JRE 8 and JRE 21 both
// freeze the app solid on real hardware (100% CPU, no crash, no log
// output); JRE 25/26 confirmed working. Root cause not identified — this
// is an empirical floor, not a known API dependency.
const MIN_JAVA_MAJOR_VERSION = 25;

// Parses `java -version`'s stderr output for the major version number.
// Handles both the pre-Java-9 scheme ("1.8.0_311" -> major 8) and the
// current scheme ("21.0.1" or "25" -> major 21 / 25).
function parseJavaMajorVersion(versionOutput) {
  const m = /version "([^"]+)"/.exec(versionOutput || '');
  if (!m) return null;
  const v = m[1];
  const major = v.startsWith('1.') ? parseInt(v.split('.')[1], 10) : parseInt(v.split('.')[0], 10);
  return Number.isNaN(major) ? null : major;
}

function findBridgeJar() {
  // Packaged build: jar sits next to the exe as an extraResource.
  // Dev (npm start): jar sits alongside main.js.
  const candidates = [
    path.join(process.resourcesPath || '', 'ElevenRackBridge.jar'),
    path.join(__dirname, 'ElevenRackBridge.jar'),
  ];
  logWrite('Bridge: locating jar — resourcesPath=' + (process.resourcesPath || '(none)') + ' __dirname=' + __dirname);
  for (const p of candidates) {
    let exists = false;
    try { exists = !!(p && fs.existsSync(p)); } catch (e) {}
    logWrite('Bridge: jar candidate "' + p + '" exists=' + exists);
    if (exists) return p;
  }
  return null;
}

function killOrphanedBridgeProcesses(cb) {
  // If a previous session's bridge process didn't get cleaned up (e.g. the
  // app was force-closed rather than quit normally), it'll still be sitting
  // on the Eleven Rack's MIDI ports and this run will find nothing available.
  // Hunt down anything running ElevenRackBridge.jar specifically (never a
  // blanket "kill all java.exe" — this machine may run other Java stuff)
  // and force-kill it before we try to launch our own copy.
  const psCmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
    'Where-Object { $_.CommandLine -like \'*ElevenRackBridge.jar*\' } | ' +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"';
  exec(psCmd, function(err) {
    if (err) logWrite('Orphan-bridge cleanup: nothing to clean up (or check failed: ' + err.message + ')');
    else logWrite('Orphan-bridge cleanup: checked for and cleared any stray ElevenRackBridge.jar process');
    cb();
  });
}

function launchBridge() {
  killOrphanedBridgeProcesses(checkJavaVersionThenLaunch);
}

// Runs `java -version` before ever spawning the bridge jar. If java itself
// can't be found here, that's the EXISTING ENOENT path's job — just proceed
// to doLaunchBridge as before and let that failure surface normally (the
// Java-missing startup gate, ui.js). Only a java THAT WAS FOUND but is
// below MIN_JAVA_MAJOR_VERSION gets a distinct block here, before the
// bridge ever launches — launching an under-version JRE is what actually
// freezes the app, so this has to happen BEFORE spawn, not after.
function checkJavaVersionThenLaunch() {
  execFile('java', ['-version'], function(err, stdout, stderr) {
    if (err) {
      // No java on PATH (or some other execution failure) — let the normal
      // spawn ENOENT path in doLaunchBridge handle and report it, unchanged.
      doLaunchBridge();
      return;
    }
    const major = parseJavaMajorVersion(stderr || stdout);
    bridgeStatus.javaVersion = major;
    if (major !== null && major < MIN_JAVA_MAJOR_VERSION) {
      bridgeStatus.launched = false;
      bridgeStatus.error = 'Java version ' + major + ' detected — requires ' + MIN_JAVA_MAJOR_VERSION + '+';
      logWrite('Bridge: detected Java major version ' + major +
        ' — below required ' + MIN_JAVA_MAJOR_VERSION + ' — blocking launch (known to freeze on hardware)');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bridge-status', bridgeStatus);
      }
      return; // never spawn the bridge on a known-bad JRE
    }
    logWrite('Bridge: detected Java major version ' + (major === null ? '(unparseable)' : major) + ' — OK');
    doLaunchBridge();
  });
}

function doLaunchBridge() {
  bridgeJarPath = findBridgeJar();
  bridgeStatus.jarPath = bridgeJarPath;

  if (!bridgeJarPath) {
    bridgeStatus.error = 'ElevenRackBridge.jar not found';
    logWrite('Bridge: ' + bridgeStatus.error + ' — checked resourcesPath and app dir');
    return;
  }

  try {
    logWrite('Bridge: launching ' + bridgeJarPath);
    bridgeProc = spawn('java', ['-jar', bridgeJarPath], {
      cwd: path.dirname(bridgeJarPath),
      windowsHide: true,
    });

    bridgeStatus.launched = true;
    bridgeStatus.error = null;

    bridgeProc.stdout.on('data', function(d) {
      logWrite('[bridge] ' + d.toString().trim());
    });
    bridgeProc.stderr.on('data', function(d) {
      logWrite('[bridge:err] ' + d.toString().trim());
    });
    bridgeProc.on('error', function(e) {
      bridgeStatus.launched = false;
      bridgeStatus.error = e.message;
      logWrite('Bridge process error: ' + e.message + ' — is a JRE installed and on PATH?');
      // 2026-09-05: a failed spawn (e.g. ENOENT — no java on PATH) still
      // hands back a ChildProcess object even though no real OS process
      // exists behind it. Left as-is, killBridge() would see a non-null
      // bridgeProc, try a graceful stdin shutdown that silently fails, and
      // sit through its full 2.5s force-kill timeout before Quit actually
      // closed the app — confirmed live: Charlie had to click Quit 2-3
      // times on the Java-missing gate before anything visibly happened.
      // Nulling it here means any Quit/killBridge call after this point
      // hits killBridge's existing fast path (`if (!bridgeProc) callback()`)
      // immediately instead of waiting out a timeout for a process that
      // was never really there.
      bridgeProc = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bridge-status', bridgeStatus);
      }
    });
    bridgeProc.on('exit', function(code, signal) {
      logWrite('Bridge process exited — code=' + code + ' signal=' + signal);
      bridgeProc = null;
      bridgeStatus.launched = false;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bridge-status', bridgeStatus);
      }
    });
  } catch(e) {
    bridgeStatus.launched = false;
    bridgeStatus.error = e.message;
    logWrite('Bridge launch failed: ' + e.message);
  }
}

function killBridge(callback) {
  if (!bridgeProc) { if (callback) callback(); return; }
  const proc = bridgeProc;
  const pid = proc.pid;
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    if (bridgeProc === proc) bridgeProc = null;
    if (callback) callback();
  }

  proc.once('exit', function() {
    logWrite('Bridge: exited (graceful shutdown succeeded)');
    finish();
  });

  try {
    proc.stdin.write('SHUTDOWN\n');
    logWrite('Bridge: requested graceful shutdown via stdin');
  } catch(e) {
    logWrite('Bridge: could not write to stdin (' + e.message + ') — will force-kill instead');
  }

  // Fallback only — if the bridge hasn't exited gracefully within 2.5s
  // (stdin write failed, bridge is an old jar without the shutdown
  // listener, or it's genuinely wedged), force it the old way.
  setTimeout(function() {
    if (done) return;
    logWrite('Bridge: graceful shutdown did not complete in time — forcing');
    try { proc.kill(); } catch(e) {}
    if (pid) {
      try { exec('taskkill /PID ' + pid + ' /F /T'); } catch(e) {}
    }
    finish();
  }, 2500);
}

ipcMain.handle('get-bridge-status', function() { return bridgeStatus; });
ipcMain.handle('quit-app', function() { app.quit(); });
ipcMain.handle('restart-bridge', function() {
  return new Promise(function(resolve) {
    killBridge(function() {
      setTimeout(function() { launchBridge(); resolve(true); }, 300);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// AUDIO ENGINE (v2.0.0) — audio-helper.js child process
// The helper does ASIO duplex passthrough via `audify`. It is SPAWNED on
// engine ON and KILLED on engine OFF — killing fully releases the ASIO
// device so a DAW can grab it. Mirrors the Java-bridge lifecycle above.
//
// The helper runs under Electron's own Node (process.execPath +
// ELECTRON_RUN_AS_NODE=1), so end users need no separate Node install. Its
// audify native module is a prebuilt N-API binary, ABI-stable across Node
// and Electron.
// ════════════════════════════════════════════════════════════════════
let audioProc   = null;
let audioStatus = { running: false, error: null, deviceId: null };

function findAudioHelper() {
  // Packaged with asar: main.js lives inside app.asar, but audio-helper.js is
  // asarUnpack'd to the sibling app.asar.unpacked (a real file the spawned
  // Node can read). Dev (npm start): it's just alongside main.js.
  const direct = path.join(__dirname, 'audio-helper.js');
  const unpacked = direct.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const candidates = (unpacked !== direct) ? [unpacked, direct] : [direct];
  logWrite('Audio: locating helper — __dirname=' + __dirname);
  for (const p of candidates) {
    let exists = false;
    try { exists = !!(p && fs.existsSync(p)); } catch (e) {}
    logWrite('Audio: helper candidate "' + p + '" exists=' + exists);
    if (exists) return p;
  }
  return direct;
}

function sendAudioCmd(obj) {
  if (audioProc && audioProc.stdin && audioProc.stdin.writable) {
    try { audioProc.stdin.write(JSON.stringify(obj) + '\n'); return true; }
    catch (e) { logWrite('Audio: stdin write failed — ' + e.message); }
  }
  return false;
}

function spawnAudioHelper() {
  if (audioProc) return; // already running
  const helperPath = findAudioHelper();
  try {
    logWrite('Audio: launching helper ' + helperPath);
    audioProc = spawn(process.execPath, [helperPath], {
      cwd: path.dirname(helperPath),
      windowsHide: true,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    audioStatus.running = false;
    audioStatus.error = e.message;
    logWrite('Audio: helper spawn failed — ' + e.message);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-status', audioStatus);
    return;
  }

  // Parse newline-delimited JSON events from the helper's stdout.
  let outBuf = '';
  audioProc.stdout.on('data', function (d) {
    outBuf += d.toString();
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, idx).trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      handleAudioEvent(msg);
    }
  });
  audioProc.stderr.on('data', function (d) {
    logWrite('[audio:err] ' + d.toString().trim());
  });
  audioProc.on('error', function (e) {
    audioStatus.running = false;
    audioStatus.error = e.message;
    logWrite('Audio: helper process error — ' + e.message);
    audioProc = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-status', audioStatus);
  });
  audioProc.on('exit', function (code, signal) {
    logWrite('Audio: helper exited — code=' + code + ' signal=' + signal);
    audioProc = null;
    audioStatus.running = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-status', audioStatus);
  });
}

function handleAudioEvent(msg) {
  switch (msg.type) {
    case 'ready':
      // Helper is up; nothing to do — the start command is sent by audio-start.
      break;
    case 'started':
      audioStatus.running = true;
      audioStatus.error = null;
      audioStatus.deviceId = msg.deviceId;
      audioStatus.rate = msg.rate;
      audioStatus.frames = msg.frames;             // ACTUAL granted buffer (may differ from requested)
      audioStatus.requestedFrames = msg.requestedFrames;
      audioStatus.mode = msg.mode;
      logWrite('Audio: engine started (device ' + msg.deviceId + ', ' + msg.rate + 'Hz, ' +
        msg.frames + ' frames' + (msg.requestedFrames && msg.requestedFrames !== msg.frames ?
        ' [driver snapped from ' + msg.requestedFrames + ']' : '') + ', ' + msg.mode + ')');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-status', audioStatus);
      break;
    case 'stopped':
      audioStatus.running = false;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-status', audioStatus);
      break;
    case 'level':
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-level', msg.in);
      break;
    case 'devices':
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-devices', msg.devices);
      // If the helper was spawned only to enumerate (engine not running),
      // shut it back down so it isn't left idling.
      if (!audioStatus.running) killAudioHelper();
      break;
    case 'error':
      audioStatus.error = msg.message;
      logWrite('Audio: helper error — ' + msg.message);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audio-status', audioStatus);
      break;
    default: break;
  }
}

function killAudioHelper(callback) {
  if (!audioProc) { if (callback) callback(); return; }
  const proc = audioProc;
  audioProc = null;
  audioStatus.running = false;
  try { proc.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n'); } catch (e) {}
  // Give it a beat to release the ASIO device, then terminate the process.
  setTimeout(function () {
    try { proc.kill(); } catch (e) {}
    if (callback) callback();
  }, 200);
}

// engine ON: spawn helper (if needed) and start passthrough on the device.
ipcMain.handle('audio-start', function (e, opts) {
  spawnAudioHelper();
  sendAudioCmd(Object.assign({ cmd: 'start' }, opts || {}));
  return true;
});
// engine OFF: fully release the device by killing the helper.
ipcMain.handle('audio-stop', function () {
  killAudioHelper();
  return true;
});
ipcMain.handle('audio-set-gain', function (e, gains) {
  sendAudioCmd(Object.assign({ cmd: 'setGain' }, gains || {}));
  return true;
});
ipcMain.handle('audio-set-mute', function (e, m) {
  sendAudioCmd({ cmd: 'setMute', muted: !!(m && m.muted) });
  return true;
});
ipcMain.handle('audio-list-devices', function () {
  spawnAudioHelper();
  sendAudioCmd({ cmd: 'list' });
  return true;
});
ipcMain.handle('get-audio-status', function () { return audioStatus; });

// Audio settings persistence (device + levels + engine-on preference).
ipcMain.handle('get-audio-settings', function () { return storeGet('audioSettings', null); });
ipcMain.handle('save-audio-settings', function (e, s) { storeSet('audioSettings', s); return true; });

// ════════════════════════════════════════════════════════════════════
// PROCESS WATCHDOG — Mode 3 style
// ════════════════════════════════════════════════════════════════════
let watchdogInterval   = null;
let watchdog3LastState = null;

function isAvidEditorRunning(callback) {
  exec('tasklist /FI "IMAGENAME eq ElevenRackEditor.exe" /NH', function(err, stdout) {
    if (err) { callback(false); return; }
    callback(stdout.toLowerCase().includes('elevenrackeditor.exe'));
  });
}

function startWatchdog(mode) {
  stopWatchdog();
  watchdog3LastState = null;
  watchdogInterval = setInterval(function() {
    if (!mainWindow) return;
    isAvidEditorRunning(function(running) {
      if (watchdog3LastState === null) { watchdog3LastState = running; return; }
      if (running === watchdog3LastState) return;
      watchdog3LastState = running;
      logWrite('Avid editor: ' + (running ? 'OPENED' : 'CLOSED'));
      mainWindow.webContents.send('watchdog-alert', {
        mode: 3, running: running,
        message: running
          ? 'Avid Eleven Rack Editor is now open.\n\nBoth it and this app talk to the same Eleven Rack USB ports. This app no longer needs the editor open for readback — if you notice stalled or conflicting behavior, close one of the two.'
          : 'Avid Eleven Rack Editor has closed.\n\nNo effect on this app — the Java bridge owns the Eleven Rack ports directly, independent of the editor.'
      });
    });
  }, 4000);
}

function stopWatchdog() {
  if (watchdogInterval) { clearInterval(watchdogInterval); watchdogInterval = null; }
  watchdog3LastState = null;
}

// ════════════════════════════════════════════════════════════════════
// IPC HANDLERS
// ════════════════════════════════════════════════════════════════════
ipcMain.handle('check-avid-editor', function() {
  return new Promise(function(resolve) { isAvidEditorRunning(resolve); });
});
ipcMain.handle('start-watchdog',  function(e, mode) { startWatchdog(mode); return true; });
ipcMain.handle('stop-watchdog',   function()        { stopWatchdog(); return true; });
ipcMain.handle('get-saved-mode',  function()        { return storeGet('selectedMode', null); });
ipcMain.handle('save-mode',       function(e, mode) { storeSet('selectedMode', mode); return true; });
ipcMain.handle('get-saved-ports', function()        { return storeGet('ports', { inIndex: null, inName: null, outIndex: null, outName: null }); });
ipcMain.handle('save-ports',      function(e, ports){ storeSet('ports', ports); return true; });
ipcMain.handle('get-bank-cache',  function()        { return storeGet('bankCache', {}); });
ipcMain.handle('save-bank-cache', function(e, cache){ storeSet('bankCache', cache); return true; });
// Amp Controls tone-knob reorder (2026-08-03) — per-amp-key array of paramLo,
// the order the user dragged that amp's knobs into. Empty/missing entry =
// that amp still uses AMP_TONE_PARAMS' table order.
ipcMain.handle('get-tone-knob-order',  function()        { return storeGet('toneKnobOrder', {}); });
ipcMain.handle('save-tone-knob-order', function(e, order){ storeSet('toneKnobOrder', order); return true; });
// Amp panel numeric readout visibility — global app preference, not per-patch.
// 0 = show all (default), 1 = hide tone-stack numbers, 2 = also hide Row 1
// (Gate/To Amp/Volumes) numbers.
ipcMain.handle('get-number-display-mode',  function()      { return storeGet('numberDisplayMode', 0); });
ipcMain.handle('save-number-display-mode', function(e, mode){ storeSet('numberDisplayMode', mode); return true; });
ipcMain.handle('get-zoom',        function()        { return storeGet('zoomFactor', 1.0); });
ipcMain.handle('set-zoom',        function(e, factor) {
  storeSet('zoomFactor', factor);
  if (mainWindow) mainWindow.webContents.setZoomFactor(factor);
  return true;
});

// ════════════════════════════════════════════════════════════════════
// WINDOW
// ════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════
// SPLASH — shown at launch instead of the (hidden) main window, while the
// bridge comes up and the first patch's chain/amp/knob state is pulled.
// Main window is only revealed once the renderer says it's fully painted
// (app-ready IPC below); if the rack never shows up, the splash swaps to
// the Try Again/Quit gate instead of ever revealing a dead-controls screen.
// ════════════════════════════════════════════════════════════════════
let splashWindow = null;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    // 2026-09-05: bumped from 480x300 — the Java gates' longer 3-paragraph
    // messages pushed the QUIT button down far enough to overlap the
    // absolutely-positioned version tag (#version-tag, bottom:8px). Applies
    // to every gate, not just the Java ones, so this is a global fix.
    width: 520,
    height: 380,
    resizable: false,
    frame: false,
    show: true,
    alwaysOnTop: true,
    backgroundColor: '#0e0e0e',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    }
  });
  splashWindow.loadFile('src/splash.html');
  splashWindow.on('closed', function() { splashWindow = null; });
}

ipcMain.on('splash-progress', function(e, data) {
  if (splashWindow) splashWindow.webContents.send('splash-progress', data);
});
ipcMain.on('splash-show-gate', function(e, data) {
  if (splashWindow) splashWindow.webContents.send('splash-show-gate', data);
});
ipcMain.on('splash-hide-gate', function() {
  if (splashWindow) splashWindow.webContents.send('splash-hide-gate');
});
ipcMain.on('startup-retry-click', function() {
  if (mainWindow) mainWindow.webContents.send('startup-retry-click');
});
ipcMain.on('app-ready', function() {
  // Charlie reported a "massive white flash" at exactly this swap
  // (2026-08-03) — a classic Electron/Windows DWM compositor artifact when
  // a topmost frameless window (splash) is destroyed in the SAME tick a
  // hidden window is first shown: the window manager can flicker through
  // the desktop/white background while it composites both changes at once.
  // mainWindow already has backgroundColor set (avoids the OTHER common
  // cause, an unpainted white frame), so this fix targets the swap timing
  // specifically: show the main window, give the compositor one paint
  // cycle to actually put it on screen, THEN close the splash — instead of
  // both happening back-to-back with no gap for Windows to catch up.
  if (mainWindow) mainWindow.show();
  if (splashWindow) {
    const s = splashWindow;
    setTimeout(function() { s.close(); }, 120);
    splashWindow = null;
  }
});

function createWindow() {
  const winBounds = storeGet('windowBounds', { width: 1400, height: 800 });
  const savedZoom = storeGet('zoomFactor', 1.0);

  mainWindow = new BrowserWindow({
    width:    winBounds.width,
    height:   winBounds.height,
    minWidth: 900,
    minHeight:600,
    title:    'Eleven Edit',
    icon:     path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#0e0e0e',
    autoHideMenuBar: true,
    show: false, // revealed only on 'app-ready' IPC — see SPLASH above
    webPreferences: {
      preload:              path.join(__dirname, 'preload.js'),
      contextIsolation:     true,
      nodeIntegration:      false,
      experimentalFeatures: true,
      // /T<seconds> override (see top of file) is handed to the renderer
      // as a process.argv entry preload.js reads synchronously; empty when
      // the flag wasn't passed, so the state.js defaults stand.
      additionalArguments:  startupTimeoutSec ? ['--ee-startup-timeout-sec=' + startupTimeoutSec] : [],
    }
  });
  if (startupTimeoutSec) logWrite('Startup timeout override /T' + startupTimeoutSec + ' active — connect gate + firmware check widened to ' + startupTimeoutSec + 's');

  mainWindow.loadFile('src/index.html');
  mainWindow.setMenu(null);

  // EXTERNAL LINKS -> SYSTEM DEFAULT BROWSER. Any target="_blank" link (About
  // box web/email links) must open in Windows' default browser/mail app, never
  // in an internal Electron window. Without this handler Electron would try to
  // spawn its own window for a _blank link, which is the reverted behaviour
  // Charlie reported. Deny the new window and hand http/https/mailto to the OS.
  mainWindow.webContents.setWindowOpenHandler(function(details) {
    const url = details.url || '';
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Belt-and-braces: block any in-page navigation to an external URL (the app
  // itself only ever lives at the loaded file://), routing it out the same way.
  mainWindow.webContents.on('will-navigate', function(event, url) {
    if (/^(https?|mailto):/i.test(url || '')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('did-finish-load', function() {
    mainWindow.webContents.setZoomFactor(savedZoom);
    logWrite('Window loaded');
  });

  mainWindow.webContents.on('before-input-event', function(event, input) {
    if ((input.control || input.meta) && ['=', '+', '-'].includes(input.key)) {
      event.preventDefault();
    }
  });

  mainWindow.on('close', function() {
    storeSet('windowBounds', mainWindow.getBounds());
    killAudioHelper();
    killBridge();
    stopWatchdog();
    logClose();
  });
  mainWindow.on('closed', function() { mainWindow = null; });
}

app.commandLine.appendSwitch('enable-web-midi');
app.commandLine.appendSwitch('enable-blink-features', 'MIDIGetSupportedExtensions');

app.whenReady().then(function() {
  initLog();
  launchBridge();
  createSplashWindow();
  createWindow();
});

app.on('window-all-closed', function() {
  stopWatchdog();
  killAudioHelper();
  killBridge(function() {
    logClose();
    if (process.platform !== 'darwin') app.quit();
  });
});

let isReallyQuitting = false;
app.on('before-quit', function(event) {
  if (isReallyQuitting) return; // already cleaned up — let this one through
  event.preventDefault();
  killAudioHelper();
  killBridge(function() {
    isReallyQuitting = true;
    app.quit();
  });
});
app.on('activate', function() {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
