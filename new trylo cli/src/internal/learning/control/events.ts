import type { ReasonCode } from "./reasons.js";
import type { BoardCommand } from "./commands.js";
import type { RewardExposure, RewardFeedback } from "../reward/contracts.js";
import type { ToolTrialRecord } from "../agent/subsystems/tool/domain/evolution/trial.js";
import type { ToolUseRecord } from "../agent/subsystems/tool/domain/evolution/use.js";
import type {
  ActivationRecord,
  ApprovalRequest,
  EvidenceBundle,
  LearningAssetVersion,
  LearningJob,
  LearningProposal,
  MethodFeedback,
  MethodFielding,
  MethodRetention,
  Tombstone,
} from "./contracts.js";

type EventBase = {
  readonly sequence: number;
  readonly commandId: string;
  readonly occurredAt: string;
};

export type ProposalSubmittedEvent = EventBase & {
  readonly type: "proposal_submitted";
  readonly proposal: LearningProposal;
};

export type ProposalTransitionedEvent = EventBase & {
  readonly type: "proposal_transitioned";
  readonly proposalId: string;
  readonly from: LearningProposal["lifecycle"];
  readonly to: LearningProposal["lifecycle"];
};

export type EvidenceRecordedEvent = EventBase & {
  readonly type: "evidence_recorded";
  readonly evidence: EvidenceBundle;
};

export type AssetCommittedEvent = EventBase & {
  readonly type: "asset_committed";
  readonly asset: LearningAssetVersion;
};

export type ActivationChangedEvent = EventBase & {
  readonly type: "activation_changed";
  readonly activation: ActivationRecord;
};

export type ApprovalChangedEvent = EventBase & {
  readonly type: "approval_changed";
  readonly approval: ApprovalRequest;
};

export type JobChangedEvent = EventBase & {
  readonly type: "job_changed";
  readonly job: LearningJob;
};

export type TombstoneWrittenEvent = EventBase & {
  readonly type: "tombstone_written";
  readonly tombstone: Tombstone;
};

export type CommandRejectedEvent = EventBase & {
  readonly type: "command_rejected";
  readonly reason: ReasonCode;
  readonly commandType: BoardCommand["type"];
};

export type MethodFieldingRecordedEvent = EventBase & {
  readonly type: "method_fielding_recorded";
  readonly fielding: MethodFielding;
};

export type MethodFeedbackRecordedEvent = EventBase & {
  readonly type: "method_feedback_recorded";
  readonly feedback: MethodFeedback;
};

export type MethodRetentionChangedEvent = EventBase & {
  readonly type: "method_retention_changed";
  readonly record: MethodRetention;
};

export type BoardEvent =
  | (EventBase & { readonly type: "method_experience_recorded"; readonly fact: import("../agent/subsystems/method/domain/experience-facts.js").MethodExperienceFact })
  | (EventBase & { readonly type: "collaboration_runtime_recorded"; readonly receipt: import("../../protocol/collaboration-resource.js").CollaborationRuntimeReceipt })
  | (EventBase & { readonly type: "learning_coordination_changed";
      readonly budget?: import("./central-budget-contract.js").CentralLearningBudget;
      readonly issue?: import("./coordination-contract.js").LearningIssue;
      readonly grant?: import("./coordination-contract.js").CentralLearningGrant;
      readonly dependencies?: readonly import("./coordination-contract.js").LearningDependency[];
      readonly job?: LearningJob })
  | (EventBase & { readonly type: "learning_grant_fact_recorded"; readonly fact: import("./grant-contract.js").LearningGrantFact })
  | (EventBase & { readonly type: "collaboration_v2_compacted"; readonly archive: import("../domains/collaboration/v2-contracts.js").CollaborationArchiveV2;
      readonly archivedFacts: readonly import("../domains/collaboration/v2-contracts.js").CollaborationV2Fact[] })
  | (EventBase & { readonly type: "collaboration_v2_rehydrated"; readonly scope: string; readonly factIds: readonly string[] })
  | (EventBase & { readonly type: "collaboration_v2_recorded"; readonly fact: import("../domains/collaboration/v2-contracts.js").CollaborationV2Fact })
  | (EventBase & { readonly type: "collaboration_fact_recorded"; readonly fact: import("../domains/collaboration/contracts.js").CollaborationFact })
  | (EventBase & { readonly type: "tool_use_recorded"; readonly record: ToolUseRecord })
  | (EventBase & { readonly type: 'reward_v2_fact_recorded'; readonly fact: import('../reward/v2-facts.js').RewardV2Fact })
  | (EventBase & { readonly type: "tool_trial_recorded"; readonly record: ToolTrialRecord })
  | (EventBase & { readonly type: "reward_exposure_recorded"; readonly exposure: RewardExposure })
  | (EventBase & { readonly type: "reward_feedback_recorded"; readonly feedback: RewardFeedback })
  | ProposalSubmittedEvent
  | ProposalTransitionedEvent
  | EvidenceRecordedEvent
  | AssetCommittedEvent
  | ActivationChangedEvent
  | ApprovalChangedEvent
  | JobChangedEvent
  | TombstoneWrittenEvent
  | MethodFieldingRecordedEvent
  | MethodFeedbackRecordedEvent
  | MethodRetentionChangedEvent
  | CommandRejectedEvent;
