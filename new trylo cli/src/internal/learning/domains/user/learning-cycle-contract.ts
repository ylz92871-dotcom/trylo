import type { CompiledPolicyRule, ConclusionRecord, EligibilityDecision, UserModelRecord } from "./contracts.js";

/** Peer User owns these records. Central receives references and public progress, never this private body. */
export type LearnedUserRule = {
  readonly rule: CompiledPolicyRule;
  readonly includeTerms: readonly string[];
  readonly excludeTerms: readonly string[];
  readonly applicability: string;
};

export type UserLearningVersion = {
  readonly schemaVersion: 1;
  readonly versionId: string;
  readonly availability?: "candidate" | "ready";
  readonly previousVersionId?: string;
  readonly questionRef: string;
  readonly sourcePrefixRef: string;
  readonly scopeFingerprint: string;
  readonly evidenceIds: readonly string[];
  readonly eligibility: readonly EligibilityDecision[];
  readonly conclusions: readonly ConclusionRecord[];
  readonly models: readonly UserModelRecord[];
  readonly policies: readonly LearnedUserRule[];
  readonly revisions?: readonly { readonly ruleId: string; readonly action: "pause" | "replace";
    readonly evidenceId: string; readonly quote: string; readonly reason: string }[];
  readonly bundleChecksum: string;
  readonly at: number;
};

export type UserLearningProgress = {
  readonly schemaVersion: 1;
  readonly questionRef: string;
  readonly sourcePrefixRef: string;
  readonly scopeFingerprint: string;
  readonly step: number;
  readonly consumedEvidenceIds?: readonly string[];
  readonly committedReservationIds?: readonly string[];
  readonly workRef?: string;
  readonly state: "continue" | "clarification" | "completed" | "no_result" | "unknown";
  /** Public work product, not hidden reasoning. Kept private to the User domain. */
  readonly understanding: string;
  readonly remaining: string;
  readonly nextAction: string;
  readonly clarification?: string;
  readonly versionId?: string;
  readonly at: number;
};

export type UserPolicyFielding = {
  readonly receiptId: string;
  readonly versionId: string;
  readonly scopeFingerprint: string;
  readonly ruleIds: readonly string[];
  readonly attemptId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly at: number;
};

export type UserPolicyFeedback = {
  readonly feedbackId: string;
  readonly sourceEventId: string;
  readonly sourceEvidenceId?: string;
  readonly receiptId: string;
  readonly versionId: string;
  readonly scopeFingerprint: string;
  readonly ruleIds: readonly string[];
  readonly signal: "explicit_helpful" | "explicit_unhelpful" | "correction" | "rollback";
  readonly disposition: "observe" | "pause";
  readonly at: number;
};

export type UserCycleRecord =
  | { readonly record: "learning_version"; readonly version: UserLearningVersion }
  | { readonly record: "learning_progress"; readonly progress: UserLearningProgress }
  | { readonly record: "policy_fielding"; readonly fielding: UserPolicyFielding }
  | { readonly record: "policy_feedback"; readonly feedback: UserPolicyFeedback };

/** A signal addresses an original User source prefix; it is neither an Agent domain nor a team issue. */
export type UserLearningSignal = {
  readonly operationRef?: string;
  /** Explicit research may reconsider a completed inference on unchanged evidence. */
  readonly reconsiderVersionRef?: string;
  readonly questionRef: string;
  readonly sourcePrefixRef: string;
  readonly purpose: string;
  readonly maxTokensPerCall: number;
  readonly maxTotalTokens?: number;
  readonly maxPromptChars?: number;
  readonly maxCalls: number;
};

export type UserPeerProgress = {
  readonly owner: "user_learning";
  readonly questionRef: string;
  readonly sourcePrefixRef: string;
  readonly state: "progress" | "waiting" | "result" | "unavailable";
  readonly reason: string;
  readonly versionRefs: readonly string[];
  readonly progressRef?: string;
  readonly outcome?: "unknown";
  readonly waitFor?: "budget" | "resources" | "dependency" | "user_clarification" | "source_change" | "recovery";
  readonly waitRefs?: readonly string[];
  readonly clarificationRef?: string;
};
