import type { LearningAllocationBasis, LearningAllocationOffer } from "../allocation-contract.js";
import type { PredictiveTimingAnalysis, PredictiveTimingModel } from "../timing/index.js";

/** Times are epoch milliseconds; durations are milliseconds. Boundaries are owner receipts, not forecasts. */
export type CentralTimingReadiness =
  | Readonly<{ kind: "ready"; sourceRef: string; now: number;
      nextHandoff: Readonly<{ at: number; sourceRef: string }> | null }>
  | Readonly<{ kind: "handoff"; sourceRef: string; now: number; boundaryAt: number }>
  | Readonly<{ kind: "waiting_evidence"; sourceRef: string; evidenceRefs: readonly string[] }>
  | Readonly<{ kind: "terminal"; sourceRef: string; reason: string }>
  | Readonly<{ kind: "in_flight"; sourceRef: string }>;

/** The response target owns its fixed use window. Deadline means no gross benefit after useBy;
 * boundary-independent explicitly declares no start-time effect within the current legal stage family.
 * No sliding horizon, unpriced interference, or implicit urgency multiplier is supplied here.
 */
export type CentralTimingTarget =
  | Readonly<{ kind: "boundary-independent"; sourceRef: string }>
  | Readonly<{ kind: "deadline"; sourceRef: string; useBy: number;
      durationUpperBound: number; durationSourceRef: string;
      /** Actual gross-result support for this whole legal start family and window,
       * in basis.utilityUnit. A posterior interval for its mean is insufficient. */
      grossSupport?: Readonly<{ minimum: number; maximum: number; sourceRef: string }> }>
  | Readonly<{ kind: "unresolved"; sourceRef: string; requirements: readonly string[] }>;

/** Utility fees exclude sunk cost and use basis.utilityUnit. Hard resource caps remain in offer.reserve. */
export type CentralTimingFee =
  | Readonly<{ kind: "hard-budget-only"; sourceRef: string }>
  | Readonly<{ kind: "utility"; sourceRef: string; now: number; atHandoff: number }>;

export type CentralTimingInput = Readonly<{
  schemaVersion: 1;
  opportunityId: string;
  windowRef: string;
  forecastRef: string;
  /** Posterior expected gross total increment over the common idle baseline, already integrated over windowRef. */
  mean: number;
  basis: LearningAllocationBasis;
  offer: LearningAllocationOffer;
  readiness: CentralTimingReadiness;
  target: CentralTimingTarget;
  fee: CentralTimingFee;
}>;

export type CentralTimingAdvice = "now" | "defer" | "wait_evidence" | "stop" | "in_flight" | "requires_model";

export type CentralTimingProgram = Readonly<{
  control: "now" | "defer";
  at: number;
  grossMean: number;
  utilityFee: number;
}>;

export type CentralTimingProgramMenu =
  | Readonly<{ status: "ready"; scope: "known_feasible_programs_only";
      /** Includes negative immediate net values; later information value belongs to the joint planner. */
      programs: readonly CentralTimingProgram[];
      unresolvedStarts: readonly Readonly<{ control: "now" | "defer"; at: number; utilityFee: number;
        /** Bound on deadline-censored gross, not a completion probability or a processing witness. */
        grossUpperBound: number | null; sourceRef: string }>[];
      sourceRefs: readonly string[]; requirements: readonly string[] }>
  | Readonly<{ status: "rejected"; reason: string; at: string }>;

export type CentralTimingResult =
  | Readonly<{ status: "ready"; opportunityId: string; advice: CentralTimingAdvice;
      /** null means no complete numerical comparison was established. */
      netValue: number | null; selectedControl: "now" | "defer" | "stop" | null;
      /** An executable processing program retained when competitors are unresolved.
       * This is neither the family optimum nor a claim that it dominates idle. */
      provisional?: Readonly<{ control: "now" | "defer"; netValue: number; scope: "best_known_feasible_program" }>;
      model: PredictiveTimingModel | null; analysis: PredictiveTimingAnalysis | null;
      sourceRefs: readonly string[]; requirements: readonly string[] }>
  | Readonly<{ status: "rejected"; reason: string; at: string }>;
