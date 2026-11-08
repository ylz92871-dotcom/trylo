import { canonicalJson, contentHashOf } from "../../control/hash.js";
import { fields, identity, list, sequence, text } from "../../../validation/json-shape.js";
import { CENTRAL_RUNTIME_LIMITS, isCentralRuntimeReferences } from "./validation.js";

export type ReadFailureReceipt = {
  readonly schema: "central-read-failure/v1";
  readonly scope: string;
  readonly targetHash: string;
  readonly targetCount: number;
  readonly targets: readonly { readonly address: string; readonly version: string }[];
  readonly reason: "content_material_missing" | "content_feedback_material_missing" | "content_material_ambiguous";
  readonly alternatives: readonly string[];
};

type ReadFailureTarget = ReadFailureReceipt["targets"][number];

const reference = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);

function isTarget(value: unknown): value is ReadFailureTarget {
  return fields(value, ["address", "version"]) && reference(value.address) && reference(value.version);
}

function isReceipt(value: unknown): value is ReadFailureReceipt {
  return fields(value, ["schema", "scope", "targetHash", "targetCount", "targets", "reason", "alternatives"])
    && value.schema === "central-read-failure/v1" && identity(value.scope)
    && typeof value.targetHash === "string" && /^[a-f0-9]{64}$/.test(value.targetHash)
    && sequence(value.targetCount) && value.targetCount > 0 && value.targetCount <= CENTRAL_RUNTIME_LIMITS.references
    && list(value.targets, 1, 2) && value.targets.length <= value.targetCount && value.targets.every(isTarget)
    && (value.reason === "content_material_missing" || value.reason === "content_feedback_material_missing" || value.reason === "content_material_ambiguous")
    && isCentralRuntimeReferences(value.alternatives) && value.alternatives.length <= 2;
}

/** Normalize only existing page transports and JSON address spelling, never guess an owner or alias. */
export function canonicalReadAddress(ref: string): string {
  const runtime = /^central-runtime-page:(\d+):(.+)$/.exec(ref), page = /^central-page:(\d+):(.+)$/.exec(ref);
  if (runtime !== null || page !== null) {
    const parts = runtime ?? page!;
    try {
      const original = canonicalReadAddress(runtime === null ? parts[2]! : decodeURIComponent(parts[2]!));
      return Number(parts[1]) === 0 ? original : canonicalJson({ ref: original, start: Number(parts[1]) });
    }
    catch { return ref; } // An invalid transport retains its exact original address.
  }

  const split = ref.indexOf(":");

  try {
    const value: unknown = JSON.parse(ref.slice(split + 1));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? ref.slice(0, split + 1) + canonicalJson(value) : ref;
  }
  catch { return ref; } // Ordinary non-JSON addresses are already opaque identities.
}

/** Only an exact bounded public receipt is a negative read fact. Ordinary error
 * prose, noncanonical JSON and partial/extra fields never become retry fences. */
export function readFailureReceipt(publicResult: string): ReadFailureReceipt | undefined {
  if (typeof publicResult !== "string" || publicResult.length > CENTRAL_RUNTIME_LIMITS.textChars) return undefined;

  let value: unknown;

  try { value = JSON.parse(publicResult); }
  catch { return undefined; } // Legacy public prose is not a read-failure receipt.

  if (!isReceipt(value) || new Set(value.targets.map(target => target.address)).size !== value.targets.length
    || canonicalJson(value) !== publicResult) return undefined;

  return value;
}

/** Failed address/version identity survives new operation IDs and prose. Actual
 * source changes, rather than a Board sequence, supply a different condition. */
export function readFailureConditionKey(receipt: ReadFailureReceipt): string {
  return `central-read-failure-condition:${contentHashOf({ scope: receipt.scope, targetHash: receipt.targetHash, reason: receipt.reason })}`;
}
