/**
 * Durable one-time approval consumption contract (WP-P01-E / E2, hardened after
 * the 2026-09-13 external audit).
 *
 * Ownership: the Permission Service is the only issuer of authorization. Tooling
 * never issues, grants, or approves anything. It may only *consume* a grant that
 * the Permission store can verify.
 *
 * Non-forgeability invariant (external audit P0-1): a caller may not present a
 * self-describing authorization object. The only thing a caller can present is
 * a grant *reference* (`grantId`); every authorization fact (action, candidate,
 * version, scope, expiry, status) is read back from the Permission store that
 * issued the grant. A hand-made reference simply does not resolve.
 *
 * This module is deliberately dependency-free so that the durable file store
 * (`internal/adapters/permission-store`), the in-process fake, and
 * `internal/tooling` can all depend on it without creating an import cycle.
 */

export type ApprovalConsumptionAction = "acquire" | "modify" | "activate" | "contribute";

/** What a caller holds: an opaque reference into the Permission store. */
export type ApprovalGrantRef = {
  readonly grantId: string;
};

/** The authorization facts, owned and served by the Permission store. */
export type PermissionGrant = {
  readonly grantId: string;
  readonly action: ApprovalConsumptionAction;
  readonly candidateId: string;
  readonly packageVersionId: string;
  readonly scope: string;
  readonly issuedAt: string;
  readonly expiry: string;
  readonly status: "active" | "revoked" | "consumed";
};

export type GrantIssuanceInput = {
  readonly action: ApprovalConsumptionAction;
  readonly candidateId: string;
  readonly packageVersionId: string;
  readonly scope: string;
  readonly issuedAt: string;
  readonly expiry: string;
};

export type ApprovalConsumptionRequest = {
  readonly token?: ApprovalGrantRef;
  readonly action: ApprovalConsumptionAction;
  readonly candidateId: string;
  readonly packageVersionId: string;
  readonly scope: string;
  readonly now: string;
};

export type ApprovalConsumptionReceipt = {
  readonly grantId: string;
  readonly action: ApprovalConsumptionAction;
  readonly candidateId: string;
  readonly packageVersionId: string;
  readonly scope: string;
  readonly consumedAt: string;
  readonly sequence: number;
};

/**
 * Failure codes of the permission contract (exactly 18; keep this list and
 * every documentation table in sync).
 *
 * The issuance-only codes were split out after the 2026-09-13 R2 audit (§4.6):
 * the issuance path used to report issuance-time violations with *consumption*
 * codes (`expired` for "expiry <= issuedAt", `invalid_token` for malformed
 * binding facts), which is a silent semantic collision between two different
 * contracts.
 *
 * caller/request shape: missing_token, invalid_token, invalid_now
 * grant resolution:     unknown_grant, grant_revoked
 * grant facts:          invalid_expiry, expired
 * issuance only:        invalid_grant_facts, grant_expiry_not_after_issued
 * binding:              action_mismatch, candidate_mismatch, version_mismatch, scope_mismatch
 * one-time use:         replayed
 * durable store:        ledger_lock_conflict, ledger_corrupt, ledger_torn_tail, ledger_write_failed
 */
export type ApprovalConsumptionFailure =
  /** no grant reference was supplied to the protected call site */
  | "missing_token"
  /** the grant reference is present but malformed */
  | "invalid_token"
  /** `now` is not a strict ISO-8601 timestamp */
  | "invalid_now"
  /** the Permission store has no grant under this reference */
  | "unknown_grant"
  /** the grant exists but was revoked before consumption */
  | "grant_revoked"
  /** the stored grant expiry is not a strict ISO-8601 timestamp */
  | "invalid_expiry"
  /** expiry is at or before `now`, compared numerically */
  | "expired"
  /** issuance only: action/binding facts are not usable grant facts */
  | "invalid_grant_facts"
  /** issuance only: expiry is at or before issuedAt */
  | "grant_expiry_not_after_issued"
  | "action_mismatch"
  | "candidate_mismatch"
  | "version_mismatch"
  | "scope_mismatch"
  /** the grant was already consumed; grants are single-use across all call sites */
  | "replayed"
  /** another writer holds the store lock */
  | "ledger_lock_conflict"
  /** checksum mismatch, sequence gap, unknown format version or malformed record */
  | "ledger_corrupt"
  /** trailing record is incomplete (crash mid-append) */
  | "ledger_torn_tail"
  /** filesystem error while reading or durably appending */
  | "ledger_write_failed";

export type ApprovalConsumptionOutcome =
  | { readonly ok: true; readonly value: ApprovalConsumptionReceipt }
  | { readonly ok: false; readonly code: ApprovalConsumptionFailure; readonly message: string };

export type ApprovalConsumptionPort = {
  readonly consume: (request: ApprovalConsumptionRequest) => Promise<ApprovalConsumptionOutcome>;
};

/**
 * Result of reading grant facts back out of a Permission store.
 *
 * `ok: false` means the store itself could not be read (corrupt ledger, torn
 * tail, I/O failure); `ok: true` with `grant: undefined` means the store is
 * healthy and holds no such grant. The old signature collapsed both into
 * `undefined`, silently swallowing corruption on the read path while the consume
 * path reported it (external audit R2 §4.3).
 */
export type PermissionGrantLookup =
  | { readonly ok: true; readonly grant: PermissionGrant | undefined }
  | { readonly ok: false; readonly code: ApprovalConsumptionFailure; readonly message: string };

export type ApprovalConsumptionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ApprovalConsumptionFailure; readonly message: string };

export type GrantIssuanceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ApprovalConsumptionFailure; readonly message: string };

export function consumptionOk(value: ApprovalConsumptionReceipt): ApprovalConsumptionOutcome {
  return { ok: true, value };
}

export function consumptionErr(
  code: ApprovalConsumptionFailure,
  message: string,
): ApprovalConsumptionOutcome {
  return { ok: false, code, message };
}

const ACTIONS: readonly ApprovalConsumptionAction[] = ["acquire", "modify", "activate", "contribute"];

const ISO8601 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

export function isNonEmptyString(value: unknown): value is string {
  // 与集成层 adapter 校验（integration/shared/validate.ts）保持同一语义：
  // 仅空白字符的字符串视为空。两份实现曾经一个用 trim、一个用 length，
  // 是第二轮质量审计（F5）修正的漂移点。
  return typeof value === "string" && value.trim().length > 0;
}

export function isIso8601(value: unknown): boolean {
  return epochMs(value) !== undefined;
}

/**
 * Dates are compared as epoch milliseconds, never as strings. String comparison
 * of ISO-8601 text breaks across offsets and fractional precision.
 *
 * Calendar-strict (external audit P1-7): `2026-02-30` and other impossible
 * dates are rejected instead of being silently normalized by `Date.parse`.
 */
export function epochMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const match = ISO8601.exec(value);
  if (match === null) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second, fraction, offsetSign, offsetH, offsetM] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) {
    return undefined;
  }

  let offsetMinutes = 0;

  if (offsetSign !== undefined) {
    const oh = Number(offsetH);
    const om = Number(offsetM);
    if (oh > 23 || om > 59) {
      return undefined;
    }
    offsetMinutes = oh * 60 + om;
  }

  const millis = fraction === undefined ? 0 : Math.round(Number(`0.${fraction}`) * 1000);
  let ms = Date.UTC(y, mo - 1, d, h, mi, s, millis);

  if (offsetSign !== undefined) {
    ms += offsetSign === "+" ? -offsetMinutes * 60_000 : offsetMinutes * 60_000;
  }

  return ms;
}

function isAction(value: unknown): value is ApprovalConsumptionAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

/**
 * Pure validation for issuing a grant: the Permission Service must refuse to
 * create grants with malformed facts or an expiry at/before issuance.
 */
export function checkGrantIssuance(input: GrantIssuanceInput): GrantIssuanceCheck {
  if (!isAction(input.action)) {
    return { ok: false, code: "invalid_grant_facts", message: "grant action must be acquire|modify|activate|contribute" };
  }

  if (
    !isNonEmptyString(input.candidateId) ||
    !isNonEmptyString(input.packageVersionId) ||
    !isNonEmptyString(input.scope)
  ) {
    return { ok: false, code: "invalid_grant_facts", message: "grant binding facts must be non-empty strings" };
  }

  const issuedMs = epochMs(input.issuedAt);
  if (issuedMs === undefined) {
    return { ok: false, code: "invalid_now", message: "grant issuedAt is not a strict ISO-8601 timestamp" };
  }

  const expiryMs = epochMs(input.expiry);
  if (expiryMs === undefined) {
    return { ok: false, code: "invalid_expiry", message: "grant expiry is not a strict ISO-8601 timestamp" };
  }

  if (expiryMs <= issuedMs) {
    return {
      ok: false,
      code: "grant_expiry_not_after_issued",
      message: "grant expiry must be after issuedAt",
    };
  }

  return { ok: true };
}

/**
 * Pure, stateless cross-check of a resolved grant against a consumption
 * request. Every implementation of {@link ApprovalConsumptionPort} must apply
 * it after resolving the grant from its store, so that rejection semantics
 * cannot diverge between the durable adapter and the in-process fake.
 */
export function checkApprovalConsumption(
  grant: PermissionGrant,
  request: ApprovalConsumptionRequest,
): ApprovalConsumptionCheck {
  if (!isNonEmptyString(request.candidateId) || !isNonEmptyString(request.packageVersionId) || !isNonEmptyString(request.scope)) {
    return { ok: false, code: "invalid_token", message: "consumption target is malformed" };
  }

  const nowMs = epochMs(request.now);
  if (nowMs === undefined) {
    return { ok: false, code: "invalid_now", message: "consumption time is not a strict ISO-8601 timestamp" };
  }

  if (grant.status === "revoked") {
    return { ok: false, code: "grant_revoked", message: `grant ${grant.grantId} was revoked` };
  }

  if (grant.status === "consumed") {
    return { ok: false, code: "replayed", message: `grant ${grant.grantId} was already consumed` };
  }

  const expiryMs = epochMs(grant.expiry);
  if (expiryMs === undefined) {
    return { ok: false, code: "invalid_expiry", message: "grant expiry is not a strict ISO-8601 timestamp" };
  }

  if (expiryMs <= nowMs) {
    return { ok: false, code: "expired", message: "approval grant expired" };
  }

  if (grant.action !== request.action) {
    return {
      ok: false,
      code: "action_mismatch",
      message: `grant action ${grant.action} cannot authorize ${request.action}`,
    };
  }

  if (grant.candidateId !== request.candidateId) {
    return { ok: false, code: "candidate_mismatch", message: "grant is bound to a different candidate" };
  }

  if (grant.packageVersionId !== request.packageVersionId) {
    return { ok: false, code: "version_mismatch", message: "grant cannot be replayed across package versions" };
  }

  if (grant.scope !== request.scope) {
    return { ok: false, code: "scope_mismatch", message: "grant cannot be reused across scopes" };
  }

  return { ok: true };
}
