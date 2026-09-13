/*
 * Pre-build gate: refuse to build unless the bundled Microsoft VC++
 * redistributable is present. electron-builder only WARNS (doesn't fail) when
 * an extraResources file is missing, so without this check a build would
 * silently ship an installer with no redist — and the built-in audio engine
 * would then crash on any machine lacking the VC++ runtime. Runs automatically
 * before `npm run build` via the "prebuild" script hook.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var file = path.join(__dirname, '..', 'vc_redist.x64.exe');

if (!fs.existsSync(file)) {
  console.error('\n  BUILD STOPPED — vc_redist.x64.exe is missing.\n');
  console.error('  The installer bundles the Microsoft Visual C++ 2015-2022');
  console.error('  Redistributable (x64) so the built-in audio engine works on');
  console.error('  fresh machines. Download "vc_redist.x64.exe" from Microsoft and');
  console.error('  put it in the project root (next to package.json), the same spot');
  console.error('  as ElevenRackBridge.jar, then run the build again.\n');
  console.error('  Expected at: ' + file + '\n');
  process.exit(1);
}

var kb = Math.round(fs.statSync(file).size / 1024);
console.log('check-redist: vc_redist.x64.exe present (' + kb + ' KB) — OK');
