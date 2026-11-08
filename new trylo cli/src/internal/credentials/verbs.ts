import {
  CREDENTIAL_FORMAT_VERSION,
  isCredentialAccountId,
  isCredentialProviderId,
  isCredentialScope,
  type CredentialDeleteInput,
  type CredentialFailure,
  type CredentialLedgerDocument,
  type CredentialLoginInput,
  type CredentialLogoutInput,
  type CredentialPort,
  type CredentialProviderId,
  type CredentialPublicEntry,
  type CredentialPublicView,
  type CredentialRecord,
  type CredentialResult,
  type CredentialScope,
  type CredentialSecretsView,
  type CredentialStatusRow,
  type CredentialSwitchInput,
  type CredentialUpdateTokenInput,
} from "../ports/credentials.js";
import { generateAccountId } from "./ids.js";
import { collectEntries, mergePublic } from "./merge.js";
import { buildRecord, buildUpdatedTokenRecord, failure, validateSecretForWrite } from "./records.js";
import {
  rejectEnvShadowedWrite,
  statusRowFor,
  withCurrent,
  withRecord,
  withoutCurrent,
  withoutRecord,
  type ResolveInput,
} from "./resolve.js";
import type { LedgerStore } from "./ledger-store.js";
import { get, getAccount, type ReadDeps } from "./verbs-read.js";

/**
 * The port's verbs, split from the factory so no single function carries the
 * whole surface (WP §0: Flash must not deliver a 200-line closure again, and
 * adversarial #12 makes `compose.ts` over 60 lines a red).
 *
 * Every verb is a small function over three injected inputs — the ledger store,
 * the environment snapshot and the clock — and returns a `Result`. Nothing here
 * touches `process.env`, `Date.now()` or the filesystem directly.
 */

export type PortDeps = {
  readonly store: LedgerStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => string;
  readonly crypto: { readonly randomUUID: () => string };
  /** True when this port resolves the project layer (a projectDir was configured). */
  readonly hasProject: boolean;
};

/** Read both scopes once. Every verb that needs resolution starts here. */
function readLedgers(deps: PortDeps): { user: CredentialLedgerDocument; project: CredentialLedgerDocument } | CredentialFailure {
  const user = deps.store.read("user");
  if (!user.ok) {
    return user;
  }

  const project = deps.store.read("project");
  if (!project.ok) {
    return project;
  }

  return { user: user.document, project: project.document };
}

function resolveInput(
  deps: PortDeps,
  ledgers: { user: CredentialLedgerDocument; project: CredentialLedgerDocument },
  providerId: CredentialProviderId,
): ResolveInput {
  return {
    providerId,
    env: deps.env,
    project: ledgers.project,
    hasProject: deps.hasProject,
    user: ledgers.user,
  };
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

export function login(deps: PortDeps, input: CredentialLoginInput): CredentialResult<CredentialRecord> {
  if (!isCredentialProviderId(input.providerId)) {
    return failure("unknown_provider", `unknown provider ${JSON.stringify(input.providerId)}`);
  }

  const scope = loginScope(input);
  if (scope === undefined) {
    return failure("unknown_provider", `unknown scope ${JSON.stringify(input.scope)}`);
  }

  const secretFailure = validateSecretForWrite(input.providerId, input.secret);
  if (secretFailure !== undefined) {
    return secretFailure;
  }

  const shadowed = rejectEnvShadowedWrite(deps.env, input.providerId);
  if (shadowed !== undefined) {
    return shadowed;
  }

  const accountId = input.accountId ?? generateAccountId(deps.crypto);
  if (!isCredentialAccountId(accountId)) {
    return failure("invalid_account_id", `${JSON.stringify(accountId)} is not a valid account id`);
  }

  const ledgers = readLedgers(deps);
  if ("ok" in ledgers) {
    return ledgers;
  }

  const target = scope === "user" ? ledgers.user : ledgers.project;

  if (scope === "project" && !deps.hasProject) {
    return failure("path_escape", "no project directory is configured");
  }

  const existing = target.records.find(
    (record) => record.providerId === input.providerId && record.accountId === accountId,
  );
  if (existing !== undefined) {
    return failure("duplicate_account", `(${input.providerId}, ${accountId}) already exists in ${scope}`);
  }

  const timestamp = deps.now();
  const record = buildRecord(input, accountId, timestamp);
  const next = withCurrent(withRecord(target, record), input.providerId, accountId);
  const writeFailure = deps.store.write(scope, next);

  return writeFailure ?? { ok: true, value: record };
}

function loginScope(input: CredentialLoginInput): CredentialScope | undefined {
  const scope = input.scope ?? "user";
  return isCredentialScope(scope) ? scope : undefined;
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

export function logout(
  deps: PortDeps,
  input: CredentialLogoutInput,
): CredentialResult<ReadonlyArray<CredentialStatusRow>> {
  if (!isCredentialProviderId(input.providerId)) {
    return failure("unknown_provider", `unknown provider ${JSON.stringify(input.providerId)}`);
  }

  const scope = input.scope;
  if (scope !== undefined && !isCredentialScope(scope)) {
    return failure("unknown_provider", `unknown scope ${JSON.stringify(scope)}`);
  }

  const ledgers = readLedgers(deps);
  if ("ok" in ledgers) {
    return ledgers;
  }

  const scopes: ReadonlyArray<CredentialScope> = scope === undefined ? ["user", "project"] : [scope];

  for (const target of scopes) {
    const document = target === "user" ? ledgers.user : ledgers.project;

    if (target === "project" && !deps.hasProject) {
      continue;
    }

    if (document.current[input.providerId] === undefined) {
      continue;
    }

    const failureOrUndefined = deps.store.write(target, withoutCurrent(document, input.providerId));
    if (failureOrUndefined !== undefined) {
      return failureOrUndefined;
    }
  }

  return statusRows(deps);
}

// ---------------------------------------------------------------------------
// status / list
// ---------------------------------------------------------------------------

export function statusRows(deps: PortDeps): CredentialResult<ReadonlyArray<CredentialStatusRow>> {
  const ledgers = readLedgers(deps);
  if ("ok" in ledgers) {
    return ledgers;
  }

  const rows = (["openai-compatible", "fixture"] as const).map((providerId) =>
    statusRowFor(resolveInput(deps, ledgers, providerId)),
  );

  return { ok: true, value: rows };
}

export function listEntries(
  deps: PortDeps,
  scope?: CredentialScope,
): CredentialResult<ReadonlyArray<CredentialPublicEntry>> {
  const ledgers = readLedgers(deps);
  if ("ok" in ledgers) {
    return ledgers;
  }

  const collected = collectEntries(ledgers.user, deps.hasProject ? ledgers.project : undefined);
  const all = [...collected.userEntries, ...collected.projectEntries];

  return { ok: true, value: scope === undefined ? all : all.filter((entry) => entry.scope === scope) };
}

// ---------------------------------------------------------------------------
// switch
// ---------------------------------------------------------------------------

export function switchAccount(
  deps: PortDeps,
  input: CredentialSwitchInput,
): CredentialResult<CredentialStatusRow> {
  if (!isCredentialProviderId(input.providerId)) {
    return failure("unknown_provider", `unknown provider ${JSON.stringify(input.providerId)}`);
  }

  if (!isCredentialAccountId(input.accountId)) {
    return failure("invalid_account_id", `${JSON.stringify(input.accountId)} is not a valid account id`);
  }

  if (!isCredentialScope(input.scope)) {
    return failure("unknown_provider", `unknown scope ${JSON.stringify(input.scope)}`);
  }

  if (input.scope === "project" && !deps.hasProject) {
    return failure("path_escape", "no project directory is configured");
  }

  const ledgers = readLedgers(deps);
  if ("ok" in ledgers) {
    return ledgers;
  }

  const document = input.scope === "user" ? ledgers.user : ledgers.project;
  const target = document.records.find(
    (record) => record.providerId === input.providerId && record.accountId === input.accountId,
  );
  if (target === undefined) {
    return failure("unknown_account", `(${input.providerId}, ${input.accountId}) is not stored in ${input.scope}`);
  }

  const writeFailure = deps.store.write(
    input.scope,
    withCurrent(document, input.providerId, input.accountId),
  );
  if (writeFailure !== undefined) {
    return writeFailure;
  }

  return {
    ok: true,
    value: {
      providerId: input.providerId,
      layer: input.scope,
      accountId: input.accountId,
      ...(target.label === undefined ? {} : { label: target.label }),
      loggedIn: true,
    },
  };
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

export function deleteAccount(
  deps: PortDeps,
  input: CredentialDeleteInput,
): CredentialResult<CredentialRecord> {
  if (!isCredentialProviderId(input.providerId)) {
    return failure("unknown_provider", `unknown provider ${JSON.stringify(input.providerId)}`);
  }

  if (!isCredentialScope(input.scope)) {
    return failure("unknown_provider", `unknown scope ${JSON.stringify(input.scope)}`);
  }

  if (input.scope === "project" && !deps.hasProject) {
    return failure("path_escape", "no project directory is configured");
  }

  const ledgers = readLedgers(deps);
  if ("ok" in ledgers) {
    return ledgers;
  }

  const document = input.scope === "user" ? ledgers.user : ledgers.project;
  const target = document.records.find(
    (record) => record.providerId === input.providerId && record.accountId === input.accountId,
  );
  if (target === undefined) {
    return failure("unknown_account", `(${input.providerId}, ${input.accountId}) is not stored in ${input.scope}`);
  }

  if (document.current[input.providerId] === input.accountId) {
    return failure(
      "current_account_protected",
      `(${input.providerId}, ${input.accountId}) is the current account; switch or logout first`,
    );
  }

  const writeFailure = deps.store.write(
    input.scope,
    withoutRecord(document, input.providerId, input.accountId),
  );

  return writeFailure ?? { ok: true, value: target };
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

export function exportPublicView(deps: PortDeps): CredentialResult<CredentialPublicView> {
  const ledgers = readLedgers(deps);
  if ("ok" in ledgers) {
    return ledgers;
  }

  const status = (["openai-compatible", "fixture"] as const).map((providerId) =>
    statusRowFor(resolveInput(deps, ledgers, providerId)),
  );
  const collected = collectEntries(ledgers.user, deps.hasProject ? ledgers.project : undefined);

  return { ok: true, value: mergePublic({ status, ...collected }) };
}

export function exportSecretsView(
  deps: PortDeps,
  options: { readonly confirm: boolean },
): CredentialResult<CredentialSecretsView> {
  if (options.confirm !== true) {
    return failure("confirm_required", "exportSecrets requires { confirm: true }");
  }

  const ledgers = readLedgers(deps);
  if ("ok" in ledgers) {
    return ledgers;
  }

  const projectRecords = deps.hasProject ? ledgers.project.records : [];

  return {
    ok: true,
    value: {
      formatVersion: CREDENTIAL_FORMAT_VERSION,
      records: [...ledgers.user.records, ...projectRecords],
    },
  };
}

export function updateToken(
  deps: PortDeps,
  input: CredentialUpdateTokenInput,
): CredentialResult<CredentialRecord> {
  if (!isCredentialProviderId(input.providerId)) {
    return failure("unknown_provider", `unknown provider ${JSON.stringify(input.providerId)}`);
  }

  const scope = input.scope ?? "user";
  if (!isCredentialScope(scope)) {
    return failure("unknown_provider", `unknown scope ${JSON.stringify(scope)}`);
  }

  const ledgers = readLedgers(deps);
  if ("ok" in ledgers) {
    return ledgers;
  }

  const document = scope === "user" ? ledgers.user : ledgers.project;
  const target = document.records.find(
    (record) => record.providerId === input.providerId && record.accountId === input.accountId,
  );
  if (target === undefined) {
    return failure("unknown_account", `(${input.providerId}, ${input.accountId}) is not stored in ${scope}`);
  }

  const updatedRecord = buildUpdatedTokenRecord(target, input, deps.now());
  const nextDoc = withRecord(document, updatedRecord);
  const writeFailure = deps.store.write(scope, nextDoc);

  return writeFailure ?? { ok: true, value: updatedRecord };
}

/**
 * Bind the verbs to one set of dependencies, producing the port surface.
 *
 * The split keeps each verb a small pure-ish function (they receive `deps`
 * explicitly) while giving the factory a single call that cannot drift from the
 * port contract: the return type is `CredentialPort`, so a missing or
 * mis-typed verb is a compile error.
 */
export function bindVerbs(deps: PortDeps): CredentialPort {
  const reads: ReadDeps = {
    env: deps.env,
    hasProject: deps.hasProject,
    readLedgers: () => readLedgers(deps),
  };
  return {
    login: (input) => login(deps, input),
    logout: (input) => logout(deps, input),
    status: () => statusRows(deps),
    list: (scope) => listEntries(deps, scope),
    get: (providerId) => get(reads, providerId),
    getAccount: (input) => getAccount(reads, input),
    switch: (input) => switchAccount(deps, input),
    delete: (input) => deleteAccount(deps, input),
    updateToken: (input) => updateToken(deps, input),
    exportPublic: () => exportPublicView(deps),
    exportSecrets: (options) => exportSecretsView(deps, options),
  };
}
