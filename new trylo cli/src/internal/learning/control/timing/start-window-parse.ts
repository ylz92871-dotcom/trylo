import { fields, identity } from "../../../validation/json-shape.js";
import { failTiming, requireTiming } from "./boundary.js";
import { readTimingBits, type ExactTiming, type Rational } from "./exact.js";
import { START_WINDOW_LIMITS, type CompiledStartWindow, type CompiledStartWorld, type StartWindowIdentity } from "./start-window-contract.js";

function isStartWindowOptions(value: unknown): value is Record<string, unknown> {
  const keys = ["maxBits", "maxBreakpoints", "maxCandidates", "requestedRegret"];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}

function boundedList(value: unknown, minimum: number, maximum: number, at: string): readonly unknown[] {
  requireTiming(Array.isArray(value) && value.length >= minimum, "start_window_list", at);
  if (value.length > maximum) failTiming("planning_limit", "start_window_size_limit", at);
  return value;
}

function nonnegative(value: unknown, math: ExactTiming, at: string): Rational {
  const parsed = math.from(value, at);
  requireTiming(math.compare(parsed, math.zero) >= 0, "start_window_negative", at);
  return parsed;
}

export function readStartWindowOptions(raw: unknown) {
  requireTiming(isStartWindowOptions(raw), "start_window_options", "options");
  const integer = (value: unknown, fallback: number, maximum: number, at: string) => {
    const parsed = value === undefined ? fallback : value;
    requireTiming(typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum,
      "start_window_option_range", at);
    return parsed;
  };

  return { maxBits: readTimingBits(raw.maxBits),
    maxBreakpoints: integer(raw.maxBreakpoints, START_WINDOW_LIMITS.breakpoints, START_WINDOW_LIMITS.breakpoints, "options.maxBreakpoints"),
    maxCandidates: integer(raw.maxCandidates, START_WINDOW_LIMITS.candidates, START_WINDOW_LIMITS.candidates, "options.maxCandidates"),
    requestedRegret: raw.requestedRegret };
}

function readProfile(raw: unknown, duration: Rational, math: ExactTiming, at: string) {
  return boundedList(raw, 0, START_WINDOW_LIMITS.profile, at).map((item, index) => {
    const here = `${at}[${index}]`;
    requireTiming(fields(item, ["u", "v", "load"]), "start_window_profile", here);
    const u = nonnegative(item.u, math, `${here}.u`), v = nonnegative(item.v, math, `${here}.v`);
    const load = nonnegative(item.load, math, `${here}.load`);
    requireTiming(math.compare(u, v) <= 0 && math.compare(v, duration) <= 0, "start_window_profile_range", here);
    return { u, v, load };
  });
}

function readWorld(raw: unknown, hi: Rational, T: Rational, math: ExactTiming, at: string) {
  requireTiming(fields(raw, ["weight", "duration", "useBy", "gross", "futureFee", "profile"]), "start_window_world", at);
  requireTiming(fields(raw.gross, ["a", "b", "c"]), "start_window_gross", `${at}.gross`);
  const weight = nonnegative(raw.weight, math, `${at}.weight`), duration = nonnegative(raw.duration, math, `${at}.duration`);
  const useBy = nonnegative(raw.useBy, math, `${at}.useBy`), futureFee = nonnegative(raw.futureFee, math, `${at}.futureFee`);

  requireTiming(math.compare(useBy, T) <= 0, "start_window_use_after_T", `${at}.useBy`);

  if (math.compare(math.add(hi, duration), T) > 0) {
    failTiming("unsupported_model", "start_window_tail_not_supplied", at);
  }

  return { weight, duration, useBy, futureFee, profile: readProfile(raw.profile, duration, math, `${at}.profile`),
    gross: { a: math.from(raw.gross.a, `${at}.gross.a`), b: math.from(raw.gross.b, `${at}.gross.b`), c: math.from(raw.gross.c, `${at}.gross.c`) } };
}

function readPhases(raw: unknown, T: Rational, math: ExactTiming) {
  let through = math.zero;
  const phases = boundedList(raw, 1, START_WINDOW_LIMITS.phases, "interference").map((item, index) => {
    const at = `interference[${index}]`;
    requireTiming(fields(item, ["from", "to", "rate"]), "start_window_phase", at);
    const from = math.from(item.from, `${at}.from`), to = math.from(item.to, `${at}.to`);
    const rate = nonnegative(item.rate, math, `${at}.rate`);
    requireTiming(math.compare(from, through) === 0 && math.compare(from, to) < 0, "start_window_phase_coverage", at);
    through = to;
    return { from, to, rate };
  });

  requireTiming(math.compare(through, T) === 0, "start_window_phase_coverage", "interference");
  return phases;
}

export function readStartWindowModel(raw: unknown, math: ExactTiming): CompiledStartWindow {
  requireTiming(fields(raw, ["schemaVersion", "modelKind", "basisRef", "evaluationRef", "programRef", "utilityUnit", "timeUnit",
    "T", "legalStart", "useRule", "extraWaitRate", "interference", "worlds"]), "start_window_fields", "model");
  requireTiming(raw.schemaVersion === 1, "start_window_schema", "schemaVersion");

  if (raw.modelKind !== "fixed_program_no_observation_start" || raw.useRule !== "completion_lte_useBy") {
    failTiming("unsupported_model", "start_window_scope_or_consumption", "modelKind/useRule");
  }

  requireTiming(identity(raw.basisRef) && identity(raw.evaluationRef) && identity(raw.programRef)
    && identity(raw.utilityUnit) && identity(raw.timeUnit), "start_window_identity", "header");
  const header: StartWindowIdentity = { schemaVersion: 1, modelKind: "fixed_program_no_observation_start",
    basisRef: raw.basisRef, evaluationRef: raw.evaluationRef, programRef: raw.programRef, utilityUnit: raw.utilityUnit, timeUnit: raw.timeUnit };
  const T = math.from(raw.T, "T");
  requireTiming(math.compare(T, math.zero) > 0, "start_window_positive_T", "T");
  requireTiming(fields(raw.legalStart, ["lo", "hi"]), "start_window_legal_interval", "legalStart");
  const lo = nonnegative(raw.legalStart.lo, math, "legalStart.lo"), hi = nonnegative(raw.legalStart.hi, math, "legalStart.hi");

  requireTiming(math.compare(lo, hi) <= 0, "start_window_interval_order", "legalStart");
  const worlds = boundedList(raw.worlds, 1, START_WINDOW_LIMITS.worlds, "worlds")
    .map((world, index) => readWorld(world, hi, T, math, `worlds[${index}]`));
  const probabilities = math.normalize(worlds.map(world => world.weight), "worlds.weight");
  const compiled: CompiledStartWorld[] = worlds.map((world, index) => ({ ...world, p: probabilities[index]! }));

  return { identity: header, T, lo, hi, waitRate: nonnegative(raw.extraWaitRate, math, "extraWaitRate"),
    phases: readPhases(raw.interference, T, math), worlds: compiled };
}
