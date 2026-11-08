import type { EvaluationEvidenceDraft } from "../../evaluation/types.js";
import type { SkillDraft, SkillEpisode } from "../../learning/domains/skill/inducer.js";
import type { VerificationAuthorityReader } from "../../learning/verification-authority/contracts.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import type { LearnedSkillContent } from "./contracts.js";

/** Runtime-owned, redacted task facts. Completion alone cannot qualify a success. */
export type SkillExperience = {
  readonly workspaceId: string;
  readonly runId: string;
  readonly sourceRef: string;
  readonly episode: SkillEpisode;
  readonly qualification:
    | { readonly kind: "external_check"; readonly ref: string }
    | { readonly kind: "explicit_correction"; readonly ref: string }
    | { readonly kind: "execution_failure"; readonly ref: string };
  readonly usedSkill?: {
    readonly versionId: string;
    readonly variantId: string;
    readonly contentHash: string;
  };
};

export type SkillOpportunity = {
  readonly opportunityId: string;
  readonly workspaceId: string;
  readonly collection: "enabled" | "disabled";
  readonly experiences: readonly SkillExperience[];
  /** Runtime changes this only when new independent trial evidence becomes available. */
  readonly trialRevision?: string;
};

/** The caller names a subsystem and allocates work; it never chooses the lesson. */
export type SkillLearningGrant = {
  readonly subsystem: "skill";
  readonly allowance: {
    readonly maxEpisodes: number;
    readonly maxInputBytes: number;
    readonly maxEvaluations: number;
    /** Defaults to one for v1 callers. Daily service can grant several bounded internal steps. */
    readonly maxCycles?: number;
  };
};

export type SkillLearningUsage = {
  readonly episodes: number;
  readonly inputBytes: number;
  readonly evaluations: number;
};

export type SkillLearningResult = {
  readonly status: "shadow" | "waiting" | "unchanged" | "disabled" | "cancelled" | "failed";
  readonly reason: string;
  readonly usage: SkillLearningUsage;
  readonly proposalId?: string;
  readonly versionId?: string;
  readonly steps?: readonly SkillLearningStep[];
};

export type SkillLearningStep = {
  readonly status: SkillLearningResult["status"];
  readonly reason: string;
  readonly proposalId?: string;
  readonly versionId?: string;
};

/** Evaluator receives immutable content, not the Board writer or permission port. */
export type SkillTrialRequest = {
  readonly content: LearnedSkillContent;
  readonly versionId: string;
  readonly baselineVersionId?: string;
  readonly scope: string;
  readonly signal: AbortSignal;
};

export type SkillTrialResult =
  | { readonly kind: "evidence"; readonly receiptRef: string; readonly evidence: EvaluationEvidenceDraft }
  | { readonly kind: "waiting"; readonly reason: string };

export type SkillLearningDependencies = {
  readonly board: BoardStore;
  readonly authority: VerificationAuthorityReader;
  /** Collection is checked before reading history, including when invoked standalone. */
  readonly collection: () => "enabled" | "disabled";
  readonly opportunity: (signal: AbortSignal) => Promise<SkillOpportunity>;
  readonly evaluate: (request: SkillTrialRequest) => Promise<SkillTrialResult>;
  readonly now: () => string;
};

export type SkillCandidate = {
  readonly content: LearnedSkillContent;
  readonly draft: SkillDraft;
  readonly versionId: string;
  readonly baselineVersionId?: string;
};
