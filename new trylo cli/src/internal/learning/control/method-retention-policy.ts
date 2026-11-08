import type { MethodLayer } from "./contracts.js";

export const WORKING_LAYER_CAPACITY = 200;
export const SETTLE_BATCH_MAX = 16;
export const SETTLE_MIN_FIELDINGS = 3;
export const SETTLE_MIN_HELPED = 2;

export function nextMethodLayer(input: {
  readonly layer: MethodLayer;
  readonly fielded: number;
  readonly helped: number;
  readonly lastUsedAt: string | undefined;
  readonly at: string;
}): MethodLayer | undefined {
  const now = Date.parse(input.at);
  if (!Number.isFinite(now)) return undefined;

  if (input.layer === "working" && input.fielded >= SETTLE_MIN_FIELDINGS && input.helped >= SETTLE_MIN_HELPED) {
    return "middle";
  }

  // Stable admission is owned by method's prospective evidence + snapshot-bound
  // model review. Counts and recency cannot bypass either gate, including replay.
  return undefined;
}
