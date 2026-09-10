// Fake Eleven Rack for bridge testing — no hardware needed.
// Creates a virtual CoreMIDI source + destination both named
// "Eleven Rack Rig (fake)". Replies to a MIDI Identity Request with an
// identity reply ending in ASCII "0157" (the firmware build Eleven Edit
// expects), answers the test request F0 13 0B 0F 01 7F ... F7 with a
// 1300-byte SysEx (exercises reassembly), and echoes everything else.
import Foundation
import CoreMIDI
setvbuf(stdout, nil, _IONBF, 0)
var client = MIDIClientRef(); MIDIClientCreate("FakeElevenRack" as CFString, nil, nil, &client)
var src = MIDIEndpointRef(); MIDISourceCreate(client, "Eleven Rack Rig (fake)" as CFString, &src)
var dst = MIDIEndpointRef()
func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02X", $0) }.joined(separator: " ") }
func send(_ bytes: [UInt8]) {
    let size = bytes.count + 128
    let raw = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 4); defer { raw.deallocate() }
    let pl = raw.bindMemory(to: MIDIPacketList.self, capacity: 1)
    let first = MIDIPacketListInit(pl)
    _ = bytes.withUnsafeBufferPointer { MIDIPacketListAdd(pl, size, first, 0, bytes.count, $0.baseAddress!) }
    MIDIReceived(src, pl)
    print("[Fake] TX \(bytes.count)b: " + String(hex(bytes).prefix(48)))
}
var buf: [UInt8] = []; var inSx = false
// Enough of the editor protocol (Tech Ref Secs 3, 4, 6) for Eleven Edit's
// startup sequence to complete and reveal the main window: a canned chain
// map (CMD 0x21, 11 triplets, amp block at handle 0x12), a current-rig
// reply (CMD 0x02), and an echo of every CMD 0x11 parameter query as a
// RESP (dir 0x12) with a plausible value. Not a rack emulator.
let HDR: [UInt8] = [0xF0,0x13,0x0B,0x0F]
let chainMap: [UInt8] = HDR + [0x12,0x21] + [
    0x0B,0x37,0x18,   // input (Guitar In), head marker back-links to itself
    0x0B,0x2B,0x0E,   // VOL   slot 0x02
    0x02,0x23,0x0F,   // WAH   slot 0x03
    0x03,0x19,0x10,   // DIST  slot 0x07
    0x07,0x01,0x11,   // MOD   slot 0x04
    0x04,0x00,0x12,   // AMP   slot 0x00  <- amp handle 0x12
    0x00,0x14,0x13,   // FX1   slot 0x08
    0x08,0x12,0x14,   // FX2   slot 0x09
    0x09,0x2D,0x15,   // LOOP  slot 0x01
    0x01,0x1C,0x16,   // DELAY slot 0x06
    0x06,0x28,0x17,   // REV   slot 0x05
    0x05,             // trailing = last block's slot id
    0xF7]
func handle(_ m: [UInt8]) {
    print("[Fake] RX \(m.count)b: " + String(hex(m).prefix(48)))
    if m == [0xF0,0x7E,0x7F,0x06,0x01,0xF7] {
        send([0xF0,0x7E,0x7F,0x06,0x02,0x00,0x01,0x3E,0x0B,0x00,0x00,0x00,0x30,0x31,0x35,0x37,0xF7]); return
    }
    if m.count >= 7 && Array(m[0..<4]) == HDR && m[4] == 0x01 {          // REQU
        switch m[5] {
        case 0x21: send(chainMap); return
        case 0x02: send(HDR + [0x12,0x02,0x00,0x00,0xF7]); return           // user space, slot A1
        case 0x11 where m.count >= 9:
            let lo = m[7]
            let v0: UInt8 = (lo == 0x0F) ? 0x00 : 0x40                        // amp #0 / mid-scale
            send(HDR + [0x12,0x11,m[6],lo,v0,0x00,0x00,0x00,0x00,0xF7]); return
        default: return                                                       // unanswered query — the app tolerates it
        }
    }
    if m.count >= 7 && Array(m[0..<4]) == HDR && m[4] == 0x00 {          // SEND (write) -> ASYNC echo
        var e = m; e[4] = 0x02; send(e); return
    }
    if m.count >= 6 && Array(m[0..<6]) == [0xF0,0x13,0x0B,0x0F,0x01,0x7F] {
        var big: [UInt8] = [0xF0,0x13,0x0B,0x0F,0x02,0x7F]
        for i in 0..<1293 { big.append(UInt8(i & 0x7F)) }
        big.append(0xF7); send(big); return
    }
    send(m)
}
func bytesIn(_ b: [UInt8]) {
    for x in b {
        if inSx { buf.append(x); if x == 0xF7 { inSx = false; handle(buf); buf = [] } }
        else if x == 0xF0 { inSx = true; buf = [0xF0] }
        else { buf.append(x); let st = buf[0]; let need = (st >= 0xC0 && st <= 0xDF) ? 2 : (st >= 0xF8 ? 1 : 3); if buf.count >= need { handle(buf); buf = [] } }
    }
}
MIDIDestinationCreateWithBlock(client, "Eleven Rack Rig (fake)" as CFString, &dst) { pl, _ in
    var chunks: [[UInt8]] = []
    for p in pl.unsafeSequence() { chunks.append(Array(p.bytes())) }
    DispatchQueue.main.async { for c in chunks { bytesIn(c) } }
}
print("[Fake] virtual Eleven Rack Rig (fake) endpoints up")
CFRunLoopRun()
