/** A wire representation version, independent of the canonical v4 input DTO. */
export const CENTRAL_SINGLE_ACTION_LEGACY_VERSION = "central-learning-single-action-v1";
export const CENTRAL_SINGLE_ACTION_V2_VERSION = "central-learning-single-action-v2";
export const CENTRAL_SINGLE_ACTION_V3_VERSION = "central-learning-single-action-v3";
export const CENTRAL_SINGLE_ACTION_V4_VERSION = "central-learning-single-action-v4";
export const CENTRAL_SINGLE_ACTION_V5_VERSION = "central-learning-single-action-v5";
export const CENTRAL_SINGLE_ACTION_V6_VERSION = "central-learning-single-action-v6";
export const CENTRAL_SINGLE_ACTION_V7_VERSION = "central-learning-single-action-v7";
export const CENTRAL_SINGLE_ACTION_V8_VERSION = "central-learning-single-action-v8";
export const CENTRAL_SINGLE_ACTION_VERSION = "central-learning-single-action-v9";

export type CentralSingleActionVersion = typeof CENTRAL_SINGLE_ACTION_LEGACY_VERSION | typeof CENTRAL_SINGLE_ACTION_V2_VERSION
  | typeof CENTRAL_SINGLE_ACTION_V3_VERSION | typeof CENTRAL_SINGLE_ACTION_V4_VERSION | typeof CENTRAL_SINGLE_ACTION_V5_VERSION
  | typeof CENTRAL_SINGLE_ACTION_V6_VERSION | typeof CENTRAL_SINGLE_ACTION_V7_VERSION | typeof CENTRAL_SINGLE_ACTION_V8_VERSION | typeof CENTRAL_SINGLE_ACTION_VERSION;

export function isCentralSingleActionVersion(value: unknown): value is CentralSingleActionVersion {
  return value === CENTRAL_SINGLE_ACTION_LEGACY_VERSION || value === CENTRAL_SINGLE_ACTION_V2_VERSION
    || value === CENTRAL_SINGLE_ACTION_V3_VERSION || value === CENTRAL_SINGLE_ACTION_V4_VERSION || value === CENTRAL_SINGLE_ACTION_V5_VERSION
    || value === CENTRAL_SINGLE_ACTION_V6_VERSION || value === CENTRAL_SINGLE_ACTION_V7_VERSION || value === CENTRAL_SINGLE_ACTION_V8_VERSION || value === CENTRAL_SINGLE_ACTION_VERSION;
}

/** v8 introduced the outer decision object; v9 makes its object type explicit. */
export function hasCentralDecisionEnvelope(version: CentralSingleActionVersion): boolean {
  return version === CENTRAL_SINGLE_ACTION_V8_VERSION || version === CENTRAL_SINGLE_ACTION_VERSION;
}

export function hasCentralSingleActionHandoff(version: CentralSingleActionVersion): boolean {
  return version === CENTRAL_SINGLE_ACTION_V6_VERSION || version === CENTRAL_SINGLE_ACTION_V7_VERSION || hasCentralDecisionEnvelope(version);
}
