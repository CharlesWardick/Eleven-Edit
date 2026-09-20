/*
 * Build-number bumper. Auto-increments package.json "buildNumber" on every
 * packaged build, and keeps build.buildVersion in sync as the Windows-native
 * 4-part version (Major.Minor.Patch.Build) that electron-builder embeds as the
 * exe's File version. So one number, bumped here, drives everything:
 *   - the window title bar + About box  (main.js get-build-info -> renderer)
 *   - the session-log banner            (main.js)
 *   - Windows Properties -> File version (build.buildVersion, this file)
 * The installer FILENAME stays clean ("Eleven Edit Setup <version>.exe") — the
 * build number lives inside the binary + the app, not the public filename.
 *
 * Runs automatically before `npm run build` via the "prebuild" hook — NOT on
 * `npm start`, so only real packaged builds tick the counter. Manual bumps are
 * still possible by editing buildNumber directly (this just does +1 each build).
 */
'use strict';
var fs = require('fs');
var path = require('path');

var pkgPath = path.join(__dirname, '..', 'package.json');
var pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

var next = (parseInt(pkg.buildNumber, 10) || 0) + 1;
pkg.buildNumber = next;
pkg.build = pkg.build || {};
pkg.build.buildVersion = pkg.version + '.' + next;

// Preserve 2-space indent + trailing newline (matches the file on disk).
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log('[bump-build] ' + pkg.name + ' v' + pkg.version +
  ' -> build ' + next + '  (File version ' + pkg.build.buildVersion + ')');
