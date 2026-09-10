#!/bin/bash
# Packaged-app smoke test (no hardware): launches the BUILT Eleven Edit.app
# the way a user does (via `open`, i.e. LaunchServices — NOT from a shell,
# which inherits the shell's file permissions and once hid a startup freeze),
# with the virtual rack running, waits for the main window to reveal, quits
# it with an Apple Event (what Cmd+Q sends) and checks the bridge exited.
#   usage: bridge-macos/tests/packaged-smoke.sh [path/to/Eleven Edit.app]
set -u
cd "$(dirname "$0")/../.."
APP="${1:-dist/mac-arm64/Eleven Edit.app}"
[ -d "$APP" ] || { echo "no app at $APP — run npm run build:mac first"; exit 1; }
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"   # open(1) needs an absolute path
OUT="${TMPDIR:-/tmp}/elevenedit-pkgsmoke"; mkdir -p "$OUT"
LOGDIR="$HOME/Library/Application Support/eleven-edit/logs"
swiftc -O -suppress-warnings bridge-macos/tests/fake-rack.swift -o "$OUT/fake-rack" || exit 1
pkill -9 -f "Eleven Edit.app/Contents" 2>/dev/null; pkill -x ElevenRackBridge 2>/dev/null; pkill -x fake-rack 2>/dev/null
for i in $(seq 1 40); do pgrep -f "Eleven Edit.app/Contents" >/dev/null || break; perl -e 'select(undef,undef,undef,0.25)'; done
"$OUT/fake-rack" > "$OUT/fake.log" 2>&1 & FAKE=$!
touch "$OUT/marker"; perl -e 'select(undef,undef,undef,0.3)'
open -n --stdout "$OUT/open.out" --stderr "$OUT/open.err" "$APP" --args --logs || exit 1
LOG=""
for i in $(seq 1 90); do
  LOG=$(find "$LOGDIR" -name 'session-*.log' -newer "$OUT/marker" | head -1)
  if [ -n "$LOG" ] && grep -q "revealing main window\|Startup gate\|Bridge gate\|treating as unverified" "$LOG"; then break; fi
  perl -e 'select(undef,undef,undef,0.5)'
done
echo "=== session log: $LOG ==="
grep -n "launching\|origin\|IN name\|OUT name\|Firmware\|Nav pull complete\|revealing\|Startup gate\|Bridge gate\|trying IN" "$LOG" | head -12
RC=1; grep -q "revealing main window" "$LOG" && RC=0
PID=$(pgrep -f "Eleven Edit.app/Contents/MacOS/Eleven Edit" | head -1)
if [ $RC -ne 0 ] && [ -n "$PID" ]; then
  echo "=== STALLED — main-thread leaf frames ==="; sample "$PID" 1 -mayDie -file "$OUT/sample.txt" >/dev/null 2>&1
  grep -m1 -A70 "com.apple.main-thread" "$OUT/sample.txt" | grep -v "???" | tail -n 8 | sed 's/^[ +!:|]*//' | cut -c1-110
fi
echo "=== quit via Apple Event (Cmd+Q path) ==="
osascript -e 'tell application id "com.wardick.rigrollerplus" to quit' 2>&1 || { echo "quit event failed"; RC=1; }
for i in $(seq 1 40); do pgrep -f "Eleven Edit.app/Contents/MacOS/Eleven Edit" >/dev/null || break; perl -e 'select(undef,undef,undef,0.25)'; done
pgrep -f "Eleven Edit.app/Contents/MacOS/Eleven Edit" >/dev/null && { echo "app still running after quit"; pkill -9 -f "Eleven Edit.app/Contents"; RC=1; } || echo "app exited on quit (ok)"
perl -e 'select(undef,undef,undef,1)'
pgrep -x ElevenRackBridge >/dev/null && { echo "bridge still running after quit"; pkill -x ElevenRackBridge; RC=1; } || echo "bridge gone after quit (ok)"
kill $FAKE 2>/dev/null
tail -n 4 "$LOG"
[ $RC -eq 0 ] && echo "PASS" || echo "FAIL"
exit $RC
