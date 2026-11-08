import type {
  CredentialFailure,
  CredentialLedgerDocument,
  CredentialScope,
} from "../../ports/credentials.js";
import { emptyDocument } from "../../credentials/document.js";
import type { LedgerReadResult, LedgerStore } from "../../credentials/ledger-store.js";

/**
 * The in-memory *fake* keyring.
 *
 * This is not a real OS keyring and must never be assembled in production. It
 * exists to prove one property the WP asks for explicitly: the port can be
 * backed by something other than a file, and login/status/logout behave the same
 * across backends. Its `kind` is reported as `keyring`, so a test can assert the
 * credential really travels through the keyring path.
 *
 * The storage is a `LedgerStore` over a private map — the same document shape the
 * file backend uses — because the port resolves *ledgers*, and a keyring that
 * stored a different shape would not be testing the same code path.
 *
 * `unavailable: true` models "a keyring was requested but no adapter is attached"
 * (WP §0: `get` hitting keyring with no implementation → `keyring_unavailable`).
 * Every read and write then fails closed with that code, rather than falling back
 * to the file store — a silent fallback would store a secret somewhere the user
 * did not ask for.
 */

export type MemoryKeyringOptions = {
  /** When true, every operation fails with `keyring_unavailable`. */
  readonly unavailable?: boolean;
  readonly seed?: Readonly<Partial<Record<CredentialScope, CredentialLedgerDocument>>>;
};

export type MemoryKeyring = {
  readonly kind: "keyring";
  readonly store: LedgerStore;
  readonly unavailable: boolean;
};

export function createMemoryKeyring(options: MemoryKeyringOptions = {}): MemoryKeyring {
  const unavailable = options.unavailable === true;
  const scopes = new Map<CredentialScope, CredentialLedgerDocument>();

  if (options.seed !== undefined) {
    for (const [scope, document] of Object.entries(options.seed)) {
      if (document !== undefined) {
        scopes.set(scope as CredentialScope, document);
      }
    }
  }

  const refuse = (): CredentialFailure => ({
    ok: false,
    code: "keyring_unavailable",
    detail: "no keyring adapter is attached to this build",
  });

  const store: LedgerStore = {
    read: (scope): LedgerReadResult => {
      if (unavailable) {
        return refuse();
      }

      const document = scopes.get(scope);
      if (document === undefined) {
        return { ok: true, document: emptyDocument(), existed: false };
      }

      return { ok: true, document, existed: true };
    },
    write: (scope, document): CredentialFailure | undefined => {
      if (unavailable) {
        return refuse();
      }
      scopes.set(scope, document);
      return undefined;
    },
  };

  return { kind: "keyring", store, unavailable };
}
