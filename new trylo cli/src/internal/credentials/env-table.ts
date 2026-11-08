import {
  ENV_ACCOUNT_ID,
  isCredentialProviderId,
  type CredentialProviderId,
} from "../ports/credentials.js";

/**
 * The declared environment-variable table.
 *
 * Hardcoded on purpose (WP §2.4): this module never enumerates `process.env`
 * keys and never accepts an undeclared name. A credential can only enter through
 * a variable this table names, so an arbitrary `AWS_SECRET_ACCESS_KEY` in the
 * environment is invisible to the ledger — there is no code path that would read
 * it, which is stronger than a blocklist.
 *
 * The table maps a variable to the provider it authenticates. Two variables may
 * name the same provider; the *more specific* one wins, which is stated here as
 * table order (later entry = more specific = higher precedence) rather than
 * discovered by inspecting names.
 */

export type EnvDeclaration = {
  readonly env: string;
  readonly providerId: CredentialProviderId;
};

/**
 * Ordered least-specific first. `TRYLO_OPENAI_API_KEY` is the provider-scoped
 * name and therefore beats the generic `TRYLO_API_KEY` when both are set, per
 * WP §2.4.
 */
export const CREDENTIAL_ENV_TABLE: ReadonlyArray<EnvDeclaration> = [
  { env: "TRYLO_API_KEY", providerId: "openai-compatible" },
  { env: "TRYLO_OPENAI_API_KEY", providerId: "openai-compatible" },
];

/** The environment variable that wins for a provider, or `undefined` if none. */
export function envVarFor(providerId: CredentialProviderId): string | undefined {
  let winner: string | undefined;

  for (const declaration of CREDENTIAL_ENV_TABLE) {
    if (declaration.providerId === providerId) {
      winner = declaration.env;
    }
  }

  return winner;
}

/** Every declared variable for a provider, least-specific first. */
export function envVarsFor(providerId: CredentialProviderId): ReadonlyArray<string> {
  return CREDENTIAL_ENV_TABLE.filter((declaration) => declaration.providerId === providerId).map(
    (declaration) => declaration.env,
  );
}

/** Every variable name this package is allowed to read. */
export const DECLARED_ENV_NAMES: ReadonlySet<string> = new Set(
  CREDENTIAL_ENV_TABLE.map((declaration) => declaration.env),
);

/**
 * Read one declared variable from an injected environment snapshot.
 *
 * The provider's declared variables are probed most-specific first, so
 * `TRYLO_OPENAI_API_KEY` wins when both it and `TRYLO_API_KEY` are set, while a
 * lone `TRYLO_API_KEY` is still honoured. A name not in the table is invisible
 * even if the snapshot contains it.
 *
 * `env` is a plain record rather than `process.env` so tests stay hermetic and
 * no production code path reads the live process environment directly.
 */
export function readDeclaredEnv(
  env: Readonly<Record<string, string | undefined>>,
  providerId: CredentialProviderId,
): { readonly env: string; readonly value: string } | undefined {
  const names = envVarsFor(providerId);

  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index];
    if (name === undefined || !DECLARED_ENV_NAMES.has(name)) {
      continue;
    }

    const value = env[name];
    if (value !== undefined && value.length > 0) {
      return { env: name, value };
    }
  }

  return undefined;
}

/** True when `name` is a variable this package may read. */
export function isDeclaredEnvName(name: string): boolean {
  return DECLARED_ENV_NAMES.has(name);
}

/**
 * The result of an environment hit: the account it reports, the secret, and the
 * variable that supplied it (for the `environment:<NAME>` label).
 */
export type EnvResolution = {
  readonly accountId: string;
  readonly secret: string;
  readonly env: string;
};

/**
 * The read-only environment layer's decision, expressed as a pure function.
 *
 * `resolve.ts` calls this first, which is what makes "env is not a file layer" a
 * single fact rather than a convention repeated at every call site: the
 * environment either resolves a provider or it does not, and there is no code
 * path that writes the value back to a ledger.
 */
export function resolveEnvCredential(
  env: Readonly<Record<string, string | undefined>>,
  providerId: CredentialProviderId,
): EnvResolution | undefined {
  const hit = readDeclaredEnv(env, providerId);
  return hit === undefined ? undefined : { accountId: ENV_ACCOUNT_ID, secret: hit.value, env: hit.env };
}

/** Re-exported so callers can validate a raw provider id in one import. */
export { isCredentialProviderId };
