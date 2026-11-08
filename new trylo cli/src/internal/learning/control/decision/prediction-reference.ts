import { fields, identity } from "../../../validation/json-shape.js";
import { contentHashOf } from "../hash.js";
import { fitSchedulingResponse, predictSchedulingResponse } from "../prediction/index.js";
import type { CentralEffectSupport } from "./effect-support-contract.js";
import type { CentralResponseForecastInput, CentralResponseForecastQuery, CentralResponseForecastResult,
  CentralResponseHistory, CentralResponseOpportunity } from "./prediction-input.js";
import { centralResponseStratum } from "./prediction-model.js";
import { isCentralResponseTarget, validCentralResponseInput } from "./prediction-validation.js";
import { buildCentralInterceptEvidence } from "./prediction-intercept.js";

export type CentralResponseReference = { readonly minimum: number; readonly maximum: number; readonly sourceRef: string };

export type CentralResponseFamilyBinding = { readonly instanceRef: string; readonly familyRef: string; readonly sourceRef: string };

type Failure = Exclude<CentralResponseForecastResult, { status: "ready" }>;

type Measured = CentralResponseHistory & { readonly outcome: Extract<CentralResponseHistory["outcome"], { kind: "paired_window" }> };

type ReferenceParameters = { readonly mean: number; readonly variance: number; readonly factor: number; readonly noiseVariance: number };

type PendingInterval = readonly [number, number];

const ASSUMPTIONS = Object.freeze([
  "Proper working Gaussian prior moment-matches a uniform law on the source-declared effect support; it is not an observed frequency.",
  "The likelihood variance is the Popoviciu maximum-variance proxy for that support, not measured Gaussian noise.",
  "The point prediction conditions only on revealed outcomes; full-population use requires ignorable reveals and response stability.",
  "pendingMeanRange concerns completion of the working posterior mean, not a confidence interval or the next actual outcome.",
  "Source-declared family equivalence permits transfer only within the same scope, target, stage, condition, window and owner.",
  "Intercept mean/noise R/n reduction is exact for this single fixed-noise posterior only; aggregate density is not full-data evidence or a noise estimate.",
]);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const difference = (row: Measured): number => row.outcome.candidateUtility - row.outcome.baselineUtility;

function invalid(reason: string, detail: string): Failure { return { status: "invalid", reason, detail }; }

function numericFailure(): Failure { return { status: "unsupported", reason: "central_reference_numeric_range",
  detail: "The declared support or working moments cannot be represented without overflow or degenerate variance" }; }

function parameters(reference: CentralResponseReference): ReferenceParameters | Failure {
  const mean = reference.minimum / 2 + reference.maximum / 2;
  if (reference.minimum === reference.maximum) return { mean: reference.minimum, variance: 0, factor: 0, noiseVariance: 0 };
  const width = reference.maximum - reference.minimum, factor = width / Math.sqrt(12);
  const variance = factor * factor, noiseVariance = (width / 2) ** 2;
  return [mean, width, factor, variance, noiseVariance].every(Number.isFinite) && width > 0 && variance > 0 && noiseVariance > 0
    ? { mean, factor, variance, noiseVariance } : numericFailure();
}

function validBindings(bindings: readonly CentralResponseFamilyBinding[], maximum: number): boolean {
  return Array.isArray(bindings) && bindings.length <= maximum && bindings.every(row =>
    fields(row, ["instanceRef", "familyRef", "sourceRef"]) && Object.values(row).every(identity))
    && new Set(bindings.map(row => row.instanceRef)).size === bindings.length;
}

function validPartialSupport(input: CentralResponseForecastInput, support: CentralEffectSupport | undefined): boolean {
  if (support === undefined) return true;

  if (support === null || typeof support !== "object" || support.schemaVersion !== 1
    || support.interpretation !== "actual_registered_window_support" || !identity(support.supportRef)
    || !isCentralResponseTarget(support.target) || contentHashOf(support.target) !== contentHashOf(input.target) || !Array.isArray(support.windows)
    || support.windows.length > input.history.length || support.population !== support.windows.length
    || !support.windows.every(row => row !== null && typeof row === "object"
      && [row.unitId, row.revisionRef, row.sourceRef].every(identity) && Array.isArray(row.sourceRefs) && row.sourceRefs.every(identity)
      && Array.isArray(row.grossSupport) && row.grossSupport.length === 2 && row.grossSupport.every(finite)
      && row.grossSupport[0] <= row.grossSupport[1])
    || new Set(support.windows.map(row => row.unitId)).size !== support.windows.length) return false;

  return support.windows.every(row => {
    const history = input.history.find(item => item.unitId === row.unitId);
    return history !== undefined && history.revisionRef === row.revisionRef && history.sourceRef === row.sourceRef;
  });
}

/** Shared by the canonical source composition when routing bounded versus legacy
 * response classes. It never changes the actual executable offer identity. */
export function centralReferenceResponseKey(row: CentralResponseOpportunity, bindings: ReadonlyMap<string, CentralResponseFamilyBinding>): string {
  const binding = bindings.get(row.instanceRef);
  return binding === undefined ? `exact:${centralResponseStratum(row)}`
    : `family:${contentHashOf([row.scope, row.targetRef, row.stage, row.conditionRef, row.windowRef, row.offer.owner, binding.familyRef])}`;
}

function pendingIntervals(rows: readonly CentralResponseHistory[], reference: CentralResponseReference,
  support: CentralEffectSupport | undefined): readonly PendingInterval[] | Failure {
  const result: PendingInterval[] = [];

  for (const row of rows) {
    if (row.outcome.kind !== "unknown") continue;
    const partial = support?.windows.find(window => window.unitId === row.unitId);
    const low = Math.max(reference.minimum, partial?.grossSupport[0] ?? reference.minimum);
    const high = Math.min(reference.maximum, partial?.grossSupport[1] ?? reference.maximum);
    if (low > high) return invalid("central_reference_support_conflict", "A reliable pending-window support conflicts with the declared effect support");
    result.push([low, high]);
  }

  return result;
}

function completionMeanRange(priorMean: number, measured: readonly Measured[], intervals: readonly PendingInterval[]): PendingInterval | Failure {
  // (R²/4)/(R²/12)=3 is the prior's equivalent observation precision, not a tuned pseudo-count.
  const denominator = 3 + measured.length + intervals.length;
  let low = priorMean * (3 / denominator), high = low;
  for (const row of measured) {
    const term = difference(row) / denominator;
    low += term;
    high += term;
  }
  for (const [left, right] of intervals) {
    low += left / denominator;
    high += right / denominator;
  }
  return [low, high].every(Number.isFinite) && low <= high ? [low, high] : numericFailure();
}

function fitGroup(input: CentralResponseForecastInput, reference: CentralResponseReference, prior: ReferenceParameters,
  context: { readonly key: string; readonly rows: readonly CentralResponseHistory[]; readonly opportunities: readonly CentralResponseOpportunity[];
    readonly bindings: ReadonlyMap<string, CentralResponseFamilyBinding>; readonly partialSupport: CentralEffectSupport | undefined }):
  { readonly queries: readonly CentralResponseForecastQuery[] } | Failure {
  const { rows, opportunities, key, bindings, partialSupport } = context;
  const measured = rows.filter((row): row is Measured => row.outcome.kind === "paired_window");
  const pending = pendingIntervals(rows, reference, partialSupport);
  if ("status" in pending) return pending;

  const completion = prior.variance === 0 ? [prior.mean, prior.mean] as const : completionMeanRange(prior.mean, measured, pending);
  if ("status" in completion) return completion;

  const usedBindings = [...new Set([...rows, ...opportunities].map(row => row.instanceRef))].flatMap(instanceRef => {
    const binding = bindings.get(instanceRef);
    return binding === undefined ? [] : [binding];
  });
  const parameterRef = `reference-response-parameters:${contentHashOf({ target: input.target, reference, prior, key, rows, usedBindings })}`;
  const featureMap = { key: "central-reference-stratum-intercept-v1", sourceRef: reference.sourceRef,
    sharedNames: ["response_class_intercept"], localNames: [] };
  const coordinates = (row: CentralResponseOpportunity) => ({ targetKey: input.target.key, featureMapKey: featureMap.key,
    instanceRef: row.instanceRef, baselineRef: row.baselineRef, group: key, sharedFeatures: [1], localFeatures: [] });
  let moments: readonly { readonly mean: number; readonly variance: number }[];

  if (prior.variance === 0) moments = opportunities.map(() => ({ mean: prior.mean, variance: 0 }));
  else {
    const evidence = buildCentralInterceptEvidence(measured.map(row => ({ ...coordinates(row), id: row.unitId, revisionRef: row.revisionRef,
      sourceRef: row.sourceRef, value: difference(row) })), prior.noiseVariance, input.limits.maxObservations);
    if (evidence.status !== "ready") return evidence;

    const fit = fitSchedulingResponse({ target: { key: input.target.key, unit: input.target.utilityUnit, stage: opportunities[0]!.stage,
      referenceKey: input.target.referenceKey, baselineRuleKey: input.target.baselineRuleKey, consumerKey: input.target.windowRef },
      featureMap, observations: evidence.value.observations, hypotheses: [{ id: "bounded-working-reference", logPriorWeight: 0,
        sourceRef: reference.sourceRef, noiseSourceRef: parameterRef, sharedMean: [prior.mean], sharedFactor: [[prior.factor]], localFactor: [],
        noise: evidence.value.noise }], limits: input.limits });
    if (fit.status !== "ready") return fit;

    const prediction = predictSchedulingResponse(fit.value, { queries: opportunities.map(row => ({ ...coordinates(row), id: row.opportunityId })) });
    if (prediction.status !== "ready") return prediction;

    moments = opportunities.map((_, index) => ({ mean: prediction.value.mean[index]!, variance: prediction.value.covariance[index]![index]! }));
  }

  const partialSources = rows.flatMap(row => partialSupport?.windows.find(window => window.unitId === row.unitId)?.sourceRefs ?? []);
  const sourceRefs = [...new Set([reference.sourceRef, ...rows.map(row => row.sourceRef), ...usedBindings.map(row => row.sourceRef),
    ...partialSources, ...(partialSources.length === 0 || partialSupport === undefined ? [] : [partialSupport.supportRef])])];

  return { queries: opportunities.map((row, index) => ({ ...row, ...moments[index]!, processVariance: prior.noiseVariance,
    support: measured.length === 0 ? "bounded_reference_prior" : "updated_bounded_reference", sourceRefs, parameterRef,
    calibrationUnitIds: [], updateUnitIds: measured.map(item => item.unitId), population: rows.length, pending: pending.length,
    grossSupport: Object.freeze({ minimum: reference.minimum, maximum: reference.maximum, sourceRef: reference.sourceRef }),
    ...(pending.length === 0 ? {} : { pendingMeanRange: completion }) })) };
}

/** A source-bounded working reference allows a first prediction without demanding
 * mature historical calibration. Each complete fact is fitted once. Unknown rows
 * remain in the declared population and completion range, never imputed as zero. */
export function buildReferenceCentralResponseForecast(input: CentralResponseForecastInput, reference: CentralResponseReference,
  partialSupport?: CentralEffectSupport, familyBindings: readonly CentralResponseFamilyBinding[] = []): CentralResponseForecastResult {
  if (!validCentralResponseInput(input) || !fields(reference, ["minimum", "maximum", "sourceRef"])
    || !finite(reference.minimum) || !finite(reference.maximum) || reference.minimum > reference.maximum || !identity(reference.sourceRef)
    || !validBindings(familyBindings, input.history.length + input.opportunities.length) || !validPartialSupport(input, partialSupport)) {
    return invalid("central_reference_input", "Invalid target, source bounds, effective partial support or family binding");
  }

  const prior = parameters(reference);
  if ("status" in prior) return prior;

  if (input.limits.maxObservations === 0 && input.history.some(row => row.outcome.kind === "paired_window")) return {
    status: "unsupported", reason: "capacity_exceeded", detail: "A history-backed response model requires a Gaussian observation slot" };

  for (const row of input.history) {
    if (row.outcome.kind !== "paired_window") continue;
    const value = row.outcome.candidateUtility - row.outcome.baselineUtility;
    if (value < reference.minimum || value > reference.maximum) return invalid("central_reference_observation_outside_bounds", "A complete response conflicts with the source-declared support");
  }

  const bindings = new Map(familyBindings.map(row => [row.instanceRef, row]));
  const groups = new Map<string, CentralResponseOpportunity[]>();

  for (const row of input.opportunities) {
    const key = centralReferenceResponseKey(row, bindings), group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const queries: CentralResponseForecastQuery[] = [];

  for (const [key, opportunities] of groups) {
    const rows = input.history.filter(row => centralReferenceResponseKey(row, bindings) === key);
    const result = fitGroup(input, reference, prior, { key, rows, opportunities, bindings, partialSupport });
    if ("status" in result) return result;
    queries.push(...result.queries);
  }

  const order = new Map(input.opportunities.map((row, index) => [row.opportunityId, index]));

  queries.sort((left, right) => order.get(left.opportunityId)! - order.get(right.opportunityId)!);
  const joint = { mean: queries.map(row => row.mean), covariance: queries.map(left => queries.map(right =>
    left.variance === 0 || right.variance === 0 ? 0 : left.parameterRef === right.parameterRef ? left.variance : null)) };
  const value = { schemaVersion: 1 as const, basis: input.basis, target: input.target, interpretation: "fixed_window_gross_increment" as const,
    queries, joint, requirements: [], modelAssumptions: ASSUMPTIONS };

  return { status: "ready", value: { ...value,
    forecastRef: `central-reference-response:${contentHashOf({ input, reference, partialSupport, familyBindings, value })}` } };
}
