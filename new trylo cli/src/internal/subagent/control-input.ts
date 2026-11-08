import type { JsonObject } from "../protocol/envelope.js";
import type { SubagentGovernance } from "./types.js";
import { SubagentGovernanceError } from "./governance.js";

/** Optional control flags never coerce malformed wire values into an action. */
export function controlFlag(args: JsonObject, key: string): boolean {
  const value = args[key];
  if (value !== undefined && typeof value !== "boolean") {
    throw new SubagentGovernanceError("invalid_arguments", `${key} must be a boolean`);
  }
  return value === true;
}

export function controlText(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  if (value !== undefined && typeof value !== "string") {
    throw new SubagentGovernanceError("invalid_arguments", `${key} must be a string`);
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function dependencyIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16 || value.some(id => typeof id !== "string" || !id.trim() || id.length > 512)) {
    throw new SubagentGovernanceError("invalid_arguments", "depends_on must contain at most 16 task ids");
  }
  return [...new Set(value as string[])];
}

function positiveInteger(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new SubagentGovernanceError("invalid_arguments", `${key} must be a positive safe integer`);
  }
  return value;
}

export function spawnSettings(args: JsonObject): { governance: SubagentGovernance; idleTimeoutMs: number | undefined; allowedTools: ReadonlyArray<string> | undefined } {
  const tokenBudget = positiveInteger(args, "token_budget");
  const timeoutMs = positiveInteger(args, "timeout_ms");
  const idleTimeoutMs = positiveInteger(args, "idle_timeout_ms");
  const allowedTools = args["allowed_tools"];
  if (allowedTools !== undefined && (!Array.isArray(allowedTools) || !allowedTools.every(name => typeof name === "string" && name.length > 0))) {
    throw new SubagentGovernanceError("invalid_arguments", "allowed_tools must be a list of tool names");
  }

  return { governance: { timeoutMode: "active", ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }) }, idleTimeoutMs,
    allowedTools: allowedTools as ReadonlyArray<string> | undefined };
}

export function inputMode(args: JsonObject): "append" | "replace_queued" | "restart" {
  const interrupt = controlFlag(args, "interrupt");
  const mode = args["mode"] === undefined ? interrupt ? "replace_queued" : "append" : args["mode"];
  if (mode !== "append" && mode !== "replace_queued" && mode !== "restart") {
    throw new SubagentGovernanceError("invalid_arguments", "mode must be append, replace_queued or restart");
  }

  if (args["mode"] !== undefined && args["interrupt"] !== undefined) {
    throw new SubagentGovernanceError("invalid_arguments", "Use mode or the legacy interrupt flag, not both");
  }

  return mode;
}

export function resultCursors(args: JsonObject, targets: ReadonlyArray<string>): ReadonlyMap<string, number> {
  const after = args["after"];
  const cursors = new Map<string, number>();

  if (after === undefined) return cursors;

  if (after === null || typeof after !== "object" || Array.isArray(after)) {
    throw new SubagentGovernanceError("invalid_arguments", "after must map target ids to result cursors");
  }

  for (const [target, cursor] of Object.entries(after)) {
    if (!targets.includes(target)) {
      throw new SubagentGovernanceError("invalid_arguments",
        `after key ${JSON.stringify(target)} is absent from targets; keep cursors only for targets in this wait call`);
    }

    if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
      throw new SubagentGovernanceError("invalid_arguments",
        `after cursor for ${JSON.stringify(target)} must be a nonnegative safe integer`);
    }

    cursors.set(target, cursor);
  }

  return cursors;
}
