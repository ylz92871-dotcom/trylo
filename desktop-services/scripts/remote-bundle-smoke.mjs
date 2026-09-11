// Sanity: round-trip remote.status + remote.enable/disable through the bundle.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The Tauri shell supplies these env vars to the real sidecar; replicate them
// so the bundle resolves identity + the vendored gateway.
const appDataDir = mkdtempSync(path.join(tmpdir(), 'trylo-remote-smoke-'));

const p = spawn('node', ['dist/host.bundle.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    TRYLO_APP_DATA_DIR: appDataDir,
    TRYLO_SIDECARS_DIR: path.resolve('..', 'desktop', 'sidecars'),
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
const send = (frame) => p.stdin.write(`${JSON.stringify(frame)}\n`);

const timers = [];
function after(ms, fn) {
  const t = setTimeout(fn, ms);
  timers.push(t);
  return t;
}

function frame(line) {
  try { return JSON.parse(line); } catch { return null; }
}

let step = 0;
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const f = frame(line);
    if (!f) continue;
    if (f.topic === 'ready') {
      send({ version: 1, type: 'request', id: '1', method: 'remote.status', params: {} });
    } else if (f.type === 'response' && f.id === '1') {
      console.log('STEP1 remote.status =>', JSON.stringify(f.result));
      send({ version: 1, type: 'request', id: '2', method: 'remote.enable', params: { port: 49390, tunnelMode: 'off' } });
    } else if (f.type === 'response' && f.id === '2') {
      console.log('STEP2 remote.enable =>', JSON.stringify(f));
      send({ version: 1, type: 'request', id: '3', method: 'remote.pairingInfo', params: {} });
    } else if (f.type === 'response' && f.id === '3') {
      const r = f.result;
      console.log('STEP3 pairingInfo =>', JSON.stringify({ pairing: r.pairing, qr: r.qrDataUrl ? 'data-url:' + r.qrDataUrl.slice(0, 30) : '' }));
      send({ version: 1, type: 'request', id: '4', method: 'remote.disable', params: {} });
    } else if (f.type === 'response' && f.id === '4') {
      console.log('STEP4 remote.disable =>', JSON.stringify(f.result));
      for (const t of timers) clearTimeout(t);
      p.kill();
      process.exit(0);
    } else if (f.topic === 'remote.status') {
      console.log('EVENT remote.status =>', JSON.stringify(f.payload));
    }
  }
});
after(10000, () => {
  console.log('TIMEOUT — remote.* round trip did not complete');
  p.kill();
  process.exit(1);
});
