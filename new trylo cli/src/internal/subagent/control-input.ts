import type { JsonObject } from "../protocol/envelope.js";
import type { SubagentGovernance } from "./types.js";
import { SubagentGovernanceError } from "./governance.js";

function boundedInteger(args: JsonObject, key: string, maximum: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new SubagentGovernanceError("invalid_arguments", `${key} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function spawnSettings(args: JsonObject): { governance: SubagentGovernance; idleTimeoutMs: number | undefined; allowedTools: ReadonlyArray<string> | undefined } {
  const tokenBudget = boundedInteger(args, "token_budget", 100_000);
  const timeoutMs = boundedInteger(args, "timeout_ms", 900_000);
  const idleTimeoutMs = boundedInteger(args, "idle_timeout_ms", 300_000);
  const allowedTools = args["allowed_tools"];
  if (allowedTools !== undefined && (!Array.isArray(allowedTools) || !allowedTools.every(name => typeof name === "string" && name.length > 0))) {
    throw new SubagentGovernanceError("invalid_arguments", "allowed_tools must be a list of tool names");
  }
  return { governance: { timeoutMode: "active", ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }) }, idleTimeoutMs,
    allowedTools: allowedTools as ReadonlyArray<string> | undefined };
}

export function inputMode(args: JsonObject): "append" | "replace_queued" | "restart" {
  const mode = args["mode"] ?? (args["interrupt"] === true ? "replace_queued" : "append");
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
    if (!targets.includes(target) || typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
      throw new SubagentGovernanceError("invalid_arguments", "after contains an unknown target or invalid cursor");
    }
    cursors.set(target, cursor);
  }
  return cursors;
}
