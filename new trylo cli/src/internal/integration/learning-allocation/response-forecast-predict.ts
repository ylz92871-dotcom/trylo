import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { buildEmpiricalCentralResponseForecast } from "../../learning/control/decision/prediction-empirical.js";
import { buildReferenceCentralResponseForecast, centralReferenceResponseKey } from "../../learning/control/decision/prediction-reference.js";
import type { CentralResponseFamilyBinding, CentralResponseReference } from "../../learning/control/decision/prediction-reference.js";
import type { CentralEffectSupport } from "../../learning/control/decision/effect-support-contract.js";
import type { CentralResponseForecastInput, CentralResponseForecastResult, CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import { validCentralResponseInput } from "../../learning/control/decision/prediction-validation.js";

/** Internal immutable source configuration. The host never supplies this closure. */
export type CentralEvidencePredictor = (input: CentralResponseForecastInput) => CentralResponseForecastResult;

export function createCentralEvidencePredictor(config: {
  readonly target: CentralResponseTarget;
  readonly reference: CentralResponseReference | null;
  readonly partialSupport: CentralEffectSupport | undefined;
  readonly familyBindings: readonly CentralResponseFamilyBinding[];
  readonly boundedKeys: readonly string[];
}): CentralEvidencePredictor {
  const reference = config.reference, bounded = new Set(config.boundedKeys), target = canonicalJson(config.target);
  const bindings = new Map(config.familyBindings.map(row => [row.instanceRef, row]));
  const belongs = (row: CentralResponseForecastInput["opportunities"][number]) => bounded.has(centralReferenceResponseKey(row, bindings));

  return input => {
    if (!validCentralResponseInput(input)) return { status: "invalid", reason: "central_response_input", detail: "Invalid rebound source input" };

    if (canonicalJson(input.target) !== target) return { status: "invalid", reason: "central_response_source_target_changed",
      detail: "Financial-prefix rebinding cannot change the source estimand or fixed target" };

    if (reference === null) return buildEmpiricalCentralResponseForecast(input);

    const boundedInput = { ...input, opportunities: input.opportunities.filter(belongs), history: input.history.filter(belongs) };
    const instances = new Set([...boundedInput.opportunities, ...boundedInput.history].map(row => row.instanceRef));
    const fitted = buildReferenceCentralResponseForecast(boundedInput, reference, config.partialSupport,
      config.familyBindings.filter(row => instances.has(row.instanceRef)));
    if (fitted.status !== "ready") return fitted;

    // An unbounded legacy class is never assigned another protocol's hard support.
    const legacy = buildEmpiricalCentralResponseForecast({ ...input, opportunities: input.opportunities.filter(row => !belongs(row)),
      history: input.history.filter(row => !belongs(row)) });
    if (legacy.status !== "ready") return legacy;

    const order = new Map(input.opportunities.map((row, index) => [row.opportunityId, index]));
    const queries = [...fitted.value.queries, ...legacy.value.queries].sort((left, right) => order.get(left.opportunityId)! - order.get(right.opportunityId)!);
    const joint = { mean: queries.map(row => row.mean), covariance: queries.map(left => queries.map(right =>
      left.variance === 0 || right.variance === 0 ? 0 : left.parameterRef === right.parameterRef ? left.variance : null)) };
    const value = { schemaVersion: 1 as const, basis: input.basis, target: input.target,
      interpretation: "fixed_window_gross_increment" as const, queries, joint,
      requirements: [...fitted.value.requirements, ...legacy.value.requirements],
      modelAssumptions: [...new Set([
        ...(fitted.value.queries.length === 0 ? [] : fitted.value.modelAssumptions ?? []),
        ...(legacy.value.queries.length === 0 ? [] : legacy.value.modelAssumptions ?? []),
        "Legacy classes use their available Gaussian calibration or an empirical point with unidentified variance; v2 bounds are never imputed into them.",
      ])] };

    return { status: "ready", value: { ...value, forecastRef: `central-evidence-response:${contentHashOf({
      input, bounded: fitted.value.forecastRef, legacy: legacy.value.forecastRef, value })}` } };
  };
}
