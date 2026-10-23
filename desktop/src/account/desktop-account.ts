import type { RelayAccountStatus, RelayBrowserLogin, RelayBrowserPoll } from '../services-host/methods';

/** Public account operations only. Tokens and browser proof remain in Service Host. */
export interface DesktopAccountPort {
  relayStatus(): Promise<RelayAccountStatus>;
  relayLogout(): Promise<RelayAccountStatus>;
  relayBrowserBegin?(params: { serverUrl: string }): Promise<RelayBrowserLogin>;
  relayBrowserPoll?(params: { id: string }): Promise<RelayBrowserPoll>;
  relayBrowserCancel?(): Promise<{ ok: boolean }>;
  relayBrowserOpen?(params: { id: string }): Promise<{ ok: boolean }>;
  relayAccountOpen?(): Promise<{ ok: boolean }>;
}

export type AccountPhase = 'checking' | 'ready' | 'starting' | 'waiting' | 'cancelling' | 'loggingout' | 'error' | 'expired';
export interface DesktopAccountModel {
  readonly phase: AccountPhase;
  readonly account: RelayAccountStatus | null;
  readonly login: RelayBrowserLogin | null;
  readonly error: string | null;
  readonly busy: boolean;
  readonly refresh: () => Promise<void>;
  readonly start: () => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly reopen: () => Promise<void>;
  readonly openCenter: () => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly retry: () => Promise<void>;
}
