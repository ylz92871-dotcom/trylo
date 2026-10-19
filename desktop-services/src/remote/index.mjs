// Trylo Desktop Services — remote domain composition root (Phase 4, spec §8).
// See migration spec §8 and architecture doc §7.
//
// Wires identity + tunnel + gateway adapter to the Service Host method
// surface. This file is lifecycle wiring only: no gateway policy, no tunnel
// policy, no token handling beyond delegating to identity.mjs (arch §2.3).
//
// Ownership: Desktop is the authority for every remote handler (projects /
// session / task / cancel / permission / chat); the gateway adapter forwards
// those invocations back to Desktop via host.remoteRequest and awaits
// remote.respond. Fun (猫箱) is rejected with 501 at the adapter.
//
// Failure policy: enabling without a vendored gateway module fails closed
// with a reason code; a failing tunnel degrades to LAN pairing (never blocks).

import { createRemoteAdapter } from './gateway-adapter.mjs';
import { createIdentityStore } from './identity.mjs';
import { createTunnelService } from './tunnel-service.mjs';
import { createRelayClient } from './relay-client.mjs';
import { createRemoteConfiguration } from './configuration.mjs';

/**
 * @param {{ emit?: (topic: string, payload: unknown) => void,
 *           log?: (m: string) => void,
 *           seam?: { gateway?: object, tunnel?: object | false, qrcode?: object } }} [options]
 *   `seam` is test-only injection (see gateway-adapter / tunnel-service).
 */
export function createRemoteServices(options = {}) {
  const emit = options.emit ?? (() => {});
  const log = options.log ?? null;
  const seam = options.seam ?? {};
  let mode = 'tunnel', relayState = { online: false };
  let operations = Promise.resolve();
  const serialize = operation => { const result = operations.then(operation); operations = result.catch(() => {}); return result; };
  const relay = createRelayClient({ appDataDir: options.appDataDir, allowLocal: seam.allowLocalRelay === true,
    onStatus(state) { relayState = state; if (mode === 'server') emit('remote.status', readStatus()); } });
  const configuration = createRemoteConfiguration({ appDataDir: options.appDataDir, relay });
  function readStatus() {
    const local = adapter.status();
    if (mode !== 'server') return local;
    return { ...local, connectionMode: mode, publicUrl: relayState.serverUrl || '', running: local.running && relayState.online,
      tunnelMode: 'off', tunnelRunning: false, reasonCode: relayState.online ? '' : relayState.loggedIn ? 'relay_reconnecting' : 'relay_login_required' };
  }

  const identity = createIdentityStore({ log, appDataDir: options.appDataDir });
  const tunnel = createTunnelService({ log, seam: { tunnel: seam.tunnel } });
  const adapter = createRemoteAdapter({
    identity,
    tunnel,

    emit(topic, payload) { emit(topic, topic === 'remote.status' && mode === 'server' ? readStatus() : payload); },
    log,
    seam: { gateway: seam.gateway, qrcode: seam.qrcode },
  });

  return {
    identity,
    tunnel,

    loadConfiguration(params = {}) { return configuration.load(params); },
    saveConfiguration(params = {}) { return configuration.save(params); },

    // ── remote.* methods (spec §8.1) ────────────────────────────────
    status() {
      return readStatus();
    },

    enable(params = {}) {
      return serialize(async () => {
        await relay.disable(); mode = params.connectionMode === 'server' ? 'server' : 'tunnel';
        await adapter.enable(mode === 'server' ? { ...params, tunnelMode: 'off' } : params);
        if (mode === 'server') {
          try { relayState = await relay.enable({ ...adapter.relayTarget(), serverUrl: params.relayUrl }); }
          catch (failure) { await adapter.disable(); throw failure; }
        }
        const status = readStatus(); emit('remote.status', status); return status;
      });
    },

    disable() {
      return serialize(async () => { await relay.disable(); return adapter.disable(); });
    },

    async publish(event) {
      return adapter.publish(event);
    },

    async pairingInfo() {
      return mode === 'server' ? relay.pairing() : adapter.pairingInfo();
    },

    relayLogin(params) { return serialize(() => relay.login(params)); },
    relayStatus() { return relay.status(); },
    relayLogout() { return serialize(async () => { const result = await relay.logout(); if (mode === 'server') await adapter.disable(); return result; }); },

    async respond(params = {}) {
      return adapter.respond(params);
    },

    async emitToHandler(params = {}) {
      return adapter.emitToHandler(params);
    },

    /** One-time legacy identity import (arch §7.4): copies the old plugin's
     *  remote-identity.json when no Desktop identity exists yet. */
    async importIdentity(params = {}) {
      return identity.importLegacy({ legacyDir: params?.legacyDir });
    },
  };
}
