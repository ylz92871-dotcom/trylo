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

const require = createRequire(import.meta.url);

export const REMOTE_HANDLER_TIMEOUT_MS = 30_000;
const DEFAULT_PORT = 49380;
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

// Static `require('qrcode')` (not dynamic import): esbuild then INLINES the CJS
// package and converts its internal `require('fs')` into a real import. A
// dynamic `import('qrcode')` stays a runtime ESM import and hits "Dynamic
// require of 'fs' is not supported" when the bundled CJS runs under Node ESM
// (verified in the dist bundle, 2026-08-28).
let qrcodeModule = null;
try {
  qrcodeModule = require('qrcode');
} catch {
  qrcodeModule = null;
}

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
  async function enable(params = {}) {
    if (!gatewayModule) {
      reasonCode = 'gateway_module_missing';
      emitStatus();
      throw new Error('Remote gateway module is unavailable.');
    }
    if (gateway) await disable();
    const identityValue = await identity.loadOrCreate();
    port = Math.max(1024, Math.min(65535, Number(params.port) || DEFAULT_PORT));
    workspaceName = String(params.workspaceName || 'Trylo Code');
    tunnelMode = String(params.tunnelMode || 'named').toLowerCase();
    publicUrl = '';
    tunnelRunning = false;

    gateway = gatewayModule.createRemoteGateway({
      port,
      host: '127.0.0.1',
      authToken: identityValue.pairingToken,
      workspaceName,
      deviceName: String(params.deviceName || os.hostname()),
      deviceSeed: identityValue.deviceSeed,
      handlers: buildHandlers(),
    });
    await gateway.start();
    enabled = true;
    reasonCode = '';

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
        // Tunnel is optional: Remote works on LAN without it. Record and
        // continue so the user can still pair over the local network.
        sanitizedNote(`tunnel start failed (${err?.message || err}) — LAN pairing still available`);
      }
    }
    emitStatus();
    return readStatus();
  }

  /** D→S `remote.disable`. Stops tunnel then gateway, releasing the port
   *  (arch §7.6: a later owner can bind 49380). */
  async function disable() {
    if (tunnel && tunnelRunning) {
      await tunnel.stop().catch(() => {});
      tunnelRunning = false;
    }
    const active = gateway;
    gateway = null;
    enabled = false;
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
    if (!gateway) {
      throw Object.assign(new Error('Remote gateway is not running.'), { code: 'REMOTE_NOT_RUNNING' });
    }
    const pairing = gateway.getPairingInfo(publicUrl || undefined);
    let qrDataUrl = '';
    try {
      const QRCode = qrcode ?? qrcodeModule;
      qrDataUrl = await QRCode.toDataURL(JSON.stringify(pairing));
    } catch (err) {
      sanitizedNote(`QR generation failed (${err?.message || err})`);
    }
    return { pairing, qrDataUrl };
  }

  function status() {
    return readStatus();
  }

  return {
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
