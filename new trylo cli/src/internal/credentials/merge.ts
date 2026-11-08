import {
  CREDENTIAL_FORMAT_VERSION,
  CREDENTIAL_PROVIDER_IDS,
  type CredentialProviderId,
  type CredentialPublicEntry,
  type CredentialPublicView,
  type CredentialStatusRow,
  type CredentialLedgerDocument,
} from "../ports/credentials.js";
import { publicEntries } from "./resolve.js";

/**
 * The merged public view: `status` rows plus `list` entries, with no secret
 * anywhere in the shape.
 *
 * `mergePublic` is the *only* function that produces a `CredentialPublicView`,
 * so "a public export cannot carry a secret" is enforced by there being no field
 * to put one in, rather than by a scrub that could be forgotten. The redaction
 * module is still applied to labels on the way out (see `verbs.ts`), because a
 * label is free-form user input and a user can type a key into it.
 *
 * Ordering is by the provider table, then by account id, so two exports of the
 * same ledger are byte-identical — which is what makes `--json` output diffable
 * and a doctor line stable.
 */

export type MergeInput = {
  readonly status: ReadonlyArray<CredentialStatusRow>;
  readonly userEntries: ReadonlyArray<CredentialPublicEntry>;
  readonly projectEntries: ReadonlyArray<CredentialPublicEntry>;
};

export function mergePublic(input: MergeInput): CredentialPublicView {
  return {
    formatVersion: CREDENTIAL_FORMAT_VERSION,
    status: orderStatus(input.status),
    entries: orderEntries([...input.userEntries, ...input.projectEntries]),
  };
}

function providerOrder(providerId: CredentialProviderId): number {
  const index = CREDENTIAL_PROVIDER_IDS.indexOf(providerId);
  return index === -1 ? CREDENTIAL_PROVIDER_IDS.length : index;
}

function orderStatus(rows: ReadonlyArray<CredentialStatusRow>): ReadonlyArray<CredentialStatusRow> {
  return [...rows].sort(
    (a, b) => providerOrder(a.providerId) - providerOrder(b.providerId),
  );
}

function orderEntries(
  entries: ReadonlyArray<CredentialPublicEntry>,
): ReadonlyArray<CredentialPublicEntry> {
  return [...entries].sort((a, b) => {
    const byProvider = providerOrder(a.providerId) - providerOrder(b.providerId);
    if (byProvider !== 0) {
      return byProvider;
    }

    const byScope = scopeOrder(a.scope) - scopeOrder(b.scope);
    if (byScope !== 0) {
      return byScope;
    }

    return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
  });
}

function scopeOrder(scope: CredentialPublicEntry["scope"]): number {
  return scope === "user" ? 0 : 1;
}

/** Public entries for both scopes, project included only when it exists. */
export function collectEntries(
  user: CredentialLedgerDocument,
  project: CredentialLedgerDocument | undefined,
): { readonly userEntries: ReadonlyArray<CredentialPublicEntry>; readonly projectEntries: ReadonlyArray<CredentialPublicEntry> } {
  return {
    userEntries: publicEntries(user, "user"),
    projectEntries: project === undefined ? [] : publicEntries(project, "project"),
  };
}
