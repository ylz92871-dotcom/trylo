import type { JsonObject } from "../../protocol/envelope.js";
import { identity, list, sequence, text } from "../../validation/json-shape.js";
import { isAbsolute, normalize, parse, sep } from "node:path";
import { isCentralRuntimeFailure, type CentralRuntimeFailure } from "./failure-contract.js";
import { isProviderWaitDescriptor, type ProviderWaitDescriptor } from "../../learning/central/runtime/provider-positive.js";

/** Mechanical scope identity. Learning decisions and expenditure remain in the original Board. */
export type CentralRuntimeScope = { readonly homeRoot: string; readonly workspaceRoot: string; readonly scopeKey: string };

export type CentralRuntimeWake = { readonly reason: string; readonly sourceRefs: readonly string[];
  /** Mechanical source-read hints, never filesystem proof or semantic configuration. */
  readonly sourceWorkspaceRoots?: readonly string[] };

export type CentralRuntimeProgress = { readonly message: string; readonly sourceRefs: readonly string[];
  readonly providerWait?: ProviderWaitDescriptor;
  readonly phase?: "initializing";
  /** Only a driver-owned ready return schedules work. Ordinary diagnostics never wake the owner. */
  readonly state?: "ready" | "waiting" | "ended"; readonly wakeAt?: number };

export type CentralRuntimeSnapshot = {
  readonly schemaVersion: 1; readonly scopeKey: string; readonly ownerId: string;
  readonly revision: number; readonly wakeSequence: number; readonly consumedSequence: number;
  readonly state: "waiting" | "running" | "stopping" | "stopped" | "failed";
  readonly progress?: CentralRuntimeProgress;
  readonly reason?: string;
  readonly failure?: CentralRuntimeFailure;
  readonly recoveryPolicy?: "eligible" | "paused";
  readonly paused?: boolean;
};

export type CentralRuntimeDriver = {
  /** A bounded drive may launch domain work and yield. Waiting consumes no inference calls. */
  drive(input: { readonly scope: CentralRuntimeScope; readonly configuration: Readonly<Record<string, unknown>>;
    readonly wake: CentralRuntimeWake; readonly signal: AbortSignal;
    readonly publish: (progress: CentralRuntimeProgress) => void;
  }): Promise<{ readonly state: "waiting" | "ready" | "ended"; readonly reason?: string;
    readonly sourceRefs?: readonly string[]; readonly wakeAt?: number }>;
  close?(): Promise<void>;
};

export type CentralRuntimeRequest =
  | { readonly operation: "status" }
  | { readonly operation: "wait"; readonly afterRevision: number }
  | { readonly operation: "wake"; readonly wake: CentralRuntimeWake; readonly configuration?: Readonly<Record<string, unknown>>;
    readonly requestId?: string }
  | { readonly operation: "wake_receipt"; readonly requestId: string }
  | { readonly operation: "activate" }
  | { readonly operation: "stop"; readonly mode?: "stop" | "pause" | "restart" };

export type CentralRuntimeReply = { readonly ok: true; readonly snapshot: CentralRuntimeSnapshot }
  | { readonly ok: false; readonly reason: string };

/** A mechanical transport nonce; it never becomes a semantic source reference. */
export function isRuntimeWakeRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
}

export function runtimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRuntimeWake(value: unknown): value is CentralRuntimeWake {
  return runtimeRecord(value) && text(value.reason, 256) && runtimeRefs(value.sourceRefs)
    && (value.sourceWorkspaceRoots === undefined && !Object.hasOwn(value, "sourceWorkspaceRoots")
      || runtimeSourceWorkspaceRoots(value.sourceWorkspaceRoots));
}

export function isRuntimeProgress(value: unknown): value is CentralRuntimeProgress {
  return runtimeRecord(value) && text(value.message, 2000) && runtimeRefs(value.sourceRefs)
    && (value.phase === undefined || value.phase === "initializing")
    && (value.state === undefined || ["ready", "waiting", "ended"].includes(String(value.state)))
    && (value.providerWait === undefined || isProviderWaitDescriptor(value.providerWait))
    && (value.wakeAt === undefined || sequence(value.wakeAt));
}

export function isRuntimeSnapshot(value: unknown): value is CentralRuntimeSnapshot {
  return runtimeRecord(value) && value.schemaVersion === 1 && identity(value.scopeKey) && identity(value.ownerId)
    && sequence(value.revision) && sequence(value.wakeSequence) && sequence(value.consumedSequence)
    && value.consumedSequence <= value.wakeSequence
    && ["waiting", "running", "stopping", "stopped", "failed"].includes(String(value.state))
    && (value.progress === undefined || isRuntimeProgress(value.progress))
    && (value.reason === undefined || text(value.reason, 256))
    && (value.recoveryPolicy === undefined || value.recoveryPolicy === "eligible" || value.recoveryPolicy === "paused")
    && (value.paused === undefined || typeof value.paused === "boolean")
    && (value.failure === undefined || value.state === "failed" && isCentralRuntimeFailure(value.failure));
}

export function isRuntimeReply(value: unknown): value is CentralRuntimeReply {
  return runtimeRecord(value) && (value.ok === true ? isRuntimeSnapshot(value.snapshot)
    : value.ok === false && text(value.reason, 256));
}

export function runtimeRefs(value: unknown): value is readonly string[] {
  return list(value, 0, 32) && Object.keys(value).length === value.length && value.every(ref => text(ref, 512));
}

export const MAX_RUNTIME_SOURCE_WORKSPACE_ROOTS = 32;

export function runtimeSourceWorkspaceRoots(value: unknown): value is readonly string[] {
  if (!list(value, 0, MAX_RUNTIME_SOURCE_WORKSPACE_ROOTS) || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor?.enumerable !== true || !("value" in descriptor) || !isCanonicalRuntimeRoot(descriptor.value)) return false;
  }
  return true;
}

/** Folded equality admits hints to this existing process key; only the worker can prove filesystem identity. */
export function runtimeSourceWorkspaceRootsMatchScope(roots: readonly string[], workspaceRoot: string): boolean {
  try {
    const scope = runtimePathIdentity(canonicalRuntimeRoot(workspaceRoot));
    return roots.every(root => isCanonicalRuntimeRoot(root) && runtimePathIdentity(root) === scope);
  } catch { return false; } // Invalid scope metadata grants no source-read compatibility.
}

/** The host supplies canonical roots; this layer never guesses a cwd or resolves a missing root. */
export function canonicalRuntimeRoot(value: string): string {
  if (!text(value, 32768) || !isAbsolute(value) || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError("runtime roots must be absolute paths without control characters");
  }

  if (sep === "\\" && parse(value).root === "\\") throw new TypeError("runtime roots must include their Windows drive or share");

  const normalized = normalize(value);
  const root = normalized.replace(/[\\/]+$/u, "");

  // Keep filesystem roots absolute: C:\ and / must not turn into C: and an empty string.
  return isAbsolute(root) ? root : normalized;
}

export function runtimePathIdentity(value: string): string {
  // Windows paths are case insensitive; the path module already owns platform mechanics.
  return sep === "\\" ? value.toLowerCase() : value;
}

export function isCanonicalRuntimeRoot(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return canonicalRuntimeRoot(value) === value; }
  catch { return false; } // Invalid roots remain invalid; never normalize corrupt records into legitimacy.
}

/** Configuration is JSON-only; its semantic schema and credential exclusions belong to the CLI host. */
export function isRuntimeConfiguration(value: unknown): value is JsonObject {
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 12) return false;

    if (item === null || typeof item === "boolean") return true;

    if (typeof item === "string") return item.length <= 32768;

    if (typeof item === "number") return Number.isFinite(item);

    if (typeof item !== "object" || item === null || Object.getOwnPropertySymbols(item).length > 0) return false;

    if (Array.isArray(item)) return item.length <= 128 && Object.keys(item).length === item.length
      && item.every(entry => visit(entry, depth + 1));

    if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;

    const properties = Object.getOwnPropertyDescriptors(item), entries = Object.entries(properties);

    return entries.length <= 128 && entries.every(([key, descriptor]) => key !== "toJSON" && descriptor.enumerable
      && "value" in descriptor && visit(descriptor.value, depth + 1));
  };
  return runtimeRecord(value) && visit(value, 0);
}
