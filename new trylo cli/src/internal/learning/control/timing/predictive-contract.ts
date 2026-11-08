import type { ExactLiteral, Rational } from "./exact.js";

export type PredictiveValueInput = readonly [ExactLiteral, ExactLiteral];

export type PredictiveActionInput =
  | Readonly<{ kind: "closed"; id: string; firstControl: string; programRef: string; value: PredictiveValueInput }>
  | Readonly<{ kind: "closed_upper_frontier"; id: string; firstControl: string; frontierScopeRef: string; upper: ExactLiteral }>
  | Readonly<{ kind: "edge"; id: string; firstControl: string; operationRef: string;
      firstLeg: "source-declared-feasible"; immediate: PredictiveValueInput; outcomeCoverage: "complete";
      outcomes: readonly Readonly<{ observed: string; weight: ExactLiteral; next: string }>[] }>;

/** A frozen declaration, not source calibration, a live capability, or an execution request. */
export interface PredictiveTimingModel {
  readonly schemaVersion: 1;
  readonly modelKind: "finite_predictive_expected";
  readonly sourceScope: string;
  readonly basisRef: string;
  readonly evaluationRef: string;
  readonly utilityUnit: string;
  readonly coverage: "complete-declared-family";
  readonly root: string;
  readonly reference: Readonly<{ scopeRef: string; value: PredictiveValueInput }> | null;
  readonly contexts: readonly Readonly<{ id: string; actionCoverage: "complete"; noMoreAction: string | null;
    actions: readonly PredictiveActionInput[] }>[];
}

export interface PredictiveTimingOptions { readonly maxBits?: number; readonly nodeLimit?: number; }

export interface NormalizedPredictiveTimingOptions { readonly maxBits: number; readonly nodeLimit: number; }

export interface PredictiveBasis {
  readonly sourceScope: string; readonly basisRef: string; readonly evaluationRef: string; readonly utilityUnit: string;
}

export interface ValueBounds { readonly low: Rational; readonly high: Rational; }

export interface CompiledOutcome { readonly observed: string; readonly probability: Rational; readonly next: string; }

interface ActionIdentity { readonly id: string; readonly firstControl: string; }

export type CompiledPredictiveAction =
  | (ActionIdentity & Readonly<{ kind: "closed"; programRef: string; value: ValueBounds }>)
  | (ActionIdentity & Readonly<{ kind: "closed_upper_frontier"; frontierScopeRef: string; upper: Rational }>)
  | (ActionIdentity & Readonly<{ kind: "edge"; operationRef: string; immediate: ValueBounds;
      outcomes: readonly CompiledOutcome[] }>);

export interface CompiledPredictiveContext {
  readonly id: string; readonly noMoreAction: string | null; readonly actions: readonly CompiledPredictiveAction[];
}

export interface CompiledPredictiveModel {
  readonly basis: PredictiveBasis; readonly modelHash: string; readonly root: string;
  readonly reference: Readonly<{ scopeRef: string; value: ValueBounds }> | null;
  readonly contexts: ReadonlyMap<string, CompiledPredictiveContext>;
}

export interface PartialValue { readonly low: Rational | null; readonly high: Rational; }

export interface ChildContribution {
  readonly observed: string; readonly nextContext: string; readonly probability: Rational;
  readonly childValue: PartialValue; readonly weightedValue: PartialValue;
}

export interface EvaluatedPredictiveAction {
  readonly definition: CompiledPredictiveAction; readonly value: PartialValue; readonly children: readonly ChildContribution[];
}

export interface EvaluatedFirstControl {
  readonly firstControl: string; low: Rational | null; high: Rational; lowerAction: string | null;
}

export interface FirstControlCertificate {
  readonly strict: readonly string[]; readonly nonInferior: readonly string[];
  readonly exactOptimalTies: readonly string[]; readonly exactTieExhaustive: boolean;
}

export interface EvaluatedPredictiveContext {
  readonly context: CompiledPredictiveContext; readonly value: PartialValue;
  readonly lowerAction: string | null; readonly actions: readonly EvaluatedPredictiveAction[];
  readonly controls: readonly EvaluatedFirstControl[]; readonly certificate: FirstControlCertificate;
}

export interface EvaluatedPredictiveModel {
  readonly root: EvaluatedPredictiveContext;
  readonly contexts: ReadonlyMap<string, EvaluatedPredictiveContext>;
}
