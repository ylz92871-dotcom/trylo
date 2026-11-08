import type { ExpertIdentity, ExpertUseScope } from "../../../../../subagent/experts/index.js";
import type { ExperienceOwner } from "../../../../../protocol/collaboration-experience.js";
import type { CollaborationEvaluation } from "../domain/evaluation.js";

export type { ExperienceOwner, ExperienceBoundaryReceipt, ExperienceUseFeedback, ExperienceAssessment } from "../../../../../protocol/collaboration-experience.js";

/** Attribution keys only. The expert library remains the identity/configuration authority. */
export type ExperienceConditions = {
  readonly surface?: "code" | "work";
  readonly taskFamily?: string;
  readonly dependency?: "artifact" | "independent" | "shared_state";
  readonly responsibility?: string;
  readonly expertDraft?: NonNullable<ExpertIdentity["draft"]>;
  readonly useScope?: ExpertUseScope;
};

export type ExperienceContext = {
  readonly surface?: "code" | "work";
  readonly taskFamily?: string;
  readonly dependency?: "artifact" | "independent" | "shared_state" | "unknown";
  readonly responsibilities?: readonly string[];
  readonly useScope?: ExpertUseScope;
};

export type PublishExperienceInput = {
  readonly evaluation?: CollaborationEvaluation;
  readonly issueId: string;
  readonly owner: ExperienceOwner;
  readonly familyId: string;
  readonly situation: string;
  readonly responsibilities: readonly string[];
  readonly practice: string;
  readonly sourceRefs: readonly string[];
  readonly parentVersion?: string;
  /** Real library value supplied by the trusted host; required for an expert owner. */
  readonly expertIdentity?: ExpertIdentity;
  readonly expertVersion?: ExpertIdentity["version"];
  readonly conditions?: ExperienceConditions;
};

export type CollaborationExperienceContent = {
  readonly evaluation?: CollaborationEvaluation;
  readonly schema: "collaboration-experience/v1";
  readonly status: "trial";
  readonly issueId: string;
  readonly focusRevision: number;
  readonly familyId: string;
  readonly owner: ExperienceOwner;
  readonly situation: string;
  readonly responsibilities: readonly string[];
  readonly practice: string;
  readonly sourceRefs: readonly string[];
  readonly sourceExpert?: ExpertIdentity;
  readonly expertVersion?: ExpertIdentity["version"];
  readonly conditions: ExperienceConditions;
  readonly parentVersionId?: string;
};

export type PrepareExperienceInput = {
  readonly owner: ExperienceOwner;
  readonly expertVersion?: ExpertIdentity["version"];
  readonly expertDraft?: ExpertIdentity["draft"];
  readonly context?: ExperienceContext;
  readonly maxChars: number;
};

export type PreparedExperience = { readonly text: string; readonly versionIds: readonly string[]; readonly selectionId: string };

export type ExperienceResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

export const EXPERIENCE_CARD_MAX_CHARS = 600;
/** Exact runtime retrieval keys; display duties inside a card keep their separate 120-character bound. */
export const EXPERIENCE_RESPONSIBILITY_LIMITS = Object.freeze({ maxChars: 200, maxItems: 8 });
