import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "../protocol/envelope.js";

/**
 * The permission contract.
 *
 * Two dimensions were added here in P03, and both exist because a tool *name*
 * is not enough to decide anything safely:
 *
 *  - `arguments`: the already-parsed arguments of the very call being decided.
 *    The loop parses a tool's JSON arguments exactly once (`loop/stream.ts`);
 *    every later stage consumes this object and never re-parses the bytes.
 *  - `pattern`: a normalised fingerprint of those arguments, so "the same call"
 *    is decidable without putting raw values into a rule. Different key order
 *    is the same call; different values are not.
 *
 * `pattern` is the unit a remembered decision is keyed on. It is derived, not
 * supplied: nothing outside this module decides what "the same call" means.
 */

export type PermissionScope = "once" | "session";

export type PermissionResolution = "approved" | "denied" | "cancelled" | "expired";

export type PermissionAction = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly pattern: string;
};

export type PermissionTicket = {
  readonly ticketId: string;
  readonly toolCallId: string;
};

/**
 * `scope` carries an exact-call approval or a tool-wide denial. Cancellation
 * and expiry are always once; no decision is persisted by this port.
 */
export type PermissionDecision = {
  readonly resolution: PermissionResolution;
  readonly scope: PermissionScope;
  /** Optional provenance; older permission adapters can omit it. */
  readonly reason?: PermissionReason;
};

export type PermissionReason = "user_denied" | "policy_denied" | "remembered_denial" | "input_closed" | "user_cancelled";

export type PermissionPort = {
  /** Explicit tool-wide refusals, lent as facts to catalog and dispatch. */
  readonly isDenied?: (name: string) => boolean;
  request(action: PermissionAction): Promise<PermissionTicket>;
  awaitDecision(ticketId: string): Promise<PermissionDecision>;
};

/** Marker for a decision recorded against the whole tool rather than one call. */
export const NAME_WIDE_PATTERN = "*";

export function decision(
  resolution: PermissionResolution,
  scope: PermissionScope = "once",
  reason?: PermissionReason,
): PermissionDecision {
  return {
    resolution,
    scope: resolution === "approved" || resolution === "denied" ? scope : "once",
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Canonical serialisation: object keys are sorted at every level, array order
 * is preserved. Two arguments objects that mean the same thing therefore
 * serialise identically even when they were built in a different order.
 */
export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function permissionPattern(name: string, args: JsonObject): string {
  return `${name}#${createHash("sha256").update(stableJson(args)).digest("hex").slice(0, 32)}`;
}

/** The pattern that stands for "every call to this tool". */
export function nameWidePattern(name: string): string {
  return `${name}#${NAME_WIDE_PATTERN}`;
}

/**
 * The old `{toolCallId, name}` shape has no way to say *which* call is being
 * approved, so admitting it on the mutating path would silently widen a grant
 * to every argument value. This guard is what makes that fail closed.
 */
export function isPermissionAction(value: unknown): value is PermissionAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record.toolCallId === "string" &&
    record.toolCallId.length > 0 &&
    typeof record.name === "string" &&
    record.name.length > 0 &&
    typeof record.arguments === "object" &&
    record.arguments !== null &&
    Array.isArray(record.arguments) === false &&
    typeof record.pattern === "string" &&
    record.pattern.length > 0
  );
}
