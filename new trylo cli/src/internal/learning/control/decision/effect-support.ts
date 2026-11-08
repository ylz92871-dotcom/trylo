import { fields, identity } from "../../../validation/json-shape.js";
import { addToSum, emptySum } from "../../reward/explanation/residual-boundary.js";
import { contentHashOf } from "../hash.js";
import { isCentralResponseTarget } from "./prediction-validation.js";
import type { CentralEffectMeasurement, CentralEffectSupport, CentralEffectSupportInput,
  CentralEffectSupportResult, CentralEffectWindow, CentralEffectWindowSupport } from "./effect-support-contract.js";

/** The single-window protocol keeps an explicit work limit. Legacy population
 * fields express integer representability only, never a retained-history cap. */
export const CENTRAL_EFFECT_SUPPORT_LIMITS = Object.freeze({ windows: Number.MAX_SAFE_INTEGER,
  comparisons: Number.MAX_SAFE_INTEGER, comparisonsPerWindow: 512 });

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isMeasurement(value: unknown): value is CentralEffectMeasurement {
  if (!fields(value, ["comparisonId", "revisionRef", "sourceRef", "outcome"])
    || ![value.comparisonId, value.revisionRef, value.sourceRef].every(identity)) return false;

  const outcome = value.outcome;

  return fields(outcome, ["kind", "reason"]) && outcome.kind === "unknown" && identity(outcome.reason)
    || fields(outcome, ["kind", "candidateUtility", "baselineUtility"]) && outcome.kind === "measured"
      && finite(outcome.candidateUtility) && finite(outcome.baselineUtility)
      && finite(outcome.candidateUtility - outcome.baselineUtility);
}

function isWindow(value: unknown, comparisons: number): value is CentralEffectWindow {
  return fields(value, ["unitId", "revisionRef", "sourceRef", "comparisonIds", "measurements"])
    && [value.unitId, value.revisionRef, value.sourceRef].every(identity)
    && Array.isArray(value.comparisonIds) && value.comparisonIds.length === comparisons && value.comparisonIds.every(identity)
    && Array.isArray(value.measurements) && value.measurements.length <= comparisons && value.measurements.every(isMeasurement);
}

function isInput(value: unknown): value is CentralEffectSupportInput {
  return fields(value, ["target", "comparisonsPerWindow", "deltaBounds", "windows"]) && isCentralResponseTarget(value.target)
    && typeof value.comparisonsPerWindow === "number" && Number.isSafeInteger(value.comparisonsPerWindow)
    && value.comparisonsPerWindow >= 1 && value.comparisonsPerWindow <= CENTRAL_EFFECT_SUPPORT_LIMITS.comparisonsPerWindow
    && fields(value.deltaBounds, ["minimum", "maximum", "sourceRef"]) && identity(value.deltaBounds.sourceRef)
    && finite(value.deltaBounds.minimum) && finite(value.deltaBounds.maximum) && value.deltaBounds.minimum <= value.deltaBounds.maximum
    && Array.isArray(value.windows) && value.windows.every(window => isWindow(window, Number(value.comparisonsPerWindow)));
}

function qualificationFailure(input: CentralEffectSupportInput): CentralEffectSupportResult | undefined {
  if (!Number.isSafeInteger(input.windows.length) || !Number.isSafeInteger(input.windows.length * input.comparisonsPerWindow)) {
    return { status: "unsupported", reason: "central_effect_support_numeric_range" };
  }

  const units = new Set<string>(), comparisons = new Set<string>();

  for (const window of input.windows) {
    if (units.has(window.unitId)) return { status: "invalid", reason: "central_effect_support_duplicate_unit" };

    units.add(window.unitId);

    for (const id of window.comparisonIds) {
      if (comparisons.has(id)) return { status: "invalid", reason: "central_effect_support_duplicate_comparison" };
      comparisons.add(id);
    }

    const registered = new Set(window.comparisonIds), measured = new Set<string>();

    for (const measurement of window.measurements) {
      if (!registered.has(measurement.comparisonId)) return { status: "invalid", reason: "central_effect_support_unregistered_comparison" };

      if (measured.has(measurement.comparisonId)) return { status: "invalid", reason: "central_effect_support_duplicate_revision" };

      measured.add(measurement.comparisonId);

      if (measurement.outcome.kind !== "measured") continue;

      const delta = measurement.outcome.candidateUtility - measurement.outcome.baselineUtility;
      if (delta < input.deltaBounds.minimum || delta > input.deltaBounds.maximum) {
        return { status: "invalid", reason: "central_effect_support_observation_outside_bounds" };
      }
    }
  }

  return undefined;
}

function summarizeWindow(window: CentralEffectWindow, input: CentralEffectSupportInput): CentralEffectWindowSupport {
  const measurements = new Map(window.measurements.map(row => [row.comparisonId, row]));
  let knownSum = emptySum();
  const pending: string[] = [];

  for (const id of window.comparisonIds) {
    const row = measurements.get(id);
    if (row?.outcome.kind !== "measured") {
      pending.push(id);
      continue;
    }
    knownSum = addToSum(knownSum, row.outcome.candidateUtility - row.outcome.baselineUtility);
  }

  const low = addToSum(knownSum, pending.length * input.deltaBounds.minimum).value;
  const high = addToSum(knownSum, pending.length * input.deltaBounds.maximum).value;
  if (low > high) throw new RangeError("central_effect_support_numeric_range");

  return Object.freeze({ unitId: window.unitId, revisionRef: window.revisionRef, sourceRef: window.sourceRef,
    status: pending.length === 0 ? "complete" : "pending", registeredComparisons: window.comparisonIds.length,
    knownComparisons: window.comparisonIds.length - pending.length, unknownComparisons: pending.length,
    grossSupport: Object.freeze([low, high] as const), pendingComparisonIds: Object.freeze(pending),
    sourceRefs: Object.freeze([...new Set([input.deltaBounds.sourceRef, window.sourceRef, ...window.measurements.map(row => row.sourceRef)])]) });
}

function summarize(input: CentralEffectSupportInput): CentralEffectSupport {
  const windows = input.windows.map(window => summarizeWindow(window, input));
  let low = emptySum(), high = emptySum();

  for (const window of windows) {
    low = addToSum(low, window.grossSupport[0]);
    high = addToSum(high, window.grossSupport[1]);
  }

  const population = windows.length, completeWindows = windows.filter(window => window.status === "complete").length;
  const mean: readonly [number, number] | null = population === 0 ? null : [low.value / population, high.value / population];
  if (mean !== null && (mean[0] > mean[1] || low.value !== 0 && mean[0] === 0 || high.value !== 0 && mean[1] === 0)) {
    throw new RangeError("central_effect_support_numeric_range");
  }

  return Object.freeze({ schemaVersion: 1, supportRef: `central-effect-support:${contentHashOf(input)}`,
    target: Object.freeze({ ...input.target }), interpretation: "actual_registered_window_support",
    numericScope: "ordinary_double_not_directed_rounding", population, completeWindows, pendingWindows: population - completeWindows,
    registeredComparisons: windows.reduce((sum, window) => sum + window.registeredComparisons, 0),
    knownComparisons: windows.reduce((sum, window) => sum + window.knownComparisons, 0),
    unknownComparisons: windows.reduce((sum, window) => sum + window.unknownComparisons, 0), windows: Object.freeze(windows),
    totalGrossSupport: Object.freeze([low.value, high.value] as const), actualMeanSupport: mean === null ? null : Object.freeze(mean),
    sourceRefs: Object.freeze([...new Set([input.deltaBounds.sourceRef, ...windows.flatMap(window => window.sourceRefs)])]) });
}

/** Missing outcomes remain bounded members of the original population. The result
 * describes observed-history identification only; no missing-at-random assumption,
 * Gaussian noise, next-window transport, permissions or money are inferred. */
export function summarizeCentralEffectSupport(input: CentralEffectSupportInput): CentralEffectSupportResult {
  if (!isInput(input)) return { status: "invalid", reason: "central_effect_support_input" };

  const failure = qualificationFailure(input);
  if (failure !== undefined) return failure;

  try { return { status: "ready", value: summarize(input) }; }
  catch (error) {
    if (error instanceof RangeError && (error.message === "residual_sum_numeric_range"
      || error.message === "central_effect_support_numeric_range")) {
      return { status: "unsupported", reason: "central_effect_support_numeric_range" };
    }
    throw error;
  }
}
