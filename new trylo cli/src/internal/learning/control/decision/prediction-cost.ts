import { fields, identity, sequence, text } from "../../../validation/json-shape.js";
import type { CentralLearningGrant } from "../coordination-contract.js";
import { isCentralLearningGrant } from "../coordination-parse.js";
import type { LearningAllocationResources } from "../allocation-contract.js";
import type { LearningUsageBoundary } from "../usage-settlement.js";
import type { CentralResponseCost } from "./prediction-input.js";

export const CENTRAL_STAGE_COST_LIMITS = Object.freeze({ reservations: 512, history: 512 });

export type CentralStageCostInput = {
  readonly grant: CentralLearningGrant;
  /** Source-owned closed set for this stage, not the grant's cumulative reservations. */
  readonly reservationIds: readonly string[];
  /** Complete asserts a successful terminal and its complete usage tail for this set. */
  readonly boundary: LearningUsageBoundary;
  readonly sourceRef: string;
};

type CostInvalid = { readonly status: "invalid"; readonly reason: string };

export type CentralStageCostProjection = { readonly status: "ready"; readonly cost: CentralResponseCost } | CostInvalid;

function validBoundary(value: unknown): value is LearningUsageBoundary {
  return fields(value, ["kind"]) && ["complete", "pending", "overrun"].includes(String(value.kind))
    || fields(value, ["kind", "reason"]) && value.kind === "unknown" && text(value.reason, 1000);
}

/** Pure measurement projection. A reservation cap is never substituted for a missing
 * bill; an overrun report is a lower bound even when its usage has been settled. */
export function projectCentralStageCost(input: CentralStageCostInput): CentralStageCostProjection {
  if (!fields(input, ["grant", "reservationIds", "boundary", "sourceRef"]) || !isCentralLearningGrant(input.grant)
    || !identity(input.sourceRef) || !validBoundary(input.boundary) || !Array.isArray(input.reservationIds)
    || input.reservationIds.length > CENTRAL_STAGE_COST_LIMITS.reservations || !input.reservationIds.every(id => text(id, 512))
    || new Set(input.reservationIds).size !== input.reservationIds.length) return { status: "invalid", reason: "central_stage_cost_input" };

  const selected = new Set(input.reservationIds);
  const reservations = input.grant.reservations.filter(item => selected.has(item.reservationId));
  if (reservations.length !== selected.size) return { status: "invalid", reason: "central_stage_cost_reservation_missing" };

  const base = { grantId: input.grant.grantId, sourceRef: input.sourceRef };
  const unknown = (reason: string): CentralStageCostProjection => ({ status: "ready", cost: { ...base, status: "unknown", reason } });

  if (input.boundary.kind !== "complete") return unknown(input.boundary.kind === "unknown" ? input.boundary.reason
    : input.boundary.kind === "overrun" ? "stage_usage_overrun_lower_bound" : "stage_usage_pending");

  let tokens = 0;

  for (const item of reservations) {
    if (item.state !== "settled" || item.usage?.kind !== "reported") return unknown("stage_usage_incomplete");
    if (item.usage.totalTokens > item.maxTokens) return unknown("stage_usage_overrun_lower_bound");
    tokens += item.usage.totalTokens;
    if (!sequence(tokens)) return { status: "invalid", reason: "central_stage_cost_numeric_range" };
  }

  // Canonical central reservation success increments both calls and steps once.
  // grant.steps is cumulative across all stages and is deliberately not used.
  return { status: "ready", cost: { ...base, status: "reported", resources: Object.freeze({ tokens,
    calls: reservations.length, steps: reservations.length }) } };
}

export type CentralStageCostHistory = {
  readonly unitId: string;
  /** Same condition, policy, stage and resource envelope, resolved by the source owner. */
  readonly stratumRef: string;
  readonly cost: CentralResponseCost;
};

export type CentralStageCostSummary = {
  readonly schemaVersion: 1;
  readonly stratumRef: string;
  readonly interpretation: "complete_integer_stage_costs_only";
  readonly status: "observed" | "no_data";
  readonly reportedCount: number;
  readonly unknownCount: number;
  readonly mean: LearningAllocationResources | null;
  /** Unbiased descriptive sample variance; one sample cannot identify it. */
  readonly sampleVariance: LearningAllocationResources | null;
  readonly unitIds: readonly string[];
  readonly unknownUnitIds: readonly string[];
  readonly sourceRefs: readonly string[];
};

export type CentralStageCostSummaryResult = { readonly status: "ready"; readonly value: CentralStageCostSummary } | CostInvalid;

const RESOURCE_KEYS = ["tokens", "calls", "steps"] as const;

function validCost(value: unknown): value is CentralResponseCost {
  if (fields(value, ["status", "grantId", "sourceRef", "reason"])) return value.status === "unknown"
    && text(value.grantId, 512) && identity(value.sourceRef) && text(value.reason, 1000);

  if (!fields(value, ["status", "grantId", "sourceRef", "resources"]) || value.status !== "reported"
    || !text(value.grantId, 512) || !identity(value.sourceRef) || !fields(value.resources, RESOURCE_KEYS)) return false;

  const resources = value.resources;

  return RESOURCE_KEYS.every(key => sequence(resources[key])) && resources.calls === resources.steps
    && Number(resources.calls) <= CENTRAL_STAGE_COST_LIMITS.reservations
    && (resources.tokens === 0 || Number(resources.calls) > 0);
}

/** Descriptive moments of actual integer receipts. Missingness remains explicit:
 * these are not all-episode expected costs, refund estimates or reserve reductions. */
export function summarizeCentralStageCosts(input: {
  readonly stratumRef: string; readonly history: readonly CentralStageCostHistory[];
}): CentralStageCostSummaryResult {
  if (!fields(input, ["stratumRef", "history"]) || !identity(input.stratumRef) || !Array.isArray(input.history)
    || input.history.length > CENTRAL_STAGE_COST_LIMITS.history || !input.history.every(row =>
      fields(row, ["unitId", "stratumRef", "cost"]) && identity(row.unitId) && identity(row.stratumRef) && validCost(row.cost))
    || new Set(input.history.map(row => row.unitId)).size !== input.history.length) return { status: "invalid", reason: "central_stage_cost_history" };

  const rows = input.history.filter(row => row.stratumRef === input.stratumRef);
  const unitIds: string[] = [], unknownUnitIds: string[] = [];
  const mean = { tokens: 0, calls: 0, steps: 0 }, m2 = { tokens: 0, calls: 0, steps: 0 };

  for (const row of rows) {
    if (row.cost.status === "unknown") {
      unknownUnitIds.push(row.unitId);
      continue;
    }

    unitIds.push(row.unitId);

    for (const key of RESOURCE_KEYS) {
      const delta = row.cost.resources[key] - mean[key];
      mean[key] += delta / unitIds.length;
      m2[key] += delta * (row.cost.resources[key] - mean[key]);
      if (!Number.isFinite(mean[key]) || !Number.isFinite(m2[key]) || m2[key] < 0) return { status: "invalid", reason: "central_stage_cost_numeric_range" };
    }
  }

  const n = unitIds.length;

  return { status: "ready", value: Object.freeze({ schemaVersion: 1, stratumRef: input.stratumRef,
    interpretation: "complete_integer_stage_costs_only", status: n === 0 ? "no_data" : "observed",
    reportedCount: n, unknownCount: unknownUnitIds.length, mean: n === 0 ? null : Object.freeze(mean),
    sampleVariance: n < 2 ? null : Object.freeze({ tokens: m2.tokens / (n - 1), calls: m2.calls / (n - 1), steps: m2.steps / (n - 1) }),
    unitIds: Object.freeze(unitIds), unknownUnitIds: Object.freeze(unknownUnitIds),
    sourceRefs: Object.freeze([...new Set(rows.map(row => row.cost.sourceRef))]) }) };
}
