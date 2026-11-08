import {
  type CredentialFailure,
  type CredentialLayer,
  type CredentialLedgerDocument,
  type CredentialProviderId,
  type CredentialPublicEntry,
  type CredentialRecord,
  type CredentialResolved,
  type CredentialScope,
  type CredentialStatusRow,
} from "../ports/credentials.js";
import { resolveEnvCredential } from "./env-table.js";
import { sealDocument, documentBody } from "./document.js";
import { failure } from "./records.js";

/**
 * Resolution and merge rules, as pure functions over ledgers.
 *
 * These are the decisions the WP fixes in §2.2 and §2.3, kept away from both the
 * filesystem and the port's verb plumbing so they can be read and tested on
 * their own:
 *
 *  - Each provider resolves independently. There is no global "current account".
 *  - Precedence is env > project > user, per provider.
 *  - An environment hit is not a ledger row and never moves a pointer.
 *  - A miss is `layer:"none"`, which `get` reports as an ok value — not an error.
 */

export type ResolveInput = {
  readonly providerId: CredentialProviderId;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly project: CredentialLedgerDocument;
  /** `undefined` when no project directory is configured. */
  readonly hasProject: boolean;
  readonly user: CredentialLedgerDocument;
};

/**
 * Resolve one provider per §2.2.
 *
 * Order is exactly: declared env hit → project current → user current → none.
 * The env *value* is returned here but never written back anywhere; the ledger
 * documents are read only.
 */
export function resolveProvider(input: ResolveInput): CredentialResolved {
  const envHit = resolveEnvCredential(input.env, input.providerId);
  if (envHit !== undefined) {
    return {
      providerId: input.providerId,
      layer: "env",
      accountId: envHit.accountId,
      label: `environment:${envHit.env}`,
      secret: envHit.secret,
    };
  }

  const fromProject = currentRecord(input.project, input.providerId);
  if (input.hasProject && fromProject !== undefined) {
    return toResolved(input.providerId, "project", fromProject);
  }

  const fromUser = currentRecord(input.user, input.providerId);
  if (fromUser !== undefined) {
    return toResolved(input.providerId, "user", fromUser);
  }

  return { providerId: input.providerId, layer: "none", accountId: "" };
}

/**
 * One *named* account, resolved from the ledger alone.
 *
 * Project is searched before user, matching {@link resolveProvider}'s
 * precedence, but the environment layer is deliberately not consulted: the
 * caller named an account, and answering with a key the environment declared
 * would be a different credential wearing the same answer. A miss is
 * `unknown_account` rather than `layer:"none"` — the caller asked by name, so
 * "no such account" and "no credential" are different facts — and the ids that
 * do exist travel with the refusal, which is what makes a typo fixable from the
 * message alone.
 */
export function resolveNamedAccount(
  input: { readonly providerId: CredentialProviderId; readonly accountId: string },
  ledgers: { readonly user: CredentialLedgerDocument; readonly project: CredentialLedgerDocument },
  hasProject: boolean,
): { readonly ok: true; readonly value: CredentialResolved } | CredentialFailure {
  const scopes: ReadonlyArray<{ readonly scope: CredentialScope; readonly document: CredentialLedgerDocument }> = [
    ...(hasProject ? [{ scope: "project" as const, document: ledgers.project }] : []),
    { scope: "user" as const, document: ledgers.user },
  ];
  const known: string[] = [];

  for (const { scope, document } of scopes) {
    const record = document.records.find(
      (entry) => entry.providerId === input.providerId && entry.accountId === input.accountId,
    );
    if (record !== undefined) {
      return { ok: true, value: toResolved(input.providerId, scope, record) };
    }

    for (const entry of document.records) {
      if (entry.providerId === input.providerId && !known.includes(entry.accountId)) {
        known.push(entry.accountId);
      }
    }
  }

  return failure(
    "unknown_account",
    `no account ${JSON.stringify(input.accountId)} for ${input.providerId}${known.length > 0 ? `; known accounts: ${known.join(", ")}` : ""}`,
  );
}

function toResolved(
  providerId: CredentialProviderId,
  layer: CredentialLayer,
  record: CredentialRecord,
): CredentialResolved {
  return {
    providerId,
    layer,
    accountId: record.accountId,
    ...(record.label === undefined ? {} : { label: record.label }),
    ...(record.secret === undefined ? {} : { secret: record.secret }),
    ...(record.authType === undefined ? {} : { authType: record.authType }),
    ...(record.accessToken === undefined ? {} : { accessToken: record.accessToken }),
    ...(record.refreshToken === undefined ? {} : { refreshToken: record.refreshToken }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.tokenType === undefined ? {} : { tokenType: record.tokenType }),
    ...(record.tokenEndpoint === undefined ? {} : { tokenEndpoint: record.tokenEndpoint }),
    ...(record.clientId === undefined ? {} : { clientId: record.clientId }),
    ...(record.scope === undefined ? {} : { scope: record.scope }),
  };
}

/** The record a provider's current pointer names, or `undefined`. */
export function currentRecord(
  document: CredentialLedgerDocument,
  providerId: CredentialProviderId,
): CredentialRecord | undefined {
  const accountId = document.current[providerId];
  if (accountId === undefined) {
    return undefined;
  }

  return document.records.find(
    (record) => record.providerId === providerId && record.accountId === accountId,
  );
}

/** Every record of one provider in a document, in stored order. */
export function recordsOf(
  document: CredentialLedgerDocument,
  providerId: CredentialProviderId,
): ReadonlyArray<CredentialRecord> {
  return document.records.filter((record) => record.providerId === providerId);
}

/**
 * A status row. `loggedIn` is true for env, project and user hits alike — the
 * distinction a caller needs is *which layer*, which is the `layer` field; the
 * boolean exists so a caller that only wants "is there something" need not know
 * the layer enumeration.
 */
export function statusRowFor(input: ResolveInput): CredentialStatusRow {
  const resolved = resolveProvider(input);
  return {
    providerId: resolved.providerId,
    layer: resolved.layer,
    accountId: resolved.accountId,
    ...(resolved.label === undefined ? {} : { label: resolved.label }),
    loggedIn: resolved.layer !== "none",
    ...(resolved.authType === undefined ? {} : { authType: resolved.authType }),
    ...(resolved.expiresAt === undefined ? {} : { expiresAt: resolved.expiresAt }),
  };
}

/**
 * Public entries for one scope. `isCurrent` is computed against that scope's own
 * document, which is what makes the flag agree with `switch`/`logout`.
 */
export function publicEntries(
  document: CredentialLedgerDocument,
  scope: CredentialScope,
): ReadonlyArray<CredentialPublicEntry> {
  return document.records.map((record) => ({
    providerId: record.providerId,
    accountId: record.accountId,
    scope,
    ...(record.label === undefined ? {} : { label: record.label }),
    isCurrent: document.current[record.providerId] === record.accountId,
    ...(record.authType === undefined ? {} : { authType: record.authType }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  }));
}

/** A document with one record inserted or replaced. Returns a sealed copy. */
export function withRecord(
  document: CredentialLedgerDocument,
  record: CredentialRecord,
): CredentialLedgerDocument {
  const kept = document.records.filter(
    (existing) =>
      !(existing.providerId === record.providerId && existing.accountId === record.accountId),
  );
  return sealDocument({
    formatVersion: document.formatVersion,
    current: document.current,
    records: [...kept, record],
  });
}

/** A document with one record removed (by provider + account). */
export function withoutRecord(
  document: CredentialLedgerDocument,
  providerId: CredentialProviderId,
  accountId: string,
): CredentialLedgerDocument {
  return sealDocument({
    formatVersion: document.formatVersion,
    current: document.current,
    records: document.records.filter(
      (existing) => !(existing.providerId === providerId && existing.accountId === accountId),
    ),
  });
}

/** A document whose provider pointer names `accountId`. */
export function withCurrent(
  document: CredentialLedgerDocument,
  providerId: CredentialProviderId,
  accountId: string,
): CredentialLedgerDocument {
  return sealDocument({
    formatVersion: document.formatVersion,
    current: { ...document.current, [providerId]: accountId },
    records: document.records,
  });
}

/** A document whose provider pointer is cleared. Other providers are untouched. */
export function withoutCurrent(
  document: CredentialLedgerDocument,
  providerId: CredentialProviderId,
): CredentialLedgerDocument {
  const current: Partial<Record<CredentialProviderId, string>> = {};

  for (const [key, value] of Object.entries(document.current)) {
    if (key !== providerId && value !== undefined) {
      current[key as CredentialProviderId] = value;
    }
  }

  return sealDocument({
    formatVersion: document.formatVersion,
    current,
    records: document.records,
  });
}

/**
 * Reject a write that would put an environment-derived secret into a ledger.
 *
 * Checks *every* declared variable for the provider, not just the winning one:
 * if either `TRYLO_API_KEY` or `TRYLO_OPENAI_API_KEY` is set, the environment
 * layer resolves ahead of any file, so a stored credential would be silently
 * shadowed. Refusing is the honest answer — the caller unsets the variable first.
 */
export function rejectEnvShadowedWrite(
  env: Readonly<Record<string, string | undefined>>,
  providerId: CredentialProviderId,
): CredentialFailure | undefined {
  const hit = resolveEnvCredential(env, providerId);
  if (hit === undefined) {
    return undefined;
  }

  return failure(
    "env_shadowed",
    `${hit.env} is set and overrides the ledger; unset it before storing a ${providerId} credential`,
  );
}

/** The checksum-verified body of a document, for callers that need to re-seal. */
export { documentBody };
