import type {
  CredentialFailure,
  CredentialProviderId,
  CredentialScope,
} from "../ports/credentials.js";

/**
 * What the port's verbs need from a *ledger*: read one scope, replace one scope.
 *
 * Expressed as a domain interface rather than as the file adapter directly, so
 * the verbs are testable against an in-memory ledger and the file backend is one
 * implementation among others. The relation to `CredentialBackend` (the
 * byte-level contract in the port) is deliberate:
 *
 *  - `CredentialBackend` moves one provider's entry — the shape a keyring wants.
 *  - `LedgerStore` moves a whole document — the shape a file wants, because a
 *    file is replaced wholesale (lock, rename) rather than edited in place.
 *
 * The `keyring` adapter implements the port directly; the file backend
 * implements `LedgerStore`; the in-memory ledger (test + fake keyring) also
 * implements `LedgerStore`.
 */

export type LedgerReadResult =
  | { readonly ok: true; readonly document: import("../ports/credentials.js").CredentialLedgerDocument; readonly existed: boolean }
  | CredentialFailure;

export type LedgerStore = {
  /** Read one scope. A missing file is `existed:false`, not a failure. */
  read(scope: CredentialScope): LedgerReadResult;
  /**
   * Replace one scope atomically. The scope's lock is taken for the duration;
   * a second writer fails with `lock_conflict` rather than waiting.
   */
  write(scope: CredentialScope, document: import("../ports/credentials.js").CredentialLedgerDocument): CredentialFailure | undefined;
};

/** Which scope a provider's current pointer lives in. Never `keyring`. */
export type FileScope = Extract<CredentialScope, "user" | "project">;

export function isFileScope(scope: CredentialScope): scope is FileScope {
  return scope === "user" || scope === "project";
}

/** The provider ids a document knows about, in table order. */
export function providersOf(
  document: import("../ports/credentials.js").CredentialLedgerDocument,
): ReadonlyArray<CredentialProviderId> {
  const seen: CredentialProviderId[] = [];

  for (const record of document.records) {
    if (!seen.includes(record.providerId)) {
      seen.push(record.providerId);
    }
  }

  return seen;
}
