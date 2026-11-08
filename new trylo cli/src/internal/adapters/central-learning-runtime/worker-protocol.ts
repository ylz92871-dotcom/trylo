import type { CentralRuntimeDriver, CentralRuntimeProgress, CentralRuntimeScope, CentralRuntimeWake } from "./contracts.js";
import { isRuntimeConfiguration, isRuntimeProgress, isRuntimeWake, runtimeRecord, runtimeRefs } from "./contracts.js";
import { fields, identity, text } from "../../validation/json-shape.js";
import { canonicalRuntimeRoot } from "./files-contract.js";
import { isCentralRuntimeFailure, type CentralRuntimeFailure } from "./failure-contract.js";
import { isCentralRuntimeWorkspaceLocation, runtimeWorkspaceLocationMatches, type CentralRuntimeWorkspaceLocation } from "./workspace-location.js";

export type CentralRuntimeWorkerBootstrap = {
  readonly schemaVersion: 1; readonly homeRoot: string; readonly workspaceRoot: string;
  readonly configuration: Readonly<Record<string, unknown>>; readonly stopBuffer: SharedArrayBuffer;
  readonly workspaceLocation?: CentralRuntimeWorkspaceLocation;
};

export type CentralRuntimeWorkerResult = Awaited<ReturnType<CentralRuntimeDriver["drive"]>>;

export type CentralRuntimeWorkerRequest = { readonly operation: "metadata_committed" | "stop" | "close" }
  | { readonly operation: "drive"; readonly requestId: string; readonly scope: CentralRuntimeScope; readonly wake: CentralRuntimeWake };

export type CentralRuntimeWorkerReply =
  | { readonly operation: "initialized"; readonly configuration: Readonly<Record<string, unknown>>;
    readonly basisConfiguration: Readonly<Record<string, unknown>>; readonly workspaceRoot: string }
  | { readonly operation: "initialization_cancelled" }
  | { readonly operation: "initialization_failed"; readonly reason: string; readonly failure?: CentralRuntimeFailure }
  | { readonly operation: "progress"; readonly scopeKey: string; readonly progress: CentralRuntimeProgress }
  | { readonly operation: "result"; readonly requestId: string; readonly result: CentralRuntimeWorkerResult }
  | { readonly operation: "drive_failed"; readonly requestId: string; readonly reason: string; readonly failure?: CentralRuntimeFailure }
  | { readonly operation: "closed"; readonly ok: true }
  | { readonly operation: "closed"; readonly ok: false; readonly reason: string };

// Thread messages carry runtime data; TypeScript types alone do not validate them.
export function isCentralRuntimeWorkerBootstrap(value: unknown): value is CentralRuntimeWorkerBootstrap {
  return fields(value, ["schemaVersion", "homeRoot", "workspaceRoot", "configuration", "stopBuffer",
    ...(runtimeRecord(value) && value.workspaceLocation !== undefined ? ["workspaceLocation"] : [])])
    && value.schemaVersion === 1 && text(value.homeRoot, 32768) && text(value.workspaceRoot, 32768)
    && isRuntimeConfiguration(value.configuration) && value.stopBuffer instanceof SharedArrayBuffer && value.stopBuffer.byteLength === 4
    && (value.workspaceLocation === undefined || isCentralRuntimeWorkspaceLocation(value.workspaceLocation)
      && runtimeWorkspaceLocationMatches(value.workspaceLocation, value.workspaceRoot, value.configuration));
}

export function isCentralRuntimeWorkerRequest(value: unknown): value is CentralRuntimeWorkerRequest {
  if (!runtimeRecord(value)) return false;
  if (["metadata_committed", "stop", "close"].includes(String(value.operation))) return fields(value, ["operation"]);
  return fields(value, ["operation", "requestId", "scope", "wake"]) && value.operation === "drive"
    && identity(value.requestId) && fields(value.scope, ["homeRoot", "workspaceRoot", "scopeKey"])
    && text(value.scope.homeRoot, 32768) && text(value.scope.workspaceRoot, 32768) && identity(value.scope.scopeKey) && isRuntimeWake(value.wake);
}

export function isCentralRuntimeWorkerReply(value: unknown): value is CentralRuntimeWorkerReply {
  if (!runtimeRecord(value)) return false;
  switch (value.operation) {
    case "initialized": return fields(value, ["operation", "configuration", "basisConfiguration", "workspaceRoot"])
      && isRuntimeConfiguration(value.configuration) && isRuntimeConfiguration(value.basisConfiguration) && canonicalWorkerRoot(value.workspaceRoot);
    case "initialization_cancelled": return fields(value, ["operation"]);
    case "initialization_failed": return fields(value, ["operation", "reason", ...(value.failure === undefined ? [] : ["failure"])])
      && text(value.reason, 256) && (value.failure === undefined || isCentralRuntimeFailure(value.failure));
    case "progress": return fields(value, ["operation", "scopeKey", "progress"]) && identity(value.scopeKey) && isRuntimeProgress(value.progress);
    case "drive_failed": return fields(value, ["operation", "requestId", "reason", ...(value.failure === undefined ? [] : ["failure"])])
      && identity(value.requestId) && text(value.reason, 256) && (value.failure === undefined || isCentralRuntimeFailure(value.failure));
    case "result": return fields(value, ["operation", "requestId", "result"]) && identity(value.requestId) && runtimeRecord(value.result)
      && ["waiting", "ready", "ended"].includes(String(value.result.state))
      && (value.result.reason === undefined || text(value.result.reason, 256))
      && (value.result.sourceRefs === undefined || runtimeRefs(value.result.sourceRefs))
      && (value.result.wakeAt === undefined || Number.isSafeInteger(value.result.wakeAt) && Number(value.result.wakeAt) >= 0);
    case "closed": return value.ok === true ? fields(value, ["operation", "ok"])
      : fields(value, ["operation", "ok", "reason"]) && value.ok === false && text(value.reason, 256);
    default: return false;
  }
}

function canonicalWorkerRoot(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return canonicalRuntimeRoot(value) === value; }
  catch { return false; } // Only the worker's verified native path may update parent metadata.
}
