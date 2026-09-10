#!/bin/bash
# Dev-mode app smoke test (no hardware): starts the fake rack, launches
# `electron . --logs`, waits for the startup handshake to show up in the
# session log, prints the relevant lines, screenshots the splash/gate, and
# quits the app. Exit 0 if the bridge spawned, the renderer connected to it
# over WebSocket, the fake rack was auto-detected and the firmware identity
# reply came back.
set -u
cd "$(dirname "$0")/../.."
OUT="${TMPDIR:-/tmp}/elevenedit-appsmoke"; mkdir -p "$OUT"
[ -x bridge-macos/ElevenRackBridge ] || bash bridge-macos/build.sh >/dev/null || exit 1
swiftc -O -suppress-warnings bridge-macos/tests/fake-rack.swift -o "$OUT/fake-rack" || exit 1
pkill -x ElevenRackBridge 2>/dev/null; pkill -x fake-rack 2>/dev/null
"$OUT/fake-rack" > "$OUT/fake.log" 2>&1 & FAKE=$!
./node_modules/.bin/electron . --logs > "$OUT/electron.log" 2>&1 & EL=$!
LOG=""
for i in $(seq 1 120); do
  LOG=$(grep -m1 'Log file: ' "$OUT/electron.log" 2>/dev/null | sed 's/.*Log file: //')
  if [ -n "$LOG" ] && grep -q "Firmware identity reply\|Startup gate\|Bridge gate\|treating as unverified" "$LOG"; then break; fi
  perl -e 'select(undef,undef,undef,0.5)'
done
perl -e 'select(undef,undef,undef,2)'
screencapture -x "$OUT/shot.png" 2>/dev/null && echo "screenshot: $OUT/shot.png"
echo "=== session log: $LOG ==="
grep -n "Bridge\|bridge\|Port auto\|IN:\|OUT:\|Firmware\|firmware\|Startup\|Nav pull\|chain\|revealing\|origin\|Listening\|Connected OK\|Connecting IN" "$LOG" | head -60
echo "=== electron stdout/stderr (tail) ==="; tail -n 15 "$OUT/electron.log"
RC=1; grep -q "Firmware identity reply" "$LOG" && RC=0
kill $EL 2>/dev/null; kill $FAKE 2>/dev/null
for i in $(seq 1 20); do kill -0 $EL 2>/dev/null || break; perl -e 'select(undef,undef,undef,0.25)'; done
pgrep -x ElevenRackBridge >/dev/null && { echo "WARN: bridge still running after app quit"; pkill -x ElevenRackBridge; } || echo "bridge gone after app quit (ok)"
exit $RC
