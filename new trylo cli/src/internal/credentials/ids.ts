import { createHash } from "node:crypto";
import {
  CREDENTIAL_PROVIDER_IDS,
  type CredentialProviderId,
} from "../ports/credentials.js";

/**
 * Account-id generation and validation.
 *
 * Kept apart from the port so the port stays a pure type/constant module. The
 * charset is shared with {@link CREDENTIAL_ACCOUNT_ID_PATTERN} — this module
 * produces ids the port's predicate accepts, and a test asserts that round trip
 * so a future edit to the pattern cannot silently make generated ids invalid.
 */

/**
 * A short, stable, collision-resistant account id.
 *
 * Derived from a random UUID with the hyphens stripped, which fits the id
 * charset (`[a-z0-9_-]`) and its 64-char cap with room to spare.
 */
export function generateAccountId(crypto: { randomUUID: () => string }): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 32);
}

/**
 * A stable identity key for one provider's *file* account.
 *
 * Environment-resolved credentials deliberately have no account row, so they
 * never reach this function.
 */
export function accountKey(providerId: CredentialProviderId, accountId: string): string {
  return `${providerId}\u0000${accountId}`;
}

/**
 * A deterministic checksum over the canonical JSON of a value, used by the file
 * store to detect a hand-edited or truncated ledger. JSON with sorted keys is
 * the canonicalization: object key order carries no meaning here, so a file that
 * was pretty-printed by another tool still verifies.
 */
export function canonicalChecksum(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Deterministic JSON: object keys sorted, arrays in order.
 *
 * We do not reuse `JSON.stringify` alone because its key order is insertion
 * order, which would make the checksum sensitive to how a value happened to be
 * built rather than to what it means.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];

  for (const key of keys) {
    const member = record[key];
    if (member === undefined) {
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }

  return `{${parts.join(",")}}`;
}

/** Every provider id, for building status/list rows in a stable order. */
export const ALL_PROVIDER_IDS: ReadonlyArray<CredentialProviderId> = CREDENTIAL_PROVIDER_IDS;
