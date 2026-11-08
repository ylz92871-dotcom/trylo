import type { BoardCommandDraft } from "../shared/board-command.js";
import type { DomainFailure, DraftStatus, Provenance, Scope, TaskFamily, TrajectorySketch } from "../shared/types.js";

/** Corrections reject a supported path; they never supply a successful replacement. */
export type SkillCorrection = {
  readonly targetEpisodeIds: readonly string[];
  readonly scope: "task" | "condition" | "family";
  readonly reason: string;
};

export type SkillEpisode = {
  readonly id: string;
  readonly taskFamily: TaskFamily;
  readonly trajectory: TrajectorySketch;
  readonly outcome: "success" | "failure";
  readonly steps: readonly string[];
  readonly checks: readonly string[];
  readonly failureMode?: string;
  readonly correction?: SkillCorrection;
  /** Runtime supplies these only after an independent successful revalidation. */
  readonly validatedAfterCorrectionIds?: readonly string[];
};

export type SkillExampleRef = {
  readonly episodeId: string;
  readonly outcome: "success" | "failure";
};

export type SkillStepEvidence = { readonly step: string; readonly episodeIds: readonly string[] };

export type SkillCheckEvidence = { readonly check: string; readonly episodeIds: readonly string[] };

export type SkillFailureLesson = { readonly failureMode: string; readonly episodeIds: readonly string[] };

/** A complete observed sequence under exact conditions, never a splice of unrelated successes. */
export type SkillVariant = {
  readonly id: string;
  readonly taskFamily: TaskFamily;
  readonly steps: readonly string[];
  readonly checks: readonly string[];
  readonly supportEpisodeIds: readonly string[];
  readonly stepEvidence: readonly SkillStepEvidence[];
  readonly checkEvidence: readonly SkillCheckEvidence[];
  readonly failureLessons: readonly SkillFailureLesson[];
  readonly correctionRefs: readonly string[];
};

export type SkillDraft = {
  readonly kind: "skill";
  readonly status: DraftStatus;
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly trigger: string;
  readonly taskFamily: TaskFamily;
  readonly variants: readonly SkillVariant[];
  /** Compatibility projection of the preferred variant; consumers must match its conditions. */
  readonly steps: readonly string[];
  readonly checks: readonly string[];
  readonly failureModes: readonly string[];
  readonly positiveExamples: readonly SkillExampleRef[];
  readonly negativeExamples: readonly SkillExampleRef[];
  readonly positiveRules: readonly string[];
  readonly negativeRules: readonly string[];
  readonly provenance: Provenance;
  readonly scope: Scope;
  readonly identity: string;
  readonly permissionClaim: false;
  readonly command: BoardCommandDraft;
};

export type SkillInduceResult = { readonly kind: "draft"; readonly draft: SkillDraft } | DomainFailure;
