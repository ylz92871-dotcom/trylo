import { createHash } from "node:crypto";
import type { CredentialScope } from "../ports/credentials.js";

/**
 * The OS keyring driver contract (WP 三轨 T3 §5).
 *
 * A driver answers one question — "can this machine store a secret under a
 * name, and give it back?" — for one backing store (Windows Credential
 * Manager, macOS Keychain, libsecret). It moves *opaque text blobs*; it knows
 * nothing about ledgers, documents or checksums. The document codec lives in
 * `adapters/credentials/keyring-store.ts`, so every driver automatically gets
 * the same fail-closed decode the file backend uses.
 *
 * Error discipline (mirrors codex's `keyring-store` normalization, D6 §5):
 *
 *  - **"never stored" is not an error.** `read` returns `undefined` when the
 *    target does not exist — `keyring::Error::NoEntry => Ok(None)`.
 *  - **`probe` never throws.** Unavailability is a *value* carrying a reason,
 *    because the prefer-keyring selection must degrade to the file ledger with
 *    a warning (acceptance #1), not crash.
 *  - **read/write/remove may throw.** A keyring that exists but fails is an
 *    operation failure, fail closed — never a silent fall back to a file the
 *    user did not choose.
 *  - **Every throw message is secret-free by construction.** Messages name the
 *    operation, the target and a size or OS error code — never blob content.
 */

/**
 * The service namespace all trylo keyring entries live under. Distinct from
 * every other app on the machine; test entries use `trylo:test:*` and are
 * removed after each run.
 */
export const KEYRING_SERVICE = "trylo";

/** The fixed target for the user-scope ledger document. */
export const KEYRING_USER_TARGET = `${KEYRING_SERVICE}:credentials:user`;

/** Fixed, read-only target the win32 driver probes against. Holds nothing. */
export const KEYRING_PROBE_TARGET = `${KEYRING_SERVICE}:credentials:probe`;

/**
 * Windows Credential Manager refuses generic blobs above this size
 * (`CRED_MAX_CREDENTIAL_BLOB_SIZE` = 5 × 512). A ledger document larger than
 * this cannot live in the keyring; the write fails closed with `write_failed`
 * and the OPEN-T3-5 escape hatch is the documented degradation path.
 */
export const KEYRING_BLOB_MAX_BYTES = 2560;

/**
 * The name a driver stores one scope's document under.
 *
 * `user` is one machine-wide name. `project` is namespaced by the resolved
 * project directory (12 hex chars of its SHA-256), because the keyring is
 * user-level storage while the project ledger is per-workspace: collapsing
 * every workspace into one entry would let `--project` of one repo read
 * another repo's credentials. No directory configured is `path_escape` —
 * the same refusal the file backend gives.
 */
export function keyringTarget(
  scope: CredentialScope,
  projectDir: string | undefined,
): { readonly ok: true; readonly target: string } | { readonly ok: false; readonly code: "path_escape"; readonly detail: string } {
  if (scope === "user") {
    return { ok: true, target: KEYRING_USER_TARGET };
  }

  if (projectDir === undefined || projectDir.length === 0) {
    return {
      ok: false,
      code: "path_escape",
      detail: "no project directory is configured",
    };
  }

  const digest = createHash("sha256").update(projectDir, "utf8").digest("hex");

  return { ok: true, target: `${KEYRING_SERVICE}:credentials:project:${digest.slice(0, 12)}` };
}

/** The result of asking a driver whether its backing store is reachable. */
export type KeyringAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * One backing keyring store. All methods are synchronous (a CLI credential
 * operation is a sequential step, like the file backend's sync `fs` calls);
 * the win32 driver blocks on one child process per operation and is honest
 * about that cost in OPEN-T3-2.
 */
export type OsKeyringDriver = {
  /** Stable identity for reports and diagnostics ("win32-credential-manager"). */
  readonly id: string;
  /** Reachability check. Never throws; may be expensive, so drivers memoize. */
  probe(): KeyringAvailability;
  /** The blob stored under `target`, or `undefined` when nothing is stored. */
  read(target: string): string | undefined;
  /** Store (replacing any previous value). Throws on failure. */
  write(target: string, blob: string): void;
  /** Remove `target`. Removing a missing target is not an error. Throws otherwise. */
  remove(target: string): void;
};

/**
 * The driver a platform with no implemented keyring gets: permanently
 * unavailable, with the honest reason. `prefer-keyring` selection then degrades
 * to the file ledger + warning exactly as acceptance #1 asks. The Linux
 * driver remains deferred in OPEN-T3-3.
 */
export function createUnavailableKeyringDriver(reason: string): OsKeyringDriver {
  return {
    id: "unavailable",
    probe: () => ({ available: false, reason }),
    read: () => unavailable(reason),
    write: () => unavailable(reason),
    remove: () => unavailable(reason),
  };
}

function unavailable(reason: string): never {
  throw new Error(`os keyring is unavailable: ${reason}`);
}
