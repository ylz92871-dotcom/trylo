import { fields, identity, text } from "../../validation/json-shape.js";
import { canonicalRuntimeRoot, runtimePathIdentity } from "./files-contract.js";

/** Private startup metadata from a host-resolved workspace, never durable funding or source authority. */
export type CentralRuntimeWorkspaceLocation = {
  readonly scope: string;
  readonly physicalRoot: string;
  readonly workspaceId: string;
};

export function isCentralRuntimeWorkspaceLocation(value: unknown): value is CentralRuntimeWorkspaceLocation {
  if (!fields(value, ["scope", "physicalRoot", "workspaceId"]) || !identity(value.workspaceId)
    || !text(value.scope, 32768) || !text(value.physicalRoot, 32768)) return false;
  try { return canonicalRuntimeRoot(value.scope) === value.scope && canonicalRuntimeRoot(value.physicalRoot) === value.physicalRoot; }
  catch { return false; } // Invalid startup paths cannot supply execution location evidence.
}

export function runtimeWorkspaceLocationMatches(location: CentralRuntimeWorkspaceLocation, workspaceRoot: string,
  configuration: Readonly<Record<string, unknown>>): boolean {
  return runtimePathIdentity(location.scope) === runtimePathIdentity(workspaceRoot) && location.workspaceId === configuration.workspaceId;
}
