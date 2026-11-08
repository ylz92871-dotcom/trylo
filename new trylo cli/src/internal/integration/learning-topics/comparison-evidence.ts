import type { TopicEvidenceWindow } from "../../learning/domains/shared/topics/contracts.js";
import type { TopicPairedMeasurement } from "../../learning/domains/shared/topics/empirical-model.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { isTopicSemanticText, isBoundedTopicComparisonText } from "./semantic-text.js";

type ArmCommon = { readonly id: string; readonly checked: "pass" | "fail" };

type LegacyArm = ArmCommon & { readonly cost: number };

type CostRoleArm = ArmCommon & { readonly candidateCost: number; readonly studyCost: number };

const COST_UNITS = ["provider_tokens", "bytes_read", "io_cost"] as const;

type ComparisonCommon = {
  readonly case: { readonly kind: "input_version" | "read_opportunity" | "pair_local"; readonly ref: string };
  readonly costUnit: typeof COST_UNITS[number];
};

type ComparisonPayload = ComparisonCommon & (
  | { readonly schemaVersion?: never; readonly arms: readonly [LegacyArm, LegacyArm] }
  | { readonly schemaVersion: 2; readonly arms: readonly [CostRoleArm, CostRoleArm] }
);

/** Legacy cost has no inferred role. V2 separates deployment objective cost from full study cost. */
export type TopicComparisonSummary = ComparisonPayload & { readonly comparisonRef: string };

type Evidence = TopicEvidenceWindow["records"][number];

function isCost(value: unknown, unit: unknown): boolean {
  return unit === "io_cost" ? typeof value === "number" && Number.isFinite(value) && value >= 0 : sequence(value);
}

function isComparisonPayload(value: unknown): value is ComparisonPayload {
  const versioned = typeof value === "object" && value !== null && "schemaVersion" in value;
  if (!fields(value, ["case", "costUnit", "arms", ...(versioned ? ["schemaVersion"] : [])])
    || (versioned && value.schemaVersion !== 2)
    || !fields(value.case, ["kind", "ref"]) || !["input_version", "read_opportunity", "pair_local"].includes(String(value.case.kind))
    || typeof value.case.ref !== "string" || !/^[a-f0-9]{64}$/.test(value.case.ref)
    || !COST_UNITS.some(unit => unit === value.costUnit) || !Array.isArray(value.arms) || value.arms.length !== 2) return false;

  return value.arms.every(arm => fields(arm, ["id", "checked", ...(versioned ? ["candidateCost", "studyCost"] : ["cost"])])
    && identity(arm.id) && arm.id.length <= 64 && (arm.checked === "pass" || arm.checked === "fail")
    && (versioned ? isCost(arm.candidateCost, value.costUnit) && isCost(arm.studyCost, value.costUnit) : isCost(arm.cost, value.costUnit)))
    && value.arms[0].id !== value.arms[1].id;
}

function isComparisonSummary(value: unknown): value is TopicComparisonSummary {
  const versioned = typeof value === "object" && value !== null && "schemaVersion" in value;
  if (!fields(value, ["comparisonRef", "case", "costUnit", "arms", ...(versioned ? ["schemaVersion"] : [])])
    || !identity(value.comparisonRef)) return false;
  const { comparisonRef: _comparisonRef, ...payload } = value;
  return isComparisonPayload(payload);
}

/** Only canonical v2 comparison payloads receive the comparison-specific text allowance. */
export function isTopicComparisonText(text: unknown): boolean {
  if (typeof text !== "string" || !isBoundedTopicComparisonText(text)) return false;
  try {
    const payload: unknown = JSON.parse(text);
    return isComparisonPayload(payload) && payload.schemaVersion === 2 && canonicalJson(payload) === text;
  } catch { return false; }
}

/** The domain supplies verified meaning; this boundary checks shape and binds the real immutable Board source. */
export function comparisonEvidenceRecord(value: unknown, measurement: TopicPairedMeasurement, scope: string,
  boardSequence: number): Evidence | undefined {
  if (!sequence(boardSequence) || measurement.kind !== "measured" || measurement.scope !== scope || !identity(measurement.id)
    || !sequence(measurement.sequence) || measurement.sequence < 1 || measurement.sequence > boardSequence
    || !isComparisonSummary(value) || value.comparisonRef !== measurement.id) return undefined;

  if (value.schemaVersion === 2) {
    const studyCost = value.arms[0].studyCost + value.arms[1].studyCost;
    if (!Number.isFinite(studyCost) || studyCost !== measurement.fullStudyCost) return undefined;
  }

  const text = canonicalJson({ ...(value.schemaVersion === 2 ? { schemaVersion: 2 } : {}),
    case: value.case, costUnit: value.costUnit, arms: value.arms });
  if (value.schemaVersion === 2 ? !isTopicComparisonText(text) : !isTopicSemanticText(text)) return undefined;

  return Object.freeze({ ref: measurement.id, runId: `board:${contentHashOf(scope)}`, sequence: measurement.sequence, scope,
    origin: "checker_result", text });
}
