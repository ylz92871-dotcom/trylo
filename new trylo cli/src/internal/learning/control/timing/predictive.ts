import { runTimingJson } from "./boundary.js";
import type { TimingFailure } from "./boundary.js";
import { ExactTiming } from "./exact.js";
import { compilePredictiveTiming, readPredictiveTimingOptions } from "./predictive-compile.js";
import { evaluateCompiledPredictive } from "./predictive-evaluate.js";
import { formatPredictiveTiming } from "./predictive-format.js";
import type { PredictiveTimingAnalysis } from "./predictive-format.js";
import type { NormalizedPredictiveTimingOptions } from "./predictive-contract.js";

export { readPredictiveTimingOptions } from "./predictive-compile.js";
export type { PredictiveTimingAnalysis } from "./predictive-format.js";
export type { PredictiveTimingModel, PredictiveTimingOptions, NormalizedPredictiveTimingOptions } from "./predictive-contract.js";

/** Internal composition seam: options have already passed readPredictiveTimingOptions.
 * The one frozen source declaration is hashed here; no external hash is accepted.
 */
export function evaluatePredictiveTimingModel(raw: unknown, options: NormalizedPredictiveTimingOptions): PredictiveTimingAnalysis {
  const exact = new ExactTiming(options.maxBits), model = compilePredictiveTiming(raw, exact);
  return formatPredictiveTiming(model, evaluateCompiledPredictive(model, exact, options), exact);
}

/** Pure advisory analysis. An upper, witness, or first-control certificate grants no execution permission. */
export function analyzeLearningTiming(json: unknown, options: unknown = undefined): PredictiveTimingAnalysis | TimingFailure {
  return runTimingJson(json, raw => evaluatePredictiveTimingModel(raw, readPredictiveTimingOptions(options)));
}
