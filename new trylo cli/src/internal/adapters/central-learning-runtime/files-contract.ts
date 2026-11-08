import { fields, identity, sequence, text } from "../../validation/json-shape.js";
import { isCanonicalRuntimeRoot, isRuntimeConfiguration, isRuntimeWake, runtimeSourceWorkspaceRoots,
  runtimeSourceWorkspaceRootsMatchScope, type CentralRuntimeScope } from "./contracts.js";

export { canonicalRuntimeRoot, runtimePathIdentity } from "./contracts.js";

export type RuntimeIntent = {
  readonly schemaVersion: 1; readonly homeRoot: string; readonly workspaceRoot: string;
  readonly enabled: boolean; readonly configuration: Readonly<Record<string, unknown>>;
  readonly wakeSequence: number; readonly consumedSequence: number;
  readonly wakeReason: string; readonly sourceRefs: readonly string[];
  readonly sourceWorkspaceRoots?: readonly string[];
  /** Absent in legacy intents; automatic recovery must never guess an old pause. */
  readonly recoveryPolicy?: "eligible" | "paused";
};

export type RuntimeLocator = {
  readonly schemaVersion: 1; readonly scopeKey: string; readonly ownerId: string;
  readonly pid: number; readonly port: number; readonly token: string;
};

export function runtimeRecoveryState(intent: Pick<RuntimeIntent, "recoveryPolicy"> | undefined): {
  readonly recoveryPolicy: "eligible" | "paused" | "legacy_unclassified"; readonly paused: boolean;
} {
  return { recoveryPolicy: intent?.recoveryPolicy ?? "legacy_unclassified", paused: intent?.recoveryPolicy === "paused" };
}

export type RuntimeScopePaths = CentralRuntimeScope & {
  readonly directory: string; readonly intentPath: string;
  readonly locatorPath: string; readonly ownerLockPath: string;
};

export type RuntimeFileFailure = "runtime_owner_busy" | "runtime_owner_lost" | "runtime_record_invalid"
  | "runtime_scope_mismatch" | "runtime_io_failed";

export type RuntimeResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: RuntimeFileFailure; readonly detail: string };

export type RuntimeOwner = {
  readonly pid: number;
  owns(): boolean;
  writeIntent(value: unknown): RuntimeResult<true>;
  writeLocator(value: unknown): RuntimeResult<true>;
  clearLocator(): RuntimeResult<true>;
  /** Releases only owner.lock; the server explicitly clears its locator before closing. */
  close(): RuntimeResult<true>;
};

export function runtimeFailure(reason: RuntimeFileFailure, detail: string): Extract<RuntimeResult<never>, { ok: false }> {
  return { ok: false, reason, detail };
}

export function runtimeSuccess(): RuntimeResult<true> { return { ok: true, value: true }; }

export function isRuntimeIntent(value: unknown): value is RuntimeIntent {
  return storedFields(value, ["schemaVersion", "homeRoot", "workspaceRoot", "enabled", "configuration", "wakeSequence",
    "consumedSequence", "wakeReason", "sourceRefs"], ["sourceWorkspaceRoots", "recoveryPolicy"])
    && value.schemaVersion === 1 && isCanonicalRuntimeRoot(value.homeRoot) && isCanonicalRuntimeRoot(value.workspaceRoot)
    && typeof value.enabled === "boolean" && isRuntimeConfiguration(value.configuration)
    && sequence(value.wakeSequence) && sequence(value.consumedSequence) && value.consumedSequence <= value.wakeSequence
    && isRuntimeWake({ reason: value.wakeReason, sourceRefs: value.sourceRefs })
    && (!Object.hasOwn(value, "recoveryPolicy") || value.recoveryPolicy === "eligible" || value.recoveryPolicy === "paused")
    && (!Object.hasOwn(value, "sourceWorkspaceRoots") || runtimeSourceWorkspaceRoots(value.sourceWorkspaceRoots)
      && runtimeSourceWorkspaceRootsMatchScope(value.sourceWorkspaceRoots, value.workspaceRoot));
}

export function isRuntimeLocator(value: unknown): value is RuntimeLocator {
  return storedFields(value, ["schemaVersion", "scopeKey", "ownerId", "pid", "port", "token"])
    && value.schemaVersion === 1 && typeof value.scopeKey === "string" && /^[a-f0-9]{64}$/u.test(value.scopeKey)
    && identity(value.ownerId) && sequence(value.pid) && value.pid > 0
    && sequence(value.port) && value.port > 0 && value.port <= 65535 && text(value.token, 512);
}

function storedFields(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const expected = [...keys, ...optional.filter(key => Object.hasOwn(value, key))];
  if (!fields(value, expected) || Reflect.ownKeys(value).length !== expected.length
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => descriptor.enumerable && "value" in descriptor);
}
