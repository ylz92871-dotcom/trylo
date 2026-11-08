import { addToSum, emptySum } from "../../reward/explanation/residual-boundary.js";
import { contentHashOf } from "../hash.js";
import type { CentralResponseForecastInput, CentralResponseForecastQuery, CentralResponseForecastResult,
  CentralResponseHistory, CentralResponseOpportunity } from "./prediction-input.js";
import { buildCentralResponseForecast, centralResponseStratum } from "./prediction-model.js";

const SOURCE = "research:central-decision-continuation-20261104/legacy-empirical-response-notes.md";
const ASSUMPTIONS = Object.freeze([
  "The empirical point is the mean of qualified revealed complete history, projected as a working expectation only under same-class response stability and exchangeability.",
  "Using revealed-only history for a population or future prediction assumes an ignorable reveal mechanism; pending rows remain in population metadata, not the mean.",
  "A repeated value or one observed response does not identify parameter variance or process noise; both remain null, with no confidence interval or invented hard bound.",
]);

type Failure = Exclude<CentralResponseForecastResult, { status: "ready" }>;

type Measured = CentralResponseHistory & { readonly outcome: Extract<CentralResponseHistory["outcome"], { kind: "paired_window" }> };

function empiricalGroup(input: CentralResponseForecastInput, rows: readonly CentralResponseHistory[], opportunities: readonly CentralResponseOpportunity[]):
  readonly CentralResponseForecastQuery[] | Failure {
  const known = rows.filter((row): row is Measured => row.outcome.kind === "paired_window");
  if (known.length === 0) return [];

  let sum = emptySum();

  for (const row of known) sum = addToSum(sum, row.outcome.candidateUtility - row.outcome.baselineUtility);

  const mean = sum.value / known.length;
  if (!Number.isFinite(mean) || sum.value !== 0 && mean === 0) return { status: "unsupported", reason: "central_empirical_response_numeric_range",
    detail: "The observed-history mean cannot be represented without a spurious zero" };

  const parameterRef = `empirical-response-point:${contentHashOf({ target: input.target, rows, estimator: "qualified_revealed_sample_mean_v1" })}`;
  const sourceRefs = [...new Set([SOURCE, ...rows.map(row => row.sourceRef)])];

  return opportunities.map(row => ({ ...row, mean, variance: null, processVariance: null, support: "empirical_history",
    parameterRef, sourceRefs, calibrationUnitIds: [], updateUnitIds: known.map(item => item.unitId),
    population: rows.length, pending: rows.length - known.length }));
}

/** Preserve the existing v1 Gaussian result whenever available. Missing query is
 * not missing economic evidence: qualified complete history still has a sample
 * mean, without requiring nonzero first-pair variance or inventing a noise law. */
export function buildEmpiricalCentralResponseForecast(input: CentralResponseForecastInput): CentralResponseForecastResult {
  const original = buildCentralResponseForecast(input);
  if (original.status !== "ready") return original;

  const existing = new Set(original.value.queries.map(row => row.opportunityId)), groups = new Map<string, CentralResponseOpportunity[]>();

  for (const row of input.opportunities) {
    if (existing.has(row.opportunityId)) continue;
    const key = centralResponseStratum(row), group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const added: CentralResponseForecastQuery[] = [];

  try {
    for (const [key, opportunities] of groups) {
      const rows = input.history.filter(row => centralResponseStratum(row) === key);
      const result = empiricalGroup(input, rows, opportunities);
      if ("status" in result) return result;
      added.push(...result);
    }
  } catch (error) {
    if (error instanceof RangeError && error.message === "residual_sum_numeric_range") return {
      status: "unsupported", reason: "central_empirical_response_numeric_range", detail: "The observed-history mean exceeds numeric capacity" };
    throw error;
  }

  if (added.length === 0) return original;

  const order = new Map(input.opportunities.map((row, index) => [row.opportunityId, index]));
  const queries = [...original.value.queries, ...added].sort((left, right) => order.get(left.opportunityId)! - order.get(right.opportunityId)!);
  const filled = new Set(added.map(row => row.opportunityId));
  const value = { ...original.value, queries, requirements: original.value.requirements.filter(row => !filled.has(row.opportunityId)),
    joint: { mean: queries.map(row => row.mean), covariance: queries.map(left => queries.map(right =>
      left.parameterRef === right.parameterRef ? left.variance : null)) },
    modelAssumptions: [...(original.value.modelAssumptions ?? []), ...ASSUMPTIONS] };

  return { status: "ready", value: { ...value, forecastRef: `central-empirical-response:${contentHashOf({ input, value })}` } };
}
