import type { TaskFamily } from "../../learning/domains/shared/types.js";

export type SkillLearningSummary = {
  readonly versionId: string;
  readonly proposalId: string;
  readonly name: string;
  readonly version: number;
  readonly status: string;
  readonly createdAt: string;
  readonly taskFamily: TaskFamily;
  readonly sourceOpportunityId: string;
  readonly observationRefs: readonly string[];
  readonly contentHash: string;
  readonly parentVersionId?: string;
  /** Loads are journal-proven runs; quality counts require separate qualified feedback. */
  readonly usage: { readonly loads: number; readonly successes: number; readonly failures: number;
    readonly qualifiedRuns?: number; readonly unknownOutcomes?: number };
};

export type SkillLearningCommandError = { readonly schemaVersion: 1; readonly ok: false; readonly code: string; readonly message: string };

export type SkillLearningCommandReply<T> = ({ readonly schemaVersion: 1; readonly ok: true } & T) | SkillLearningCommandError;

export type SkillLearningListReply = SkillLearningCommandReply<{ readonly workspaceId: string; readonly skills: readonly SkillLearningSummary[] }>;

export type SkillLearningShowReply = SkillLearningCommandReply<{
  readonly skill: SkillLearningSummary;
  readonly content: string;
  readonly uses: readonly { readonly runId: string; readonly variantId: string; readonly outcome: string; readonly sourceRef: string }[];
}>;

export type SkillLearningWithdrawReply = SkillLearningCommandReply<{ readonly versionId: string; readonly status: "withdrawn" | "already_withdrawn" }>;

export type SkillLearningLearnReply = SkillLearningCommandReply<{ readonly result: {
  readonly status: string; readonly reason: string; readonly versionId?: string; readonly proposalId?: string; readonly grantId?: string;
  readonly usage: { readonly tokens?: number; readonly outputTokens?: number; readonly calls: number; readonly usageStatus?: "reported" | "missing" };
} }>;

/** The CLI presents runtime-owned facts and Board commands; it never reads a second skill library. */
export type SkillLearningCommandPort = {
  readonly list: () => Promise<SkillLearningListReply>;
  readonly show: (versionId: string) => Promise<SkillLearningShowReply>;
  readonly withdraw: (versionId: string) => Promise<SkillLearningWithdrawReply>;
  readonly learn: (allowance: { readonly maxTokens: number; readonly maxCalls: number }, signal: AbortSignal) => Promise<SkillLearningLearnReply>;
  readonly close?: () => Promise<void>;
};
