import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import type { WorkflowImprovement, WorkflowOpportunity, WorkflowImprovementEvidence, WorkflowImprovementFeedback, WorkflowImprovementModelPort, WorkflowImprovementUse } from "../improvement/contracts.js";
import type { CentralLearningUsage, CentralLearningFinishResult } from "../../../../control/coordination-contract.js";
import type { JobState } from "../../../../control/contracts.js";
import type { WorkflowProcessTask } from "../improvement/contracts.js";
import type { WorkflowAssetVisibility } from "./asset-visibility.js";
import type { CentralLearningSourceContext } from "../../../../control/source-context.js";
import type { WorkflowResearchCheckpoint, WorkflowResearchHead } from "./research-state.js";
import type { WorkflowResearchFundingPort } from "./research-funding-contracts.js";

export const WORKFLOW_IMPROVEMENT_LIMITS = Object.freeze({ maxRunCalls: 4, maxPromptChars: 24_000,
  minProposalOutputTokens: 1536, maxDispatchTokens: 8192, maxProviderTimeoutMs: 90_000 });

export type WorkflowImprovementFunding = {
  readonly grantId: string; readonly jobId: string; readonly inputVersionId: string;
  readonly state: "queued" | "existing"; readonly resultRefs: readonly string[];
};

export type WorkflowImprovementReservation = WorkflowImprovementFunding & {
  readonly claimId: string; readonly reservationId: string; readonly maxTokens: number;
  /** Exact source basis at the managed claim, retained across local completion. */
  readonly expectedIssueRevision?: number;
};

export type WorkflowImprovementOpportunityRecord = {
  readonly type: "workflow_improvement_opportunity"; readonly schemaVersion: 1;
  readonly opportunity: WorkflowOpportunity; readonly evidence: readonly WorkflowImprovementEvidence[];
  readonly parentVersionId?: string;
};

/** Source-only central nomination is not a funded worker/job receipt. */
export type WorkflowCentralNomination = { readonly status: "queued_for_central"; readonly issueId: string;
  readonly inputVersionId: string; readonly sourceBindingRef: string; readonly note: string };

export type WorkflowOpportunityNominationPort = (record: WorkflowImprovementOpportunityRecord, signal: AbortSignal) =>
  Promise<WorkflowLearningResult<WorkflowCentralNomination>>;

export type WorkflowImprovementUseRecord = {
  readonly type: "workflow_improvement_use"; readonly schemaVersion: 1;
  readonly use: WorkflowImprovementUse; readonly sessionId: string; readonly afterSequence: number;
};

export type WorkflowImprovementFeedbackRecord = {
  readonly type: "workflow_improvement_feedback"; readonly schemaVersion: 1; readonly feedback: WorkflowImprovementFeedback;
};

export type WorkflowImprovementBoardContent = WorkflowImprovement | WorkflowImprovementOpportunityRecord | WorkflowImprovementUseRecord | WorkflowImprovementFeedbackRecord | WorkflowResearchCheckpoint;

export type WorkflowImprovementBoardView = {
  /** Internal source revocation facts. Never serialize the whole index to a model. */
  readonly sourceVisibility?: Readonly<Record<string, WorkflowAssetVisibility>>;
  readonly versions: readonly { readonly versionId: string; readonly artifact: WorkflowImprovement; readonly status: "eligible" | "blocked" | "unsettled" }[];
  readonly opportunities: readonly { readonly versionId: string; readonly record: WorkflowImprovementOpportunityRecord }[];
  readonly uses: readonly WorkflowImprovementUseRecord[];
  readonly feedback: readonly WorkflowImprovementFeedback[];
  readonly research?: readonly WorkflowResearchHead[];
  readonly recentIssues: readonly {
    readonly opportunityVersionId: string; readonly opportunityId: string; readonly issueKey: string;
    readonly task: WorkflowOpportunity["task"]; readonly trigger: WorkflowOpportunity["trigger"];
    readonly problem: string; readonly proposalState: JobState | "unfunded";
    readonly grantId?: string; readonly jobId?: string; readonly reason?: string;
  }[];
};

export type WorkflowImprovementPublishOwner = {
  readonly reservation: WorkflowImprovementReservation; readonly signal: AbortSignal; readonly now: () => number;
  readonly centralScope?: string;
};

export type WorkflowImprovementAdoption = { readonly versionId: string; readonly dispatchChecked?: true; readonly hostGuidance?: string };

export type WorkflowImprovementStorePort = {
  read(): Promise<WorkflowLearningResult<WorkflowImprovementBoardView>>;
  save(content: WorkflowImprovementBoardContent, issuedAt: string, signal?: AbortSignal): Promise<WorkflowLearningResult<{ readonly versionId: string }>>;
  /** Recheck current lineage, correction floor and contextual standing under the writer lock. */
  adopt(record: WorkflowImprovementUseRecord, issuedAt: string, signal?: AbortSignal,
    dispatchPolicy?: WorkflowImprovementDispatchPolicy): Promise<WorkflowLearningResult<WorkflowImprovementAdoption>>;
  publish(artifact: WorkflowImprovement, issuedAt: string, owner: WorkflowImprovementPublishOwner): Promise<WorkflowLearningResult<{ readonly versionId: string }>>;
  saveResearch?(record: WorkflowResearchCheckpoint, owner: WorkflowImprovementPublishOwner): Promise<WorkflowLearningResult<{ readonly versionId: string }>>;
};

export type WorkflowImprovementFundingPort = {
  readonly research?: WorkflowResearchFundingPort;
  fund(record: WorkflowImprovementOpportunityRecord): Promise<WorkflowLearningResult<WorkflowImprovementFunding>>;
  reserve(funding: WorkflowImprovementFunding): Promise<WorkflowLearningResult<WorkflowImprovementReservation>>;
  settle(reservation: WorkflowImprovementReservation, usage: CentralLearningUsage): Promise<WorkflowLearningResult<unknown>>;
  finish(reservation: WorkflowImprovementReservation, result: CentralLearningFinishResult): Promise<WorkflowLearningResult<unknown>>;
  stop(funding: WorkflowImprovementFunding): Promise<WorkflowLearningResult<unknown>>;
  prepareResume(inputVersionId: string): Promise<WorkflowLearningResult<unknown>>;
};

/** A receipt says what ran; it does not by itself attest every quality invariant. */
export type WorkflowImprovementReceipt = {
  readonly ref: string;
  readonly sequence: number;
  readonly executionId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly checkStatus?: "passed" | "failed";
};

export type WorkflowImprovementEvidenceSnapshot = {
  readonly evidence: readonly WorkflowImprovementEvidence[];
  readonly receipts: readonly WorkflowImprovementReceipt[];
  readonly watermark: number;
  readonly executionId: string;
  /** Internal durable workflow tool issuances still awaiting their own result; never model evidence. */
  readonly pendingHooks?: readonly {
    readonly toolCallId: string;
    readonly executionId: string;
    readonly operation: "context" | "opportunity" | "feedback";
    readonly useId?: string;
  }[];
};

export type WorkflowImprovementQualityAssessment = {
  readonly quality: WorkflowImprovementFeedback["quality"];
  readonly comparison?: WorkflowImprovementFeedback["comparison"];
  readonly processEvidence?: WorkflowImprovementFeedback["processEvidence"];
};

export type WorkflowImprovementDispatchDecision = { readonly kind: "allowed"; readonly guidance?: string }
  | { readonly kind: "deferred"; readonly reason: string; readonly sourceRefs: readonly string[]; readonly pinnedVersionId?: string };

export type WorkflowImprovementDispatchPolicy = (task: WorkflowProcessTask, sourceVisibility?: Readonly<Record<string, WorkflowAssetVisibility>>) => WorkflowLearningResult<WorkflowImprovementDispatchDecision>;

export type WorkflowImprovementRuntimeOptions = {
  readonly store: WorkflowImprovementStorePort;
  readonly funding: WorkflowImprovementFundingPort;
  /** Explicit managed mode keeps normal source/feedback/adoption hooks but delegates investment to central allocation. */
  readonly nominateOpportunity?: WorkflowOpportunityNominationPort;
  /** Immutable source analysis is model input data, never an independent measurement or permission. */
  readonly centralContent?: CentralLearningSourceContext;
  readonly scope: string;
  /** Asset scope remains stable; central issues and grants share the host's canonical workspace path. */
  readonly centralScope?: string;
  readonly sessionId: string;
  readonly budgetId: string;
  readonly allowance: number;
  readonly now: () => number;
  readonly newModel: () => WorkflowImprovementModelPort;
  readonly readEvidence: () => Promise<WorkflowLearningResult<WorkflowImprovementEvidenceSnapshot>>;
  /** Reject secret-bearing model reports before persistence or provider calls. */
  readonly publicData: (value: unknown) => boolean;
  /** Host source frames may carry canonical identity paths; never used for model output. */
  readonly contextPublicData?: (value: unknown) => boolean;
  readonly warn: (code: string) => void;
  /** Business close waits at most this grace for workers; reservations remain conservative if storage is unavailable. */
  readonly closeGraceMs?: number;
  readonly hostEvidence?: readonly WorkflowImprovementEvidence[];
  /** Frozen host intent/legacy pins are independent from model-supplied operation labels. */
  readonly dispatchPolicy?: WorkflowImprovementDispatchPolicy;
  /** Only an independent host checker may admit quality or a paired comparison. */
  readonly assessQuality?: (input: {
    readonly use: WorkflowImprovementUse;
    readonly artifact: WorkflowImprovement;
    readonly receipts: readonly WorkflowImprovementReceipt[];
    readonly evidenceRefs: readonly string[];
  }) => Promise<WorkflowLearningResult<WorkflowImprovementQualityAssessment>>;
};
