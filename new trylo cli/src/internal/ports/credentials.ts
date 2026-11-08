/**
 * Credential ledger port — the *secret* half of configuration.
 *
 * The counterpart of `ports/settings.ts`. Settings loads non-secret
 * configuration and refuses secrets outright; this port stores them. The two are
 * deliberately separate (opencode's "declarations and credentials split",
 * D6 §10.7): a settings file must never be able to declare a credential, and a
 * credential ledger is not a configuration layer.
 *
 * Scope, stated so the boundary is unmissable:
 *
 *  - **This is a ledger, not an authority.** Reading an API key here is not a
 *    tool grant. Nothing in this package feeds the PermissionGate; a credential
 *    is data, not permission and not evidence. `CredentialPort` has no verb that
 *    approves, grants or admits anything.
 *  - **Two scopes, not one flat table.** `user` is one file shared by every
 *    project; `project` is one file per workspace. Each *provider* carries its
 *    own current pointer, so switching the OpenAI account does not move the
 *    fixture one.
 *  - **Environment wins, but is never written.** A declared environment variable
 *    overrides every file layer and is read-only: `login`/`set` never persist it
 *    and never mutate `process.env`.
 *  - **Secrets appear in exactly two ok branches** — `get` and `exportSecrets` —
 *    and nowhere else. `status`, `list`, `exportPublic` and every failure
 *    `detail` are secret-free by construction (`credentials/redact.ts` is the
 *    single scrubbing point).
 *  - **OS keyring and OAuth are out of scope.** A `keyring` backend kind exists
 *    so the port can *be* backed by one later, but production assembly does not
 *    attach a real keyring, and reaching an unimplemented keyring backend fails
 *    closed as `keyring_unavailable` rather than pretending the file holds it.
 *
 * The dependency on `credentials/ids.js` and `credentials/env-table.js` is a
 * type/constant-only import of pure enumerations (no I/O), which keeps the
 * contract acyclic: the domain modules implement against these types and never
 * import this port back into a cycle.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Account ids are used verbatim inside `switch`/`delete`, so the charset is tight. */
export const CREDENTIAL_ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Providers this build can hold credentials for. A closed set: an unknown id is
 * refused rather than stored, so the ledger cannot accumulate rows nothing can
 * resolve.
 *
 *  - `openai-compatible` — the keyed provider;
 *  - `fixture` — the keyless test provider. Its records may omit `secret`, and
 *    `get("fixture")` returns `layer:"none"` with `ok:true` when nothing is
 *    stored, so a test run never has to fabricate a fake key.
 */
export const CREDENTIAL_PROVIDER_IDS = ["openai-compatible", "fixture"] as const;

export type CredentialProviderId = (typeof CREDENTIAL_PROVIDER_IDS)[number];

/** The two ledger scopes, lowest precedence first. */
export const CREDENTIAL_SCOPES = ["user", "project"] as const;

export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

/**
 * Which layer resolved a `get`. `env` means a declared environment variable is
 * active (and is *not* backed by the ledger); `none` means nothing is stored —
 * a miss, not an error.
 */
export const CREDENTIAL_LAYERS = ["env", "project", "user", "none"] as const;

export type CredentialLayer = (typeof CREDENTIAL_LAYERS)[number];

/** Backend kinds. `env` is read-only; `keyring` is an adapter slot only. */
export const CREDENTIAL_BACKEND_KINDS = ["file", "env", "keyring"] as const;

export type CredentialBackendKind = (typeof CREDENTIAL_BACKEND_KINDS)[number];

/**
 * The accountId reported for an environment-resolved credential. Synthetic and
 * fixed: an environment variable has no account row, and inventing one would let
 * a caller `switch` to a pointer that cannot exist.
 */
export const ENV_ACCOUNT_ID = "env";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The only ledger document version this build reads or writes. */
export const CREDENTIAL_FORMAT_VERSION = 1;

/**
 * One stored credential. `secret` is optional *only* because `fixture` is a
 * keyless provider; every other provider's record must carry a non-empty secret,
 * which `records.ts` enforces on both the write and the read path.
 */
export type CredentialRecord = {
  readonly formatVersion: typeof CREDENTIAL_FORMAT_VERSION;
  readonly accountId: string;
  readonly providerId: CredentialProviderId;
  /** Non-secret short name for display (e.g. "work", "personal"). */
  readonly label?: string;
  /** The credential itself. Absent only for a keyless provider. */
  readonly secret?: string;
  readonly authType?: "api_key" | "oauth";
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly tokenType?: string;
  readonly tokenEndpoint?: string;
  readonly clientId?: string;
  readonly scope?: string;
  /** Injected-clock ISO timestamps; never `Date.now()` inside this package. */
  readonly createdAt: string;
  readonly updatedAt: string;
};

/**
 * A ledger file: every record plus one current pointer *per provider*.
 *
 * The map shape (rather than a single `current` string) is what makes "switch
 * the OpenAI account" leave the fixture account where it was. `checksum` covers
 * the canonical serialization of `{ formatVersion, current, records }`; a
 * mismatch rejects the whole file (see `adapters/credentials/file-store.ts`).
 */
export type CredentialLedgerDocument = {
  readonly formatVersion: typeof CREDENTIAL_FORMAT_VERSION;
  readonly current: Readonly<Partial<Record<CredentialProviderId, string>>>;
  readonly records: ReadonlyArray<CredentialRecord>;
  readonly checksum: string;
};

// ---------------------------------------------------------------------------
// Byte-level backend contract
// ---------------------------------------------------------------------------

/**
 * A byte-level store for one scope. The file backend implements it directly; the
 * environment backend implements it read-only; the in-memory fake keyring
 * implements it to prove the port can be backed by something other than a file.
 *
 * `get` returns `undefined` for "not stored" — *not* an error. Copying goose's
 * keyring-store normalisation (D6 §5: `keyring::Error::NoEntry => Ok(None)`):
 * "the user never stored this" must not surface as a failure.
 */
export type CredentialBackend = {
  readonly kind: CredentialBackendKind;
  /** `undefined` when absent. A throw is an I/O failure, not an absence. */
  get(providerId: CredentialProviderId): CredentialBackendEntry | undefined;
  set(entry: CredentialBackendEntry): void;
  delete(providerId: CredentialProviderId): void;
  list(): ReadonlyArray<CredentialBackendEntry>;
};

/** The minimal stored shape a backend moves around; the ledger adds metadata. */
export type CredentialBackendEntry = {
  readonly providerId: CredentialProviderId;
  readonly accountId: string;
  readonly secret?: string;
};

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type CredentialFailureCode =
  /** `providerId` is not in the closed provider set. */
  | "unknown_provider"
  /** `accountId` fails {@link CREDENTIAL_ACCOUNT_ID_PATTERN}. */
  | "invalid_account_id"
  /** A provider that needs a secret was given a missing/blank one. */
  | "missing_secret"
  /** An account with this `(providerId, accountId, scope)` already exists. */
  | "duplicate_account"
  /** No such account in that scope. */
  | "unknown_account"
  /** `switch`/`delete` targeted a provider whose current pointer is absent. */
  | "not_logged_in"
  /** `delete` refused: the account is its provider's current pointer. */
  | "current_account_protected"
  /** Unknown `formatVersion`, unknown key, or checksum mismatch. Whole file refused. */
  | "credentials_corrupt"
  /** The ledger file exists but is group/world readable. */
  | "credentials_insecure"
  /** A path resolved outside its root (`..` escape). */
  | "path_escape"
  /** A writer already holds the ledger lock. */
  | "lock_conflict"
  /** The directory a ledger lives in could not be created. */
  | "directory_unavailable"
  /** A keyring backend was explicitly requested but none is attached. */
  | "keyring_unavailable"
  /** `exportSecrets` called without `confirm: true`. */
  | "confirm_required"
  /** A declared env variable is set, so a ledger write would be shadowed. */
  | "env_shadowed"
  /** The filesystem raised while reading a ledger (not the same as a miss). */
  | "read_failed"
  /** The filesystem raised while replacing a ledger. */
  | "write_failed";

export type CredentialFailure = {
  readonly ok: false;
  readonly code: CredentialFailureCode;
  readonly detail: string;
};

export type CredentialOk<T> = { readonly ok: true; readonly value: T };

export type CredentialResult<T> = CredentialOk<T> | CredentialFailure;

// ---------------------------------------------------------------------------
// Verb payloads
// ---------------------------------------------------------------------------

export type CredentialLoginInput = {
  readonly providerId: CredentialProviderId;
  /** Explicit account id; generated when omitted. */
  readonly accountId?: string | undefined;
  /** Required for keyed providers; optional for `fixture`. */
  readonly secret?: string | undefined;
  readonly label?: string | undefined;
  /** Defaults to `"user"`. `"project"` must be explicit. */
  readonly scope?: CredentialScope | undefined;
  readonly authType?: "api_key" | "oauth" | undefined;
  readonly accessToken?: string | undefined;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly tokenType?: string | undefined;
  readonly tokenEndpoint?: string | undefined;
  readonly clientId?: string | undefined;
};

export type CredentialLogoutInput = {
  readonly providerId: CredentialProviderId;
  /** Omit to clear both scopes for this provider. */
  readonly scope?: CredentialScope | undefined;
};

/**
 * Read one stored account by id, without touching any current pointer.
 *
 * This is the verb a *provider declaration* needs: `providers add amd --account
 * work` says "this endpoint uses the `work` key", and resolving that must never
 * go through `switch`, because `switch` moves the family's current pointer and
 * would re-point every other `openai-compatible` endpoint with it.
 *
 * Deliberately narrower than `get`: an environment declaration is *not* consulted
 * here, because the caller has named a specific account and returning the env
 * key instead would send one host a key that was issued for another — the one
 * mistake this verb exists to make impossible.
 */
export type CredentialGetAccountInput = {
  readonly providerId: CredentialProviderId;
  readonly accountId: string;
};

export type CredentialSwitchInput = {
  readonly providerId: CredentialProviderId;
  readonly accountId: string;
  readonly scope: CredentialScope;
};

export type CredentialDeleteInput = {
  readonly providerId: CredentialProviderId;
  readonly accountId: string;
  readonly scope: CredentialScope;
};

export type CredentialUpdateTokenInput = {
  readonly providerId: CredentialProviderId;
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly tokenType?: string | undefined;
  readonly scope?: CredentialScope | undefined;
};

/** What `get` returns on a hit. `secret` is present only when `layer !== "none"`. */
export type CredentialResolved = {
  readonly providerId: CredentialProviderId;
  readonly layer: CredentialLayer;
  readonly accountId: string;
  readonly label?: string;
  readonly secret?: string;
  readonly authType?: "api_key" | "oauth";
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly tokenType?: string;
  readonly tokenEndpoint?: string;
  readonly clientId?: string;
  readonly scope?: string;
};

/** One public row of `list`. Never carries a secret. */
export type CredentialPublicEntry = {
  readonly providerId: CredentialProviderId;
  readonly accountId: string;
  readonly scope: CredentialScope;
  readonly label?: string;
  readonly isCurrent: boolean;
  readonly authType?: "api_key" | "oauth";
  readonly expiresAt?: string;
};

/** One row of `status`. Never carries a secret. */
export type CredentialStatusRow = {
  readonly providerId: CredentialProviderId;
  readonly layer: CredentialLayer;
  readonly accountId: string;
  readonly label?: string;
  readonly loggedIn: boolean;
  readonly authType?: "api_key" | "oauth";
  readonly expiresAt?: string;
};

/** The serializable public view: safe for `doctor`, a bug report or `--json`. */
export type CredentialPublicView = {
  readonly formatVersion: typeof CREDENTIAL_FORMAT_VERSION;
  readonly status: ReadonlyArray<CredentialStatusRow>;
  readonly entries: ReadonlyArray<CredentialPublicEntry>;
};

/** The explicit-secret view. Only reachable through `exportSecrets({ confirm: true })`. */
export type CredentialSecretsView = {
  readonly formatVersion: typeof CREDENTIAL_FORMAT_VERSION;
  readonly records: ReadonlyArray<CredentialRecord>;
};

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export type CredentialPort = {
  /** Store a credential and point that provider's current at it. */
  login(input: CredentialLoginInput): CredentialResult<CredentialRecord>;
  /** Clear the current pointer for a provider; other accounts are untouched. */
  logout(input: CredentialLogoutInput): CredentialResult<ReadonlyArray<CredentialStatusRow>>;
  /** One row per provider. Resolves env first. Never carries a secret. */
  status(): CredentialResult<ReadonlyArray<CredentialStatusRow>>;
  /** Public records, optionally filtered by scope. Never carries a secret. */
  list(scope?: CredentialScope): CredentialResult<ReadonlyArray<CredentialPublicEntry>>;
  /** Resolve a provider's credential. The secret is present only on a hit. */
  get(providerId: CredentialProviderId): CredentialResult<CredentialResolved>;
  /**
   * Resolve one *named* account, current pointer untouched.
   *
   * A miss is `unknown_account`, not `layer:"none"`: the caller asked for an
   * account by name, so "there is no such account" and "the provider has no
   * credential" are different facts and the second one would read as a login
   * problem when it is really a typo.
   */
  getAccount(input: CredentialGetAccountInput): CredentialResult<CredentialResolved>;
  /** Move one provider's current pointer. Unknown account leaves it unchanged. */
  switch(input: CredentialSwitchInput): CredentialResult<CredentialStatusRow>;
  /** Remove a record. Refused when it is the provider's current pointer. */
  delete(input: CredentialDeleteInput): CredentialResult<CredentialRecord>;
  /** Update stored OAuth tokens after renewal. */
  updateToken(input: CredentialUpdateTokenInput): CredentialResult<CredentialRecord>;
  /** `status` + `list` as one serializable public object. Never carries a secret. */
  exportPublic(): CredentialResult<CredentialPublicView>;
  /** Every record *with* secrets. Refused unless `confirm` is exactly `true`. */
  exportSecrets(options: { readonly confirm: boolean }): CredentialResult<CredentialSecretsView>;
};

// ---------------------------------------------------------------------------
// Pure predicates and constants
// ---------------------------------------------------------------------------

export function isCredentialProviderId(value: string): value is CredentialProviderId {
  return (CREDENTIAL_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isCredentialScope(value: string): value is CredentialScope {
  return (CREDENTIAL_SCOPES as readonly string[]).includes(value);
}

export function isCredentialAccountId(value: string): boolean {
  return CREDENTIAL_ACCOUNT_ID_PATTERN.test(value);
}

/** `fixture` is keyless; every other provider requires a non-empty secret. */
export function providerRequiresSecret(providerId: CredentialProviderId): boolean {
  return providerId !== "fixture";
}
