import type { LearningIssue } from "../../../../control/coordination-contract.js";
import type { CentralFundingPort } from "../control/contracts.js";
import type { ExpertSelection } from "../../../../../subagent/experts/index.js";
import type { PublishExperienceInput, ExperienceResult } from "../experience/contracts.js";
import type { CollaborationEvaluation } from "../domain/evaluation.js";

export const LEARNING_RESPONSE_FAILURE = Object.freeze({ action: "learning_action_invalid", json: "learning_action_json_invalid" });

export type ResourceOwner = "tool" | "expert" | "experience" | "research";

export type CollaborationAdjustment = {
  readonly memberId: string;
  readonly kind: "division" | "handoff" | "sharing" | "review" | "configuration";
  readonly instruction: string;
  readonly expertSelection?: ExpertSelection;
};

export type CapabilityNeed = { readonly owner: "tool" | "expert"; readonly memberId: string; readonly instruction: string;
  readonly expertId?: string };

export type CollaborationPlan = {
  readonly evaluation?: CollaborationEvaluation;
  readonly schema: "collaboration-plan/v1"; readonly issueId: string; readonly focusRevision: number;
  readonly familyId: string; readonly title: string; readonly summary: string;
  readonly sourceRefs: readonly string[]; readonly adjustments: readonly CollaborationAdjustment[];
  readonly experienceVersionIds: readonly string[]; readonly needs: readonly CapabilityNeed[];
};

export type ExperienceDraft = {
  readonly evaluation?: CollaborationEvaluation;
  /** Optional exact source configuration restriction; otherwise experience follows its stable owner. */
  readonly expertVersion?: number;
  readonly ownerRef: string; readonly familyId: string; readonly situation: string;
  readonly responsibilities: readonly string[]; readonly practice: string; readonly sourceRefs: readonly string[];
  readonly parentVersion?: string; readonly conditions?: PublishExperienceInput["conditions"];
};

export type CollaborationExperiencePublicationPorts = {
  /** Host resolves an actual existing owner; an unknown owner never authorizes creating one. */
  readonly experienceInput: (issueId: string, draft: ExperienceDraft) => Promise<ExperienceResult<{ input: PublishExperienceInput }>>;
  /** Production uses the canonical store admission; absent only for older isolated callers. */
  readonly preflightExperience?: (input: PublishExperienceInput) => Promise<ExperienceResult<{ input: PublishExperienceInput }>>;
  readonly publishExperience: (input: PublishExperienceInput) => Promise<ExperienceResult<{ versionId: string; proposalId: string }>>;
};

export type LearningAction = { readonly kind: "query"; readonly owner: ResourceOwner; readonly query: string }
  | { readonly kind: "propose"; readonly familyId: string; readonly title: string; readonly summary: string;
      readonly evaluation?: CollaborationEvaluation;
      readonly sourceRefs: readonly string[]; readonly adjustments: readonly CollaborationAdjustment[];
      readonly experiences: readonly ExperienceDraft[]; readonly needs: readonly CapabilityNeed[] }
  | { readonly kind: "no_change"; readonly reason: string; readonly sourceRefs: readonly string[] };

export type ActionResult = { readonly ok: true; readonly action: LearningAction } | { readonly ok: false; readonly reason: string };

export type CollaborationDecisionPort = {
  decide(input: { readonly issue: LearningIssue; readonly material: unknown; readonly step: number;
    readonly knownSourceRefs?: readonly string[];
    readonly jobId: string; readonly claimId: string; readonly funding: CentralFundingPort;
    readonly maxPromptChars: number; readonly signal: AbortSignal }): Promise<ActionResult>;
};

export type CollaborationResourcePort = {
  query(input: { readonly issue: LearningIssue; readonly jobId: string; readonly grantId: string;
    readonly requestId: string; readonly owner: ResourceOwner; readonly query: string; readonly signal: AbortSignal }):
    Promise<{ readonly ok: true; readonly summary: unknown; readonly sourceRefs: readonly string[] }
      | { readonly ok: false; readonly reason: string }>;
};

/** Rehydrate only existing source authority and summary observations from the original grant. */
export type CollaborationResearchRecoveryPort = (input: {
  readonly issueId: string; readonly jobId: string; readonly grantId: string;
}) => Promise<ExperienceResult<{ readonly observations: readonly unknown[]; readonly sourceRefs: readonly string[] }>>;
