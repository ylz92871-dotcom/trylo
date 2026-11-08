import { contentHashOf } from "../../../../../control/hash.js";
import type { CheckInput } from "./contracts.js";

/** A second phase or instruction does not make an already public artifact independent evaluation evidence. */
export function checkerTargetFingerprint(input: CheckInput): string {
  return contentHashOf({ type: "checker_target_v1", requirementRef: input.task.requirementRef,
    requirementDigest: input.task.requirementDigest, output: input.output });
}

export function checkerExposureFingerprints(input: CheckInput): readonly string[] {
  return [contentHashOf(input), checkerTargetFingerprint(input)];
}
