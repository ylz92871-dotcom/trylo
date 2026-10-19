// Exercise the staged runtime with isolated identity data; never touch the
// desktop's pairing identity. --live-conflict explicitly verifies an owned
// Quick Tunnel while the preferred port is occupied; default stays local.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

const root = path.resolve(process.argv[2] || '../desktop/src-tauri/resources');
const live = process.argv.includes('--live-conflict');
const appData = mkdtempSync(path.join(process.argv[3] || tmpdir(), 'trylo-remote-runtime-'));
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = live ? 49380 : server.address().port;
await new Promise(resolve => server.close(resolve));
const child = spawn(path.join(root, 'runtime/node/win-x64/node.exe'), [path.join(root, 'desktop-services/dist/host.bundle.mjs')], {
  cwd: root,
  env: { ...process.env, TRYLO_APP_DATA_DIR: appData, TRYLO_SIDECARS_DIR: path.join(root, 'sidecars') },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const pending = new Map();
let readyResolve, readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
// Attach immediately so an early process error cannot become unhandled.
ready.catch(() => {});
const failure = message => {
  const error = new Error(message);
  readyReject(error);
  for (const request of pending.values()) request.reject(error);
  pending.clear();
};
child.once('error', error => failure(`runtime spawn failed: ${error.code}`));
child.once('exit', code => failure(`runtime exited: ${code}`));
child.stderr.resume();
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.topic === 'ready') readyResolve();
  if (frame.type === 'response') {
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    if (frame.ok) request.resolve(frame.result);
    else request.reject(new Error(`request failed: ${frame.error?.code}`));
  }
});
let sequence = 0;
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ version: 1, type: 'request', id, method, params }) + '\n');
  });
}
let timeout;
try {
  await Promise.race([
    (async () => {
      await ready;
      const account = await request('remote.relayStatus', {});
      if (account.loggedIn || account.online) throw new Error('isolated runtime unexpectedly has a relay account');
      const preferences = await request('remote.loadConfiguration', { enabled: false, connectionMode: 'server', relayUrl: 'https://example.invalid', port });
      if (preferences.enabled || preferences.connectionMode !== 'server') throw new Error('remote preference restore failed');
      const saved = await request('remote.saveConfiguration', { ...preferences, connectionMode: 'tunnel' });
      if (saved.connectionMode !== 'tunnel' || saved.enabled) throw new Error('remote preference save failed');
      const status = await request('remote.enable', live ? { port, tunnelMode: 'named' } : { port, tunnelMode: 'manual', publicUrl: 'https://example.invalid' });
      if (!status.running) throw new Error('gateway did not start');
      if (live && (status.port === port || status.tunnelMode !== 'quick')) throw new Error('conflict did not create an independent tunnel');
      const qr = await request('remote.pairingInfo', {});
      if (!qr.qrDataUrl?.startsWith('data:image/png;base64,') || qr.pairing?.baseUrl !== status.publicUrl) throw new Error('QR invalid');
      if (live) {
        console.log(JSON.stringify({ gatewayRunning: true, port: status.port, independentTunnel: true, qrGenerated: true }));
        const deadline = Date.now() + 25000;
        let verified = false;
        while (Date.now() < deadline && !verified) {
          try {
            const response = await fetch(`${qr.pairing.baseUrl}/v1/snapshot`, { headers: { Authorization: `Bearer ${qr.pairing.token}` }, signal: AbortSignal.timeout(4000) });
            const snapshot = await response.json();
            verified = response.ok && snapshot.device?.id === qr.pairing.deviceId;
          } catch {}
          if (!verified) await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!verified) throw new Error('public tunnel did not reach this Desktop identity');
        console.log(JSON.stringify({ authenticatedPublicSnapshot: true, desktopIdentityMatched: true }));
      }
      await request('remote.disable', {});
      console.log(JSON.stringify({ ready: true, configurationPersisted: true, gatewayRunning: true, qrGenerated: true, stopped: true }));
    })(),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('runtime verification timed out')), live ? 80000 : 12000); }),
  ]);
} finally {
  clearTimeout(timeout);
  // In live mode this also closes only the Quick Tunnel created by this test.
  await Promise.race([request('remote.disable', {}).catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
  lines.close();
  child.kill();
}
