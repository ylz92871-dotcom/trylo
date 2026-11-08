import { contentHashOf } from "../hash.js";
import { fitSchedulingResponse, predictSchedulingResponse } from "../prediction/index.js";
import type { SchedulingResponseQuery } from "../prediction/index.js";
import type { CentralResponseForecastInput, CentralResponseForecastQuery, CentralResponseForecastResult,
  CentralResponseHistory, CentralResponseOpportunity, CentralResponseRequirement } from "./prediction-input.js";
import { validCentralResponseInput } from "./prediction-validation.js";
import { buildCentralInterceptEvidence } from "./prediction-intercept.js";

const ASSUMPTIONS = Object.freeze([
  "The first two complete responses provide a plug-in empirical Gaussian prior and noise scale, not measured known true Gaussian noise.",
  "Calibration-parameter uncertainty is not propagated; exact-class response stability and an ignorable reveal mechanism are working transport assumptions.",
  "Intercept mean/noise R/n reduction is sufficient only for the parameter posterior of one fixed-noise component; its density is not complete-data evidence or a noise estimator.",
]);

/** Exact categorical features: no cross-policy, cross-depth or cross-condition transfer
 * is inferred merely because two opportunities have the same subsystem name. */
export function centralResponseStratum(row: CentralResponseOpportunity): string {
  return contentHashOf([row.scope, row.targetRef, row.stage, row.conditionRef, row.windowRef,
    row.offer.owner, row.offer.policyRef, row.offer.reserve, row.offer.maxPromptChars]);
}

type Measured = CentralResponseHistory & { readonly outcome: Extract<CentralResponseHistory["outcome"], { kind: "paired_window" }> };

type ForecastGroup = { readonly queries: readonly CentralResponseForecastQuery[]; readonly parameterRef: string };

function difference(row: Measured): number { return row.outcome.candidateUtility - row.outcome.baselineUtility; }

function fitGroup(input: CentralResponseForecastInput, rows: readonly Measured[], opportunities: readonly CentralResponseOpportunity[]):
  ForecastGroup | Exclude<CentralResponseForecastResult, { status: "ready" }> {
  // Two is the mathematical minimum for an unbiased residual variance estimate. The
  // calibration pair is used as a proper empirical prior, never fitted a second time.
  const seed = rows.slice(0, 2), updates = rows.slice(2);
  const priorMean = difference(seed[0]!) / 2 + difference(seed[1]!) / 2;
  const contrast = difference(seed[0]!) - difference(seed[1]!);
  const noiseVariance = (contrast / Math.SQRT2) ** 2;
  if (!(noiseVariance > 0) || !Number.isFinite(noiseVariance)) {
    return { status: "unsupported", reason: "history_variance_unidentified", detail: "Calibration variance is zero or outside numeric range" };
  }

  const parameterRef = `response-parameters:${contentHashOf({ target: input.target, rows, estimator: "split-calibration-gaussian-v1" })}`;
  const group = centralResponseStratum(opportunities[0]!);
  const featureMap = { key: "central-exact-stratum-intercept-v1", sourceRef: "central-response:categorical-strata-v1",
    sharedNames: ["stratum_intercept"], localNames: [] };
  const coordinates = (row: CentralResponseOpportunity) => ({ targetKey: input.target.key, featureMapKey: featureMap.key,
    instanceRef: row.instanceRef, baselineRef: row.baselineRef, group, sharedFeatures: [1], localFeatures: [] });
  const evidence = buildCentralInterceptEvidence(updates.map(row => ({ ...coordinates(row), id: row.unitId,
    revisionRef: row.revisionRef, sourceRef: row.sourceRef, value: difference(row) })), noiseVariance, input.limits.maxObservations);
  if (evidence.status !== "ready") return evidence;

  const fit = fitSchedulingResponse({ target: { key: input.target.key, unit: input.target.utilityUnit, stage: opportunities[0]!.stage,
    referenceKey: input.target.referenceKey, baselineRuleKey: input.target.baselineRuleKey, consumerKey: input.target.windowRef },
    featureMap, observations: evidence.value.observations,
    hypotheses: [{ id: "empirical-calibration", logPriorWeight: 0, sourceRef: parameterRef, noiseSourceRef: parameterRef,
      sharedMean: [priorMean], sharedFactor: [[Math.sqrt(noiseVariance / 2)]], localFactor: [],
      noise: evidence.value.noise }], limits: input.limits });
  if (fit.status !== "ready") return fit;

  const queries: SchedulingResponseQuery[] = opportunities.map(row => ({ ...coordinates(row), id: row.opportunityId }));
  const prediction = predictSchedulingResponse(fit.value, { queries });
  if (prediction.status !== "ready") return prediction;

  return { parameterRef, queries: opportunities.map((row, index) => ({ ...row, mean: prediction.value.mean[index]!,
    variance: prediction.value.covariance[index]![index]!, processVariance: noiseVariance,
    support: updates.length === 0 ? "calibrated_history" : "updated_history", parameterRef,
    sourceRefs: rows.map(item => item.sourceRef), calibrationUnitIds: seed.map(item => item.unitId),
    updateUnitIds: updates.map(item => item.unitId), population: rows.length, pending: 0 })) };
}

/** Rebuild from the owner's effective projection on every changed basis. No prediction
 * ledger, timer, permission, provider or accounting state is created here. */
export function buildCentralResponseForecast(input: CentralResponseForecastInput): CentralResponseForecastResult {
  if (!validCentralResponseInput(input)) return { status: "invalid", reason: "central_response_input", detail: "Invalid source projection, target, basis or capacity" };

  if (input.limits.maxObservations === 0 && input.history.some(row => row.outcome.kind === "paired_window")) return {
    status: "unsupported", reason: "capacity_exceeded", detail: "A history-backed response model requires a Gaussian observation slot" };

  const groups = new Map<string, CentralResponseOpportunity[]>();

  for (const row of input.opportunities) {
    const key = centralResponseStratum(row), group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const queries: CentralResponseForecastQuery[] = [], requirements: CentralResponseRequirement[] = [];

  for (const [key, opportunities] of groups) {
    const history = input.history.filter(row => centralResponseStratum(row) === key).sort((a, b) =>
      (a.episodeSequence ?? a.sequence) - (b.episodeSequence ?? b.sequence) || a.unitId.localeCompare(b.unitId));
    const pending = history.some(row => row.outcome.kind === "unknown");
    const measured = history.filter((row): row is Measured => row.outcome.kind === "paired_window");
    const result = pending || measured.length < 2 ? undefined : fitGroup(input, measured, opportunities);
    if (result !== undefined && "queries" in result) {
      queries.push(...result.queries);
      continue;
    }

    if (result !== undefined && result.reason !== "history_variance_unidentified") return result;

    const reason = pending ? "pending_feedback" : measured.length < 2 ? "paired_history_missing" : "history_variance_unidentified";

    for (const row of opportunities) requirements.push({ opportunityId: row.opportunityId, reason, sourceRefs: history.map(item => item.sourceRef) });
  }

  const order = new Map(input.opportunities.map((row, index) => [row.opportunityId, index]));

  queries.sort((a, b) => order.get(a.opportunityId)! - order.get(b.opportunityId)!);
  const joint = { mean: queries.map(row => row.mean), covariance: queries.map(left => queries.map(right =>
    left.parameterRef === right.parameterRef ? left.variance : null)) };
  const value = { schemaVersion: 1 as const, basis: input.basis, target: input.target,
    interpretation: "fixed_window_gross_increment" as const, queries, joint, requirements, modelAssumptions: ASSUMPTIONS };

  return { status: "ready", value: { ...value, forecastRef: `central-response:${contentHashOf({ input, value })}` } };
}
