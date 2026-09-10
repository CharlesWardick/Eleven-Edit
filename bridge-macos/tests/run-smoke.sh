#!/bin/bash
# Builds the bridge + fake rack, runs the WebSocket smoke test, cleans up.
set -u
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/elevenedit-smoke"; mkdir -p "$OUT"
( cd .. && ./build.sh >/dev/null ) || { echo "bridge build failed"; exit 1; }
swiftc -O -suppress-warnings fake-rack.swift -o "$OUT/fake-rack" || exit 1
pkill -x ElevenRackBridge 2>/dev/null; pkill -x fake-rack 2>/dev/null
"$OUT/fake-rack" > "$OUT/fake.log" 2>&1 & FAKE=$!
# The bridge exits on stdin EOF (by design) — keep a pipe open to it.
mkfifo "$OUT/stdin.fifo" 2>/dev/null
exec 3<>"$OUT/stdin.fifo"
../ElevenRackBridge < "$OUT/stdin.fifo" > "$OUT/bridge.log" 2>&1 & BRIDGE=$!
node ws-smoke.mjs; RC=$?
echo "--- graceful SHUTDOWN via stdin ---"
echo SHUTDOWN >&3
for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 $BRIDGE 2>/dev/null || break; perl -e 'select(undef,undef,undef,0.2)'; done
kill -0 $BRIDGE 2>/dev/null && { echo "bridge did NOT exit on SHUTDOWN"; kill -9 $BRIDGE; RC=1; } || echo "bridge exited on SHUTDOWN (ok)"
kill $FAKE 2>/dev/null; exec 3>&-; rm -f "$OUT/stdin.fifo"
echo "--- bridge.log (tail) ---"; tail -n 25 "$OUT/bridge.log"
echo "--- fake.log (tail) ---"; tail -n 12 "$OUT/fake.log"
exit $RC
