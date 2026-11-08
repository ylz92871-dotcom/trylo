import type { MethodObservation } from "./domain/inference.js";
import type { ScopeHypothesis, ScopePredicate } from "./domain/scope-learning.js";
import type { CompiledProcedure } from "./domain/procedure.js";
import type { CentralLearningSourceContext } from "../../../control/source-context.js";

export { ExperienceModelError } from "./domain/model-error.js";

export const METHOD_CONTEXT_TOOL = "method_context";

/** Model supplies business facts; the host supplies task identity and delivery boundaries. */
export type ExperienceContext = {
  readonly taskId: string;
  readonly opportunityId: string;
  readonly situation: string;
  readonly features: Readonly<Record<string, string>>;
};

export type ExperienceSelection = {
  /** This parent-task/expression unit settled business work before adoption. */
  readonly adoptionWindowClosed?: boolean;
  readonly procedureStepIds?: readonly string[];
  readonly sourceVersionIds?: readonly string[];
  readonly versionId: string;
  readonly scopeId: string;
  readonly compilationId: string;
  readonly compact: string;
  readonly stable: boolean;
};

export type ExperienceDecision = {
  /** Host-bound compilation actually selected; absent for source-method trials. */
  readonly compilationId?: string;
  readonly versionId: string;
  readonly scopeId: string;
  readonly action: "adopt" | "deviate" | "block";
  readonly reason: string;
  readonly step?: string;
  readonly facts?: string;
};

export type ExperienceConditionRequest = {
  readonly versionId: string;
  readonly scopeId: string;
  readonly condition: string;
  readonly missing: readonly { readonly relation: "required" | "excluded"; readonly feature: string; readonly expectedValue: string }[];
};

/** An explicit local experiment with an existing method, never a global activation. */
export type ExperienceSourceTrial = { readonly versionId: string; readonly scopeId: string };

export type ExperienceRuntimePort = {
  correct(input: { readonly observationId: string; readonly outcome: MethodObservation["outcome"]; readonly reason: string;
    readonly application?: import("./domain/application-report.js").MethodApplicationReport }): Promise<void>;
  context(input: ExperienceContext, trial?: ExperienceSourceTrial): Promise<readonly ExperienceSelection[]>;
  /** Consumed once per unchanged context; the model supplies missing truth values. */
  takeContextConditions?(): readonly ExperienceConditionRequest[];
  decide(input: ExperienceDecision): Promise<void>;
  expand(versionId: string): Promise<string>;
  /** Bounded catalog of scope predicates, never the full method bodies. */
  catalog(): Promise<string>;
};

/** A related compilation keeps its own qualification snapshot and current reliability; its samples never join the target. */
export type ExperienceRelatedSource = {
  readonly compiledEvidence?: { readonly successes: number; readonly failures: number; readonly confidence: number;
    readonly adoptionCoverage: import("./domain/adoption-coverage.js").AdoptionCoverage };
  readonly versionId: string;
  readonly scope: ScopeHypothesis;
  readonly effectivePredicate: ScopePredicate;
  readonly compilationId: string;
  readonly qualificationSnapshotId: string;
  readonly qualificationEvidenceRevisions: readonly string[];
  readonly currentSnapshotId: string;
  readonly confidence: number;
  readonly compact: NonNullable<ExperienceReview["compact"]>;
  readonly procedure?: CompiledProcedure;
  readonly summary: { readonly method: string; readonly judgment: string };
  readonly evidence: {
    readonly successes: number; readonly failures: number; readonly unknown: number;
    readonly externalFailures: number; readonly notAdopted: number;
    readonly observationIds: readonly string[]; readonly omittedObservationIds: number;
  };
};

export type ExperienceReviewRequest = {
  /** Public source analysis is context, never independent helpfulness or permission. */
  readonly centralSourceContext?: CentralLearningSourceContext;
  /** Settled tool facts are context, never additional helpfulness trials. */
  readonly executionTraces?: readonly import("./domain/execution-trace.js").MethodExecutionTrace[];
  readonly experiences?: readonly { readonly observationId: string; readonly situation: string; readonly adoptionReason: string;
    readonly excerpted: boolean; readonly blocking?: { readonly reason: string; readonly step?: string; readonly facts?: string } }[];
  readonly evidenceSummary?: { readonly successes: number; readonly failures: number; readonly omittedKnownObservations: number;
    readonly knownCounterexamples: number; readonly omittedCounterexamples: number };
  readonly adoptionCoverage?: import("./domain/adoption-coverage.js").AdoptionCoverage;
  readonly snapshotId: string;
  readonly versionId: string;
  readonly scope: ScopeHypothesis;
  readonly effectivePredicate?: ScopePredicate;
  readonly method: string;
  readonly confidence: number;
  readonly observations: readonly MethodObservation[];
  readonly counterexamples: readonly string[];
  /** Optional for existing callers. Normal orchestration supplies up to three compatible mature sources. */
  readonly relatedSources?: readonly ExperienceRelatedSource[];
  readonly repair?: ExperienceDecision;
  /** Prior subjective assessment is context for reconsideration, never a new observation. */
  readonly previousAssessment?: { readonly reviewId: string; readonly snapshotId: string;
    readonly decision: ExperienceReview["decision"]; readonly score: number;
    readonly reason: string; readonly excerpted: boolean };
  readonly currentCompilation?: { readonly compilationId: string; readonly compact: NonNullable<ExperienceReview["compact"]>;
    readonly procedure?: CompiledProcedure; readonly sources: readonly string[]; readonly withdrawn: boolean;
    /** Host-derived defect obligation; a checkpoint/revision alone is not one. */
    readonly repairRequired?: boolean;
    readonly empirical?: { readonly successes: number; readonly failures: number; readonly confidence: number;
      readonly adoptionCoverage?: import("./domain/adoption-coverage.js").AdoptionCoverage };
    readonly reentry?: { readonly afterSequence: number; readonly successes: number; readonly failures: number; readonly confidence: number } };
  readonly reconsideration?: {
    readonly compilationId: string;
    readonly reason: "counterexample" | "pattern_change" | "evidence_change";
    readonly evidenceRevisions: readonly string[];
    readonly observations: readonly MethodObservation[];
    readonly confidence: number;
    readonly changeProbability: number;
  };
};

export type ExperienceReview = {
  readonly decision: "promote" | "defer" | "expression" | "narrow" | "behavior" | "core_invalid";
  readonly score: number;
  readonly reason: string;
  readonly compact?: { readonly when: string; readonly action: string; readonly exceptions: string };
  readonly procedure?: CompiledProcedure;
  readonly scopes?: readonly ScopeHypothesis[];
  readonly revisedMethod?: string;
  readonly sources: readonly string[];
};

/** Adapter owns real provider transport and charges the existing central Board allowance. */
export type ExperienceModelPort = {
  review(request: ExperienceReviewRequest, signal: AbortSignal): Promise<ExperienceReview>;
};
