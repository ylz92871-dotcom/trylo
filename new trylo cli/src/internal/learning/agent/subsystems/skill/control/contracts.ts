import type { CentralLearningAllowance, CentralLearningGrant, CentralLearningRemaining, CentralLearningUsage,
  CentralLearningWorkResult, LearningIssue } from "../../../../control/coordination-contract.js";
import type { BoardStore } from "../../../../control/store-port.js";

export type SkillControlResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

export type SkillCentralFunding = {
  inspect(): Promise<SkillControlResult<{ readonly active: boolean; readonly grant: CentralLearningGrant; readonly remaining: CentralLearningRemaining;
    /** Execution-view prompt cap. The canonical cumulative grant remains unchanged. */
    readonly maxPromptChars?: number }>>;
  reserve(input: { readonly reservationId: string; readonly maxTokens: number }): Promise<SkillControlResult<{
    readonly status: "reserved" | "duplicate"; readonly grant: CentralLearningGrant; readonly remaining: CentralLearningRemaining }>>;
  settle(input: { readonly reservationId: string; readonly usage: CentralLearningUsage }): Promise<SkillControlResult<{
    readonly status: "settled" | "duplicate"; readonly grant: CentralLearningGrant; readonly remaining: CentralLearningRemaining }>>;
};

export type SkillCentralWorker = (input: {
  readonly issue: LearningIssue; readonly grant: CentralLearningGrant; readonly claimId: string;
  readonly remaining: CentralLearningRemaining; readonly funding: SkillCentralFunding; readonly signal: AbortSignal;
}) => Promise<CentralLearningWorkResult>;

export type SkillCoordinationOptions = {
  readonly board: Pick<BoardStore, "load" | "apply">; readonly scope: string; readonly ownerId: string;
  readonly now: () => string; readonly enabled?: () => boolean;
};

export type SkillTaskReport = {
  readonly sourceRef: string;
  /** Canonical source turn, not the generated skill identity. */
  readonly taskId: string;
  /** Existing Board source field: this adapter carries the source session locator, not a skill version. */
  readonly versionId?: string;
  readonly facts: readonly string[]; readonly evidenceRefs: readonly string[];
};

export type SkillFocus = {
  readonly issueId: string; readonly expectedRevision: number; readonly reason: string;
  readonly sourceRefs: readonly string[]; readonly allowance: CentralLearningAllowance;
};

export type SkillDispatchResult = SkillControlResult<{
  readonly status: "idle" | "busy" | "completed" | "waiting_dependency" | "failed" | "cancelled";
  readonly issueId?: string; readonly jobId?: string; readonly grantId?: string;
  readonly result?: CentralLearningWorkResult; readonly remaining?: CentralLearningRemaining;
}>;
