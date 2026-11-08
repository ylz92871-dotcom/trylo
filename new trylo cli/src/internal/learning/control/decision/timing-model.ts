import { fields, identity, list, sequence } from "../../../validation/json-shape.js";
import { isAllocationBasis, isAllocationOffer } from "../allocation-shape.js";
import { contentHashOf } from "../hash.js";
import { analyzeLearningTiming } from "../timing/index.js";
import type { PredictiveActionInput, PredictiveTimingModel } from "../timing/index.js";
import type { CentralTimingAdvice, CentralTimingFee, CentralTimingInput, CentralTimingReadiness,
  CentralTimingResult, CentralTimingTarget, CentralTimingProgramMenu } from "./timing-contract.js";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const refs = (value: unknown): value is readonly string[] => list(value, 1, 32) && value.every(identity)
  && new Set(value).size === value.length;

function isReadiness(value: unknown): value is CentralTimingReadiness {
  if (fields(value, ["kind", "sourceRef", "now", "nextHandoff"]) && value.kind === "ready") {
    return identity(value.sourceRef) && sequence(value.now)
      && (value.nextHandoff === null || (fields(value.nextHandoff, ["at", "sourceRef"])
        && sequence(value.nextHandoff.at) && value.nextHandoff.at > value.now && identity(value.nextHandoff.sourceRef)));
  }

  if (fields(value, ["kind", "sourceRef", "now", "boundaryAt"]) && value.kind === "handoff") {
    return identity(value.sourceRef) && sequence(value.now) && sequence(value.boundaryAt) && value.boundaryAt > value.now;
  }

  if (fields(value, ["kind", "sourceRef", "evidenceRefs"]) && value.kind === "waiting_evidence") {
    return identity(value.sourceRef) && refs(value.evidenceRefs);
  }

  return (fields(value, ["kind", "sourceRef", "reason"]) && value.kind === "terminal"
      && identity(value.sourceRef) && identity(value.reason))
    || (fields(value, ["kind", "sourceRef"]) && value.kind === "in_flight" && identity(value.sourceRef));
}

function isTarget(value: unknown): value is CentralTimingTarget {
  return (fields(value, ["kind", "sourceRef"]) && value.kind === "boundary-independent" && identity(value.sourceRef))
    || ((fields(value, ["kind", "sourceRef", "useBy", "durationUpperBound", "durationSourceRef"])
        || fields(value, ["kind", "sourceRef", "useBy", "durationUpperBound", "durationSourceRef", "grossSupport"]))
      && value.kind === "deadline" && identity(value.sourceRef) && sequence(value.useBy)
      && sequence(value.durationUpperBound) && identity(value.durationSourceRef)
      && (!Object.hasOwn(value, "grossSupport") || (fields(value.grossSupport, ["minimum", "maximum", "sourceRef"])
        && finite(value.grossSupport.minimum) && finite(value.grossSupport.maximum)
        && value.grossSupport.minimum <= value.grossSupport.maximum && identity(value.grossSupport.sourceRef))))
    || (fields(value, ["kind", "sourceRef", "requirements"]) && value.kind === "unresolved"
      && identity(value.sourceRef) && refs(value.requirements));
}

function isFee(value: unknown): value is CentralTimingFee {
  return (fields(value, ["kind", "sourceRef"]) && value.kind === "hard-budget-only" && identity(value.sourceRef))
    || (fields(value, ["kind", "sourceRef", "now", "atHandoff"]) && value.kind === "utility"
      && identity(value.sourceRef) && nonnegative(value.now) && nonnegative(value.atHandoff));
}

export function isCentralTimingInput(value: unknown): value is CentralTimingInput {
  return fields(value, ["schemaVersion", "opportunityId", "windowRef", "forecastRef", "mean", "basis", "offer",
    "readiness", "target", "fee"]) && value.schemaVersion === 1 && identity(value.opportunityId)
    && identity(value.windowRef) && identity(value.forecastRef) && finite(value.mean)
    && isAllocationBasis(value.basis) && isAllocationOffer(value.offer)
    && isReadiness(value.readiness) && isTarget(value.target) && isFee(value.fee);
}

function sourceRefs(input: CentralTimingInput): readonly string[] {
  const sources = [input.forecastRef, input.windowRef, input.basis.valuationRef, input.offer.policyRef,
    input.readiness.sourceRef, input.target.sourceRef, input.fee.sourceRef];

  if (input.readiness.kind === "ready" && input.readiness.nextHandoff !== null) sources.push(input.readiness.nextHandoff.sourceRef);

  if (input.readiness.kind === "waiting_evidence") sources.push(...input.readiness.evidenceRefs);

  if (input.target.kind === "deadline") {
    sources.push(input.target.durationSourceRef);
    if (input.target.grossSupport !== undefined) sources.push(input.target.grossSupport.sourceRef);
  }

  return [...new Set(sources)];
}

function operational(input: CentralTimingInput, advice: CentralTimingAdvice, requirements: readonly string[]): CentralTimingResult {
  return { status: "ready", opportunityId: input.opportunityId, advice, netValue: advice === "stop" ? 0 : null,
    selectedControl: advice === "stop" ? "stop" : null, model: null, analysis: null, sourceRefs: sourceRefs(input), requirements };
}

type Start = { readonly control: "now" | "defer"; readonly at: number; readonly fee: number };

type Program = Start & { readonly netValue: number };

type UpperProgram = Start & { readonly upper: number; readonly frontierScopeRef: string };

function legalStarts(input: CentralTimingInput): readonly Start[] {
  const state = input.readiness, fee = input.fee;
  const nowFee = fee.kind === "utility" ? fee.now : 0, laterFee = fee.kind === "utility" ? fee.atHandoff : 0;
  if (state.kind === "handoff") return [{ control: "defer", at: state.boundaryAt, fee: laterFee }];
  if (state.kind !== "ready") return [];
  return [{ control: "now", at: state.now, fee: nowFee }, ...(state.nextHandoff === null ? []
    : [{ control: "defer" as const, at: state.nextHandoff.at, fee: laterFee }])];
}

/** Generates the current legal macro-stage family, not a caller-authored best policy graph. */
function buildModel(input: CentralTimingInput, programs: readonly Program[], upperPrograms: readonly UpperProgram[]): PredictiveTimingModel {
  const basisRef = `central-timing:${contentHashOf(input)}`;
  const actions: PredictiveActionInput[] = [{ kind: "closed", id: "idle", firstControl: "no_more_processing",
    programRef: `central-idle:${contentHashOf([input.opportunityId, input.windowRef])}`, value: [0, 0] }];

  for (const program of programs) {
    actions.push({ kind: "closed", id: program.control, firstControl: program.control,
      programRef: input.offer.policyRef, value: [program.netValue, program.netValue] });
  }

  for (const program of upperPrograms) actions.push({ kind: "closed_upper_frontier", id: program.control,
    firstControl: program.control, frontierScopeRef: program.frontierScopeRef, upper: program.upper });

  return { schemaVersion: 1, modelKind: "finite_predictive_expected", sourceScope: input.basis.scope, basisRef,
    evaluationRef: `fixed-window:${contentHashOf([input.windowRef, input.basis.utilityUnit, input.forecastRef])}`,
    utilityUnit: input.basis.utilityUnit, coverage: "complete-declared-family", root: "current-stage",
    reference: { scopeRef: input.windowRef, value: [0, 0] },
    contexts: [{ id: "current-stage", actionCoverage: "complete", noMoreAction: "idle", actions }] };
}

function provisional(programs: readonly Program[]): Pick<Extract<CentralTimingResult, { status: "ready" }>, "provisional"> {
  const best = programs.reduce<Program | null>((previous, row) => previous === null || row.netValue > previous.netValue ? row : previous, null);
  return best === null ? {} : { provisional: { control: best.control, netValue: best.netValue, scope: "best_known_feasible_program" } };
}

function uncertainCompletion(start: Start, target: Extract<CentralTimingTarget, { kind: "deadline" }>): boolean {
  return start.at <= target.useBy && (!Number.isSafeInteger(start.at + target.durationUpperBound)
    || start.at + target.durationUpperBound > target.useBy);
}

function requiresModel(input: CentralTimingInput, programs: readonly Program[], requirements: readonly string[],
  model: PredictiveTimingModel | null = null, analysis: Extract<CentralTimingResult, { status: "ready" }>["analysis"] = null): CentralTimingResult {
  return { status: "ready", opportunityId: input.opportunityId, advice: "requires_model", netValue: null,
    selectedControl: null, ...provisional(programs), model, analysis, sourceRefs: sourceRefs(input), requirements };
}

type ReadyMenu = Extract<CentralTimingProgramMenu, { status: "ready" }>;

type Classification = { readonly status: "ready"; readonly menu: ReadyMenu;
  readonly operational: { readonly advice: CentralTimingAdvice; readonly requirements: readonly string[] } | null }
  | Extract<CentralTimingProgramMenu, { status: "rejected" }>;

/** One owner of feasibility and deadline censoring for both local timing analysis
 * and joint planning. It never compares processing values with idle. */
function classifyTimingPrograms(input: CentralTimingInput): Classification {
  const state = input.readiness;
  const empty = (advice: CentralTimingAdvice, requirements: readonly string[]): Classification => ({ status: "ready",
    menu: { status: "ready", scope: "known_feasible_programs_only", programs: [], unresolvedStarts: [],
      sourceRefs: sourceRefs(input), requirements }, operational: { advice, requirements } });

  if (state.kind === "terminal") return empty("stop", []);

  if (state.kind === "waiting_evidence") return empty("wait_evidence", state.evidenceRefs);

  if (state.kind === "in_flight") return empty("in_flight", ["owner_confirmed_stage_boundary"]);

  if (input.target.kind === "unresolved") return empty("requires_model", input.target.requirements);

  const programs: ReadyMenu["programs"][number][] = [], unresolvedStarts: ReadyMenu["unresolvedStarts"][number][] = [];
  const starts = legalStarts(input), requirements: string[] = [];

  if (input.target.kind === "deadline") {
    const target = input.target;
    if (target.grossSupport !== undefined && (input.mean < target.grossSupport.minimum || input.mean > target.grossSupport.maximum)) {
      return { status: "rejected", reason: "central_timing_gross_support_conflict", at: "target.grossSupport" };
    }

    if (target.useBy < state.now) return empty("stop", []);

    for (const start of starts) {
      if (!uncertainCompletion(start, target)) {
        programs.push({ control: start.control, at: start.at,
          grossMean: start.at > target.useBy ? 0 : input.mean, utilityFee: start.fee });
      } else {
        // Deadline censoring can correlate with gross benefit. Actual support,
        // rather than max(0, E[gross]), bounds the whole unresolved start family.
        unresolvedStarts.push({ control: start.control, at: start.at, utilityFee: start.fee,
          grossUpperBound: target.grossSupport === undefined ? null : Math.max(0, target.grossSupport.maximum),
          sourceRef: target.grossSupport?.sourceRef ?? target.durationSourceRef });
      }
    }

    if (unresolvedStarts.length > 0) requirements.push("timely_completion_not_bounded");

    if (unresolvedStarts.some(start => start.grossUpperBound === null)) requirements.push("gross_support_missing");
  } else programs.push(...starts.map(start => ({ control: start.control, at: start.at, grossMean: input.mean, utilityFee: start.fee })));

  if (programs.some(program => !finite(program.grossMean - program.utilityFee))) {
    return { status: "rejected", reason: "central_timing_numeric_range", at: "input.mean" };
  }

  return { status: "ready", menu: { status: "ready", scope: "known_feasible_programs_only", programs, unresolvedStarts,
    sourceRefs: sourceRefs(input), requirements }, operational: null };
}

/** Enumerates actual processing witnesses for a joint Bellman planner. An immediate
 * negative net value does not erase a program whose observation can improve later choices. */
export function enumerateCentralTimingPrograms(raw: unknown): CentralTimingProgramMenu {
  if (!isCentralTimingInput(raw)) return { status: "rejected", reason: "central_timing_input", at: "input" };
  const result = classifyTimingPrograms(raw);
  return result.status === "rejected" ? result : result.menu;
}

/** Posterior means are expected values, not confidence bounds on reality. This bridge adds no exploration bonus. */
export function analyzeCentralOpportunityTiming(raw: unknown): CentralTimingResult {
  if (!isCentralTimingInput(raw)) return { status: "rejected", reason: "central_timing_input", at: "input" };

  const input = raw, classified = classifyTimingPrograms(input);
  if (classified.status === "rejected") return classified;

  if (classified.operational !== null) return operational(input, classified.operational.advice, classified.operational.requirements);

  const menu = classified.menu;
  const programs: Program[] = menu.programs.map(row => ({ control: row.control, at: row.at,
    fee: row.utilityFee, netValue: row.grossMean - row.utilityFee }));
  const upperPrograms: UpperProgram[] = menu.unresolvedStarts.flatMap(row => row.grossUpperBound === null ? []
    : [{ control: row.control, at: row.at, fee: row.utilityFee, upper: row.grossUpperBound - row.utilityFee, frontierScopeRef: row.sourceRef }]);

  // An unbounded competitor cannot be silently omitted from a complete model.
  if (menu.unresolvedStarts.some(start => start.grossUpperBound === null)) return requiresModel(input, programs, menu.requirements);

  const model = buildModel(input, programs, upperPrograms), analysis = analyzeLearningTiming(JSON.stringify(model));
  if (analysis.status !== "analyzed") return { status: "rejected", reason: analysis.reason, at: analysis.at };

  const firstControl = analysis.bestKnownLowerWitness?.firstControl;
  const selected = firstControl === "no_more_processing" ? "stop" : firstControl;
  if (selected !== "now" && selected !== "defer" && selected !== "stop") {
    return { status: "rejected", reason: "central_timing_witness_missing", at: "analysis" };
  }

  const certifiedControl = selected === "stop" ? "no_more_processing" : selected;
  if (!analysis.firstControlCertificate.nonInferior.includes(certifiedControl)) {
    return requiresModel(input, programs, ["timely_completion_not_bounded", "timing_competitor_not_excluded"], model, analysis);
  }

  const chosen = programs.find(program => program.control === selected);

  return { status: "ready", opportunityId: input.opportunityId, advice: selected,
    netValue: chosen?.netValue ?? 0, selectedControl: selected,
    model, analysis, sourceRefs: sourceRefs(input), requirements: [] };
}
