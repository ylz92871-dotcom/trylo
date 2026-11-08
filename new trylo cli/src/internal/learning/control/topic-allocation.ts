import type { TopicBudgetBid } from "./topic-bid.js";
import { LEARNING_DOMAINS } from "./contracts.js";
import { canonicalJson, contentHashOf } from "./hash.js";
import { allocateLearning } from "./allocation-kernel.js";
import { fields, identity, list, sequence } from "../../validation/json-shape.js";

export type TopicAllocationRequest = {
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly boardSequence: number;
  readonly utilityUnit: string;
  readonly quotaUnit: string;
  /** Host assertion; shared-benefit domains require a joint model, not an additive allocation. */
  readonly domainRelation: "separable";
  readonly totalQuota: number;
  readonly bids: readonly TopicBudgetBid[];
};

export type TopicAllocation = {
  readonly schemaVersion: 1;
  readonly allocationId: string;
  readonly scope: string;
  readonly boardSequence: number;
  readonly utilityUnit: string;
  readonly quotaUnit: string;
  readonly allocated: number;
  readonly netValue: number;
  readonly allocations: readonly { readonly domain: TopicBudgetBid["domain"]; readonly valuationId: string;
    readonly bidHash: string; readonly quota: number }[];
};

export type TopicAllocationResult =
  | { readonly status: "rejected"; readonly reason: "topic_allocation_invalid" | "topic_allocation_binding" }
  | { readonly status: "allocated"; readonly request: TopicAllocationRequest; readonly plan: TopicAllocation };

export function allocateTopicBudget(json: string): TopicAllocationResult {
  const invalid = { status: "rejected", reason: "topic_allocation_invalid" } as const;

  if (typeof json !== "string" || json.length > 65536) return invalid;

  let raw: unknown;

  try { raw = JSON.parse(json); } catch { return invalid; }

  if (!fields(raw, ["schemaVersion", "scope", "boardSequence", "utilityUnit", "quotaUnit", "domainRelation", "totalQuota", "bids"])
    || raw.schemaVersion !== 1 || !identity(raw.scope) || !sequence(raw.boardSequence) || !identity(raw.utilityUnit) || !identity(raw.quotaUnit)
    || raw.domainRelation !== "separable" || !sequence(raw.totalQuota) || raw.totalQuota > 6 || !list(raw.bids, 0, LEARNING_DOMAINS.length)) return invalid;

  const bids: TopicBudgetBid[] = [], domains = new Set<string>(), identities = new Set<string>();

  for (const bid of raw.bids) {
    if (!isTopicBudgetBid(bid) || domains.has(bid.domain) || identities.has(bid.valuationId)) return invalid;
    if (bid.scope !== raw.scope || bid.basis.boardSequence !== raw.boardSequence
      || bid.utilityUnit !== raw.utilityUnit || bid.quotaUnit !== raw.quotaUnit) {
      return { status: "rejected", reason: "topic_allocation_binding" };
    }
    domains.add(bid.domain);
    identities.add(bid.valuationId);
    bids.push(bid);
  }

  const request: TopicAllocationRequest = { schemaVersion: 1, scope: raw.scope, boardSequence: raw.boardSequence,
    utilityUnit: raw.utilityUnit, quotaUnit: raw.quotaUnit, domainRelation: "separable", totalQuota: raw.totalQuota, bids };
  const allocated = allocateLearning(bids.map(bid => ({ domain: bid.domain, values: bid.curve.map(point => point.netValue) })), request.totalQuota);
  const allocations = Object.freeze(allocated.allocations.map((item, index) => Object.freeze({ ...item, domain: bids[index]!.domain,
    valuationId: bids[index]!.valuationId, bidHash: contentHashOf(bids[index]) })));
  const body = { schemaVersion: 1 as const, scope: request.scope, boardSequence: request.boardSequence,
    utilityUnit: request.utilityUnit, quotaUnit: request.quotaUnit, allocated: allocated.allocated, netValue: allocated.value, allocations };

  return { status: "allocated", request, plan: Object.freeze({ ...body, allocationId: `topic-allocation:${contentHashOf(request)}` }) };
}

export function isTopicBudgetBid(value: unknown): value is TopicBudgetBid {
  if (!fields(value, ["schemaVersion", "valuationId", "domain", "scope", "basis", "utilityUnit", "quotaUnit", "modelKind", "curve"])
    || value.schemaVersion !== 1 || !identity(value.valuationId) || !LEARNING_DOMAINS.some(domain => domain === value.domain)
    || !identity(value.scope) || !identity(value.utilityUnit) || !identity(value.quotaUnit)
    || value.modelKind !== "declared_finite_expected_utility" || !fields(value.basis, ["boardSequence", "evidenceWindowHash"])
    || !sequence(value.basis.boardSequence) || !identity(value.basis.evidenceWindowHash) || !list(value.curve, 1, 7)) return false;

  let previous = 0;

  for (const [index, point] of value.curve.entries()) {
    if (!fields(point, ["quota", "netValue"]) || point.quota !== index || typeof point.netValue !== "number" || !Number.isFinite(point.netValue)
      || point.netValue < 0 || point.netValue > 2 || (index === 0 && point.netValue !== 0) || point.netValue + 1e-12 < previous) return false;
    previous = point.netValue;
  }

  // Keep the accepted bid JSON representation stable; numeric identity uses the full content, not a label alone.
  return canonicalJson(value).length <= 8192;
}
