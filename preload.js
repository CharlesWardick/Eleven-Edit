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
  getZoom:        ()              => ipcRenderer.invoke('get-zoom'),
  setZoom:        (factor)        => ipcRenderer.invoke('set-zoom', factor),
  getStartupMode: ()              => ipcRenderer.invoke('get-startup-mode'),

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
  browseAvidDir:  ()              => ipcRenderer.invoke('browse-avid-dir'),
  getAvidDir:     ()              => ipcRenderer.invoke('get-avid-dir'),
  getLogsDir:     ()              => ipcRenderer.invoke('get-logs-dir'),
  scanAvidGraphics: (rootDir)     => ipcRenderer.invoke('scan-avid-graphics', rootDir),

  // Bank export ("Export All Rigs…", 2026-08-10)
  chooseExportDir: ()                        => ipcRenderer.invoke('choose-export-dir'),
  exportBank:      (folder, bankName, entries) => ipcRenderer.invoke('export-bank', folder, bankName, entries),

  // Splash window — main window renderer drives progress/gate state; the
  // splash window itself listens for these and relays button clicks back.
  splashProgress:      (data)       => ipcRenderer.send('splash-progress', data),
  splashShowGate:      ()           => ipcRenderer.send('splash-show-gate'),
  splashHideGate:      ()           => ipcRenderer.send('splash-hide-gate'),
  onSplashProgress:    (cb)         => ipcRenderer.on('splash-progress', (e, data) => cb(data)),
  onSplashShowGate:    (cb)         => ipcRenderer.on('splash-show-gate', () => cb()),
  onSplashHideGate:    (cb)         => ipcRenderer.on('splash-hide-gate', () => cb()),
  sendStartupRetryClick: ()         => ipcRenderer.send('startup-retry-click'),
  onStartupRetryClick: (cb)         => ipcRenderer.on('startup-retry-click', () => cb()),
  appReady:            ()          => ipcRenderer.send('app-ready'),

  platform:   process.platform,
  isElectron: true,
});
