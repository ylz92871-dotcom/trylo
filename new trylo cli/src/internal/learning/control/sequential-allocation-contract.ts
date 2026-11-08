import type { LearningAllocationBasis, LearningAllocationOffer, LearningAllocationResources } from "./allocation-contract.js";

export const SEQUENTIAL_ALLOCATION_LIMITS = {
  jsonCharacters: 262144, states: 256, offers: 512, branches: 2048, outcomesPerOffer: 8, horizon: 8,
  stopMagnitude: 16, utilityCost: 32, probabilityTolerance: 64 * Number.EPSILON, valueTolerance: 1e-12,
  defaultNodes: 20000, maxNodes: 100000, defaultOperations: 200000, maxOperations: 1000000,
} as const;

/** An outcome is an observable report, not a latent state that a future policy may secretly inspect. */
export type SequentialAllocationOutcome = {
  readonly probability: number;
  /** Confirmed conservative charge at this observable decision boundary, after releasing unused commitment.
   * Hidden final usage is not a valid input: remaining resources are themselves observable policy information. */
  readonly cost: LearningAllocationResources;
  readonly utilityCost: number;
  readonly nextStateId: string;
};

export type SequentialAllocationAction = {
  readonly offer: LearningAllocationOffer;
  readonly outcomes: readonly SequentialAllocationOutcome[];
};

export type SequentialAllocationState = {
  readonly stateId: string;
  /** Terminal utility if learning stops here. Never accumulated as a reward at every visited state. */
  readonly stopValue: number;
  readonly offers: readonly SequentialAllocationAction[];
};

export type SequentialAllocationRequest = {
  readonly schemaVersion: 1;
  /** Host assertion of observable sufficient states; numerical parsing cannot establish its truth. */
  readonly modelKind: "declared_finite_observable";
  readonly basis: LearningAllocationBasis;
  readonly initialStateId: string;
  readonly remaining: LearningAllocationResources;
  /** Number of funded stages represented, not internal tool steps or a claim about all future opportunities. */
  readonly horizon: number;
  readonly states: readonly SequentialAllocationState[];
};

export type SequentialAllocationDecision = { readonly kind: "stop" }
  | { readonly kind: "offer"; readonly offer: LearningAllocationOffer; readonly offerHash: string };

export type SequentialAllocationPlan = {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly modelHash: string;
  readonly basis: LearningAllocationBasis;
  readonly initialStateId: string;
  readonly remaining: LearningAllocationResources;
  readonly horizon: number;
  readonly decision: SequentialAllocationDecision;
  readonly netPolicyValue: number;
  readonly baselineStopValue: number;
  readonly netGain: number;
  readonly numericalScope: {
    readonly kind: "bounded_declared_model";
    readonly probabilityTolerance: number;
    readonly valueTolerance: number;
    readonly maximumProbabilityMassDrift: number;
  };
  readonly work: { readonly nodes: number; readonly operations: number };
};

export type SequentialAllocationFailure = "sequential_allocation_invalid" | "sequential_allocation_node_limit"
  | "sequential_allocation_operation_limit";

export type SequentialAllocationResult =
  | { readonly status: "rejected"; readonly reason: SequentialAllocationFailure }
  | { readonly status: "planned"; readonly plan: SequentialAllocationPlan };

export type SequentialAllocationOptions = { readonly nodeLimit?: number; readonly operationLimit?: number };
