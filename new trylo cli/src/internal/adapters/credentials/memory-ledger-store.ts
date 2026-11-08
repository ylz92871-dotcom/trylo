import type {
  CredentialFailure,
  CredentialLedgerDocument,
  CredentialScope,
} from "../../ports/credentials.js";
import { emptyDocument } from "../../credentials/document.js";
import type { LedgerReadResult, LedgerStore } from "../../credentials/ledger-store.js";

/**
 * An in-memory ledger, used by the port's tests and as the storage half of the
 * fake keyring backend.
 *
 * It exists so the port's *semantics* (two scopes, per-provider current, the
 * current-account protection on delete) can be tested without a filesystem, and
 * so the keyring adapter path is exercised end to end rather than stubbed: a
 * fake keyring that only implemented `CredentialBackend` would prove nothing
 * about whether the port can actually be backed by something other than a file.
 */

export function createMemoryLedgerStore(seed?: Readonly<Partial<Record<CredentialScope, CredentialLedgerDocument>>>): LedgerStore {
  const scopes = new Map<CredentialScope, CredentialLedgerDocument>();

  if (seed !== undefined) {
    for (const [scope, document] of Object.entries(seed)) {
      if (document !== undefined) {
        scopes.set(scope as CredentialScope, document);
      }
    }
  }

  return {
    read: (scope): LedgerReadResult => {
      const document = scopes.get(scope);
      return document === undefined
        ? { ok: true, document: emptyDocument(), existed: false }
        : { ok: true, document, existed: true };
    },
    write: (scope, document): CredentialFailure | undefined => {
      scopes.set(scope, document);
      return undefined;
    },
  };
}
