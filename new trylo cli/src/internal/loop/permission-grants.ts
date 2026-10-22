import {
  nameWidePattern,
  permissionPattern,
  type PermissionAction,
  type PermissionResolution,
  type PermissionScope,
} from "../ports/permission.js";
import type { JsonObject } from "../protocol/envelope.js";
import { deepFreeze } from "../protocol/validate.js";

/**
 * Remembered decisions for the lifetime selected by the composition root.
 *
 * This is deliberately *not* a ledger and *not* the persisted permission store:
 * it lives in memory. Standalone turns create their own cache; the CLI lends
 * one cache across turns of an open session and clears it on close.
 *
 * The key is the call's fingerprint, never the tool name. "Allow writes" is not
 * a thing that can be recorded here — what can be recorded is "this exact call
 * was allowed", and a different argument is a different call.
 *
 * The one name-wide entry is a *denial*: answering "deny this tool" is an
 * operator turning a capability off, which is a widening that is safe in the
 * fail-closed direction and is also what removes the tool from the catalog.
 */

export type PermissionGrant = {
  readonly pattern: string;
  readonly name: string;
  readonly decision: "approved" | "denied";
};

export type GrantLookup =
  | { readonly kind: "approved" }
  | { readonly kind: "denied" }
  | { readonly kind: "ask" };

export type PermissionGrantCache = {
  lookup(action: PermissionAction): GrantLookup;
  record(action: PermissionAction, resolution: PermissionResolution, scope: PermissionScope): void;
  isDenied(name: string): boolean;
  entries(): ReadonlyArray<PermissionGrant>;
  revoke(pattern: string): void;
  clear(): void;
};

export function buildPermissionAction(
  toolCallId: string,
  name: string,
  args: JsonObject,
): PermissionAction {
  const argumentsSnapshot = structuredClone(args);
  deepFreeze(argumentsSnapshot);
  return Object.freeze({ toolCallId, name, arguments: argumentsSnapshot, pattern: permissionPattern(name, argumentsSnapshot) });
}

export function createPermissionGrantCache(): PermissionGrantCache {
  const grants = new Map<string, PermissionGrant>();
  return {
    lookup(action) {
      const denied = grants.get(nameWidePattern(action.name));
      if (denied !== undefined) {
        return { kind: "denied" };
      }
      const exact = grants.get(action.pattern);
      if (exact !== undefined) {
        return { kind: exact.decision };
      }
      return { kind: "ask" };
    },
    record(action, resolution, scope) {
      if (resolution === "approved") {
        if (scope !== "session") {
          return;
        }
        grants.set(action.pattern, { pattern: action.pattern, name: action.name, decision: "approved" });
        return;
      }
      if (resolution === "denied" && scope === "session") {
        // The answer was "no such tool at all", so every argument is covered.
        grants.set(nameWidePattern(action.name), {
          pattern: nameWidePattern(action.name),
          name: action.name,
          decision: "denied",
        });
      }
    },
    isDenied(name) {
      return grants.get(nameWidePattern(name))?.decision === "denied";
    },
    entries() {
      return [...grants.values()];
    },
    revoke(pattern) {
      grants.delete(pattern);
    },
    clear() {
      grants.clear();
    },
  };
}
