import type { CollaborationBoardPort } from "./contracts.js";

export const COLLABORATION_DIMENSIONS = ["decomposition", "assignment", "handoff", "synchronization", "information_sharing", "review", "waiting", "rework"] as const;

export type CollaborationDimension = typeof COLLABORATION_DIMENSIONS[number];

export type CollaborationAudience = "parent" | "member";

export type CollaborationCause = "capability_gap" | "task_difficulty" | "coordination" | "unknown";

export type CollaborationV2Context = {
  readonly scope: string;
  readonly teamRunId: string;
  readonly taskId: string;
  readonly round: number;
  readonly memberId: string;
  readonly role: string;
  readonly taskFamily: string;
  readonly dependency: "artifact" | "independent" | "unknown";
  readonly coordinationMode: "sequential" | "parallel" | "mixed" | "unknown";
  readonly difficulty: "routine" | "hard" | "unknown";
  readonly members: readonly { readonly memberId: string; readonly role: string; readonly model?: string; readonly capabilityRefs?: readonly string[] }[];
  readonly taskConditionRefs?: readonly string[];
};

type V2Base = { readonly schemaVersion: 2; readonly factId: string; readonly scope: string; readonly recordedAt: string };

/** Host-bound observations. Peer model reports remain claims, never external quality authority. */
export type CollaborationEventV2 = V2Base & {
  readonly kind: "event";
  readonly context: CollaborationV2Context;
  readonly dimension: CollaborationDimension;
  readonly action: string;
  readonly summary: string;
  readonly source: "runtime" | "peer_report" | "external_checker" | "user";
  readonly evidenceRefs: readonly string[];
  readonly causedBy: readonly string[];
  readonly metrics: { readonly waitMs?: number; readonly reworkCount?: number; readonly tokenCost?: number; readonly memberCount?: number; readonly taskCount?: number };
};

export type CollaborationMetricsV2 = {
  readonly delivery: "passed" | "failed" | "unverified";
  readonly handoffCompleteness?: number;
  readonly reworkCount?: number;
  readonly waitMs?: number;
  readonly tokenCost?: number;
};

export type CollaborationEpisodeV2 = V2Base & {
  readonly kind: "episode";
  readonly context: CollaborationV2Context;
  readonly eventIds: readonly string[];
  readonly metrics: CollaborationMetricsV2;
  readonly source: "runtime" | "peer_report" | "external_checker" | "user";
  readonly evidenceRefs: readonly string[];
};

export type CollaborationConditionV2 = {
  readonly dependency: "artifact" | "independent" | "any";
  readonly taskFamilies: readonly string[];
  readonly roles: readonly string[];
  readonly coordinationModes: readonly CollaborationV2Context["coordinationMode"][];
  readonly difficulty: readonly CollaborationV2Context["difficulty"][];
  readonly minimumMembers: number;
};

export type CollaborationActionV2 = {
  readonly actionId: string;
  readonly dimension: CollaborationDimension;
  readonly audience: CollaborationAudience;
  readonly operation: "split_task" | "assign_member" | "request_context" | "synchronize" | "share_reference" | "schedule_review" | "wait_for_dependency" | "replan";
  readonly instruction: string;
  readonly expectedObservable: string;
};

export type CollaborationPracticeDraftV2 = {
  readonly familyId: string;
  readonly title: string;
  readonly hypothesis: string;
  readonly alternatives: readonly { readonly cause: CollaborationCause; readonly explanation: string; readonly evidenceRefs: readonly string[] }[];
  readonly discriminator: { readonly observation: string; readonly distinguishes: readonly CollaborationCause[] };
  readonly conditions: CollaborationConditionV2;
  readonly actions: readonly CollaborationActionV2[];
  readonly failureConditions: readonly string[];
  readonly sourceEventIds: readonly string[];
  readonly sourceEpisodeIds: readonly string[];
  readonly sourceOutcomeIds: readonly string[];
  readonly parentVersionId?: string;
};

export type CollaborationPracticeV2 = CollaborationPracticeDraftV2 & {
  readonly schema: "collaboration-practice/v2";
  readonly status: "trial";
  readonly sourceWindowHash: string;
  readonly cycleId: string;
};

export type CollaborationExposureV2 = V2Base & {
  readonly kind: "exposure";
  readonly context: CollaborationV2Context;
  readonly selectionId: string;
  readonly versionId: string;
  readonly actionIds: readonly string[];
  readonly audience: CollaborationAudience;
  readonly requestId: string;
  readonly contentHash: string;
};

export type CollaborationAdoptionV2 = V2Base & {
  readonly kind: "adoption";
  readonly exposureId: string;
  readonly actionId: string;
  readonly eventIds: readonly string[];
};

export type CollaborationOutcomeV2 = V2Base & {
  readonly kind: "outcome";
  readonly adoptionIds: readonly string[];
  readonly episodeIds: readonly string[];
  readonly metrics: CollaborationMetricsV2;
  readonly source: "runtime" | "peer_report" | "external_checker" | "user";
  readonly evidenceRefs: readonly string[];
};

export type CollaborationCorrectionV2 = V2Base & {
  readonly kind: "correction";
  readonly familyId: string;
  readonly appliesTo: { readonly kind: "once"; readonly taskId: string }
    | { readonly kind: "class"; readonly taskFamily: string; readonly role: string }
    | { readonly kind: "workspace" };
  readonly action: "suspend" | "restore";
  readonly replacesCorrectionId?: string;
  readonly evidenceRef: string;
};

export type CollaborationGrantV2 = {
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly maxModelTokens: number;
  readonly maxPromptChars: number;
};

export type CollaborationCycleV2 = V2Base & {
  readonly kind: "cycle";
  readonly cycleId: string;
  readonly requestId: string;
  readonly phase: "running" | "reserved" | "completed" | "cancelled" | "waiting_evidence" | "failed";
  readonly step: number;
  readonly grant: CollaborationGrantV2;
  readonly spent: { readonly steps: number; readonly modelCalls: number; readonly modelTokens: number };
  readonly cursor: number;
  readonly sourceWindowHash: string;
  readonly reason?: string;
  readonly usage?: CollaborationUsageV2;
  readonly claimOwner?: string;
  readonly claimExpiresAt?: string;
  readonly pinnedFactIds?: readonly string[];
};

export type CollaborationArchiveV2 = {
  readonly schemaVersion: 1;
  readonly scope: string;
  readonly throughSequence: number;
  readonly totalFactCount: number;
  readonly archivedFactCount: number;
  readonly learningCursor: number;
  readonly archiveDigest: string;
  readonly recordedAt: string;
  readonly usage: { readonly modelCalls: number; readonly chargedTokens: number; readonly reportedTokens: number; readonly reportedCalls: number };
};

export type CollaborationArchiveQueryV2 = { readonly scope: string; readonly factIds?: readonly string[]; readonly cycleId?: string;
  readonly afterSequence?: number; readonly versionIds?: readonly string[]; readonly pending?: boolean; readonly excludeRequestIds?: readonly string[] };

export type CollaborationV2Fact = CollaborationEventV2 | CollaborationEpisodeV2 | CollaborationExposureV2 | CollaborationAdoptionV2
  | CollaborationOutcomeV2 | CollaborationCorrectionV2 | CollaborationCycleV2 | CollaborationAnalysisFactV2;

export type CollaborationEvidenceProjectionV2 = { readonly omittedEventCount: number; readonly fullEventSetHash: string };

export type CollaborationAnalysisFactV2 = V2Base & {
  readonly kind: "analysis";
  readonly cycleId: string;
  readonly step: number;
  readonly sourceWindowHash: string;
  readonly throughCursor: number;
  readonly basis: { readonly boardSequence: number; readonly eventIds: readonly string[]; readonly episodeIds: readonly string[];
    readonly outcomeIds: readonly string[]; readonly practiceVersionIds: readonly string[]; readonly exposureIds: readonly string[]; readonly adoptionIds: readonly string[];
    readonly projection?: CollaborationEvidenceProjectionV2 };
  readonly result: Awaited<ReturnType<CollaborationAnalysisPortV2["analyze"]>>;
};

export type CollaborationAnalysisWindowV2 = {
  readonly schemaVersion: 2;
  readonly scope: string;
  readonly boardSequence: number;
  readonly events: readonly CollaborationEventV2[];
  readonly episodes: readonly CollaborationEpisodeV2[];
  readonly outcomes: readonly CollaborationOutcomeV2[];
  readonly receipts?: { readonly exposures: readonly CollaborationExposureV2[]; readonly adoptions: readonly CollaborationAdoptionV2[] };
  readonly projection?: CollaborationEvidenceProjectionV2;
  readonly practices: readonly { readonly versionId: string; readonly practice: CollaborationPracticeV2 }[];
};

export type CollaborationAnalysisPortV2 = {
  readonly estimateInputTokens?: (window: CollaborationAnalysisWindowV2) => number;
  analyze(request: { readonly cycleId: string; readonly step: number; readonly window: CollaborationAnalysisWindowV2;
    readonly maxTokens: number; readonly signal: AbortSignal }): Promise<{
      readonly status: "proposed"; readonly proposals: readonly CollaborationPracticeDraftV2[]; readonly tokenCost: number; readonly usage?: CollaborationUsageV2;
    } | { readonly status: "no_change"; readonly reason: string; readonly tokenCost: number; readonly usage?: CollaborationUsageV2 }
      | { readonly status: "failed"; readonly reason: string; readonly tokenCost: number; readonly usage?: CollaborationUsageV2 }>;
};

/** tokenCost is budget charge; usage separately distinguishes measured cost from a conservative unknown reservation. */
export type CollaborationUsageV2 = { readonly status: "reported" | "reserved_unknown"; readonly elapsedMs: number;
  readonly inputTokens?: number; readonly outputTokens?: number; readonly totalTokens?: number; readonly model?: string; readonly providerId?: string };

export type CollaborationSelectionV2 = {
  readonly kind: "selected";
  readonly selectionId: string;
  readonly versionId: string;
  readonly proposalId: string;
  readonly familyId: string;
  readonly actions: readonly CollaborationActionV2[];
  readonly guidance: string;
  readonly contentHash: string;
  readonly context: CollaborationV2Context;
  readonly audience: CollaborationAudience;
} | { readonly kind: "skip"; readonly reason: string };

export type CollaborationSubsystemOptionsV2 = {
  readonly board: CollaborationBoardPort;
  readonly analyzer: CollaborationAnalysisPortV2;
  readonly now: () => string;
  readonly enabled?: () => boolean;
  /** Required for paid generation/resume; supplied uniquely by the host at each boot. Read/governance paths may omit it. */
  readonly ownerId?: string;
  readonly claimLeaseMs?: number;
};
