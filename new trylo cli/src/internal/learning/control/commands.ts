import type {
  ApprovalAction,
  ApprovalStatus,
  EvidenceBundle,
  JobState,
  LearningJob,
  LearningProposal,
  MethodRetention,
} from "./contracts.js";
import type { RewardExposureDraft, RewardFeedback } from "../reward/contracts.js";
import type { ToolTrialRecord } from "../agent/subsystems/tool/domain/evolution/trial.js";
import type { ToolUseRecord } from "../agent/subsystems/tool/domain/evolution/use.js";

type CommandBase = {
  readonly commandId: string;
  readonly issuedAt: string;
};

export type ProposalDraft = Omit<LearningProposal, "lifecycle">;

export type SubmitProposalCommand = CommandBase & {
  readonly type: "submit_proposal";
  readonly proposal: ProposalDraft;
};

export type QuarantineCommand = CommandBase & {
  readonly type: "quarantine";
  readonly proposalId: string;
};

export type StartEvaluationCommand = CommandBase & {
  readonly type: "start_evaluation";
  readonly proposalId: string;
};

export type RecordEvidenceCommand = CommandBase & {
  readonly type: "record_evidence";
  readonly evidence: EvidenceBundle;
};

export type EnterShadowCommand = CommandBase & {
  readonly type: "enter_shadow";
  readonly proposalId: string;
  readonly versionId: string;
};

export type RequestApprovalCommand = CommandBase & {
  readonly type: "request_approval";
  readonly proposalId: string;
  readonly approvalId: string;
  readonly action: ApprovalAction;
};

export type RecordApprovalDecisionCommand = CommandBase & {
  readonly type: "record_approval_decision";
  readonly approvalId: string;
  readonly status: Exclude<ApprovalStatus, "pending">;
};

export type ActivateCommand = CommandBase & {
  readonly type: "activate";
  readonly proposalId: string;
  readonly versionId: string;
  readonly expectedGeneration?: number;
};

export type RejectCommand = CommandBase & {
  readonly type: "reject";
  readonly proposalId: string;
  readonly reason: string;
};

export type FastLaneValidateCommand = CommandBase & {
  readonly type: "fast_lane_validate";
  readonly proposalId: string;
};

export type CommitAssetCommand = CommandBase & {
  readonly type: "commit_asset";
  readonly versionId: string;
  readonly proposalId: string;
  readonly content: unknown;
  readonly schemaVersion: number;
  readonly parentVersionId?: string;
};

export type SuspendCommand = CommandBase & {
  readonly type: "suspend";
  readonly proposalId: string;
  readonly breakerReason: string;
};

export type ResumeCommand = CommandBase & {
  readonly type: "resume";
  readonly proposalId: string;
  readonly expectedGeneration?: number;
};

export type RollbackCommand = CommandBase & {
  readonly type: "rollback";
  readonly proposalId: string;
  readonly reason: string;
};

export type RetireCommand = CommandBase & {
  readonly type: "retire";
  readonly proposalId: string;
};

export type EnqueueJobCommand = CommandBase & {
  readonly type: "enqueue_job";
  readonly job: Omit<LearningJob, "state" | "attempt" | "breakerOpen">;
};

/** Exact original managed source/lease plus a confirmed native checkpoint, never new funds. */
export type ManagedJobContinuation = {
  readonly grantId: string; readonly claimId: string; readonly expectedIssueRevision: number;
  readonly resultRef: string; readonly expectedAttempt: number;
};

export type StartJobCommand = CommandBase & {
  readonly type: "start_job";
  readonly jobId: string;
  readonly continuation?: ManagedJobContinuation;
};

/** Evidence arrival only requeues work; it grants no authority and consumes no attempt. */
export type RequeueJobCommand = CommandBase & {
  readonly type: "requeue_job";
  readonly jobId: string;
  readonly expectedAttempt: number;
  readonly continuation?: ManagedJobContinuation;
};

export type CompleteJobCommand = CommandBase & {
  readonly type: "complete_job";
  readonly jobId: string;
  readonly next: Extract<
    JobState,
    "waiting_approval" | "waiting_evidence" | "succeeded"
  >;
};

export type FailJobCommand = CommandBase & {
  readonly type: "fail_job";
  readonly jobId: string;
  readonly terminal: Extract<JobState, "failed" | "cancelled" | "expired">;
};

export type TombstoneCommand = CommandBase & {
  readonly type: "tombstone";
  readonly entityId: string;
  readonly entityType: "proposal" | "asset" | "observation" | "fragment";
  readonly reason: string;
};

export type RecordMethodFieldingCommand = CommandBase & {
  readonly type: "record_method_fielding";
  readonly exposureId: string;
  readonly versionId: string;
  readonly proposalId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly requestId: string;
  readonly scope: string;
  readonly binding?: import("../agent/subsystems/method/domain/exposure-binding.js").ExperienceExposureBinding;
};

export type RecordMethodFeedbackCommand = CommandBase & {
  readonly type: "record_method_feedback";
  readonly versionId: string;
  readonly turnId: string;
  readonly helped: boolean;
  readonly exposureId?: string;
  readonly providerAttemptId?: string;
  readonly sourceEventId?: string;
  readonly observation?: import("../agent/subsystems/method/domain/inference.js").MethodObservation;
};

export type SetMethodRetentionCommand = CommandBase & {
  readonly type: "set_method_retention";
  readonly record: MethodRetention;
};

export type RecordRewardExposureCommand = CommandBase & {
  readonly type: "record_reward_exposure";
  readonly exposure: RewardExposureDraft;
};

export type RecordRewardFeedbackCommand = CommandBase & {
  readonly type: "record_reward_feedback";
  readonly feedback: RewardFeedback;
};

export type RecordRewardV2FactCommand = CommandBase & {
  readonly type: 'record_reward_v2_fact'; readonly expectedSequence: number;
  readonly fact: import('../reward/v2-facts.js').RewardV2Draft;
};

export type RecordCollaborationV2Command = CommandBase & { readonly type: "record_collaboration_v2";
  readonly fact: import("../domains/collaboration/v2-contracts.js").CollaborationV2Fact; readonly expectedCycleFactId?: string };

export type RecordLearningGrantFactCommand = CommandBase & { readonly type: "record_learning_grant_fact";
  readonly fact: import("./grant-contract.js").LearningGrantDraft };

export type BoardCommand =
  | (CommandBase & { readonly type: "record_method_experience"; readonly fact: import("../agent/subsystems/method/domain/experience-facts.js").MethodExperienceFact })
  | (CommandBase & { readonly type: "record_collaboration_runtime"; readonly receipt: import("../../protocol/collaboration-resource.js").CollaborationRuntimeReceipt })
  | import("./coordination-contract.js").CoordinateLearningCommand
  | RecordLearningGrantFactCommand
  | (CommandBase & { readonly type: "compact_collaboration_v2"; readonly scope: string; readonly expectedSequence: number })
  | (CommandBase & { readonly type: "rehydrate_collaboration_v2"; readonly scope: string; readonly records: readonly RecordCollaborationV2Command[] })
  | RecordCollaborationV2Command
  | (CommandBase & { readonly type: "record_collaboration_fact"; readonly fact: import("../domains/collaboration/contracts.js").CollaborationFact })
  | (CommandBase & { readonly type: "record_tool_use"; readonly record: ToolUseRecord })
  | RecordRewardV2FactCommand
  | (CommandBase & { readonly type: "record_tool_trial"; readonly record: ToolTrialRecord })
  | RecordRewardExposureCommand
  | RecordRewardFeedbackCommand
  | SubmitProposalCommand
  | QuarantineCommand
  | StartEvaluationCommand
  | RecordEvidenceCommand
  | EnterShadowCommand
  | RequestApprovalCommand
  | RecordApprovalDecisionCommand
  | ActivateCommand
  | RejectCommand
  | FastLaneValidateCommand
  | CommitAssetCommand
  | SuspendCommand
  | ResumeCommand
  | RollbackCommand
  | RetireCommand
  | EnqueueJobCommand
  | StartJobCommand
  | RequeueJobCommand
  | CompleteJobCommand
  | FailJobCommand
  | TombstoneCommand
  | RecordMethodFieldingCommand
  | RecordMethodFeedbackCommand
  | SetMethodRetentionCommand;

export type CommandType = BoardCommand["type"];
