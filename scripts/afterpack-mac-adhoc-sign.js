/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// electron-builder afterPack hook (macOS only). There is no Apple Developer
// ID certificate behind this project, so electron-builder skips signing —
// which leaves the bundle with Electron's ORIGINAL ad-hoc seal, now stale
// because Resources/ changed. A downloaded app with a stale (invalid) seal is
// reported by Gatekeeper as "damaged and can't be opened", and right-click ->
// Open does NOT get past that. A consistent ad-hoc signature over the whole
// bundle instead gets the ordinary "unidentified developer" prompt, which
// right-click -> Open (or Privacy & Security -> Open Anyway) does clear.
// A real Developer ID (mac.identity / CSC_LINK) makes this hook a no-op.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  try {
    const signed = execFileSync('codesign', ['-dv', appPath], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
      + execFileSync('codesign', ['-dv', appPath], { stdio: ['ignore', 'ignore', 'pipe'] }).toString();
    if (/Authority=Developer ID/.test(signed)) return; // properly signed — leave it alone
  } catch (e) { /* unsigned or unreadable: fall through and ad-hoc sign */ }
  console.log('  • ad-hoc signing (no Developer ID available)  app=' + appPath);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
