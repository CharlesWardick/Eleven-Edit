// End-to-end smoke test: WebSocket protocol -> bridge -> CoreMIDI -> fake rack -> back.
const URL = 'ws://127.0.0.1:57121';
const msgs = [];
function connect(tries = 40) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    ws.onopen = () => res(ws);
    ws.onerror = () => { ws.close?.(); tries > 0 ? setTimeout(() => connect(tries - 1).then(res, rej), 250) : rej(new Error('bridge never came up')); };
  });
}
function waitFor(pred, ms = 6000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      const i = msgs.findIndex(pred);
      if (i >= 0) return res(msgs.splice(i, 1)[0]);
      if (Date.now() - t0 > ms) return rej(new Error('timeout waiting; have ' + JSON.stringify(msgs.map(m => m.type + ':' + (m.hex || m.message || '').slice(0, 30)))));
      setTimeout(poll, 20);
    })();
  });
}
const ok = (c, what) => { if (!c) { console.error('FAIL: ' + what); process.exit(1); } console.log('ok  ' + what); };
const ws = await connect();
ws.onmessage = e => msgs.push(JSON.parse(e.data));
const send = o => ws.send(JSON.stringify(o));

const ports = await waitFor(m => m.type === 'ports');
ok(Array.isArray(ports.devices) && ports.devices.every((d, i) => d.index === i), 'ports list arrives on connect, indexes are positions');
const inDev  = ports.devices.find(d => d.kind === 'in'  && d.name.includes('fake'));
const outDev = ports.devices.find(d => d.kind === 'out' && d.name.includes('fake'));
ok(inDev && outDev, 'fake rack visible as in [' + inDev?.index + '] and out [' + outDev?.index + ']');

send({ cmd: 'connect', inPort: outDev.index, outPort: inDev.index });
const bad = await waitFor(m => m.type === 'error');
ok(/not an input|not an output/.test(bad.message), 'swapped in/out rejected with a clear error');

send({ cmd: 'connect', inPort: inDev.index, outPort: outDev.index });
const c = await waitFor(m => m.type === 'connected');
ok(c.inPort === inDev.index && c.outPort === outDev.index, 'connected echoes the chosen ports');

send({ cmd: 'send', hex: 'F0 7E 7F 06 01 F7' });
const id = await waitFor(m => m.type === 'midi_in' && m.bytes[1] === 0x7E);
ok(id.hex.endsWith('30 31 35 37 F7') && id.bytes.length === 17, 'identity request -> reply with build "0157" (' + id.hex + ')');

send({ cmd: 'send', hex: 'C0 23' });
ok((await waitFor(m => m.type === 'midi_in' && m.hex === 'C0 23')), 'program change round-trips');
send({ cmd: 'send', hex: 'B0 45 40' });
ok((await waitFor(m => m.type === 'midi_in' && m.hex === 'B0 45 40')), 'control change round-trips');

const body = Array.from({ length: 1194 }, (_, i) => (i & 0x7F).toString(16).padStart(2, '0').toUpperCase());
send({ cmd: 'send', hex: ['F0', '13', '0B', '0F', '01', '7F', ...body, 'F7'].join(' ') });
const big = await waitFor(m => m.type === 'midi_in' && m.bytes.length === 1300);
ok(big.bytes[0] === 0xF0 && big.bytes[5] === 0x7F && big.bytes[1299] === 0xF7 && big.bytes[6 + 200] === (200 & 0x7F), '1200-byte SysEx out, 1300-byte SysEx back, reassembled whole');
ok(!msgs.some(m => m.type === 'midi_in' && m.bytes[0] === 0xF0 && m.bytes[m.bytes.length - 1] !== 0xF7), 'no fragmented SysEx leaked through');

send({ cmd: 'send', hex: 'ZZ' });
ok(/bad hex/.test((await waitFor(m => m.type === 'error')).message), 'bad hex rejected');
send({ cmd: 'nope' });
ok(/unknown cmd/.test((await waitFor(m => m.type === 'error')).message), 'unknown cmd rejected');

send({ cmd: 'disconnect' });
ok(await waitFor(m => m.type === 'disconnected'), 'disconnect acknowledged');
send({ cmd: 'send', hex: 'C0 01' });
ok(/Not connected/.test((await waitFor(m => m.type === 'error')).message), 'send while disconnected -> Not connected');
send({ cmd: 'list_ports' });
ok(await waitFor(m => m.type === 'ports'), 'list_ports answers');
console.log('PASS');
ws.close();
process.exit(0);
