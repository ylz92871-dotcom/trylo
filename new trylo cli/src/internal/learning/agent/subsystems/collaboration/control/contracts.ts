import type { CentralLearningAllowance, CentralLearningGrant, CentralLearningRemaining, CentralLearningUsage,
  CentralLearningFinishResult, LearningDependency, LearningDependencyState, LearningIssue, LearningIssueReport } from "../../../../control/coordination-contract.js";
import type { CollaborationBoardPort } from "../domain/contracts.js";
import type { TimerScheduler } from "../../../../../subagent/scheduler.js";
import type { CentralLearningSourceContext } from "../../../../control/source-context.js";

export type ControlResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: string };

export type CentralFundingPort = {
  reserve(input: { readonly reservationId: string; readonly maxTokens: number }): Promise<ControlResult<{
    readonly status: "reserved" | "duplicate"; readonly grant: CentralLearningGrant; readonly remaining: CentralLearningRemaining }>>;
  settle(input: { readonly reservationId: string; readonly usage: CentralLearningUsage }): Promise<ControlResult<{
    readonly status: "settled" | "duplicate"; readonly grant: CentralLearningGrant; readonly remaining: CentralLearningRemaining }>>;
  inspect(): Promise<ControlResult<{ readonly active: boolean; readonly grant: CentralLearningGrant; readonly remaining: CentralLearningRemaining }>>;
};

export type CollaborationCentralWorker = {
  run(input: { readonly issue: LearningIssue; readonly jobId: string; readonly grantId: string; readonly claimId: string;
    readonly centralSourceContext?: CentralLearningSourceContext;
    readonly dependencies: readonly LearningDependency[];
    readonly allowance: CentralLearningAllowance; readonly remaining: CentralLearningRemaining; readonly funding: CentralFundingPort;
    readonly signal: AbortSignal }): Promise<CentralLearningFinishResult>;
};

export type CollaborationControlOptions = {
  readonly board: Pick<CollaborationBoardPort, "load" | "apply">; readonly now: () => string; readonly ownerId: string;
  readonly worker?: CollaborationCentralWorker; readonly enabled?: () => boolean; readonly claimLeaseMs?: number;
  readonly workScheduler?: TimerScheduler;
};

export type ReportLearningIssueInput = { readonly scope: string; readonly problemKey: string; readonly report: LearningIssueReport;
  readonly issueId?: string; readonly expectedRevision?: number };

export type DecideLearningIssueInput = { readonly issueId: string; readonly expectedRevision: number;
  readonly decision: "resolved" | "ordinary_execution" | "focused_learning"; readonly reason: string; readonly sourceRefs: readonly string[] };

export type FundLearningIssueInput = { readonly issueId: string; readonly expectedRevision: number; readonly grantId: string;
  readonly allowance: CentralLearningAllowance };

export type ObserveLearningDependencyInput = { readonly dependencyId: string; readonly expectedRevision: number; readonly requestId?: string; readonly state: LearningDependencyState };

export type CollaborationDispatchResult = { readonly workAttempted?: true } & ControlResult<{ readonly status: "idle" | "busy" | "completed" | "waiting_dependency" | "failed" | "cancelled";
  readonly issueId?: string; readonly jobId?: string; readonly grantId?: string; readonly remaining?: CentralLearningRemaining;
  readonly result?: CentralLearningFinishResult }>;
