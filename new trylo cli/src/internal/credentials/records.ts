import {
  CREDENTIAL_FORMAT_VERSION,
  CREDENTIAL_PROVIDER_IDS,
  isCredentialAccountId,
  isCredentialProviderId,
  isCredentialScope,
  providerRequiresSecret,
  type CredentialFailure,
  type CredentialLoginInput,
  type CredentialProviderId,
  type CredentialRecord,
  type CredentialScope,
  type CredentialUpdateTokenInput,
} from "../ports/credentials.js";

/**
 * Shape validation for ledger records and scope, shared by the write path (the
 * port's verbs) and the read path (the file store's decoder). Validating in one
 * place is what keeps "a record the writer accepts is a record the reader
 * accepts" true; two copies would drift.
 *
 * Failures are `Result` values, never throws — the package fails closed by
 * returning a code, per the project's error discipline.
 */

export const RECORD_REQUIRED_KEYS: ReadonlySet<string> = new Set([
  "formatVersion",
  "accountId",
  "providerId",
  "createdAt",
  "updatedAt",
]);

export const RECORD_OPTIONAL_KEYS: ReadonlySet<string> = new Set([
  "label",
  "secret",
  "authType",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "tokenType",
  "tokenEndpoint",
  "clientId",
  "scope",
]);

export function failure(code: CredentialFailure["code"], detail: string): CredentialFailure {
  return { ok: false, code, detail };
}

/**
 * Validate a scope value that arrived from a caller. `undefined` is not handled
 * here — the caller decides the default (`user`), because "absent" and "invalid"
 * are different answers.
 */
export function validateScope(value: string): CredentialFailure | undefined {
  return isCredentialScope(value)
    ? undefined
    : failure("unknown_provider", `unknown scope ${JSON.stringify(value)}`);
}

export function validateProviderId(value: string): CredentialFailure | undefined {
  return isCredentialProviderId(value)
    ? undefined
    : failure("unknown_provider", `unknown provider ${JSON.stringify(value)}`);
}

/**
 * Validate one candidate record. Rejects unknown keys so a record cannot smuggle
 * a field this build does not understand (the same closed-shape rule the
 * settings schema uses).
 */
export function validateRecord(value: unknown, where: string): CredentialFailure | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("credentials_corrupt", `${where} is not a record object`);
  }

  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!RECORD_REQUIRED_KEYS.has(key) && !RECORD_OPTIONAL_KEYS.has(key)) {
      return failure("credentials_corrupt", `${where} has unknown key ${JSON.stringify(key)}`);
    }
  }

  if (record["formatVersion"] !== CREDENTIAL_FORMAT_VERSION) {
    return failure("credentials_corrupt", `${where} has unknown formatVersion`);
  }

  if (typeof record["accountId"] !== "string" || !isCredentialAccountId(record["accountId"])) {
    return failure("credentials_corrupt", `${where} has an invalid accountId`);
  }

  if (typeof record["providerId"] !== "string" || !isCredentialProviderId(record["providerId"])) {
    return failure("credentials_corrupt", `${where} has an unknown providerId`);
  }

  for (const key of ["createdAt", "updatedAt"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      return failure("credentials_corrupt", `${where} has an invalid ${key}`);
    }
  }

  if (record["label"] !== undefined && typeof record["label"] !== "string") {
    return failure("credentials_corrupt", `${where} has an invalid label`);
  }

  if (record["secret"] !== undefined && typeof record["secret"] !== "string") {
    return failure("credentials_corrupt", `${where} has an invalid secret`);
  }

  if (
    record["authType"] !== undefined &&
    record["authType"] !== "api_key" &&
    record["authType"] !== "oauth"
  ) {
    return failure("credentials_corrupt", `${where} has an invalid authType`);
  }

  for (const strKey of [
    "accessToken",
    "refreshToken",
    "expiresAt",
    "tokenType",
    "tokenEndpoint",
    "clientId",
    "scope",
  ] as const) {
    if (record[strKey] !== undefined && typeof record[strKey] !== "string") {
      return failure("credentials_corrupt", `${where} has an invalid ${strKey}`);
    }
  }

  return undefined;
}

/**
 * The secret rule, applied at the *write* boundary: a keyed provider must carry
 * a non-empty secret, while `fixture` may omit it. Reading a ledger does not
 * re-apply this (a record with no secret for `fixture` is legal), which is why
 * it is a separate function from {@link validateRecord}.
 */
export function validateSecretForWrite(
  providerId: CredentialProviderId,
  secret: string | undefined,
): CredentialFailure | undefined {
  if (!providerRequiresSecret(providerId)) {
    return undefined;
  }

  if (secret === undefined || secret.length === 0) {
    return failure("missing_secret", `provider ${providerId} requires a non-empty secret`);
  }

  return undefined;
}

/** Narrow a validated raw object into a `CredentialRecord`. Call after {@link validateRecord}. */
export function toRecord(raw: Record<string, unknown>): CredentialRecord {
  return {
    formatVersion: CREDENTIAL_FORMAT_VERSION,
    accountId: raw["accountId"] as string,
    providerId: raw["providerId"] as CredentialProviderId,
    ...(raw["label"] === undefined ? {} : { label: raw["label"] as string }),
    ...(raw["secret"] === undefined ? {} : { secret: raw["secret"] as string }),
    ...(raw["authType"] === undefined ? {} : { authType: raw["authType"] as "api_key" | "oauth" }),
    ...(raw["accessToken"] === undefined ? {} : { accessToken: raw["accessToken"] as string }),
    ...(raw["refreshToken"] === undefined ? {} : { refreshToken: raw["refreshToken"] as string }),
    ...(raw["expiresAt"] === undefined ? {} : { expiresAt: raw["expiresAt"] as string }),
    ...(raw["tokenType"] === undefined ? {} : { tokenType: raw["tokenType"] as string }),
    ...(raw["tokenEndpoint"] === undefined ? {} : { tokenEndpoint: raw["tokenEndpoint"] as string }),
    ...(raw["clientId"] === undefined ? {} : { clientId: raw["clientId"] as string }),
    ...(raw["scope"] === undefined ? {} : { scope: raw["scope"] as string }),
    createdAt: raw["createdAt"] as string,
    updatedAt: raw["updatedAt"] as string,
  };
}

/** All provider ids, used to build stable status rows. */
export const KNOWN_PROVIDERS: ReadonlyArray<CredentialProviderId> = CREDENTIAL_PROVIDER_IDS;

/** A caller-supplied scope, already defaulted. Kept explicit for readability. */
export type ResolvedScope = CredentialScope;

export function buildRecord(
  input: CredentialLoginInput,
  accountId: string,
  timestamp: string,
): CredentialRecord {
  return {
    formatVersion: CREDENTIAL_FORMAT_VERSION,
    accountId,
    providerId: input.providerId,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.secret === undefined ? {} : { secret: input.secret }),
    ...(input.authType === undefined ? {} : { authType: input.authType }),
    ...(input.accessToken === undefined
      ? input.secret === undefined
        ? {}
        : { accessToken: input.secret }
      : { accessToken: input.accessToken }),
    ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.tokenType === undefined ? {} : { tokenType: input.tokenType }),
    ...(input.tokenEndpoint === undefined ? {} : { tokenEndpoint: input.tokenEndpoint }),
    ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function buildUpdatedTokenRecord(
  target: CredentialRecord,
  input: CredentialUpdateTokenInput,
  timestamp: string,
): CredentialRecord {
  return {
    ...target,
    secret: input.accessToken,
    accessToken: input.accessToken,
    ...(input.refreshToken !== undefined ? { refreshToken: input.refreshToken } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.tokenType !== undefined ? { tokenType: input.tokenType } : {}),
    updatedAt: timestamp,
  };
}
