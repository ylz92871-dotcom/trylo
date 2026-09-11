// Trylo Desktop — packaged workd sidecar smoke (audit P0-C §5.2 / §5.3-R03).
//
// Boots the REAL daemon from the PACKAGED layout —
// `resources/workd/dist/daemon/daemon/main.js` through the wrapper — and
// walks the minimum Control Plane round-trip the installed app depends on:
//
//   1. readiness (the daemon binds its Control Plane port)
//   2. workspace.list
//   3. managedSession.create → get → cancel
//
// The user-machine contract this proves: NO npm, NO build, NO rebuild —
// the child runs the prebuilt artifact with the pinned Node only.
//
// Usage: node scripts/smoke-workd-sidecar.mjs
//   TRYLO_WORKD_PACKAGED_DIR  defaults to desktop/src-tauri/resources/workd
//   Exits 0 on PASS, 1 on FAIL. The daemon child is always killed.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const resourcesRoot = path.join(desktopRoot, 'src-tauri', 'resources');
const packagedDir = process.env.TRYLO_WORKD_PACKAGED_DIR
  ?? path.join(resourcesRoot, 'workd');
const wrapper = path.join(repoRoot, 'work', 'bin', 'trylo-workd.mjs');
const pinnedNode = path.join(resourcesRoot, 'runtime', 'node', 'win-x64', 'node.exe');
const nodeExe = existsSync(pinnedNode) ? pinnedNode : process.execPath;

// ws resolves from the desktop-services package (the sidecar-adjacent copy).
const requireDs = createRequire(path.join(repoRoot, 'desktop-services', 'package.json'));
const WebSocket = requireDs('ws');

function log(m) { console.log(`[smoke-workd] ${m}`); }
function fail(m) { console.error(`[smoke-workd] FAIL: ${m}`); }

function waitPort(port, host, deadline) {
  return new Promise((resolveP, rejectP) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host });
      socket.once('connect', () => { socket.destroy(); resolveP(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) rejectP(new Error(`port ${port} never opened`));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

/** Minimal Control Plane client: challenge → connect(token) → req/res. */
function connectControlPlane(url, token, timeoutMs) {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      rejectP(new Error('control-plane handshake timed out'));
    }, timeoutMs);
    const send = (method, params) => new Promise((res, rej) => {
      const id = randomBytes(8).toString('hex');
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
    ws.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        ws.send(JSON.stringify({ type: 'req', id: randomBytes(8).toString('hex'), method: 'connect', params: { token } }));
        return;
      }
      if ((frame.type === 'res' || frame.type === 'response') && frame.id && pending.has(frame.id)) {
        const entry = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.ok === false || frame.error) {
          entry.rej(new Error(frame.error?.message ?? frame.error ?? 'request failed'));
        } else {
          // cowork's res frame carries the method result under `payload`.
          entry.res(frame.payload ?? frame.result ?? frame.data ?? {});
        }
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
    ws.on('open', () => { /* wait for the challenge */ });
    // The handshake completes when the server answers our `connect` request.
    // Detect it via the first successful response OR the connect.success event.
    ws.on('message', (data) => {
      let frame;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (frame.type === 'event' && (frame.event === 'connect.success' || frame.event === 'ready')) {
        clearTimeout(timer);
        resolveP({ ws, send });
      }
    });
  });
}

async function main() {
  for (const p of [path.join(packagedDir, 'dist', 'daemon', 'daemon', 'main.js'), wrapper]) {
    if (!existsSync(p)) {
      fail(`missing ${p} — run scripts/build-workd-sidecar.mjs first`);
      process.exit(1);
    }
  }
  const port = 48000 + Math.floor(Math.random() * 1500);
  const token = randomBytes(32).toString('hex');
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'trylo-workd-smoke-'));
  const child = spawn(nodeExe, [wrapper], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TRYLO_WORKD_MODE: 'real',
      TRYLO_WORKD_PORT: String(port),
      TRYLO_WORKD_HOST: '127.0.0.1',
      TRYLO_WORKD_PACKAGED_DIR: packagedDir,
      COWORK_CONTROL_PLANE_TOKEN: token,
      COWORK_USER_DATA_DIR: userDataDir,
    },
  });
  let stderrTail = '';
  child.stderr.on('data', (d) => { stderrTail = `${stderrTail}${d}`.slice(-4000); });
  child.stdout.on('data', () => {});

  let conn = null;
  try {
    await waitPort(port, '127.0.0.1', Date.now() + 90_000);
    log(`daemon bound 127.0.0.1:${port}`);
    conn = await connectControlPlane(`ws://127.0.0.1:${port}`, token, 60_000);
    log('control-plane handshake OK');

    const list = await conn.send('workspace.list', {});
    const workspaces = list?.workspaces ?? [];
    log(`workspace.list -> ${workspaces.length} workspace(s)`);

    // The daemon provisions built-in managed agents + environments AFTER the
    // port binds. Poll until the environment exists (bounded).
    const deadline = Date.now() + 60_000;
    let environment = null;
    while (Date.now() < deadline && !environment) {
      const envList = await conn.send('managedEnvironment.list', {});
      const environments = envList?.environments ?? [];
      const workspace = workspaces[0] ?? null;
      environment =
        environments.find((e) => workspace && e.id === `managed-env-${workspace.id}`)
        ?? environments[0]
        ?? null;
      if (!environment) await new Promise((r) => setTimeout(r, 1_500));
    }
    if (!environment) throw new Error('no managed environment provisioned within 60s (agent seeding failed)');
    log(`managedEnvironment.list -> using ${environment.id}`);

    const created = await conn.send('managedSession.create', {
      agentId: 'trylo-managed-work',
      environmentId: environment.id,
      title: 'smoke',
      initialEvent: { type: 'user.message', content: [{ type: 'text', text: 'smoke' }] },
    });
    const session = created?.session;
    if (!session?.id) throw new Error('managedSession.create returned no session');
    log(`managedSession.create -> ${session.id} (${session.status})`);

    const got = await conn.send('managedSession.get', { sessionId: session.id });
    if (!got?.session?.id) throw new Error('managedSession.get returned no session');
    log(`managedSession.get -> ${got.session.status}`);

    await conn.send('managedSession.cancel', { sessionId: session.id });
    log('managedSession.cancel OK');

    console.log('smoke-workd: PASS');
  } catch (error) {
    fail(error?.message ?? error);
    if (stderrTail) console.error(`--- daemon stderr tail ---\n${stderrTail}`);
    process.exitCode = 1;
  } finally {
    try { conn?.ws.close(); } catch { /* already gone */ }
    child.kill();
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main();
