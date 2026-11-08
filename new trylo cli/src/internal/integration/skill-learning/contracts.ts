import type { SkillDraft } from "../../learning/domains/skill/index.js";
import type { TaskFamily } from "../../learning/domains/shared/types.js";

/** Version 1 is Board content, never a second skill store or an installed SKILL.md. */
export type LearnedSkillContent = {
  readonly kind: "learned_skill";
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly experienceDigest: string;
  readonly sourceOpportunityId: string;
  readonly draft: SkillDraft;
  /** Full input stays in runtime evidence archives; this records the exact bounded proof consumed. */
  readonly sourceWindow?: {
    readonly inputDigest: string;
    readonly selectedEpisodeIds: readonly string[];
    readonly omittedCount: number;
    readonly sourceRefs: readonly string[];
  };
};

/** Runtime facts at a task boundary. Missing facts must not broaden applicability. */
export type LearnedSkillContext = {
  readonly workspaceId: string;
  readonly taskFamily: TaskFamily;
};

/** Loading is evidence of exposure only; success needs the task's independent result. */
export type LearnedSkillLoad = {
  readonly versionId: string;
  readonly proposalId: string;
  readonly variantId: string;
  readonly contentHash: string;
};
