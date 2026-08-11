const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { exec, spawn } = require('child_process');

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
    const xml =
      '<?xml version="1.0"?>\n' +
      '<eleven>\n' +
      '    <hardware type_="string">"Eleven Rack"</hardware>\n' +
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
        const fpath = path.join(folder, filename);
        return fs.existsSync(fpath) ? fs.readFileSync(fpath) : null;
      };
    }

    const parsed = parseBankXml(xmlText);
    if (!parsed.length) {
      return { ok: false, error: 'No <patch> entries found in this XML — is it a bank export file?' };
    }

    const valid = [];
    const problems = [];
    for (const p of parsed) {
      const raw = lookupBody(p.filename);
      if (raw === null) { problems.push({ bank: p.bank, filename: p.filename, reason: 'file not found' }); continue; }
      const body = validTfxBody(raw);
      if (!body) { problems.push({ bank: p.bank, filename: p.filename, reason: 'not a valid TFX file' }); continue; }
      valid.push({ bank: p.bank, filename: p.filename, body: Array.from(body) });
    }

    logWrite('Import bank read: ' + valid.length + ' valid, ' + problems.length + ' problem(s) from ' + sourcePath);
    return { ok: true, valid: valid, problems: problems };
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

    const body = Array.from(raw.slice(56));
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

function findBridgeJar() {
  // Packaged build: jar sits next to the exe as an extraResource.
  // Dev (npm start): jar sits alongside main.js.
  const candidates = [
    path.join(process.resourcesPath || '', 'ElevenRackBridge.jar'),
    path.join(__dirname, 'ElevenRackBridge.jar'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
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
  killOrphanedBridgeProcesses(doLaunchBridge);
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
    width: 480,
    height: 300,
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
ipcMain.on('splash-show-gate', function() {
  if (splashWindow) splashWindow.webContents.send('splash-show-gate');
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
    }
  });

  mainWindow.loadFile('src/index.html');
  mainWindow.setMenu(null);

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
  killBridge(function() {
    logClose();
    if (process.platform !== 'darwin') app.quit();
  });
});

let isReallyQuitting = false;
app.on('before-quit', function(event) {
  if (isReallyQuitting) return; // already cleaned up — let this one through
  event.preventDefault();
  killBridge(function() {
    isReallyQuitting = true;
    app.quit();
  });
});
app.on('activate', function() {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
