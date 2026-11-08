import type { LedgerReadResult, LedgerStore } from "../../credentials/ledger-store.js";
import type { CredentialScope } from "../../ports/credentials.js";

/**
 * The read order of the prefer-keyring selection (WP `2026-09-16-WP-传统CLI-
 * 交付面收尾波` §3-D6 / §4 W-KEY #4).
 *
 * Two rules, and the asymmetry between them is the whole point:
 *
 *  - **reads ask the keyring first and defer to the file ledger on a miss.** A
 *    machine that already holds file-ledger credentials keeps them after a user
 *    opts in: a scope the keyring has *never stored* (`existed: false`, the
 *    codex `NoEntry => Ok(None)` normalization) falls through to the file.
 *    Opting in must not cost a user the credential they already had.
 *  - **writes go to the keyring only.** Once the keyring is the selected
 *    backend no new secret lands in a file — the fallback is a *read* path, not
 *    a second place secrets accumulate.
 *
 * What is deliberately **not** here: a fallback after a keyring *failure*. A
 * driver that exists but throws stays a failure (`read_failed` / `write_failed`
 * from `keyring-store.ts`), because quietly serving a file the user did not
 * choose is how a secret ends up somewhere nobody expected. A miss is not a
 * failure, and a failure is not a miss.
 *
 * `existed` — not "the document happens to have records" — is the hit test. A
 * keyring document that was written and later emptied by a `logout` is still
 * *stored*, so it stays authoritative and the file's older copy is not
 * resurrected behind the user's back.
 */
export function createPreferReadLedgerStore(options: {
  readonly preferred: LedgerStore;
  readonly fallback: LedgerStore;
}): LedgerStore {
  return {
    read: (scope) => readPreferring(options, scope),
    write: (scope, document) => options.preferred.write(scope, document),
  };
}

function readPreferring(
  options: { readonly preferred: LedgerStore; readonly fallback: LedgerStore },
  scope: CredentialScope,
): LedgerReadResult {
  const preferred = options.preferred.read(scope);

  // Two ways the file ledger is never consulted: the keyring refused the read
  // (fail closed), or it holds this scope's document (it is authoritative).
  if (!preferred.ok || preferred.existed) {
    return preferred;
  }

  return options.fallback.read(scope);
}
