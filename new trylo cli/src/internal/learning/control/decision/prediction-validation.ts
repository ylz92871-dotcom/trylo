import { fields, identity, sequence } from "../../../validation/json-shape.js";
import { isAllocationBasis, isAllocationOffer } from "../allocation-shape.js";
import { validLimits } from "../prediction/validation.js";
import type { CentralResponseForecastInput, CentralResponseHistory, CentralResponseOpportunity, CentralResponseTarget } from "./prediction-input.js";
import { CENTRAL_RESPONSE_KERNEL_MAX_OBSERVATIONS } from "./prediction-intercept.js";

const OPPORTUNITY_FIELDS = ["opportunityId", "scope", "targetRef", "instanceRef", "sourceRef", "stage", "conditionRef",
  "baselineRef", "windowRef", "offer"];

function opportunity(value: unknown, history: boolean): value is CentralResponseOpportunity {
  const keys = history ? [...OPPORTUNITY_FIELDS, "unitId", "sequence", "revisionRef", "outcome"] : OPPORTUNITY_FIELDS;
  if (!(fields(value, keys) || history && fields(value, [...keys, "episodeSequence"]))) return false;
  return OPPORTUNITY_FIELDS.filter(key => key !== "offer" && key !== "stage").every(key => identity(value[key]))
    && (value.stage === "initial" || value.stage === "continuation") && isAllocationOffer(value.offer);
}

export function isCentralResponseOpportunity(value: unknown): value is CentralResponseOpportunity { return opportunity(value, false); }

export function isCentralResponseTarget(value: unknown): value is CentralResponseTarget {
  const keys = ["key", "utilityUnit", "referenceKey", "baselineRuleKey", "windowRef"];
  return (fields(value, keys) || fields(value, [...keys, "estimand"])) && keys.every(key => identity(value[key]))
    && (!Object.hasOwn(value, "estimand") || value.estimand === "learning_policy_response" || value.estimand === "deployment_response");
}

function historical(value: unknown): value is CentralResponseHistory {
  if (!opportunity(value, true) || !("unitId" in value) || !("sequence" in value)
    || !("revisionRef" in value) || !("outcome" in value)) return false;

  if (!identity(value.unitId) || !identity(value.revisionRef) || !sequence(value.sequence)) return false;

  if ("episodeSequence" in value && (!sequence(value.episodeSequence) || value.episodeSequence > value.sequence)) return false;

  const outcome = value.outcome;

  return fields(outcome, ["kind", "reason"]) && outcome.kind === "unknown" && identity(outcome.reason)
    || fields(outcome, ["kind", "candidateUtility", "baselineUtility"]) && outcome.kind === "paired_window"
      && typeof outcome.candidateUtility === "number" && Number.isFinite(outcome.candidateUtility)
      && typeof outcome.baselineUtility === "number" && Number.isFinite(outcome.baselineUtility)
      && Number.isFinite(outcome.candidateUtility - outcome.baselineUtility);
}

/** Validate once at the projection boundary; no JSON cast or model-controlled priors. */
export function validCentralResponseInput(value: unknown): value is CentralResponseForecastInput {
  if (!fields(value, ["basis", "target", "opportunities", "history", "limits"]) || !isAllocationBasis(value.basis)
    || !isCentralResponseTarget(value.target) || value.target.utilityUnit !== value.basis.utilityUnit
    || !validLimits(value.limits) || value.limits.maxObservations > CENTRAL_RESPONSE_KERNEL_MAX_OBSERVATIONS || value.limits.maxLatentDimension > 512
    || value.limits.maxQueries > 36 || value.limits.maxComponents > 8
    || !Array.isArray(value.opportunities) || value.opportunities.length > value.limits.maxQueries
    || !Array.isArray(value.history)
    || !value.opportunities.every(row => opportunity(row, false)) || !value.history.every(historical)) return false;

  const { basis, target } = value;
  const rows = [...value.opportunities, ...value.history];
  if (!rows.every(row => row.scope === basis.scope && row.targetRef === target.key
    && row.windowRef === target.windowRef)) return false;

  return value.history.every(row => row.sequence <= basis.boardSequence)
    && new Set(value.history.map(row => row.unitId)).size === value.history.length
    && new Set(value.opportunities.map(row => row.opportunityId)).size === value.opportunities.length;
}
