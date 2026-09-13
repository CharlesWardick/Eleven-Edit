/*
 * Pre-build gate: refuse to build unless the git-ignored, locally-managed build
 * assets are present in the project root. electron-builder only WARNS (doesn't
 * fail) when an extraResources file is missing, so without this check a build
 * would silently ship an installer that's missing a critical piece:
 *   - ElevenRackBridge.jar  → no MIDI bridge ("rack not found")
 *   - vc_redist.x64.exe      → built-in audio engine crashes on machines that
 *                              lack the Microsoft VC++ runtime
 * Runs automatically before `npm run build` via the "prebuild" script hook.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var assets = [
  { file: 'ElevenRackBridge.jar',
    note: 'the Java MIDI bridge (build it / copy it in as you have been)' },
  { file: 'vc_redist.x64.exe',
    note: 'Microsoft Visual C++ 2015-2022 Redistributable (x64), from Microsoft' },
];

var missing = assets.filter(function (a) { return !fs.existsSync(path.join(root, a.file)); });

if (missing.length) {
  console.error('\n  BUILD STOPPED — required build asset(s) missing from the project root:\n');
  missing.forEach(function (a) {
    console.error('    * ' + a.file + '  — ' + a.note);
  });
  console.error('\n  These are git-ignored and kept locally. Put the file(s) next to package.json,');
  console.error('  then run the build again. (electron-builder would otherwise build "successfully"');
  console.error('  but silently omit them from the installer.)\n');
  process.exit(1);
}

console.log('check-build-assets: ' + assets.map(function (a) { return a.file; }).join(' + ') + ' present — OK');
