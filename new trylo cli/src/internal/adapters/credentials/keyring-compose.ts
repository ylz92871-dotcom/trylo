import type { CredentialPort } from "../../ports/credentials.js";
import { createUnavailableKeyringDriver, type KeyringAvailability, type OsKeyringDriver } from "../../credentials/keyring-driver.js";
import { createFileLedgerStore } from "./file-store.js";
import { createPreferReadLedgerStore } from "./prefer-store.js";
import { createOsKeyringLedgerStore } from "./keyring-store.js";
import { createWindowsCredentialManagerDriver } from "./windows/keyring-win32.js";
import { createDarwinKeychainDriver } from "./keyring-darwin.js";
import { createCredentialPort, type ComposeOptions } from "./compose.js";

/**
 * The prefer-keyring composition (WP 三轨 T3 §5 acceptance #1):
 *
 * **when an OS keyring is available it wins; when it is not, degrade to the
 * file ledger and say so** — the report carries a non-empty `reason` for the
 * caller to surface as one `warning` (the port's `Result` has no warning
 * channel, so the degradation is a *selection-time* fact, decided before any
 * secret moves).
 *
 * The line this module refuses to cross, inherited from `compose.ts`:
 * degrading *at selection time* (no keyring on this machine) writes nothing
 * anywhere and only changes which empty store is used. Degrading *mid-operation*
 * (the keyring exists but a read or write fails) would move a secret into a
 * file the user did not choose — so `keyring-store.ts` fails closed instead,
 * and this module never retries against the file ledger after a *failure*.
 *
 * Read order is a separate question from failure, and the two were conflated
 * once (WP §3-D6 / §4 W-KEY #4 spell them apart): **a miss is not a failure.**
 * When the keyring is the selected backend but has never stored a scope, the
 * read defers to the file ledger (`prefer-store.ts`), so opting in cannot cost
 * a user the credential they already had; writes still go to the keyring only.
 * A driver that exists and throws is still an operation failure, never a quiet
 * file read.
 *
 * `compose.ts` itself is untouched: the three selection semantics its tests pin
 * (absent → file, attached → store, `attached:false` → fail closed) and the
 * ≤60-line `createCredentialPort` source scan all hold byte for byte. This
 * factory composes *on top of* `createCredentialPort`.
 *
 * Wiring note (待接线, HANDOFF §5): production activation is one call-site swap
 * in `surface/cli/credentials-wiring.ts` — owned by the收口轨, not by this track.
 */

export type KeyringBackendReport =
  | { readonly backend: "os-keyring"; readonly driverId: string }
  | { readonly backend: "file"; readonly fallback: true; readonly reason: string };

export type PreferKeyringOptions = Omit<ComposeOptions, "keyring"> & {
  /** Injected for tests. Defaults to the platform driver. */
  readonly driver?: OsKeyringDriver | undefined;
};

export type PreferKeyringResult = {
  readonly port: CredentialPort;
  readonly report: KeyringBackendReport;
};

export function createCredentialPortPreferringKeyring(options: PreferKeyringOptions): PreferKeyringResult {
  const driver = options.driver ?? defaultDriverForPlatform();
  const availability = driver.probe();
  if (availability.available) {
    const keyring = createOsKeyringLedgerStore({
      driver,
      ...(options.projectDir === undefined ? {} : { projectDir: options.projectDir }),
    });
    return {
      port: createCredentialPort({
        ...options,
        keyring: {
          attached: true,
          store: createPreferReadLedgerStore({
            preferred: keyring,
            fallback: createFileLedgerStore({
              homeDir: options.homeDir,
              ...(options.projectDir === undefined ? {} : { projectDir: options.projectDir }),
            }),
          }),
        },
      }),
      report: { backend: "os-keyring", driverId: driver.id },
    };
  }

  return {
    port: createCredentialPort(options),
    report: { backend: "file", fallback: true, reason: availability.reason },
  };
}

function defaultDriverForPlatform(): OsKeyringDriver {
  if (process.platform === "win32") {
    return createWindowsCredentialManagerDriver();
  }
  if (process.platform === "darwin") return createDarwinKeychainDriver();
  return createUnavailableKeyringDriver(noDriverReason(process.platform));
}

function noDriverReason(platform: string): string {
  return `no OS keyring driver is implemented for platform ${platform} (deferred, OPEN-T3-3)`;
}

/** Re-exported so the wiring layer can type its warning without adapter paths. */
export type { KeyringAvailability };
