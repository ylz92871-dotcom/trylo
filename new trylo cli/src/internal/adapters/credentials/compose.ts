import type { CredentialPort } from "../../ports/credentials.js";
import type { CredentialFailure } from "../../ports/credentials.js";
import { bindVerbs, type PortDeps } from "../../credentials/verbs.js";
import { createFileLedgerStore } from "./file-store.js";
import { createMemoryKeyring } from "./memory-keyring.js";
import type { LedgerStore } from "../../credentials/ledger-store.js";

/**
 * The one factory that assembles a `CredentialPort`.
 *
 * Kept to wiring only (≤60 lines, adversarial #12): the verbs live in
 * `credentials/verbs.ts`, the storage in `adapters/credentials/**`. This module
 * decides *which* storage backs the port and hands the verbs their dependencies.
 *
 * Backend selection is explicit and defaults to the file ledger:
 *
 *  - **no `keyring`** → the file store. A keyring that is merely *absent* is not
 *    an error; the file ledger is the documented default (WP §0: 未挂 keyring 时
 *    走 file，不得报 `keyring_unavailable`).
 *  - **`keyring: { attached: true }`** → the attached keyring store.
 *  - **`keyring: { attached: false }`** → a port whose every read fails with
 *    `keyring_unavailable`. This models "the deployment asked for a keyring but
 *    none is wired", which must fail closed rather than silently writing the
 *    secret to a file the user did not choose.
 *
 * No real OS keyring is attached here, and this module never spawns a process or
 * reads the live environment.
 */

export type KeyringSelection =
  | { readonly attached: true; readonly store: LedgerStore }
  | { readonly attached: false };

export type ComposeOptions = {
  readonly homeDir: string;
  /** Absent means no project layer. */
  readonly projectDir?: string | undefined;
  /** Injected environment snapshot. Never `process.env` directly. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Injected clock, ISO-8601. Defaults to the system clock. */
  readonly now?: (() => string) | undefined;
  /** Injected uuid source; defaults to `node:crypto`. */
  readonly crypto?: { readonly randomUUID: () => string } | undefined;
  readonly keyring?: KeyringSelection | undefined;
};

export function createCredentialPort(options: ComposeOptions): CredentialPort {
  const deps: PortDeps = {
    store: selectStore(options),
    env: options.env ?? {},
    now: options.now ?? (() => new Date().toISOString()),
    crypto: options.crypto ?? { randomUUID: () => globalThis.crypto.randomUUID() },
    hasProject: options.projectDir !== undefined,
  };

  if (options.keyring !== undefined && !options.keyring.attached) {
    return unavailablePort(deps);
  }

  return bindVerbs(deps);
}

function selectStore(options: ComposeOptions): LedgerStore {
  if (options.keyring !== undefined && options.keyring.attached) {
    return options.keyring.store;
  }
  return createFileLedgerStore({
    homeDir: options.homeDir,
    ...(options.projectDir === undefined ? {} : { projectDir: options.projectDir }),
  });
}

/** A port that refuses every operation because the requested keyring is missing. */
function unavailablePort(deps: PortDeps): CredentialPort {
  const failure = (): CredentialFailure => ({
    ok: false,
    code: "keyring_unavailable",
    detail: "a keyring backend was requested but no adapter is attached",
  });

  void deps;

  return {
    login: failure,
    logout: failure,
    status: failure,
    list: failure,
    get: failure,
    getAccount: failure,
    switch: failure,
    delete: failure,
    updateToken: failure,
    exportPublic: failure,
    exportSecrets: failure,
  };
}

/** Re-exported so a test can build a fake keyring without importing the adapter path. */
export { createMemoryKeyring };
