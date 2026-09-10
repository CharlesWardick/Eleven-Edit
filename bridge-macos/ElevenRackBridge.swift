/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
/**
 * ElevenRackBridge.swift — macOS native MIDI bridge for Eleven Edit.
 *
 * A drop-in replacement for ElevenRackBridge.jar on macOS. Speaks the SAME
 * JSON-over-WebSocket protocol on ws://127.0.0.1:57121 so the Electron
 * renderer (transport.js) needs no transport changes, but talks to the
 * hardware through CoreMIDI directly — no Java runtime required.
 *
 * WHY NO JAVA ON MAC: the Windows build needs javax.sound.midi because the
 * Avid driver exposes the rack's SysEx transport as a "Vendor Specific"
 * interface that WinMM hides. macOS has no such layer: CoreMIDI enumerates
 * the Eleven Rack's USB-MIDI ports natively, with no Avid driver installed
 * at all, so a ~400-line native bridge covers the whole job.
 *
 * Compile (universal): see build.sh — or, for a quick local build:
 *     swiftc -O ElevenRackBridge.swift -o ElevenRackBridge
 * Run:  ./ElevenRackBridge            (add --list to just print MIDI endpoints)
 *
 * Protocol (JSON over WebSocket) — identical to the Java bridge:
 *   FROM BRIDGE -> CLIENT:
 *     {"type":"ports","devices":[{"index":0,"kind":"in"|"out","name":"...","desc":"..."},...]}
 *     {"type":"connected","inPort":1,"outPort":6}
 *     {"type":"disconnected"}
 *     {"type":"midi_in","hex":"F0 13 0B...","bytes":[...]}
 *     {"type":"error","message":"..."}
 *     {"type":"log","message":"..."}
 *   FROM CLIENT -> BRIDGE:
 *     {"cmd":"list_ports"}
 *     {"cmd":"connect","inPort":1,"outPort":6}
 *     {"cmd":"disconnect"}
 *     {"cmd":"send","hex":"F0 13 0B 0F 01 01 07 00 00 F7"}   (SysEx)
 *     {"cmd":"send","hex":"C0 23"}                            (Program Change)
 *     {"cmd":"send","hex":"B0 11 7F"}                         (Control Change)
 *
 *   The device list is ONE flat array like the Java bridge's (the renderer
 *   indexes it by position), with every CoreMIDI source listed first
 *   (kind "in") and every destination after (kind "out"). "kind" is an
 *   addition the Java bridge never had; the renderer uses it, when present,
 *   to show inputs only in the IN picker and outputs only in the OUT picker.
 *
 *   Hot-plug (also new vs. Java): a fresh "ports" list is broadcast when the
 *   MIDI setup changes while NOT connected (plug the rack in after launch and
 *   the app auto-connects), and "disconnected" + a fresh list when the
 *   connected endpoints vanish (rack unplugged / powered off).
 *
 *   SHUTDOWN: write the line "SHUTDOWN" to stdin (or just close stdin) for a
 *   graceful exit that releases the MIDI endpoints first — same contract as
 *   the Java bridge, so main.js's killBridge() works unchanged.
 */

import Foundation
import CoreMIDI
import Network

let WS_PORT: UInt16 = 57121

// Every piece of bridge state lives on this one serial queue. CoreMIDI's
// read callback and the Network framework both hop onto it, so nothing
// below needs a lock.
let q = DispatchQueue(label: "com.wardick.elevenedit.bridge")

setvbuf(stdout, nil, _IONBF, 0) // main.js reads our stdout through a pipe — never buffer
func log(_ s: String) { print("[Bridge] " + s) }

struct BridgeError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

// ── JSON / hex helpers ────────────────────────────────────────────────
func jsonString(_ obj: Any) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let s = String(data: d, encoding: .utf8) else { return "{}" }
    return s
}
func errJSON(_ m: String) -> String { jsonString(["type": "error", "message": m]) }
func hexString(_ bytes: [UInt8]) -> String {
    bytes.map { String(format: "%02X", $0) }.joined(separator: " ")
}
func hexToBytes(_ hex: String) -> [UInt8]? {
    var out: [UInt8] = []
    for part in hex.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" }) {
        guard let v = UInt8(part, radix: 16) else { return nil }
        out.append(v)
    }
    return out
}

// ── MIDI endpoint enumeration ─────────────────────────────────────────
struct Dev {
    let index: Int
    let kind: String          // "in" (CoreMIDI source) or "out" (CoreMIDI destination)
    let ref: MIDIEndpointRef
    let name: String
    let desc: String
}
var devices: [Dev] = []
var lastSignature = ""

func strProp(_ obj: MIDIObjectRef, _ prop: CFString) -> String? {
    var s: Unmanaged<CFString>?
    guard MIDIObjectGetStringProperty(obj, prop, &s) == noErr, let v = s?.takeRetainedValue() else { return nil }
    return v as String
}

// kMIDIPropertyDisplayName is CoreMIDI's own "device + port" label — e.g.
// "Eleven Rack" for a single-port device, "Eleven Rack Port 2" for a
// multi-port one — the same string Audio MIDI Setup and Logic show.
func endpointName(_ ep: MIDIEndpointRef) -> String {
    return strProp(ep, kMIDIPropertyDisplayName) ?? strProp(ep, kMIDIPropertyName) ?? "Unknown"
}
func endpointDesc(_ ep: MIDIEndpointRef, _ kind: String) -> String {
    var parts: [String] = [kind == "in" ? "MIDI input" : "MIDI output"]
    var entity = MIDIEntityRef(), device = MIDIDeviceRef()
    if MIDIEndpointGetEntity(ep, &entity) == noErr, MIDIEntityGetDevice(entity, &device) == noErr {
        if let m = strProp(device, kMIDIPropertyManufacturer), !m.isEmpty { parts.append(m) }
        if let model = strProp(device, kMIDIPropertyModel), !model.isEmpty { parts.append(model) }
    } else {
        parts.append("virtual")
    }
    return parts.joined(separator: " · ")
}

func enumerateDevices() -> [Dev] {
    var list: [Dev] = []
    for i in 0..<MIDIGetNumberOfSources() {
        let ep = MIDIGetSource(i)
        list.append(Dev(index: list.count, kind: "in", ref: ep, name: endpointName(ep), desc: endpointDesc(ep, "in")))
    }
    for i in 0..<MIDIGetNumberOfDestinations() {
        let ep = MIDIGetDestination(i)
        list.append(Dev(index: list.count, kind: "out", ref: ep, name: endpointName(ep), desc: endpointDesc(ep, "out")))
    }
    return list
}
func signature(_ list: [Dev]) -> String { list.map { "\($0.kind):\($0.name)" }.joined(separator: "|") }

func portListJSON() -> String {
    devices = enumerateDevices()
    lastSignature = signature(devices)
    let arr: [[String: Any]] = devices.map {
        ["index": $0.index, "kind": $0.kind, "name": $0.name, "desc": $0.desc]
    }
    return jsonString(["type": "ports", "devices": arr])
}

// ── MIDI client / ports ───────────────────────────────────────────────
var midiClient = MIDIClientRef()
var inPort     = MIDIPortRef()
var outPort    = MIDIPortRef()
var connectedSrc: MIDIEndpointRef? = nil
var connectedDst: MIDIEndpointRef? = nil
var connectedIn  = -1
var connectedOut = -1

// SysEx reassembly. CoreMIDI hands a long SysEx over as several MIDIPackets
// (first starts with F0, the rest are bare data, the last ends with F7),
// exactly the split the Java bridge had to stitch back together on Windows
// — a 1107-byte bulk patch MUST reach the renderer as one message.
var sysexBuf: [UInt8] = []
var inSysex = false

func shortMessageLength(_ status: UInt8) -> Int {
    switch status {
    case 0x80...0xBF, 0xE0...0xEF: return 3
    case 0xC0...0xDF:              return 2
    case 0xF1, 0xF3:               return 2
    case 0xF2:                     return 3
    default:                       return 1   // F6, F8-FF (realtime)
    }
}

func emitMidiIn(_ bytes: [UInt8]) {
    let hex = hexString(bytes)
    if bytes.first == 0xF0 {
        log("MIDI IN (reassembled \(bytes.count)b): " + String(hex.prefix(60)) + "...")
    } else {
        log("MIDI IN: " + hex)
    }
    broadcast(jsonString(["type": "midi_in", "hex": hex, "bytes": bytes.map { Int($0) }]))
}

func handleBytes(_ bytes: [UInt8]) {
    var i = 0
    while i < bytes.count {
        let b = bytes[i]
        if inSysex {
            if b == 0xF7 {
                sysexBuf.append(0xF7)
                inSysex = false
                let msg = sysexBuf; sysexBuf = []
                emitMidiIn(msg)
                i += 1
            } else if b >= 0xF8 {
                emitMidiIn([b])            // realtime byte interleaved mid-SysEx — pass it on
                i += 1
            } else if b & 0x80 != 0 {
                // A non-realtime status mid-SysEx terminates it (MIDI spec);
                // drop the partial and re-parse this byte as a new message.
                log("SysEx aborted by status \(String(format: "%02X", b)) after \(sysexBuf.count) bytes")
                inSysex = false; sysexBuf = []
            } else {
                sysexBuf.append(b)
                i += 1
            }
        } else if b == 0xF0 {
            inSysex = true
            sysexBuf = [0xF0]
            i += 1
        } else if b < 0x80 {
            i += 1                          // stray data byte with no status — ignore
        } else {
            let len = shortMessageLength(b)
            let end = min(i + len, bytes.count)
            emitMidiIn(Array(bytes[i..<end]))
            i = end
        }
    }
}

// Called on CoreMIDI's high-priority thread: copy the bytes out, then do
// all parsing/broadcasting on our own queue.
func midiReadBlock(_ pktList: UnsafePointer<MIDIPacketList>, _ srcConnRefCon: UnsafeMutableRawPointer?) {
    var chunks: [[UInt8]] = []
    for pkt in pktList.unsafeSequence() {
        chunks.append(Array(pkt.bytes()))
    }
    q.async { for c in chunks { handleBytes(c) } }
}

func setupMIDI() {
    var st = MIDIClientCreateWithBlock("ElevenRackBridge" as CFString, &midiClient) { notifPtr in
        if notifPtr.pointee.messageID == .msgSetupChanged { q.async { scheduleSetupChanged() } }
    }
    guard st == noErr else { log("MIDIClientCreate failed (\(st))"); exit(3) }
    st = MIDIInputPortCreateWithBlock(midiClient, "ElevenRackBridge In" as CFString, &inPort, midiReadBlock)
    guard st == noErr else { log("MIDIInputPortCreate failed (\(st))"); exit(3) }
    st = MIDIOutputPortCreate(midiClient, "ElevenRackBridge Out" as CFString, &outPort)
    guard st == noErr else { log("MIDIOutputPortCreate failed (\(st))"); exit(3) }
}

func connectMidi(_ inIdx: Int, _ outIdx: Int) throws {
    closeMidi()
    // Fresh enumeration, like the Java bridge — indices are positions in the
    // list the client last saw; a device change in between is the renderer's
    // name check's job (it re-validates saved ports by name).
    devices = enumerateDevices()
    lastSignature = signature(devices)
    guard inIdx >= 0, inIdx < devices.count, outIdx >= 0, outIdx < devices.count else {
        throw BridgeError("port index out of range (have \(devices.count) endpoints)")
    }
    let din = devices[inIdx], dout = devices[outIdx]
    guard din.kind == "in"   else { throw BridgeError("inPort [\(inIdx)] \"\(din.name)\" is a MIDI output, not an input") }
    guard dout.kind == "out" else { throw BridgeError("outPort [\(outIdx)] \"\(dout.name)\" is a MIDI input, not an output") }

    log("Connecting IN=\(inIdx) OUT=\(outIdx)")
    log("IN name: \(din.name) (\(din.desc))")
    log("OUT name: \(dout.name) (\(dout.desc))")

    let st = MIDIPortConnectSource(inPort, din.ref, nil)
    guard st == noErr else { throw BridgeError("MIDIPortConnectSource failed (\(st))") }
    connectedSrc = din.ref; connectedDst = dout.ref
    connectedIn = inIdx;    connectedOut = outIdx
    sysexBuf = []; inSysex = false

    broadcast(jsonString(["type": "connected", "inPort": inIdx, "outPort": outIdx]))
    log("Connected OK")
}

func closeMidi() {
    if let s = connectedSrc { MIDIPortDisconnectSource(inPort, s) }
    connectedSrc = nil; connectedDst = nil
    connectedIn = -1;   connectedOut = -1
    sysexBuf = []; inSysex = false
}

func sendMidi(_ bytes: [UInt8]) throws {
    guard let dst = connectedDst else { throw BridgeError("Not connected") }
    guard !bytes.isEmpty else { throw BridgeError("Empty message") }
    guard bytes.count <= 65000 else { throw BridgeError("Message too large (\(bytes.count) bytes)") }

    // One MIDIPacket carries the whole message — including a full-size SysEx
    // (MIDIPacket.length is 16-bit; the 256-byte data field is just the
    // declared minimum). The USB-MIDI driver does the wire chunking.
    let bufSize = bytes.count + 128
    let raw = UnsafeMutableRawPointer.allocate(byteCount: bufSize, alignment: MemoryLayout<MIDIPacketList>.alignment)
    defer { raw.deallocate() }
    let plist = raw.bindMemory(to: MIDIPacketList.self, capacity: 1)
    let first = MIDIPacketListInit(plist)
    let added = bytes.withUnsafeBufferPointer { buf -> UnsafeMutablePointer<MIDIPacket>? in
        MIDIPacketListAdd(plist, bufSize, first, 0, bytes.count, buf.baseAddress!)
    }
    guard added != nil else { throw BridgeError("MIDIPacketListAdd failed") }
    let st = MIDISend(outPort, dst, plist)
    guard st == noErr else { throw BridgeError("MIDISend failed (\(st))") }
    log("MIDI OUT: " + hexString(bytes))
}

// ── Hot-plug: MIDI setup changes ──────────────────────────────────────
var setupChangePending = false
func scheduleSetupChanged() {
    if setupChangePending { return }
    setupChangePending = true
    // Debounced — a USB device arriving fires several notifications in a row.
    q.asyncAfter(deadline: .now() + 0.7) {
        setupChangePending = false
        let fresh = enumerateDevices()
        let sig = signature(fresh)
        if sig == lastSignature { return }
        log("MIDI setup changed — \(fresh.count) endpoint(s) now")
        if let src = connectedSrc, let dst = connectedDst {
            let srcAlive = fresh.contains { $0.kind == "in"  && $0.ref == src }
            let dstAlive = fresh.contains { $0.kind == "out" && $0.ref == dst }
            if srcAlive && dstAlive {
                // Still connected and healthy — an unrelated device came or
                // went. Don't poke the renderer into a needless reconnect.
                lastSignature = sig
                return
            }
            log("Connected Eleven Rack endpoint disappeared — disconnecting")
            closeMidi()
            broadcast(jsonString(["type": "disconnected"]))
        }
        broadcast(portListJSON())
    }
}

// ── WebSocket server (Network framework) ──────────────────────────────
var clients: [NWConnection] = []

func makeListener() throws -> NWListener {
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: WS_PORT)!)
    let ws = NWProtocolWebSocket.Options()
    ws.autoReplyPing = true
    ws.maximumMessageSize = 4 * 1024 * 1024
    // Origin guard — same rule as the Java bridge: only the app's own Electron
    // window (file:// origin, or none) may connect. A browser page sends
    // http(s):// and is rejected, so a malicious local web page can't drive
    // the rack over ws://127.0.0.1 with arbitrary SysEx.
    ws.setClientRequestHandler(q) { _, additionalHeaders in
        let origin = additionalHeaders.first { $0.name.lowercased() == "origin" }?.value ?? ""
        if !origin.isEmpty && !origin.lowercased().hasPrefix("file://") {
            log("Rejected WS connect from origin: \(origin)")
            return NWProtocolWebSocket.Response(status: .reject, subprotocol: nil)
        }
        log("WS handshake from origin: " + (origin.isEmpty ? "(none)" : origin))
        return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
    }
    params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
    return try NWListener(using: params)
}

func removeClient(_ conn: NWConnection) {
    if let i = clients.firstIndex(where: { $0 === conn }) {
        clients.remove(at: i)
        log("Client disconnected")
    }
    conn.cancel()
}

func wsSend(_ conn: NWConnection, _ text: String) {
    let meta = NWProtocolWebSocket.Metadata(opcode: .text)
    let ctx = NWConnection.ContentContext(identifier: "text", metadata: [meta])
    conn.send(content: text.data(using: .utf8), contentContext: ctx, isComplete: true,
              completion: .contentProcessed { err in
                  if let err = err { log("Client send error: \(err)"); removeClient(conn) }
              })
}

func broadcast(_ text: String) {
    for c in clients { wsSend(c, text) }
}

func receiveLoop(_ conn: NWConnection) {
    conn.receiveMessage { data, ctx, isComplete, error in
        if let error = error {
            if clients.contains(where: { $0 === conn }) { log("Client error: \(error)") }
            removeClient(conn); return
        }
        if let ctx = ctx, let meta = ctx.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
            switch meta.opcode {
            case .text:
                if let d = data, let s = String(data: d, encoding: .utf8) { handleMessage(conn, s) }
            case .close:
                removeClient(conn); return
            default:
                break
            }
        } else if data == nil && (ctx == nil || ctx!.isFinal) {
            removeClient(conn); return
        }
        receiveLoop(conn)
    }
}

func handleNewConnection(_ conn: NWConnection) {
    conn.stateUpdateHandler = { state in
        switch state {
        case .ready:
            clients.append(conn)
            log("Client connected: \(conn.endpoint)")
            log("WS handshake complete")
            wsSend(conn, portListJSON())   // port list goes out the instant a client connects
        case .failed(let e):
            log("Client connection failed: \(e)")
            removeClient(conn)
        case .cancelled:
            removeClient(conn)
        default:
            break
        }
    }
    receiveLoop(conn)
    conn.start(queue: q)
}

func handleMessage(_ conn: NWConnection, _ json: String) {
    log("RX: " + json)
    guard let d = json.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          let cmd = obj["cmd"] as? String else { return }
    do {
        switch cmd {
        case "list_ports":
            wsSend(conn, portListJSON())
        case "connect":
            let i = (obj["inPort"]  as? NSNumber)?.intValue ?? -1
            let o = (obj["outPort"] as? NSNumber)?.intValue ?? -1
            if i < 0 || o < 0 { wsSend(conn, errJSON("connect requires inPort and outPort")); return }
            try connectMidi(i, o)
        case "disconnect":
            closeMidi()
            broadcast(jsonString(["type": "disconnected"]))
        case "send":
            guard let hex = obj["hex"] as? String, !hex.isEmpty else { return }
            guard let bytes = hexToBytes(hex) else { throw BridgeError("send: bad hex \"\(hex.prefix(40))\"") }
            try sendMidi(bytes)
        default:
            wsSend(conn, errJSON("unknown cmd: \(cmd)"))
        }
    } catch {
        log("handleMessage error: \(error)")
        wsSend(conn, errJSON("\(error)"))
    }
}

// ── Shutdown paths ────────────────────────────────────────────────────
func shutdown(_ why: String) -> Never {
    log(why)
    q.sync { closeMidi() }
    log("Shutting down...")
    exit(0)
}

// ── main ──────────────────────────────────────────────────────────────
if CommandLine.arguments.contains("--list") {
    for d in enumerateDevices() { print("[\(d.index)] \(d.kind.uppercased().padding(toLength: 3, withPad: " ", startingAt: 0))  \(d.name)  —  \(d.desc)") }
    exit(0)
}

log("Avid Eleven Rack Bridge (macOS / CoreMIDI) starting on port \(WS_PORT)")
setupMIDI()

let listener: NWListener
do { listener = try makeListener() }
catch { log("Could not create listener: \(error)"); exit(2) }

listener.stateUpdateHandler = { state in
    switch state {
    case .ready:            log("Listening on ws://localhost:\(WS_PORT)")
    case .failed(let e):    log("Listener failed: \(e) — is another bridge already running on port \(WS_PORT)?"); exit(2)
    default:                break
    }
}
listener.newConnectionHandler = { conn in handleNewConnection(conn) }
listener.start(queue: q)

// Graceful stop on SIGTERM/SIGINT (Node's proc.kill() default is SIGTERM).
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let sigTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: q)
sigTerm.setEventHandler { closeMidi(); log("SIGTERM — shutting down"); exit(0) }
sigTerm.resume()
let sigInt = DispatchSource.makeSignalSource(signal: SIGINT, queue: q)
sigInt.setEventHandler { closeMidi(); log("SIGINT — shutting down"); exit(0) }
sigInt.resume()

// stdin watcher: "SHUTDOWN" line, or EOF (parent gone), both exit cleanly.
Thread {
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() == "SHUTDOWN" {
            shutdown("Graceful shutdown requested via stdin")
        }
    }
    shutdown("stdin closed — shutting down")
}.start()

CFRunLoopRun()
