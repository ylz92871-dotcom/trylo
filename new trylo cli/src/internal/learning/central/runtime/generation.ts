import { fields } from "../../../validation/json-shape.js";

/** Legacy host defaults, not a model's technical limits or spending authority. */
export const CENTRAL_MIN_OUTPUT_TOKENS = 256;
export const CENTRAL_MAX_OUTPUT_TOKENS = 16384;
export const CENTRAL_DEFAULT_OUTPUT_TOKENS = 8192;
/** Public serialization capacity; it grants neither host capability nor funds. */
export const CENTRAL_MAX_SERIALIZED_OUTPUT_TOKENS = 1_000_000_000;

/** Public capabilities for future thoughts. The root and per-thought total
 * budget still authorize every actual input-plus-generation reservation. */
export interface CentralGenerationLimits {
  readonly defaultMaxOutputTokens: number;
  readonly maxOutputTokens: number;
}

/** Numeric legality only. Each operation must also fit its current host policy. */
export function isCentralThinkMaxOutputTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= CENTRAL_MIN_OUTPUT_TOKENS && value <= CENTRAL_MAX_SERIALIZED_OUTPUT_TOKENS;
}

export function isCentralGenerationLimits(value: unknown): value is CentralGenerationLimits {
  return fields(value, ["defaultMaxOutputTokens", "maxOutputTokens"])
    && Reflect.ownKeys(value).length === 2
    && isCentralThinkMaxOutputTokens(value.defaultMaxOutputTokens) && isCentralThinkMaxOutputTokens(value.maxOutputTokens)
    && value.defaultMaxOutputTokens <= value.maxOutputTokens;
}
