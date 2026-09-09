#!/usr/bin/env python3
"""
parse_capture.py — Eleven Rack SysEx extractor for Wireshark/USBPcap captures.

WHY THIS EXISTS
  Every capture-analysis session was re-deriving the same pcapng + USB-MIDI
  reassembly from scratch and re-hitting the same framing trap. This is the
  canonical, correct reader. Reach for it FIRST before writing a new parser,
  and EXTEND it (don't fork it) when you need to decode a new command.

WHAT IT DOES
  Reads a .pcapng, pulls the USB-MIDI event stream out of every packet, and
  reassembles clean application-level SysEx exactly as the Java bridge presents
  it: F0 13 0B 0F [dir] [cmd] ... F7  — with the USB-MIDI CIN framing bytes
  (0x04/0x05/0x06/0x07) STRIPPED. See Tech Ref Sec 2 "USB-MIDI FRAMING".

  A naive `find(F0..F7)` scan of the raw bytes is WRONG: it leaves the CIN
  bytes embedded (you get the tell-tale spurious 0x04 after `13 0B`, and phantom
  param bytes mid-message). This tool does real 4-byte-group CIN reassembly, and
  it does it ACROSS packets, so a message split over more than one USB transfer
  (large TFX/bulk dumps) is reassembled whole rather than dropped.

USAGE
  python3 tools/parse_capture.py CAP.pcapng                 # summary by [dir cmd]
  python3 tools/parse_capture.py CAP.pcapng --cmd 0x42      # dump one command
  python3 tools/parse_capture.py CAP.pcapng --tuner         # decode tuner
  python3 tools/parse_capture.py CAP.pcapng --raw           # every message, hex
  python3 tools/parse_capture.py CAP.pcapng --diff CAP2.pcapng   # compare two caps
  Add --with-ts to prefix timestamps (seconds from capture start).

  --diff is the workhorse for the "load on X, step through settings, find the one
  thing that changed" workflow: it prints the messages unique to each capture and
  those whose counts differ — e.g. an input-selector capture on Guitar vs Mic
  surfaces exactly `12 3d 00` vs `12 3d 02`. Add --by-cmd to collapse the diff to
  [dir cmd] groups instead of full message bytes.

NOTES
  - Only Enhanced Packet Blocks (0x06) are read; timestamps assume microsecond
    resolution (the default). Good enough for rate estimates.
  - The USB payload is located via the USBPcap pseudo-header length field, so the
    MIDI region is found exactly (not guessed), which is what makes cross-packet
    reassembly reliable.
  - KNOWN LIMITATION: only SysEx (F0..F7) is extracted. Channel-voice messages
    (CC/PC/note — e.g. tap-tempo CC64, PC nav) are NOT surfaced. Everything this
    project's Avid editor drives for globals/params is 13 0B 0F SysEx, so this has
    not mattered yet; add a channel-voice path here if a future capture needs it.
"""
import struct, sys, argparse
from collections import Counter

def u16(b, o): return struct.unpack('<H', b[o:o+2])[0]
def u32(b, o): return struct.unpack('<I', b[o:o+4])[0]

def read_records(path):
    """Yield (ts, usbpcap_record_bytes) for each Enhanced Packet Block."""
    f = open(path, 'rb').read()
    off = 0
    while off + 12 <= len(f):
        btype = u32(f, off); blen = u32(f, off+4)
        if blen < 12 or off + blen > len(f): break
        if btype == 0x06:
            th = u32(f, off+12); tl = u32(f, off+16)
            ts = (th << 32) | tl
            caplen = u32(f, off+20)
            yield ts, f[off+28:off+28+caplen]
        off += blen

# USB-MIDI CIN -> number of valid MIDI bytes in the 3-byte payload of the group
CIN_LEN = {0x2:2,0x3:3,0x4:3,0x5:1,0x6:2,0x7:3,0x8:3,0x9:3,0xA:3,0xB:3,0xC:2,0xD:1,0xE:3,0xF:1}

def record_midi(rec):
    """Reassemble the clean MIDI bytes carried in one USBPcap record.

    The USB data payload starts after the USBPcap pseudo-header, whose length is
    the uint16 at offset 0. From there the payload is contiguous 4-byte USB-MIDI
    event groups; we strip the leading CIN byte of each and keep the real MIDI
    bytes. Returns b'' for records that carry no USB-MIDI groups.
    """
    if len(rec) < 2: return b''
    hlen = u16(rec, 0)
    if hlen < 27 or hlen > len(rec): return b''
    payload = rec[hlen:]
    out = bytearray()
    i = 0
    while i + 4 <= len(payload):
        cin = payload[i] & 0x0F
        n = CIN_LEN.get(cin, 0)
        if n == 0:
            # not a MIDI group (padding / non-MIDI transfer) — stop this record
            break
        out += payload[i+1:i+1+n]
        i += 4
    return bytes(out)

def clean_sysex(path):
    """Yield (ts_seconds, bytes) per F0..F7 message, CIN-stripped, cross-packet.

    MIDI bytes are concatenated across records (with the timestamp of the record
    each byte arrived in) so a SysEx spanning multiple USB transfers reassembles
    whole. Each yielded message is tagged with the timestamp of its final byte.
    """
    t0 = None
    buf = bytearray()   # pending MIDI bytes not yet closed into a message
    btime = []          # parallel per-byte timestamps (seconds from start)
    for ts, rec in read_records(path):
        if t0 is None: t0 = ts
        midi = record_midi(rec)
        if not midi: continue
        rel = (ts - t0) / 1e6
        buf.extend(midi)
        btime.extend([rel] * len(midi))
        # extract every complete F0..F7 span currently in the buffer
        while True:
            j = buf.find(0xF0)
            if j < 0:
                del buf[:]; del btime[:]; break
            k = buf.find(0xF7, j)
            if k < 0:
                # keep from the open F0 onward; drop anything before it
                del buf[:j]; del btime[:j]; break
            yield btime[k], bytes(buf[j:k+1])
            del buf[:k+1]; del btime[:k+1]

NOTE = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']

def cmd_key(b):
    # F0 13 0B 0F [dir] [cmd] ...  -> "dir cmd" if it matches, else prefix
    if len(b) >= 6 and b[1]==0x13 and b[2]==0x0B and b[3]==0x0F:
        return f"{b[4]:02x} {b[5]:02x}"
    return b.hex()[:12]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('capture')
    ap.add_argument('--cmd', help='hex cmd byte, e.g. 0x42 — dump matching messages')
    ap.add_argument('--tuner', action='store_true', help='decode CMD 0x42 note/tune + 0x41 needle')
    ap.add_argument('--raw', action='store_true', help='dump every clean message as hex')
    ap.add_argument('--diff', metavar='CAPTURE2', help='compare against a second capture')
    ap.add_argument('--by-cmd', action='store_true', help='with --diff: group by [dir cmd] not full bytes')
    ap.add_argument('--with-ts', action='store_true')
    a = ap.parse_args()

    # BrokenPipe guard so `... | head` doesn't dump a traceback
    try:
        run(a)
    except BrokenPipeError:
        try: sys.stdout.close()
        except Exception: pass

def run(a):
    msgs = list(clean_sysex(a.capture))

    if a.diff:
        diff_caps(a.capture, a.diff, by_cmd=a.by_cmd); return
    if a.tuner:
        decode_tuner(msgs); return
    if a.raw:
        for ts, b in msgs:
            print(f"{ts:8.3f}  {b.hex()}" if a.with_ts else b.hex())
        return
    if a.cmd:
        cc = int(a.cmd, 16)
        sel = [(ts,b) for ts,b in msgs if len(b)>=6 and b[5]==cc and b[3]==0x0F]
        print(f"CMD 0x{cc:02x}: {len(sel)} messages")
        for h,c in Counter(b.hex() for _,b in sel).most_common(40):
            print(f"  {c:5d}  {h}")
        return
    # default: summary by [dir cmd]
    print(f"{len(msgs)} clean SysEx messages\n{'count':>7}  dir cmd")
    for k,c in Counter(cmd_key(b) for _,b in msgs).most_common(40):
        print(f"{c:7d}  {k}")

def diff_caps(path_a, path_b, by_cmd=False):
    key = cmd_key if by_cmd else (lambda b: b.hex())
    ca = Counter(key(b) for _,b in clean_sysex(path_a))
    cb = Counter(key(b) for _,b in clean_sysex(path_b))
    label = '[dir cmd]' if by_cmd else 'message'
    print(f"A = {path_a.split('/')[-1]}")
    print(f"B = {path_b.split('/')[-1]}")
    print(f"comparing by {label}\n")
    keys = sorted(set(ca) | set(cb))
    only_a = [k for k in keys if cb[k] == 0]
    only_b = [k for k in keys if ca[k] == 0]
    changed = [k for k in keys if ca[k] and cb[k] and ca[k] != cb[k]]
    def show(title, ks):
        print(f"── {title} ({len(ks)}) ──")
        for k in ks:
            print(f"   A{ca[k]:>4} B{cb[k]:>4}  {k}")
        if not ks: print("   (none)")
        print()
    show("only in A", only_a)
    show("only in B", only_b)
    show("count differs", changed)

def decode_tuner(msgs):
    r42 = [(ts,b) for ts,b in msgs if len(b)>=6 and b[3]==0x0F and b[5]==0x42 and b[4]==0x12]
    q42 = [(ts,b) for ts,b in msgs if len(b)>=6 and b[3]==0x0F and b[5]==0x42 and b[4]==0x01]
    b41 = [(ts,b) for ts,b in msgs if len(b)>=6 and b[3]==0x0F and b[5]==0x41 and b[4]==0x02]
    print(f"CMD 0x42 RESP: {len(r42)}   REQU: {len(q42)}   CMD 0x41 bcast: {len(b41)}")
    if q42:
        gaps = sorted((q42[i+1][0]-q42[i][0])*1000 for i in range(len(q42)-1))
        gaps = [g for g in gaps if 0 < g < 0.5*1000]
        if gaps:
            med = gaps[len(gaps)//2]
            print(f"poll median gap {med:.1f}ms (~{1000/med:.0f} Hz)")
    print("\nRESP 0x42 layout: F0 13 0B 0F 12 42 [note] [tune] F7")
    print("  note = octave<<4 | chromatic(0=C..11=B); tune 0x40=in tune (>sharp <flat)")
    last=None
    for ts,b in r42:
        # b = F0 13 0B 0F 12 42 note tune F7  (indices 6,7)
        if len(b) < 9: continue
        note, tune = b[6], b[7]
        nn, oc = note & 0x0F, note >> 4
        if note==0x00 and tune==0x40: continue
        key=(nn,oc)
        if key!=last:
            name = NOTE[nn] if nn<12 else f'?{nn}'
            print(f"  t={ts:6.1f}  note=0x{note:02x} {name}{oc}  tune=0x{tune:02x} ({tune-0x40:+d})")
            last=key

if __name__ == '__main__':
    main()
