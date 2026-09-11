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

  const identity = createIdentityStore({ log });
  const tunnel = createTunnelService({ log, seam: { tunnel: seam.tunnel } });
  const adapter = createRemoteAdapter({
    identity,
    tunnel,
    emit,
    log,
    seam: { gateway: seam.gateway, qrcode: seam.qrcode },
  });

  return {
    identity,
    tunnel,

    // ── remote.* methods (spec §8.1) ────────────────────────────────
    status() {
      return adapter.status();
    },

    async enable(params = {}) {
      return adapter.enable(params);
    },

    async disable() {
      return adapter.disable();
    },

    async publish(event) {
      return adapter.publish(event);
    },

    async pairingInfo() {
      return adapter.pairingInfo();
    },

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
