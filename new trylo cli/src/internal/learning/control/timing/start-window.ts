import { contentHashOf } from "../hash.js";
import { requireTiming, runTimingJson } from "./boundary.js";
import { ExactTiming } from "./exact.js";
import type { LearningStartWindowAnalysis, LearningStartWindowOptions } from "./start-window-contract.js";
import { readStartWindowModel, readStartWindowOptions } from "./start-window-parse.js";
import { evaluateStartWindow } from "./start-window-analysis.js";

/** Pure conditional advice for one fixed program; never dispatches or grants resources. */
export function analyzeLearningStartWindow(json: unknown, options: LearningStartWindowOptions = {}): LearningStartWindowAnalysis {
  return runTimingJson(json, raw => {
    const parsedOptions = readStartWindowOptions(options), math = new ExactTiming(parsedOptions.maxBits);
    const model = readStartWindowModel(raw, math);
    const requestedRegret = parsedOptions.requestedRegret === undefined ? null
      : math.from(parsedOptions.requestedRegret, "options.requestedRegret");

    requireTiming(requestedRegret === null || math.compare(requestedRegret, math.zero) > 0,
      "start_window_positive_requested_regret", "options.requestedRegret");

    // This hashes only the actual validated declaration, not epsilon/options or a caller fingerprint.
    return evaluateStartWindow(model, math, { modelHash: contentHashOf(raw),
      maxBreakpoints: parsedOptions.maxBreakpoints, maxCandidates: parsedOptions.maxCandidates, requestedRegret });
  });
}
