import type { JsonObject } from "../../../../../protocol/envelope.js";

/** A tool lifecycle success is insufficient: shell checkpoints require a known exit.
 * Existing consumers also retain failed calls as negative execution evidence. */
export function workflowCheckStatus(payload: JsonObject): "passed" | "failed" | undefined {
  const value = payload.value;
  const exitCode = typeof value === "object" && value !== null && "exitCode" in value ? value.exitCode : undefined;
  if (payload.status === "failed") return "failed";
  if (payload.status !== "succeeded" || typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)) return undefined;
  return exitCode === 0 ? "passed" : "failed";
}
