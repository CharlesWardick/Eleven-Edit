const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { exec, spawn } = require('child_process');

// ════════════════════════════════════════════════════════════════════
// SINGLE INSTANCE LOCK
// ════════════════════════════════════════════════════════════════════
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

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
    logWrite('=== RigRollerPlus Session Start ' + now.toLocaleString() + ' ===');
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
    logWrite('=== RigRollerPlus Session End ===');
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
ipcMain.handle('get-zoom',        function()        { return storeGet('zoomFactor', 1.0); });
ipcMain.handle('set-zoom',        function(e, factor) {
  storeSet('zoomFactor', factor);
  if (mainWindow) mainWindow.webContents.setZoomFactor(factor);
  return true;
});

// ════════════════════════════════════════════════════════════════════
// WINDOW
// ════════════════════════════════════════════════════════════════════
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
