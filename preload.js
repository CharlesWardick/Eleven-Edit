/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Java bridge process (ElevenRackBridge.jar) — the renderer talks MIDI
  // directly to it over ws://localhost:57121 via the browser's native
  // WebSocket; these just cover the child-process lifecycle.
  getBridgeStatus:    ()          => ipcRenderer.invoke('get-bridge-status'),
  restartBridge:      ()          => ipcRenderer.invoke('restart-bridge'),
  quitApp:            ()          => ipcRenderer.invoke('quit-app'),
  onBridgeStatus:     (cb)        => ipcRenderer.on('bridge-status', (e, data) => cb(data)),
  removeBridgeStatus: ()          => ipcRenderer.removeAllListeners('bridge-status'),

  // Avid editor watchdog
  checkAvidEditor:     ()         => ipcRenderer.invoke('check-avid-editor'),
  startWatchdog:       (mode)     => ipcRenderer.invoke('start-watchdog', mode),
  stopWatchdog:        ()         => ipcRenderer.invoke('stop-watchdog'),
  onWatchdogAlert:     (cb)       => ipcRenderer.on('watchdog-alert', (e, data) => cb(data)),
  removeWatchdogAlert: ()         => ipcRenderer.removeAllListeners('watchdog-alert'),

  // Persistence
  getSavedMode:   ()              => ipcRenderer.invoke('get-saved-mode'),
  saveMode:       (mode)          => ipcRenderer.invoke('save-mode', mode),
  getSavedPorts:  ()              => ipcRenderer.invoke('get-saved-ports'),
  savePorts:      (ports)         => ipcRenderer.invoke('save-ports', ports),
  getBankCache:   ()              => ipcRenderer.invoke('get-bank-cache'),
  saveBankCache:  (cache)         => ipcRenderer.invoke('save-bank-cache', cache),
  getToneKnobOrder:  ()           => ipcRenderer.invoke('get-tone-knob-order'),
  saveToneKnobOrder: (order)      => ipcRenderer.invoke('save-tone-knob-order', order),
  getNumberDisplayMode:  ()       => ipcRenderer.invoke('get-number-display-mode'),
  saveNumberDisplayMode: (mode)   => ipcRenderer.invoke('save-number-display-mode', mode),
  getZoom:        ()              => ipcRenderer.invoke('get-zoom'),
  setZoom:        (factor)        => ipcRenderer.invoke('set-zoom', factor),
  getStartupMode: ()              => ipcRenderer.invoke('get-startup-mode'),
  getAppVersion:  ()              => ipcRenderer.invoke('get-app-version'),
  getMidiStackStatus:          () => ipcRenderer.invoke('get-midi-stack-status'),
  setWin11UploadWarnDisabled: (v) => ipcRenderer.invoke('set-win11-upload-warn-disabled', v),
  setWin11StartupAck:          () => ipcRenderer.invoke('set-win11-startup-ack'),

  // Logging
  logWrite:       (line)          => ipcRenderer.invoke('log-write', line),
  getLogPath:     ()              => ipcRenderer.invoke('get-log-path'),
  getLogsEnabled: ()              => ipcRenderer.invoke('get-logs-enabled'),

  // TFX file operations
  saveTfx:          (name, data, opts)  => ipcRenderer.invoke('save-tfx', name, data, opts),
  getCapturesDir:   ()            => ipcRenderer.invoke('get-captures-dir'),
  loadTfxDialog:    ()            => ipcRenderer.invoke('load-tfx-dialog'),
  chooseCapturesDir:()            => ipcRenderer.invoke('choose-captures-dir'),
  resetCapturesDir: ()            => ipcRenderer.invoke('reset-captures-dir'),
  openPath:       (path)          => ipcRenderer.invoke('open-path', path),
  openUserManual: ()              => ipcRenderer.invoke('open-user-manual'),
  browseAvidDir:  ()              => ipcRenderer.invoke('browse-avid-dir'),
  getAvidDir:     ()              => ipcRenderer.invoke('get-avid-dir'),
  getLogsDir:     ()              => ipcRenderer.invoke('get-logs-dir'),
  scanAvidGraphics: (rootDir)     => ipcRenderer.invoke('scan-avid-graphics', rootDir),

  // Bank export ("Export All Rigs…", 2026-08-10)
  chooseExportDir: ()                        => ipcRenderer.invoke('choose-export-dir'),
  exportBank:      (folder, bankName, entries) => ipcRenderer.invoke('export-bank', folder, bankName, entries),

  // Bank import ("Import Rigs…", 2026-08-10) — accepts .xml or .zip
  chooseImportSource: ()          => ipcRenderer.invoke('choose-import-source'),
  readImportBank:     (sourcePath) => ipcRenderer.invoke('read-import-bank', sourcePath),

  // Splash window — main window renderer drives progress/gate state; the
  // splash window itself listens for these and relays button clicks back.
  splashProgress:      (data)       => ipcRenderer.send('splash-progress', data),
  // data is optional — {reason:'firmware', detail:'...'} for the firmware
  // mismatch gate (2026-08-28), omitted for the original "no hardware found"
  // gate so splash.html can tell the two apart.
  splashShowGate:      (data)       => ipcRenderer.send('splash-show-gate', data),
  splashHideGate:      ()           => ipcRenderer.send('splash-hide-gate'),
  onSplashProgress:    (cb)         => ipcRenderer.on('splash-progress', (e, data) => cb(data)),
  onSplashShowGate:    (cb)         => ipcRenderer.on('splash-show-gate', (e, data) => cb(data)),
  onSplashHideGate:    (cb)         => ipcRenderer.on('splash-hide-gate', () => cb()),
  sendStartupRetryClick: ()         => ipcRenderer.send('startup-retry-click'),
  onStartupRetryClick: (cb)         => ipcRenderer.on('startup-retry-click', () => cb()),
  appReady:            ()          => ipcRenderer.send('app-ready'),

  // Startup timeout override (/T<seconds>) — main.js injects this as a
  // process.argv entry; null when the flag wasn't passed. Read once here so
  // the renderer can widen the startup timers before it arms them.
  startupTimeoutSec: (function () {
    var a = process.argv.find(function (x) { return x.indexOf('--ee-startup-timeout-sec=') === 0; });
    return a ? parseInt(a.split('=')[1], 10) : null;
  })(),

  platform:   process.platform,
  isElectron: true,
});
