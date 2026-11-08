import { createHash } from "node:crypto";
import type { CompleteInputTokenObservation } from "../ports/provider.js";
import type { PromptInputCommitment, StoredPromptInputBasisV1 } from "../ports/prompt-input.js";
import type { PromptMeasurement } from "./prompt-measurement.js";

export function isPromptInputDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...names].sort().join(",");
}

function commitment(value: unknown, native: "included" | "absent"): boolean {
  return object(value) && keys(value, native === "included" ? ["count", "digest", "nativeDigest"] : ["count", "digest"])
    && typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 0
    && isPromptInputDigest(value.digest) && (native === "absent" || isPromptInputDigest(value.nativeDigest));
}

/** Unknown versions/fields are unavailable, never partial successful input. */
export function isStoredPromptInputBasisV1(value: unknown): value is StoredPromptInputBasisV1 {
  if (!object(value) || !keys(value, ["version", "model", "input", "inputBindingDigest", "settingsDigest", "toolDigest",
    "windowDigest", "nativeMode", "nonSystem", "systems"]) || value.version !== 1 || typeof value.model !== "string") return false;

  const input = value.input;

  return object(input) && keys(input, ["kind", "source", "tokens"]) && input.kind === "complete_prompt"
    && input.source === "provider_complete_input" && typeof input.tokens === "number"
    && Number.isSafeInteger(input.tokens) && input.tokens >= 0
    && [value.inputBindingDigest, value.settingsDigest, value.toolDigest, value.windowDigest].every(isPromptInputDigest)
    && (value.nativeMode === "none" || value.nativeMode === "measured")
    && commitment(value.nonSystem, "absent") && commitment(value.systems, "included");
}

/** Ordered, count-framed commitments preserve duplicates and occurrence order. */
export function promptInputCommitment(measurement: PromptMeasurement, indices: readonly number[]): PromptInputCommitment {
  const hash = createHash("sha256").update(JSON.stringify(["prompt-input-occurrences-v1", indices.length]));
  for (const index of indices) hash.update(JSON.stringify([measurement.messageDigests[index],
    measurement.nativeIdentity?.messageFieldDigests[index] ?? null]));
  return { count: indices.length, digest: hash.digest("hex") };
}

export function promptNativeSystemDigest(measurement: PromptMeasurement, indices: readonly number[]): string {
  const hash = createHash("sha256").update(JSON.stringify(["prompt-native-systems-v1", indices.length]));
  for (const index of indices) hash.update(JSON.stringify(measurement.nativeIdentity?.messageFieldDigests[index] ?? null));
  return hash.digest("hex");
}

/** Captured from the actual prepared request before streaming, then paired
 * with only that stream's proven complete input observation. */
export function captureStoredInputBasis(measurement: PromptMeasurement,
  input: CompleteInputTokenObservation): StoredPromptInputBasisV1 | undefined {
  const binding = measurement.persistableInput;
  const roles = measurement.messageRoles;
  if (binding === undefined || measurement.model === undefined || measurement.nativeIdentity === null
    || roles === undefined || roles.length !== measurement.messageDigests.length) return undefined;

  const history: number[] = [], systems: number[] = [];

  for (const [index, role] of roles.entries()) (role === "system" ? systems : history).push(index);

  const value = { version: 1, model: measurement.model, input: { ...input }, ...binding,
    toolDigest: measurement.toolDigest, nativeMode: measurement.nativeIdentity === undefined ? "none" : "measured",
    nonSystem: promptInputCommitment(measurement, history),
    systems: { ...promptInputCommitment(measurement, systems), nativeDigest: promptNativeSystemDigest(measurement, systems) } };

  return isStoredPromptInputBasisV1(value) ? value : undefined;
}
