/**
 * The single redaction point for the credentials package (WP §2.6).
 *
 * Every string this package could hand to a human or to JSON — a failure
 * `detail`, a status row, a public export, a log line — is expected to pass
 * through {@link redactText} with the set of secrets currently known to the
 * ledger. The guarantee is structural rather than hopeful:
 *
 *  - The public views ({@link import("../ports/credentials.js").CredentialStatusRow},
 *    `CredentialPublicEntry`, `CredentialPublicView`) are *shaped* without a
 *    `secret` field, so no code path can put one there by accident.
 *  - Redaction is the second layer of defence, for text that was assembled from
 *    free-form input: a caller that interpolates a user-supplied value into a
 *    `detail` still cannot leak a stored secret through it.
 *
 * A secret is replaced by {@link REDACTED} — deliberately a fixed marker, not a
 * masked prefix, because a partial secret in a bug report is still a leak.
 */

export const REDACTED = "<redacted>";

/**
 * Scrub every occurrence of every known secret from `text`.
 *
 * Secrets are compared as literal substrings. Blank and very short values are
 * ignored: replacing a one-character "secret" everywhere would corrupt the
 * message without protecting anything, and an empty string would match between
 * every character.
 */
export function redactText(text: string, secrets: Iterable<string>): string {
  let out = text;

  for (const secret of secrets) {
    if (secret.length < 4 || out.length === 0) {
      continue;
    }
    out = out.split(secret).join(REDACTED);
  }

  return out;
}

/**
 * Redact a structured value by walking it and scrubbing every string leaf.
 * Returns a new value; the input is never mutated.
 *
 * Used for observation JSON and any object that leaves the package for display.
 */
export function redactValue<T>(value: T, secrets: Iterable<string>): T {
  const known = dedupeSecrets(secrets);
  if (known.length === 0) {
    return value;
  }
  return walk(value, known) as T;
}

function dedupeSecrets(secrets: Iterable<string>): ReadonlyArray<string> {
  const seen = new Set<string>();

  for (const secret of secrets) {
    if (secret.length >= 4) {
      seen.add(secret);
    }
  }

  return [...seen];
}

function walk(value: unknown, secrets: ReadonlyArray<string>): unknown {
  if (typeof value === "string") {
    return redactText(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, secrets));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      out[redactText(key, secrets)] = walk(member, secrets);
    }
    return out;
  }

  return value;
}

/**
 * Assertion helper for tests: true when `text` contains none of `secrets`.
 *
 * Lives in production code (not a test helper) so the same predicate can back a
 * runtime invariant check on a rendered view without importing test code.
 */
export function containsNoSecret(text: string, secrets: Iterable<string>): boolean {
  for (const secret of secrets) {
    if (secret.length >= 4 && text.includes(secret)) {
      return false;
    }
  }
  return true;
}
