import type {
  ApprovalConsumptionAction,
  ApprovalConsumptionFailure,
  GrantIssuanceInput,
  PermissionGrant,
} from "../../ports/approval-consumption.js";
import {
  epochMs,
  isNonEmptyString,
} from "../../ports/approval-consumption.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";

/**
 * Append-only, checksummed record of one Permission store event.
 *
 * This is *not* a second learning state machine: it holds exactly one kind of
 * fact stream — grants issued, grants revoked, grants consumed — and nothing
 * about Board assets, proposals, or evidence.
 *
 * The file is event-sourced (external audit P1-8): every line is re-validated
 * against the full schema (format version, enum fields, strict timestamps,
 * sequence continuity), so a checksum-valid but malformed record cannot be
 * replayed into state. `formatVersion` is 1; a reader that does not understand
 * a version must refuse the whole file instead of guessing a migration.
 */
export const PERMISSION_STORE_FORMAT_VERSION = 1;

export type PermissionStoreEvent =
  | {
      readonly formatVersion: 1;
      readonly kind: "grant_issued";
      readonly sequence: number;
      readonly grantId: string;
      readonly action: ApprovalConsumptionAction;
      readonly candidateId: string;
      readonly packageVersionId: string;
      readonly scope: string;
      readonly issuedAt: string;
      readonly expiry: string;
    }
  | {
      readonly formatVersion: 1;
      readonly kind: "grant_revoked";
      readonly sequence: number;
      readonly grantId: string;
      readonly revokedAt: string;
    }
  | {
      readonly formatVersion: 1;
      readonly kind: "grant_consumed";
      readonly sequence: number;
      readonly grantId: string;
      readonly action: ApprovalConsumptionAction;
      readonly candidateId: string;
      readonly packageVersionId: string;
      readonly scope: string;
      readonly consumedAt: string;
    };

export type LedgerDecodeErr = Extract<
  ApprovalConsumptionFailure,
  "ledger_corrupt" | "ledger_torn_tail"
>;

/**
 * 每种事件的**精确**键集合（外审 R2 §4.4 的 P3 债）。
 *
 * 旧实现只在 checksum 通过后按已知字段取值，未知键被静默忽略。虽然当时无实害，
 * 但它意味着「未来语义可以靠追加字段偷渡进当前记录」。现在多一个键即 corrupt。
 */
export const GRANT_ISSUED_KEYS: readonly string[] = [
  "formatVersion",
  "kind",
  "sequence",
  "grantId",
  "action",
  "candidateId",
  "packageVersionId",
  "scope",
  "issuedAt",
  "expiry",
];

export const GRANT_REVOKED_KEYS: readonly string[] = [
  "formatVersion",
  "kind",
  "sequence",
  "grantId",
  "revokedAt",
];

export const GRANT_CONSUMED_KEYS: readonly string[] = [
  "formatVersion",
  "kind",
  "sequence",
  "grantId",
  "action",
  "candidateId",
  "packageVersionId",
  "scope",
  "consumedAt",
];

export type LedgerDecode =
  | { readonly ok: true; readonly events: readonly PermissionStoreEvent[] }
  | { readonly ok: false; readonly reason: LedgerDecodeErr; readonly detail: string };

export type LedgerLine =
  | { readonly ok: true; readonly event: PermissionStoreEvent }
  | { readonly ok: false; readonly reason: LedgerDecodeErr; readonly detail: string };

export function grantIssuedEvent(event: Omit<Extract<PermissionStoreEvent, { kind: "grant_issued" }>, "formatVersion">): PermissionStoreEvent {
  return { formatVersion: PERMISSION_STORE_FORMAT_VERSION, ...event };
}

export function grantRevokedEvent(event: Omit<Extract<PermissionStoreEvent, { kind: "grant_revoked" }>, "formatVersion">): PermissionStoreEvent {
  return { formatVersion: PERMISSION_STORE_FORMAT_VERSION, ...event };
}

export function grantConsumedEvent(event: Omit<Extract<PermissionStoreEvent, { kind: "grant_consumed" }>, "formatVersion">): PermissionStoreEvent {
  return { formatVersion: PERMISSION_STORE_FORMAT_VERSION, ...event };
}

export function encodeStoreEvent(event: PermissionStoreEvent): string {
  const payload = canonicalJson(event);
  return `${sha256Hex(payload)} ${payload}\n`;
}

export function decodeStoreLedger(raw: string): LedgerDecode {
  if (raw.length === 0) {
    return { ok: true, events: [] };
  }

  // A trailing line without its terminator means a write was interrupted. The
  // event it may or may not have recorded is unknowable, so the whole store
  // refuses to serve: re-authorization is cheaper than a double side effect.
  if (!raw.endsWith("\n")) {
    return { ok: false, reason: "ledger_torn_tail", detail: "trailing record is incomplete" };
  }

  const lines = splitRecordLines(raw);
  if (!lines.ok) {
    return { ok: false, reason: "ledger_corrupt", detail: lines.detail };
  }

  const events: PermissionStoreEvent[] = [];
  let expected = 1;

  for (const line of lines.value) {
    const parsed = decodeLine(line, expected);
    if (!parsed.ok) {
      return parsed;
    }
    events.push(parsed.event);
    expected = parsed.event.sequence + 1;
  }

  return { ok: true, events };
}

/**
 * Split the ledger into record lines, treating a **blank line between records** as
 * corruption (external audit R3 §3 P3-2).
 *
 * The old implementation used `raw.split("\n").filter((line) => line.length > 0)`,
 * which silently dropped blank lines before per-line validation, so
 * `rec1\n\nrec2\n` and `rec1\nrec2\n` were indistinguishable. That contradicts the
 * documented position that the line terminator is part of record integrity and that
 * any corruption refuses service. A blank line carries no record, so there is no
 * privilege escalation — but it means the file was edited outside the writer, which
 * must fail closed instead of being skipped.
 *
 * The empty element produced by the trailing terminator is a terminator, not a
 * blank line, so it is removed first.
 */
function splitRecordLines(
  raw: string,
): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false; readonly detail: string } {
  const lines = raw.split("\n");

  lines.pop();
  const blank = lines.findIndex((line) => line.length === 0);
  if (blank >= 0) {
    return { ok: false, detail: `blank line between records at line ${String(blank + 1)}` };
  }

  return { ok: true, value: lines };
}

function decodeLine(line: string, expectedSequence: number): LedgerLine {
  const space = line.indexOf(" ");
  if (space <= 0) {
    return { ok: false, reason: "ledger_corrupt", detail: `missing checksum at seq~${String(expectedSequence)}` };
  }

  const checksum = line.slice(0, space);
  const payload = line.slice(space + 1);
  if (sha256Hex(payload) !== checksum) {
    return { ok: false, reason: "ledger_corrupt", detail: `checksum mismatch at seq~${String(expectedSequence)}` };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, reason: "ledger_corrupt", detail: `unparseable record at seq~${String(expectedSequence)}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "ledger_corrupt", detail: `record is not an object at seq~${String(expectedSequence)}` };
  }

  const event = parsed as Record<string, unknown>;
  if (event.formatVersion !== PERMISSION_STORE_FORMAT_VERSION) {
    return {
      ok: false,
      reason: "ledger_corrupt",
      detail: `unsupported format version ${String(event.formatVersion)} at seq~${String(expectedSequence)}`,
    };
  }

  if (typeof event.sequence !== "number" || event.sequence !== expectedSequence) {
    return {
      ok: false,
      reason: "ledger_corrupt",
      detail: `sequence gap: expected ${String(expectedSequence)} got ${String(event.sequence)}`,
    };
  }

  return validateEventShape(event, expectedSequence);
}

function validateEventShape(event: Record<string, unknown>, sequence: number): LedgerLine {
  switch (event.kind) {
    case "grant_issued":
      if (!hasExactKeys(event, GRANT_ISSUED_KEYS)) {
        return corrupt(sequence, "grant_issued carries unknown or missing keys");
      }
      if (
        !isNonEmptyString(event.grantId) ||
        !isStoreAction(event.action) ||
        !isNonEmptyString(event.candidateId) ||
        !isNonEmptyString(event.packageVersionId) ||
        !isNonEmptyString(event.scope) ||
        epochMs(event.issuedAt) === undefined ||
        epochMs(event.expiry) === undefined
      ) {
        return corrupt(sequence, "grant_issued");
      }
      return okEvent(event as PermissionStoreEvent, sequence);
    case "grant_revoked":
      if (!hasExactKeys(event, GRANT_REVOKED_KEYS)) {
        return corrupt(sequence, "grant_revoked carries unknown or missing keys");
      }
      if (!isNonEmptyString(event.grantId) || epochMs(event.revokedAt) === undefined) {
        return corrupt(sequence, "grant_revoked");
      }
      return okEvent(event as PermissionStoreEvent, sequence);
    case "grant_consumed":
      if (!hasExactKeys(event, GRANT_CONSUMED_KEYS)) {
        return corrupt(sequence, "grant_consumed carries unknown or missing keys");
      }
      if (
        !isNonEmptyString(event.grantId) ||
        !isStoreAction(event.action) ||
        !isNonEmptyString(event.candidateId) ||
        !isNonEmptyString(event.packageVersionId) ||
        !isNonEmptyString(event.scope) ||
        epochMs(event.consumedAt) === undefined
      ) {
        return corrupt(sequence, "grant_consumed");
      }
      return okEvent(event as PermissionStoreEvent, sequence);
    default:
      return corrupt(sequence, `unknown kind ${String(event.kind)}`);
  }
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== keys.length) {
    return false;
  }
  const expected = new Set(keys);
  return actual.every((key) => expected.has(key));
}

function isStoreAction(value: unknown): value is ApprovalConsumptionAction {
  return (
    value === "acquire" || value === "modify" || value === "activate" || value === "contribute"
  );
}

function okEvent(event: PermissionStoreEvent, sequence: number): LedgerLine {
  return { ok: true, event: { ...event, sequence } };
}

function corrupt(sequence: number, detail: string): LedgerLine {
  return { ok: false, reason: "ledger_corrupt", detail: `malformed ${detail} at seq~${String(sequence)}` };
}

/**
 * Grant ids are derived, not random: sha256 over the canonical grant facts, the
 * issuing sequence **and the issuing store's identity**.
 *
 * Store identity is required (external audit R2 §3/§4 P2-R4): without it, two
 * stores issuing the same facts at the same sequence derive the same id, and the
 * same reference can be consumed once in each ledger. `storeId` is supplied by
 * the store itself, never by the caller of `consume`.
 *
 * Compatibility: this only changes ids derived *after* the fix. Existing ledgers
 * keep resolving the ids recorded in their own `grant_issued` events, so no
 * migration is needed and no fallback for "store-less" ids is introduced.
 * Cross-store resolution has never existed (`resolveGrant` reads one file), so
 * legacy ids remain confined to the store that physically holds them.
 */
export function deriveGrantId(
  input: GrantIssuanceInput,
  sequence: number,
  storeId: string,
): string {
  const payload = canonicalJson({ ...input, sequence, storeId });
  return `grant:` + sha256Hex(payload).slice(0, 24);
}

/** Fold the event stream into the current facts of one grant. */
export function resolveGrant(
  events: readonly PermissionStoreEvent[],
  grantId: string,
): PermissionGrant | undefined {
  let grant: PermissionGrant | undefined;

  for (const event of events) {
    if (event.grantId !== grantId) {
      continue;
    }
    if (event.kind === "grant_issued") {
      grant = {
        grantId: event.grantId,
        action: event.action,
        candidateId: event.candidateId,
        packageVersionId: event.packageVersionId,
        scope: event.scope,
        issuedAt: event.issuedAt,
        expiry: event.expiry,
        status: "active",
      };
    } else if (event.kind === "grant_revoked" && grant !== undefined) {
      grant = { ...grant, status: "revoked" };
    } else if (event.kind === "grant_consumed" && grant !== undefined) {
      grant = { ...grant, status: "consumed" };
    }
  }

  return grant;
}
