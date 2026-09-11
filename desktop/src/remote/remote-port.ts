// Trylo Desktop — Remote port (architecture doc §4.3 / migration spec §8.1).
//
// `RemotePort` is the Desktop's stable boundary for Remote: interface +
// adapter only. The implementation forwards to the Service Host's remote
// domain, which runs the byte-identical vendored gateway. The gateway's
// handlers are owned by Desktop (via host.remoteRequest → remote.respond);
// this side only pushes projection events (remote.publish) and answers
// forwarded handler invocations.
//
// Token/deviceSeed never cross this boundary in plain settings/logs — the
// pairing token only appears inside the `remote.pairingInfo` result, which
// the Settings UI shows as a QR code (spec §8.1.3 / arch §7.4).

import type { ServiceManager } from '../services-host/service-manager';
import type {
  RemoteEnableParams,
  RemoteGatewayEvent,
  RemotePairingInfoResult,
  RemoteRespondParams,
  RemoteStatusResult,
} from '../services-host/methods';

/** A gateway handler invocation the sidecar forwarded (host.remoteRequest). */
export interface RemoteRequest {
  readonly requestId: string;
  readonly name: string;
  readonly payload: unknown;
}

export interface RemotePort {
  /** Query the gateway+tunnel state. Safe to poll; never starts anything. */
  status(): Promise<RemoteStatusResult>;
  /** Start the gateway (and tunnel when configured). Idempotent. */
  enable(config: RemoteEnableParams): Promise<RemoteStatusResult>;
  /** Stop the gateway + tunnel, releasing port 49380 (arch §7.6). */
  disable(): Promise<{ readonly ok: boolean }>;
  /** Push a projection event into the gateway's in-memory snapshot. */
  publish(event: RemoteGatewayEvent): Promise<{ readonly ok: boolean }>;
  /** Pairing payload + QR data URL for the Settings page. */
  pairingInfo(): Promise<RemotePairingInfoResult>;
  /** Answer a forwarded gateway handler invocation. */
  respond(params: RemoteRespondParams): Promise<{ readonly ok: boolean }>;
  /** Stream an action_event back to mobile on behalf of an in-flight handler. */
  emit(requestId: string, payload: unknown): Promise<{ readonly ok: boolean }>;
  /** One-time legacy identity import (spec §7.6 / arch §7.4). */
  importIdentity(legacyDir?: string): Promise<{
    readonly imported: boolean;
    readonly skipped: boolean;
    readonly reason?: string;
  }>;
}

/** Every field present, nothing running — used before the first query and
 *  after shutdown so the UI never renders `undefined`. */
export const EMPTY_REMOTE_STATUS: RemoteStatusResult = {
  ok: false,
  enabled: false,
  running: false,
  port: 49380,
  publicUrl: '',
  tunnelMode: 'off',
  tunnelRunning: false,
  reasonCode: 'not_attempted',
};

export class ServicesRemotePort implements RemotePort {
  constructor(private readonly manager: ServiceManager) {}

  async status(): Promise<RemoteStatusResult> {
    try {
      return await this.manager.client.request('remote.status');
    } catch {
      // The sidecar is gone; "not attempted" is the honest answer and the
      // renderer shows the service-host health alongside it.
      return EMPTY_REMOTE_STATUS;
    }
  }

  enable(config: RemoteEnableParams): Promise<RemoteStatusResult> {
    return this.manager.client.request('remote.enable', config);
  }

  async disable(): Promise<{ readonly ok: boolean }> {
    return this.manager.client.request('remote.disable');
  }

  async publish(event: RemoteGatewayEvent): Promise<{ readonly ok: boolean }> {
    return this.manager.client.request('remote.publish', event);
  }

  pairingInfo(): Promise<RemotePairingInfoResult> {
    return this.manager.client.request('remote.pairingInfo');
  }

  async respond(params: RemoteRespondParams): Promise<{ readonly ok: boolean }> {
    return this.manager.client.request('remote.respond', params);
  }

  async emit(requestId: string, payload: unknown): Promise<{ readonly ok: boolean }> {
    return this.manager.client.request('remote.emit', { requestId, payload });
  }

  importIdentity(legacyDir?: string): Promise<{
    readonly imported: boolean;
    readonly skipped: boolean;
    readonly reason?: string;
  }> {
    return this.manager.client.request('remote.importIdentity', { legacyDir });
  }
}
