// Trylo Desktop Services — remote gateway adapter (migration spec §8.1, arch §7.2/§7.3).
//
// Owns ONE `createRemoteGateway` instance (vendor/legacy/remote-gateway/
// index.js carries the additive Trylo P3 patch — surface forwarding plus the
// read-only /v1/artifacts routes, recorded in work/README.md "Vendor
// patches") and maps its handlers to the Desktop, the
// authority for every domain. Because the Desktop is a SEPARATE process, each
// gateway handler invocation is forwarded over the frame protocol:
//
//   S→D event  host.remoteRequest { requestId, name, payload }
//   D→S method remote.respond      { requestId, ok, result?, error? }
//   D→S method remote.emit         { requestId, action, payload }  (streaming)
//
// This mirrors the pet-chat pattern (host.petChat / pet.chatHandle): the
// sidecar never guesses a handler's answer, it asks the owner. A handler whose
// Desktop response never arrives rejects after HANDLER_TIMEOUT_MS (fail-closed,
// the gateway turns it into a 500).
//
// Fun (猫箱) is NOT migrated (spec §1 / §12): the `fun` handler always throws
// 501 so the mobile Fun pages degrade naturally. `handoff` releases the port by
// stopping this gateway (arch §7.6).
//
// Token/deviceSeed come from identity.mjs and NEVER reach logs or settings.

import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import qrcodeModule from 'qrcode';

const require = createRequire(import.meta.url);

export const REMOTE_HANDLER_TIMEOUT_MS = 30_000;
const DEFAULT_PORT = 49380;
async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}
const KNOWN_HANDLERS = [
  'projects',
  'project',
  'session',
  'task',
  'cancel',
  'permission',
  'chat',
  'artifacts',
  'artifact',
  'handoff',
];

/// Locate the byte-identical vendored gateway module. Same layout reasoning as
/// pet-channel resolveVendorBridgeModule.
function resolveVendorGatewayModule() {
  const rel = path.join('vendor', 'legacy', 'remote-gateway', 'index.js');
  const candidates = [];
  if (process.argv[1]) {
    candidates.push(path.resolve(path.dirname(path.resolve(process.argv[1])), '..', rel));
  }
  candidates.push(fileURLToPath(new URL('../../' + rel, import.meta.url)));
  for (const candidate of candidates) {
    if (candidate && require('node:fs').existsSync(candidate)) return candidate;
  }
  return null;
}

// The static import above lets esbuild include QRCode. A local createRequire
// call stays external and would require an unstaged node_modules/qrcode.
// The bundle banner supplies Node require for QRCode's built-in fs/zlib use.

/**
 * @param {{ identity: object, tunnel?: object, emit?: (topic: string, payload: unknown) => void,
 *           log?: (m: string) => void, handlerTimeoutMs?: number,
 *           seam?: { gateway?: object, qrcode?: object } }} options
 *   `identity` is the createIdentityStore() return (loadOrCreate / filePath).
 *   `tunnel` is the createTunnelService() return (start/stop/status).
 *   `emit` is the host's S→D event emitter (host.remoteRequest, remote.status).
 *   `handlerTimeoutMs` is the per-handler Desktop-response timeout (testable).
 *   `seam` is test-only injection for the vendored gateway and qrcode.
 */
export function createRemoteAdapter(options) {
  const identity = options.identity;
  const tunnel = options.tunnel ?? null;
  const emit = options.emit ?? (() => {});
  const log = options.log ?? null;
  const handlerTimeoutMs = options.handlerTimeoutMs ?? REMOTE_HANDLER_TIMEOUT_MS;
  const seamGateway = options.seam?.gateway;
  let gatewayModule = seamGateway;
  if (gatewayModule === undefined) {
    const modulePath = resolveVendorGatewayModule();
    gatewayModule = modulePath ? require(modulePath) : null;
  }
  if (!gatewayModule) {
    log?.('remote gateway: vendored remote-gateway module not found — remote disabled');
  }
  const qrcode = options.seam?.qrcode ?? null;

  let gateway = null;
  let enabled = false;
  let reasonCode = '';
  let port = DEFAULT_PORT;
  let workspaceName = 'Trylo Code';
  let publicUrl = '';
  let tunnelMode = 'named';
  let tunnelRunning = false;
  let lifecycle = Promise.resolve();
  const serialize = operation => {
    const next = lifecycle.then(operation);
    lifecycle = next.catch(() => {});
    return next;
  };
  /** In-flight handler invocations awaiting the Desktop response. */
  const pending = new Map();

  function sanitizedNote(message) {
    log?.(`remote gateway: ${message}`);
  }

  function readStatus() {
    return {
      ok: Boolean(gateway),
      enabled,
      running: Boolean(gateway?.listening),
      port,
      publicUrl,
      tunnelMode: tunnelRunning ? tunnelMode : 'off',
      tunnelRunning,
      reasonCode,
    };
  }

  function emitStatus() {
    emit('remote.status', readStatus());
  }

  /** Forward one gateway handler call to Desktop and await its response.
   *  `emitPayload` is the gateway's per-invocation onEmit closure (streaming
   *  back to mobile as action_event). */
  function forward(name, payload, emitPayload) {
    if (!gateway) {
      return Promise.reject(Object.assign(new Error('Remote gateway is not running.'), { statusCode: 409 }));
    }
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`remote handler '${name}' timed out waiting for Desktop.`));
      }, handlerTimeoutMs);
      pending.set(requestId, {
        name,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        emitPayload: typeof emitPayload === 'function' ? emitPayload : null,
      });
      emit('host.remoteRequest', { requestId, name, payload });
    });
  }

  /** D→S `remote.respond`: the Desktop's answer to a forwarded handler. */
  function respond(params) {
    const requestId = String(params?.requestId || '');
    const entry = pending.get(requestId);
    if (!entry) return { ok: false, error: 'unknown requestId' };
    pending.delete(requestId);
    if (params?.ok) {
      entry.resolve(params.result);
    } else {
      const error = params?.error && typeof params.error === 'object'
        ? params.error
        : { code: 'REMOTE_HANDLER_ERROR', message: String(params?.error?.message ?? params?.error ?? 'handler failed') };
      entry.reject(Object.assign(new Error(error.message || 'handler failed'), { statusCode: error.statusCode || 500 }));
    }
    return { ok: true };
  }

  /** D→S `remote.emit`: stream an action_event back to mobile on behalf of an
   *  in-flight handler (chat streaming). Unknown requestId is dropped. */
  function emitToHandler(params) {
    const entry = pending.get(String(params?.requestId || ''));
    if (!entry?.emitPayload) return { ok: false };
    entry.emitPayload(params.payload);
    return { ok: true };
  }

  /** The `fun` (猫箱) handler — capability unavailable (spec §1 / §8.1). */
  function funUnavailable() {
    return Promise.reject(
      Object.assign(new Error('Fun (猫箱) is not supported in this version.'), { statusCode: 501 }),
    );
  }

  function buildHandlers() {
    const handlers = {};
    // Fun (猫箱) is explicitly not migrated — every fun request is rejected
    // with 501 so the mobile Fun pages degrade naturally (spec §1 / §8.1).
    handlers.fun = funUnavailable;
    for (const name of KNOWN_HANDLERS) {
      if (name === 'fun') continue;
      if (name === 'handoff') {
        handlers.handoff = async () => {
          // Stop AFTER the response frame is flushed — stopping mid-request
          // would swallow the 202 the gateway is about to send.
          setImmediate(() => void disable());
          return { ok: true, stopped: true };
        };
        continue;
      }
      handlers[name] = (payload, onEmit) => forward(name, payload, onEmit);
    }
    return handlers;
  }

  /** D→S `remote.enable`. Creates+starts the gateway and, when configured,
   *  the tunnel. Idempotent: re-enabling with new config restarts cleanly. */
  function enable(params = {}) {
    return serialize(() => enableGateway(params));
  }

  async function enableGateway(params) {
    if (!gatewayModule) {
      reasonCode = 'gateway_module_missing';
      emitStatus();
      throw new Error('Remote gateway module is unavailable.');
    }
    if (gateway) await disableGateway();
    const identityValue = await identity.loadOrCreate();
    const preferredPort = Math.trunc(Math.max(1024, Math.min(65535, Number(params.port) || DEFAULT_PORT)));
    port = preferredPort;
    workspaceName = String(params.workspaceName || 'Trylo Code');
    tunnelMode = String(params.tunnelMode || 'named').toLowerCase();
    publicUrl = '';
    tunnelRunning = false;

    // Own a listener independently of any other process. Never kill or hand
    // off another program merely because it occupies the preferred port.
    for (let attempt = 0; attempt < 8; attempt++) {
      port = attempt === 0 ? preferredPort : attempt === 1 && preferredPort < 65535 ? preferredPort + 1 : await availablePort();
      const candidate = gatewayModule.createRemoteGateway({
        port,
        host: '127.0.0.1',
        authToken: identityValue.pairingToken,
        workspaceName,
        deviceName: String(params.deviceName || os.hostname()),
        deviceSeed: identityValue.deviceSeed,
        handlers: buildHandlers(),
      });
      try {
        await candidate.start();
        gateway = candidate;
        break;
      } catch (error) {
        await candidate.stop().catch(() => {});
        // Windows excluded port ranges can reject a nearby port with EACCES.
        // Ask the OS for an available listener after the first nearby retry.
        const unavailable = error?.code === 'EADDRINUSE' || error?.code === 'EACCES';
        if (unavailable && attempt < 7) continue;
        gateway = null;
        enabled = false;
        reasonCode = unavailable ? 'port_in_use' : 'gateway_start_failed';
        emitStatus();
        if (unavailable) {
          throw Object.assign(new Error(`无法为 Desktop 分配可用的远程端口（首选 ${preferredPort}），请稍后重试。`), { code: 'REMOTE_PORT_IN_USE' });
        }
        throw error;
      }
    }
    enabled = true;
    reasonCode = port === preferredPort ? '' : 'port_fallback';

    // A static named/manual URL may still point to the occupied port and a
    // different authority. Use a Desktop-owned tunnel for the actual listener.
    if (port !== preferredPort && (tunnelMode === 'named' || tunnelMode === 'manual')) {
      tunnelMode = 'quick';
    }

    // Tunnel after the gateway is listening so the tunnel can reach it.
    if (tunnel && tunnelMode !== 'off') {
      try {
        const tunnelResult = await tunnel.start({
          port,
          mode: tunnelMode,
          publicUrl: params.publicUrl,
          cloudflaredPath: params.cloudflaredPath,
          timeoutMs: params.tunnelTimeoutMs,
        });
        publicUrl = tunnelResult.publicUrl || '';
        tunnelRunning = tunnelResult.running;
      } catch (err) {
        // Keep the loopback gateway available for diagnostics/retry. Phone
        // pairing still requires an externally reachable HTTPS endpoint.
        sanitizedNote(`tunnel start failed (${err?.message || err}) — phone pairing requires HTTPS`);
        reasonCode = 'tunnel_start_failed';
      }
    }
    emitStatus();
    return readStatus();
  }

  /** D→S `remote.disable`. Stops tunnel then gateway, releasing the port
   *  (arch §7.6: a later owner can bind 49380). */
  function disable() {
    return serialize(disableGateway);
  }

  async function disableGateway() {
    if (tunnel && tunnelRunning) {
      await tunnel.stop().catch(() => {});
      tunnelRunning = false;
    }
    const active = gateway;
    gateway = null;
    enabled = false;
    publicUrl = '';
    if (active) {
      await active.stop().catch(() => {});
    }
    // Reject anything still awaiting the Desktop (we are going away).
    for (const entry of pending.values()) {
      entry.reject(new Error('Remote gateway disabled.'));
    }
    pending.clear();
    emitStatus();
    return { ok: true };
  }

  /** D→S `remote.publish`: Desktop pushes projection events into the gateway's
   *  in-memory snapshot, which broadcasts snapshot_update to mobile. */
  async function publish(event) {
    if (!gateway || !enabled) return { ok: false, error: 'Remote gateway is not running.' };
    gateway.publish(event);
    return { ok: true };
  }

  /** D→S `remote.pairingInfo`: pairing payload (identity token + tunnel/local
   *  base URL) plus a QR data URL for the phone. */
  async function pairingInfo() {
    if (!gateway?.listening || !enabled) {
      throw Object.assign(new Error('Remote gateway is not running.'), { code: 'REMOTE_NOT_RUNNING' });
    }
    // The listener is loopback-only; its fallback URL cannot be reached by a
    // phone and production mobile correctly requires HTTPS. Never turn that
    // local diagnostic endpoint into a misleading pairing QR.
    let pairingUrl;
    try { pairingUrl = new URL(publicUrl); } catch {}
    if (!pairingUrl || pairingUrl.protocol !== 'https:'
      || ['localhost', '127.0.0.1', '[::1]'].includes(pairingUrl.hostname)
      || pairingUrl.username || pairingUrl.password || pairingUrl.search || pairingUrl.hash
      || (pairingUrl.pathname !== '' && pairingUrl.pathname !== '/')) {
      if (reasonCode === 'tunnel_start_failed') {
        throw Object.assign(new Error('Desktop 本地服务已启动，但远程通道启动失败。请检查网络后重试生成二维码。'), { code: 'REMOTE_TUNNEL_FAILED' });
      }
      throw Object.assign(new Error('手机配对需要可从手机访问的 HTTPS 远程地址。请在远程设置中配置隧道或 HTTPS 地址后重试。'), {
        code: 'REMOTE_PUBLIC_URL_REQUIRED', statusCode: 409,
      });
    }
    const pairing = gateway.getPairingInfo(publicUrl || undefined);
    let qrDataUrl = '';
    try {
      const QRCode = qrcode ?? qrcodeModule;
      qrDataUrl = await QRCode.toDataURL(JSON.stringify(pairing));
    } catch (err) {
      sanitizedNote(`QR generation failed (${err?.message || err})`);
      throw Object.assign(new Error('配对二维码生成失败，请重试或检查桌面程序的配套服务文件。'), {
        code: 'REMOTE_QR_FAILED',
      });
    }
    if (!qrDataUrl) throw Object.assign(new Error('配对二维码生成失败，请重试。'), { code: 'REMOTE_QR_FAILED' });
    return { pairing, qrDataUrl };
  }

  function status() {
    return readStatus();
  }

  return {
    // Private composition boundary. Never exposed as an RPC method.
    relayTarget() {
      if (!gateway?.listening || !enabled) throw new Error('Remote gateway is not running.');
      return gateway.getPairingInfo(`http://127.0.0.1:${port}`);
    },
    enable,
    disable,
    publish,
    pairingInfo,
    respond,
    emitToHandler,
    status,
    get enabled() {
      return enabled;
    },
  };
}
