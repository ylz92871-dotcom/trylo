import type {
  CredentialFailure,
  CredentialLedgerDocument,
  CredentialScope,
} from "../../ports/credentials.js";
import { decodeDocument, encodeDocument, emptyDocument } from "../../credentials/document.js";
import { keyringTarget, type OsKeyringDriver } from "../../credentials/keyring-driver.js";
import type { LedgerReadResult, LedgerStore } from "../../credentials/ledger-store.js";

/**
 * The OS-keyring-backed `LedgerStore` (WP 三轨 T3 §5).
 *
 * One keyring entry per scope holds one whole ledger document — the same
 * canonical JSON the file backend writes (`encodeDocument`), so:
 *
 *  - **the codec is shared, not restated.** A tampered or half-written entry
 *    fails `decodeDocument` and surfaces as `credentials_corrupt` — fail closed,
 *    identical to the file backend; a keyring gets no gentler read path than a
 *    file just because it is encrypted at rest.
 *  - **"nothing stored" is `existed: false`, not a failure** — the codex
 *    `NoEntry => Ok(None)` normalization (D6 §5), so a fresh keyring behaves
 *    exactly like a missing ledger file.
 *  - **operation failures stay operation failures.** If the driver throws, the
 *    scope read fails with `read_failed` / write with `write_failed`. This store
 *    never falls back to the file ledger on its own: degrading is a *selection*
 *    decision (`keyring-compose.ts` at probe time, before any secret exists),
 *    never a mid-operation rewrite of where secrets live.
 *
 * Scope mapping lives in `keyringTarget` (contract side): `user` is one fixed
 * machine-wide name; `project` carries a digest of the workspace directory, so
 * two repos never read each other's project ledger.
 */

export type OsKeyringStoreConfig = {
  readonly driver: OsKeyringDriver;
  /** Absent means no project layer; a project-scope access is `path_escape`. */
  readonly projectDir?: string | undefined;
};

export function createOsKeyringLedgerStore(config: OsKeyringStoreConfig): LedgerStore {
  return {
    read: (scope) => readScope(config, scope),
    write: (scope, document) => writeScope(config, scope, document),
  };
}

function readScope(config: OsKeyringStoreConfig, scope: CredentialScope): LedgerReadResult {
  // Mirror the file backend exactly: a project-scope *read* with no project
  // directory configured is an empty ledger, not an error — the verbs refuse
  // project writes themselves (`hasProject`), and every verb reads both scopes.
  if (scope === "project" && config.projectDir === undefined) {
    return { ok: true, document: emptyDocument(), existed: false };
  }

  const located = keyringTarget(scope, config.projectDir);
  if (!located.ok) {
    return located;
  }

  let stored: string | undefined;

  try {
    stored = config.driver.read(located.target);
  } catch (error) {
    return {
      ok: false,
      code: "read_failed",
      detail: `keyring entry ${located.target} could not be read (${messageOf(error)})`,
    };
  }

  if (stored === undefined) {
    return { ok: true, document: emptyDocument(), existed: false };
  }

  const decoded = decodeDocument(stored, `keyring:${located.target}`);

  return decoded.ok ? { ok: true, document: decoded.value, existed: true } : decoded;
}

function writeScope(
  config: OsKeyringStoreConfig,
  scope: CredentialScope,
  document: CredentialLedgerDocument,
): CredentialFailure | undefined {
  const located = keyringTarget(scope, config.projectDir);
  if (!located.ok) {
    return located;
  }

  try {
    config.driver.write(located.target, encodeDocument(document));
    return undefined;
  } catch (error) {
    return {
      ok: false,
      code: "write_failed",
      detail: `keyring entry ${located.target} could not be written (${messageOf(error)})`,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown keyring failure";
}
