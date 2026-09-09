/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
/**
 * ElevenRackBridge.java
 * Single-file Java WebSocket bridge for Avid Eleven Rack
 * Uses javax.sound.midi (same as ElevenHack) to access all MIDI ports
 * including "No details available" Vendor Specific interface.
 *
 * Exposes a WebSocket server on localhost:57121
 * Electron connects to ws://localhost:57121 to send/receive all hardware data.
 *
 * Compile: javac ElevenRackBridge.java
 * Run:     java ElevenRackBridge
 *
 * Protocol (JSON over WebSocket):
 *   FROM BRIDGE → CLIENT:
 *     {"type":"ports","inputs":[...],"outputs":[...]}
 *     {"type":"connected","inPort":1,"outPort":6}
 *     {"type":"disconnected"}
 *     {"type":"midi_in","hex":"F0 13 0B...","bytes":[...]}
 *     {"type":"error","message":"..."}
 *     {"type":"log","message":"..."}
 *
 *   FROM CLIENT → BRIDGE:
 *     {"cmd":"list_ports"}
 *     {"cmd":"connect","inPort":1,"outPort":6}
 *     {"cmd":"disconnect"}
 *     {"cmd":"send","hex":"F0 13 0B 0F 01 01 07 00 00 F7"}   (SysEx)
 *     {"cmd":"send","hex":"C0 23"}                            (Program Change)
 *     {"cmd":"send","hex":"B0 11 7F"}                         (Control Change)
 *
 *   "send" auto-detects message type from the first byte: 0xF0 = SysEx,
 *   anything else = a standard MIDI short message (PC/CC/etc).
 *
 *   SHUTDOWN: write the line "SHUTDOWN" to this process's stdin to trigger
 *   a graceful in-process exit (closes MIDI ports properly, then calls
 *   System.exit(0)). Closing stdin (EOF) does the same thing automatically.
 *   This exists because a forceful external kill (taskkill /F, Node's
 *   child_process.kill()) skips the JVM shutdown hook entirely on Windows,
 *   which can leave the MIDI/USB handle stuck open even after the process
 *   is gone.
 */

import com.sun.net.httpserver.HttpServer;
import javax.sound.midi.*;
import java.io.*;
import java.net.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

public class ElevenRackBridge {

    static final int WS_PORT = 57121;

    // Active MIDI devices
    static MidiDevice  devIn   = null;
    static MidiDevice  devOut  = null;
    static Receiver    txRx    = null;  // transmitter receiver on devIn
    static Receiver    outRx   = null;  // receiver on devOut

    // WebSocket clients
    static final List<Socket> clients = new CopyOnWriteArrayList<>();

    // SysEx reassembly buffer — javax.sound.midi can split large SysEx
    // messages across multiple callbacks. First fragment starts with 0xF0,
    // subsequent fragments start with 0xF7 (continuation). We accumulate
    // until a fragment contains a terminating 0xF7 at the end, then
    // broadcast the fully reassembled message. Confirmed necessary 7/12/2026
    // via session log: a 1107-byte encoded bulk patch arrived as a 1024-byte
    // first fragment and an ~89-byte second fragment, causing our app to
    // process only the truncated first fragment and discard the rest.
    static final List<Byte> sysexBuffer = new ArrayList<>();
    static boolean sysexPending = false;

    // ── MAIN ──────────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        System.out.println("[Bridge] Avid Eleven Rack Bridge starting on port " + WS_PORT);

        ServerSocket server = new ServerSocket(WS_PORT, 10,
            InetAddress.getByName("127.0.0.1"));
        System.out.println("[Bridge] Listening on ws://localhost:" + WS_PORT);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            System.out.println("[Bridge] Shutting down...");
            closeMidi();
        }));

        // Graceful shutdown via stdin, requested by main.js. This matters
        // specifically on Windows: a forceful kill (taskkill /F,
        // TerminateProcess, Node's child_process.kill()) does NOT run the
        // shutdown hook above at all — it skips cleanup entirely, which is
        // almost certainly why the MIDI/USB handle was staying stuck open
        // even after the process was "killed". Closing it from inside our
        // own running thread, via a normal System.exit(), is what actually
        // lets closeMidi() run before the process goes away.
        Thread stdinShutdown = new Thread(() -> {
            try {
                BufferedReader stdinReader = new BufferedReader(new InputStreamReader(System.in));
                String line;
                while ((line = stdinReader.readLine()) != null) {
                    if (line.trim().equalsIgnoreCase("SHUTDOWN")) {
                        System.out.println("[Bridge] Graceful shutdown requested via stdin");
                        closeMidi();
                        System.exit(0);
                    }
                }
                // stdin closed (EOF) without an explicit command — parent
                // process is gone, shut down the same way rather than
                // lingering as an orphan.
                System.out.println("[Bridge] stdin closed — shutting down");
                closeMidi();
                System.exit(0);
            } catch (Exception e) {
                // If stdin itself breaks, don't take the whole bridge down —
                // just stop watching it. The shutdown hook is still the
                // fallback for a graceful exit path.
            }
        });
        stdinShutdown.setDaemon(true);
        stdinShutdown.start();

        while (true) {
            Socket client = server.accept();
            System.out.println("[Bridge] Client connected: " + client.getRemoteSocketAddress());
            new Thread(() -> handleClient(client)).start();
        }
    }

    // ── WEBSOCKET HANDSHAKE + MESSAGE LOOP ────────────────────────────────
    static void handleClient(Socket sock) {
        try {
            InputStream  in  = sock.getInputStream();
            OutputStream out = sock.getOutputStream();

            // HTTP upgrade
            BufferedReader br = new BufferedReader(new InputStreamReader(in));
            String wsKey = null;
            String origin = null;
            String line;
            while (!(line = br.readLine()).isEmpty()) {
                if (line.startsWith("Sec-WebSocket-Key:"))
                    wsKey = line.substring(line.indexOf(':') + 1).trim();
                else if (line.regionMatches(true, 0, "Origin:", 0, 7))
                    origin = line.substring(line.indexOf(':') + 1).trim();
            }
            if (wsKey == null) { sock.close(); return; }

            // Origin guard: only the app's own Electron window (file:// origin, or
            // none) may connect. A browser page sends http(s):// and is rejected —
            // this blocks a malicious local web page from driving the rack over
            // ws://127.0.0.1 with arbitrary SysEx.
            if (origin != null && !origin.isEmpty() && !origin.startsWith("file://")) {
                System.out.println("[Bridge] Rejected WS connect from origin: " + origin);
                sock.close();
                return;
            }

            // Send 101 Switching Protocols
            String accept = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1").digest(
                    (wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes("UTF-8")
                )
            );
            String response = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
            out.write(response.getBytes("UTF-8"));
            out.flush();

            clients.add(sock);
            System.out.println("[Bridge] WS handshake complete");

            // Send port list immediately on connect
            wsSend(sock, buildPortList());

            // Message loop
            DataInputStream dis = new DataInputStream(in);
            while (!sock.isClosed()) {
                int b0 = dis.read();
                if (b0 == -1) break;
                int b1 = dis.read();
                boolean masked = (b1 & 0x80) != 0;
                int payLen = b1 & 0x7F;
                if (payLen == 126) {
                    payLen = ((dis.read() & 0xFF) << 8) | (dis.read() & 0xFF);
                } else if (payLen == 127) {
                    dis.readLong(); // skip 8 bytes (huge messages not expected)
                    payLen = 0;
                }
                byte[] mask = new byte[4];
                if (masked) dis.readFully(mask);
                byte[] payload = new byte[payLen];
                dis.readFully(payload);
                if (masked) {
                    for (int i = 0; i < payload.length; i++)
                        payload[i] ^= mask[i % 4];
                }
                String msg = new String(payload, StandardCharsets.UTF_8);
                handleMessage(sock, msg);
            }
        } catch (Exception e) {
            System.out.println("[Bridge] Client error: " + e.getMessage());
        } finally {
            clients.remove(sock);
            try { sock.close(); } catch (Exception e) {}
            System.out.println("[Bridge] Client disconnected");
        }
    }

    // ── MESSAGE HANDLER ───────────────────────────────────────────────────
    static void handleMessage(Socket from, String json) {
        System.out.println("[Bridge] RX: " + json);
        try {
            String cmd = jsonStr(json, "cmd");
            if (cmd == null) return;

            switch (cmd) {
                case "list_ports":
                    wsSend(from, buildPortList());
                    break;

                case "connect": {
                    int inPort  = jsonInt(json, "inPort",  -1);
                    int outPort = jsonInt(json, "outPort", -1);
                    if (inPort < 0 || outPort < 0) {
                        wsSend(from, "{\"type\":\"error\",\"message\":\"connect requires inPort and outPort\"}");
                        return;
                    }
                    connectMidi(inPort, outPort);
                    break;
                }

                case "disconnect":
                    closeMidi();
                    broadcast("{\"type\":\"disconnected\"}");
                    break;

                case "send": {
                    String hex = jsonStr(json, "hex");
                    if (hex == null || hex.isEmpty()) return;
                    byte[] bytes = hexToBytes(hex);
                    sendMidi(bytes);
                    break;
                }

                default:
                    wsSend(from, "{\"type\":\"error\",\"message\":\"unknown cmd: " + cmd + "\"}");
            }
        } catch (Exception e) {
            System.out.println("[Bridge] handleMessage error: " + e.getMessage());
            try { wsSend(from, "{\"type\":\"error\",\"message\":\"" + esc(e.getMessage()) + "\"}"); }
            catch (Exception ex) {}
        }
    }

    // ── MIDI ──────────────────────────────────────────────────────────────
    static String buildPortList() {
        MidiDevice.Info[] infos = MidiSystem.getMidiDeviceInfo();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"type\":\"ports\",\"devices\":[");
        boolean first = true;
        for (int i = 0; i < infos.length; i++) {
            if (!first) sb.append(",");
            first = false;
            String name = infos[i].getName();
            String desc = infos[i].getDescription();
            sb.append("{\"index\":").append(i)
              .append(",\"name\":\"").append(esc(name)).append("\"")
              .append(",\"desc\":\"").append(esc(desc)).append("\"")
              .append("}");
        }
        sb.append("]}");
        return sb.toString();
    }

    static synchronized void connectMidi(int inPort, int outPort) throws Exception {
        closeMidi();

        MidiDevice.Info[] infos = MidiSystem.getMidiDeviceInfo();
        System.out.println("[Bridge] Connecting IN=" + inPort + " OUT=" + outPort);
        System.out.println("[Bridge] IN name: " + infos[inPort].getName() + " " + infos[inPort].getDescription());
        System.out.println("[Bridge] OUT name: " + infos[outPort].getName() + " " + infos[outPort].getDescription());

        // Open IN
        devIn = MidiSystem.getMidiDevice(infos[inPort]);
        if (!devIn.isOpen()) devIn.open();

        // Open OUT
        devOut = MidiSystem.getMidiDevice(infos[outPort]);
        if (!devOut.isOpen()) devOut.open();
        outRx = devOut.getReceiver();

        // Register IN callback — with SysEx fragment reassembly.
        // javax.sound.midi splits large SysEx messages across multiple
        // callbacks on Windows. First fragment: starts 0xF0, may or may
        // not end with 0xF7. Continuation fragments: start with 0xF7.
        // We accumulate into sysexBuffer until we see a terminal 0xF7,
        // then broadcast the fully reassembled message in one piece.
        Transmitter tx = devIn.getTransmitter();
        tx.setReceiver(new Receiver() {
            @Override
            public void send(MidiMessage message, long timestamp) {
                byte[] raw = message.getMessage();
                if (raw.length == 0) return;

                int firstByte = raw[0] & 0xFF;

                // SysEx start fragment
                if (firstByte == 0xF0) {
                    sysexBuffer.clear();
                    sysexPending = true;
                    for (byte b : raw) sysexBuffer.add(b);
                    // Check if this single fragment is already complete
                    if ((raw[raw.length - 1] & 0xFF) == 0xF7) {
                        broadcastBuffer();
                    }
                    return;
                }

                // SysEx continuation fragment (starts with 0xF7)
                if (firstByte == 0xF7 && sysexPending) {
                    // Skip the leading 0xF7 continuation marker —
                    // it is not part of the data, just Java's signal
                    // that this is a continuation. Append remaining bytes.
                    for (int i = 1; i < raw.length; i++) sysexBuffer.add(raw[i]);
                    // If this fragment ends with 0xF7, message is complete
                    if ((raw[raw.length - 1] & 0xFF) == 0xF7) {
                        broadcastBuffer();
                    }
                    return;
                }

                // Non-SysEx short message (CC, PC, etc) — broadcast directly
                sysexPending = false;
                sysexBuffer.clear();
                StringBuilder hexSb = new StringBuilder();
                StringBuilder bytesSb = new StringBuilder();
                for (int i = 0; i < raw.length; i++) {
                    if (i > 0) { hexSb.append(" "); bytesSb.append(","); }
                    hexSb.append(String.format("%02X", raw[i] & 0xFF));
                    bytesSb.append(raw[i] & 0xFF);
                }
                String msg = "{\"type\":\"midi_in\",\"hex\":\""
                    + hexSb.toString() + "\",\"bytes\":["
                    + bytesSb.toString() + "]}";
                System.out.println("[Bridge] MIDI IN: " + hexSb.toString());
                broadcast(msg);
            }
            @Override public void close() {}
        });

        broadcast("{\"type\":\"connected\",\"inPort\":" + inPort
            + ",\"outPort\":" + outPort + "}");
        System.out.println("[Bridge] Connected OK");
    }

    static synchronized void closeMidi() {
        try { if (outRx  != null) { outRx.close();  outRx  = null; } } catch(Exception e){}
        try { if (devOut != null) { devOut.close();  devOut = null; } } catch(Exception e){}
        try { if (devIn  != null) { devIn.close();   devIn  = null; } } catch(Exception e){}
    }

    // Broadcast a fully reassembled SysEx message from sysexBuffer.
    static synchronized void broadcastBuffer() {
        sysexPending = false;
        int len = sysexBuffer.size();
        StringBuilder hexSb = new StringBuilder();
        StringBuilder bytesSb = new StringBuilder();
        for (int i = 0; i < len; i++) {
            int b = sysexBuffer.get(i) & 0xFF;
            if (i > 0) { hexSb.append(" "); bytesSb.append(","); }
            hexSb.append(String.format("%02X", b));
            bytesSb.append(b);
        }
        sysexBuffer.clear();
        String msg = "{\"type\":\"midi_in\",\"hex\":\""
            + hexSb.toString() + "\",\"bytes\":["
            + bytesSb.toString() + "]}";
        System.out.println("[Bridge] MIDI IN (reassembled " + len + "b): " + hexSb.toString().substring(0, Math.min(60, hexSb.length())) + "...");
        broadcast(msg);
    }

    static synchronized void sendMidi(byte[] bytes) throws Exception {
        if (outRx == null) throw new Exception("Not connected");
        if (bytes.length == 0) throw new Exception("Empty message");

        int status = bytes[0] & 0xFF;

        if (status == 0xF0) {
            // SysEx — SysexMessage.setMessage expects data WITHOUT the leading
            // 0xF0 (getMessage() includes it, so we strip it here)
            SysexMessage msg = new SysexMessage();
            byte[] data = new byte[bytes.length - 1];
            System.arraycopy(bytes, 1, data, 0, data.length);
            msg.setMessage(SysexMessage.SYSTEM_EXCLUSIVE, data, data.length);
            outRx.send(msg, -1);
        } else {
            // Short message — Program Change (0xC0-0xCF, 2 bytes) or
            // Control Change (0xB0-0xBF, 3 bytes), or any other channel message
            ShortMessage msg = new ShortMessage();
            if (bytes.length >= 3) {
                msg.setMessage(status, bytes[1] & 0xFF, bytes[2] & 0xFF);
            } else if (bytes.length == 2) {
                msg.setMessage(status, bytes[1] & 0xFF, 0);
            } else {
                msg.setMessage(status);
            }
            outRx.send(msg, -1);
        }

        StringBuilder hexSb = new StringBuilder();
        for (int i = 0; i < bytes.length; i++) {
            if (i > 0) hexSb.append(" ");
            hexSb.append(String.format("%02X", bytes[i] & 0xFF));
        }
        System.out.println("[Bridge] MIDI OUT: " + hexSb.toString());
    }

    // ── WEBSOCKET SEND ────────────────────────────────────────────────────
    static synchronized void wsSend(Socket sock, String text) throws Exception {
        byte[] payload = text.getBytes(StandardCharsets.UTF_8);
        OutputStream out = sock.getOutputStream();
        out.write(0x81); // FIN + text frame
        int len = payload.length;
        if (len <= 125) {
            out.write(len);
        } else if (len <= 65535) {
            out.write(126);
            out.write((len >> 8) & 0xFF);
            out.write(len & 0xFF);
        } else {
            out.write(127);
            for (int i = 7; i >= 0; i--) out.write((len >> (i * 8)) & 0xFF);
        }
        out.write(payload);
        out.flush();
    }

    static void broadcast(String text) {
        for (Socket s : clients) {
            try { wsSend(s, text); }
            catch (Exception e) { clients.remove(s); }
        }
    }

    // ── UTILITIES ─────────────────────────────────────────────────────────
    static byte[] hexToBytes(String hex) {
        String[] parts = hex.trim().split("\\s+");
        byte[] bytes = new byte[parts.length];
        for (int i = 0; i < parts.length; i++)
            bytes[i] = (byte) Integer.parseInt(parts[i], 16);
        return bytes;
    }

    static String esc(String s) {
        if (s == null) return "";
        return s.replace("\\","\\\\").replace("\"","\\\"")
                .replace("\n","\\n").replace("\r","\\r");
    }

    // Minimal JSON string extractor - no library needed
    static String jsonStr(String json, String key) {
        String search = "\"" + key + "\":\"";
        int idx = json.indexOf(search);
        if (idx < 0) return null;
        idx += search.length();
        int end = json.indexOf("\"", idx);
        return end < 0 ? null : json.substring(idx, end);
    }

    static int jsonInt(String json, String key, int def) {
        String search = "\"" + key + "\":";
        int idx = json.indexOf(search);
        if (idx < 0) return def;
        idx += search.length();
        int end = idx;
        while (end < json.length() && (Character.isDigit(json.charAt(end)) || json.charAt(end) == '-'))
            end++;
        try { return Integer.parseInt(json.substring(idx, end)); }
        catch (Exception e) { return def; }
    }
}
