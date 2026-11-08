import type { TimingFailure } from "./boundary.js";
import type { ExactLiteral, Rational } from "./exact.js";

/** All real starts in legalStart are source-declared legal; this is no grant. */
export type LearningStartWindowModel = {
  readonly schemaVersion: 1;
  readonly modelKind: "fixed_program_no_observation_start";
  readonly basisRef: string;
  readonly evaluationRef: string;
  readonly programRef: string;
  readonly utilityUnit: string;
  readonly timeUnit: string;
  readonly T: ExactLiteral;
  readonly legalStart: { readonly lo: ExactLiteral; readonly hi: ExactLiteral };
  readonly useRule: "completion_lte_useBy";
  readonly extraWaitRate: ExactLiteral;
  readonly interference: readonly { readonly from: ExactLiteral; readonly to: ExactLiteral; readonly rate: ExactLiteral }[];
  readonly worlds: readonly {
    readonly weight: ExactLiteral;
    readonly duration: ExactLiteral;
    readonly useBy: ExactLiteral;
    /** Gross excludes every fee/cost separately supplied below, and may be negative. */
    readonly gross: { readonly a: ExactLiteral; readonly b: ExactLiteral; readonly c: ExactLiteral };
    readonly futureFee: ExactLiteral;
    readonly profile: readonly { readonly u: ExactLiteral; readonly v: ExactLiteral; readonly load: ExactLiteral }[];
  }[];
};

export type LearningStartWindowOptions = {
  readonly maxBits?: number;
  readonly maxBreakpoints?: number;
  readonly maxCandidates?: number;
  /** Positive regret in the model's utilityUnit; never a clock tick or numeric tolerance. */
  readonly requestedRegret?: ExactLiteral;
};

export type StartWindowIdentity = Pick<LearningStartWindowModel,
  "schemaVersion" | "modelKind" | "basisRef" | "evaluationRef" | "programRef" | "utilityUnit" | "timeUnit">;

export type StartQuadratic<T> = { readonly a: T; readonly b: T; readonly c: T };

export type StartWitnessKind = "actual_boundary" | "cell_midpoint" | "joint_concave_vertex" | "requested_regret";

export type StartWindowWitness = {
  readonly start: string; readonly value: string; readonly kinds: readonly StartWitnessKind[];
};

export type StartWindowLimit = {
  readonly value: string; readonly at: string; readonly side: "right" | "left";
  readonly cell: { readonly lo: string; readonly hi: string };
};

export type StartWindowConstant = {
  readonly lo: string; readonly hi: string; readonly value: string; readonly interior: "open";
  readonly cooptimal: boolean; readonly includeLo: boolean; readonly includeHi: boolean;
};

export type StartWindowCell = {
  readonly lo: string; readonly hi: string; readonly midpointWitness: StartWindowWitness;
  readonly gainQuadratic: StartQuadratic<string>; readonly netQuadratic: StartQuadratic<string>;
  readonly costAffine: { readonly slope: string; readonly intercept: string; readonly costLo: string; readonly costHi: string };
  readonly leftLimit: string; readonly rightLimit: string;
  readonly vertex: StartWindowWitness | null; readonly flat: boolean;
};

type StartWindowCommon = StartWindowIdentity & {
  readonly modelHash: string;
  readonly scope: "one_fixed_program_no_observation_closed_start_family";
  readonly maximumOrSupremum: string;
  readonly bestKnown: StartWindowWitness;
  readonly gap: string;
  readonly requestedRegret: string | null;
  readonly supremumLimitSides: readonly StartWindowLimit[];
  readonly actualBoundaryValues: readonly { readonly at: string; readonly value: string; readonly kinds: readonly string[] }[];
  readonly cells: readonly StartWindowCell[];
  readonly constantWindows: readonly StartWindowConstant[];
  readonly cooptimalWindows: readonly StartWindowConstant[];
  readonly candidateCount: number;
  readonly breakpointCount: number;
};

export type LearningStartWindowAnalysis =
  | (StartWindowCommon & { readonly status: "max_attained"; readonly maximizer: StartWindowWitness })
  | (StartWindowCommon & { readonly status: "supremum_unattained"; readonly maximizer: null })
  | TimingFailure;

export type CompiledStartWorld = {
  readonly p: Rational; readonly duration: Rational; readonly useBy: Rational; readonly futureFee: Rational;
  readonly gross: StartQuadratic<Rational>;
  readonly profile: readonly { readonly u: Rational; readonly v: Rational; readonly load: Rational }[];
};

export type CompiledStartWindow = {
  readonly identity: StartWindowIdentity;
  readonly T: Rational; readonly lo: Rational; readonly hi: Rational; readonly waitRate: Rational;
  readonly phases: readonly { readonly from: Rational; readonly to: Rational; readonly rate: Rational }[];
  readonly worlds: readonly CompiledStartWorld[];
};

export const START_WINDOW_LIMITS = Object.freeze({ worlds: 8, phases: 32, profile: 16,
  breakpoints: 256, candidates: 2048 });
