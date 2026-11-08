import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { allocateTopicBudget, type TopicAllocation } from "../../learning/control/topic-allocation.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { readCalibrationReservation, type TopicCalibrationAllocation } from "./calibration-allocation.js";

export type TopicPoolPolicy = { readonly scope: string; readonly poolId: string; readonly algorithmVersion: string;
  readonly utilityUnit: string; readonly quotaUnit: string; readonly totalQuota: number };

export type TopicPoolPlan = TopicAllocation | TopicCalibrationAllocation;

export type PoolLedger = { readonly opened: boolean; readonly reserved: number; readonly plans: ReadonlyMap<string, TopicPoolPlan>;
  readonly requests: ReadonlyMap<string, string>;
  readonly claims: ReadonlyMap<string, number>; readonly spends: ReadonlyMap<string, { readonly units: number; readonly claimId: string; readonly valuationId: string }> };

export type TopicPoolClaim = { readonly schemaVersion: 1; readonly type: "ws1_topic_claim"; readonly allocationId: string;
  readonly domain: string; readonly valuationId: string; readonly offset: number; readonly units: number; readonly spendId: string };

/** Shared structural boundary; replay callers additionally check the charged claim against their reservation. */
export function readPoolClaim(raw: unknown): TopicPoolClaim | undefined {
  if (!fields(raw, ["schemaVersion", "type", "allocationId", "domain", "valuationId", "offset", "units", "spendId"])
    || raw.schemaVersion !== 1 || raw.type !== "ws1_topic_claim" || !identity(raw.allocationId) || !identity(raw.domain)
    || !identity(raw.valuationId) || !identity(raw.spendId) || !sequence(raw.offset) || !sequence(raw.units) || raw.units < 1) return undefined;
  return { schemaVersion: 1, type: "ws1_topic_claim", allocationId: raw.allocationId, domain: raw.domain,
    valuationId: raw.valuationId, offset: raw.offset, units: raw.units, spendId: raw.spendId };
}

export function poolKey(policy: TopicPoolPolicy): string {
  // Algorithm/unit changes cannot manufacture a fresh budget under the same host-issued pool identity.
  return `ws1-pool:${contentHashOf([policy.scope, policy.poolId])}`;
}

export function poolPolicyRecord(policy: TopicPoolPolicy) {
  return { schemaVersion: 1, type: "ws1_topic_pool", ...policy };
}

export function validPoolPolicy(policy: TopicPoolPolicy): boolean {
  return [policy.scope, policy.poolId, policy.algorithmVersion, policy.utilityUnit, policy.quotaUnit].every(identity)
    && sequence(policy.totalQuota) && policy.totalQuota <= 256;
}

export function claimKey(allocationId: string, domain: string): string { return canonicalJson([allocationId, domain]); }

export function spendKey(allocationId: string, domain: string, spendId: string): string { return canonicalJson([allocationId, domain, spendId]); }

/** Rebuilds only this pool's facts from Board. Opaque payloads are never blindly cast as trusted state. */
export function decodePoolLedger(policy: TopicPoolPolicy, facts: readonly RewardV2Fact[]): PoolLedger {
  const key = poolKey(policy), plans = new Map<string, TopicPoolPlan>(), claims = new Map<string, number>();
  const requests = new Map<string, string>();
  const spends = new Map<string, { units: number; claimId: string; valuationId: string }>();
  let opened = false, reserved = 0;

  for (const fact of facts) {
    if (!fact.id.startsWith(key + ":")) continue;

    if (fact.scope !== policy.scope || fact.algorithmVersion !== policy.algorithmVersion || fact.kind !== "learning_decision") throw new Error("topic_pool_corrupt");

    const raw: unknown = JSON.parse(fact.payloadJson);

    if (fact.id === key + ":open") {
      if (opened || canonicalJson(raw) !== canonicalJson(poolPolicyRecord(policy))) throw new Error("topic_pool_policy_conflict");
      opened = true;
      continue;
    }

    if (!opened || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("topic_pool_corrupt");

    const row = raw as Record<string, unknown>;
    if (row.type === "ws1_topic_reservation" || row.type === "ws1_topic_calibration") {
      const { plan, requestId } = row.type === "ws1_topic_reservation"
        ? reservation(policy, raw, fact.sequence) : readCalibrationReservation(policy, raw, fact.sequence);

      if (plans.has(plan.allocationId) || fact.id !== `${key}:reserve:${contentHashOf(plan.allocationId)}`) throw new Error("topic_pool_corrupt");

      if (requestId !== null) {
        if (requests.has(requestId)) throw new Error("topic_pool_request_conflict");
        requests.set(requestId, plan.allocationId);
      }

      plans.set(plan.allocationId, plan);
      reserved += plan.allocated;

      if (reserved > policy.totalQuota) throw new Error("topic_pool_corrupt");
    } else if (row.type === "ws1_topic_claim") {
      const claim = readPoolClaim(row);
      if (claim === undefined) throw new Error("topic_pool_corrupt");

      const grant = plans.get(claim.allocationId)?.allocations.find(item => item.domain === claim.domain);
      const identityKey = claimKey(claim.allocationId, claim.domain), used = claims.get(identityKey) ?? 0;
      const spend = spendKey(claim.allocationId, claim.domain, claim.spendId);
      if (grant === undefined || grant.valuationId !== claim.valuationId || claim.offset !== used || used + claim.units > grant.quota
        || spends.has(spend) || fact.id !== `${key}:claim:${contentHashOf([claim.allocationId, claim.domain, claim.spendId])}`) throw new Error("topic_pool_corrupt");

      claims.set(identityKey, used + claim.units);
      spends.set(spend, { units: claim.units, claimId: fact.id, valuationId: claim.valuationId });
    } else throw new Error("topic_pool_corrupt");
  }

  return { opened, reserved, plans, requests, claims, spends };
}

/** Existing four-field records remain canonical; requestId is optional metadata on new reservations. */
function reservation(policy: TopicPoolPolicy, raw: unknown, factSequence: number): { readonly plan: TopicAllocation; readonly requestId: string | null } {
  if (!fields(raw, ["schemaVersion", "type", "requestJson", "plan"])
    && !fields(raw, ["schemaVersion", "type", "requestJson", "plan", "requestId"])) throw new Error("topic_pool_corrupt");

  if (raw.schemaVersion !== 1 || typeof raw.requestJson !== "string" || ("requestId" in raw && !identity(raw.requestId))) throw new Error("topic_pool_corrupt");

  const parsed = allocateTopicBudget(raw.requestJson);
  if (parsed.status !== "allocated" || parsed.plan.scope !== policy.scope || parsed.plan.utilityUnit !== policy.utilityUnit
    || parsed.plan.quotaUnit !== policy.quotaUnit || parsed.plan.allocated < 1 || parsed.request.totalQuota > policy.totalQuota
    || parsed.plan.boardSequence + 1 !== factSequence || canonicalJson(raw.plan) !== canonicalJson(parsed.plan)) throw new Error("topic_pool_corrupt");

  return { plan: parsed.plan, requestId: typeof raw.requestId === "string" ? raw.requestId : null };
}
