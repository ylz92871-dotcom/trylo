import { LEARNING_DOMAINS, type LearningDomain } from "../../learning/control/contracts.js";
import type { TopicAllocation } from "../../learning/control/topic-allocation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";

export type TopicCalibrationRequest = {
  readonly requestId: string; readonly domain: LearningDomain; readonly quota: number; readonly protocolHash: string;
};

export type TopicCalibrationAllocation = Pick<TopicAllocation,
  "schemaVersion" | "scope" | "boardSequence" | "utilityUnit" | "quotaUnit" | "allocated" | "allocations"> & {
  readonly purpose: "calibration"; readonly allocationId: string;
};

type CalibrationPolicy = Pick<TopicAllocation, "scope" | "utilityUnit" | "quotaUnit">;

function domain(value: unknown): value is LearningDomain { return LEARNING_DOMAINS.some(candidate => candidate === value); }

export function readTopicCalibrationRequest(value: unknown): TopicCalibrationRequest | undefined {
  if (!fields(value, ["requestId", "domain", "quota", "protocolHash"]) || !identity(value.requestId) || !domain(value.domain)
    || !sequence(value.quota) || value.quota < 1 || value.quota > 6
    || typeof value.protocolHash !== "string" || !/^[a-f0-9]{64}$/.test(value.protocolHash)) return undefined;
  return Object.freeze({ requestId: value.requestId, domain: value.domain, quota: value.quota, protocolHash: value.protocolHash });
}

export function calibrationBidHash(protocolHash: string): string {
  return contentHashOf({ purpose: "calibration", protocolHash });
}

/** A host nomination reserves resources to obtain evidence. It makes no numerical value claim. */
export function createTopicCalibrationAllocation(policy: CalibrationPolicy, boardSequence: number, request: TopicCalibrationRequest): TopicCalibrationAllocation {
  if (!sequence(boardSequence)) throw new Error("topic_calibration_invalid");

  const basis = { purpose: "calibration", scope: policy.scope, boardSequence,
    utilityUnit: policy.utilityUnit, quotaUnit: policy.quotaUnit, ...request };
  const allocation = Object.freeze({ domain: request.domain, valuationId: `calibration:${request.protocolHash}`,
    bidHash: calibrationBidHash(request.protocolHash), quota: request.quota });

  return Object.freeze({ schemaVersion: 1, purpose: "calibration", allocationId: `topic-calibration:${contentHashOf(basis)}`,
    scope: policy.scope, boardSequence, utilityUnit: policy.utilityUnit, quotaUnit: policy.quotaUnit,
    allocated: request.quota, allocations: Object.freeze([allocation]) });
}

/** Decode only the explicit calibration record; normal finite-model reservations remain a separate schema. */
export function readCalibrationReservation(policy: CalibrationPolicy & { readonly totalQuota: number }, raw: unknown,
  factSequence: number): { readonly plan: TopicCalibrationAllocation; readonly requestId: string } {
  if (!fields(raw, ["schemaVersion", "type", "purpose", "requestId", "domain", "quota", "protocolHash", "plan"])
    || raw.schemaVersion !== 1 || raw.type !== "ws1_topic_calibration" || raw.purpose !== "calibration") throw new Error("topic_pool_corrupt");

  const request = readTopicCalibrationRequest({ requestId: raw.requestId, domain: raw.domain, quota: raw.quota, protocolHash: raw.protocolHash });
  if (request === undefined || request.quota > policy.totalQuota) throw new Error("topic_pool_corrupt");

  const plan = createTopicCalibrationAllocation(policy, factSequence - 1, request);
  if (canonicalJson(raw.plan) !== canonicalJson(plan)) throw new Error("topic_pool_corrupt");

  return { plan, requestId: request.requestId };
}
