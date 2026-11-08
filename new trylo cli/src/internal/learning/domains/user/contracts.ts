/**
 * 用户学习深链的权威域契约（纯域层，无落盘、无注入、无执行绑定）。
 *
 * 只回答"是什么"，不回答"怎么做"：每个契约都是不可变快照，
 * 由唯一 writer 函数创建（见同目录各模块），其他模块只读。
 * 链：Evidence → Eligibility → Conclusion → UserModel →
 * BehaviorCommitment → PolicyBundle → Receipt → Outcome。
 */

export const ELIGIBILITY_CLASSES = [
  "personalization_candidate",
  "session_instruction",
  "general_quality_defect",
  "authorization_or_permission",
  "insufficient_information",
] as const;

export type EligibilityClass = (typeof ELIGIBILITY_CLASSES)[number];

/** 资格闸之后"该去哪"：只有 personalization_chain 进 user_rule 深链。 */
export const ELIGIBILITY_ROUTES = [
  "personalization_chain",
  "session_intent",
  "quality_repair",
  "permission_service",
  "drop_insufficient",
] as const;

export type EligibilityRoute = (typeof ELIGIBILITY_ROUTES)[number];

export function routeForClass(classification: EligibilityClass): EligibilityRoute {
  switch (classification) {
    case "personalization_candidate":
      return "personalization_chain";
    case "session_instruction":
      return "session_intent";
    case "general_quality_defect":
      return "quality_repair";
    case "authorization_or_permission":
      return "permission_service";
    case "insufficient_information":
      return "drop_insufficient";
  }
}

export type EvidenceDurability =
  | "task_local"
  | "session_local"
  | "long_term_candidate"
  | "authoritative_long_term";

export type UserSignalKind =
  | "task_requirement"
  | "task_override"
  | "collaboration_preference"
  | "correction"
  | "cognition_answer"
  | "impact_resolution";

export const EVIDENCE_EVENT_KINDS = [
  "explicit_statement",
  "correction",
  "choice",
  "approval",
  "rejection",
  "override",
  "intervention",
] as const;

export type EvidenceEventKind = (typeof EVIDENCE_EVENT_KINDS)[number];

export const INFORMEDNESS_STAGES = [
  "pre_task",
  "in_task",
  "post_execution",
  "post_outcome",
  "unknown",
] as const;

export type InformednessStage = (typeof INFORMEDNESS_STAGES)[number];

export const SCOPE_NARROWNESS = ["narrow", "medium", "broad"] as const;

export type ScopeNarrowness = (typeof SCOPE_NARROWNESS)[number];

/**
 * 总纲领 §3.4 的"五问"：每项独立可答（null = 本次答不上来，不许用别项代替）。
 * semantic：表达是否就是所记之意；relevance：对以后工程的价值；
 * contextInformedness：反馈时是否已看到真实结果；governance：治理强度；
 * scopeNarrowness：scope 有多窄。
 */
export type EvidenceFiveQuestions = {
  readonly semantic: number | null;
  readonly relevance: number | null;
  readonly contextInformedness: InformednessStage | null;
  readonly governance: 1 | 2 | 3 | 4 | null;
  readonly scopeNarrowness: ScopeNarrowness | null;
};

export function unansweredFiveQuestions(): EvidenceFiveQuestions {
  return {
    semantic: null,
    relevance: null,
    contextInformedness: null,
    governance: null,
    scopeNarrowness: null,
  };
}

export type EvidenceSourceFacts = {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly turnId?: string;
  readonly actionId?: string;
  readonly traceId?: string;
  /**
   * 证据**产生时**所在的工作区身份（E0M1 P1-1）。
   *
   * 用户账本是单一物理文件、不按 workspace 分键，所以「这条证据属于哪个工作区」必须
   * 写在证据自己身上，而不是读出来时用当前运行时的 workspace 重新盖戳——后者会让
   * 工作区 A 的偏好被建模成工作区 B 的（外部复核实测的跨 scope 串用）。
   *
   * 可选：M1 之前的旧证据没有它。缺省**不等于**「属于当前工作区」，而是「来源未知」，
   * 合成时按隔离处理、永不提升到当前 scope（见 `integration/user-learning/chain.ts`）。
   */
  readonly workspaceId?: string;
};

export type UserEvidence = {
  readonly id: string;
  /** 原文快照：逐字保存，永不与推断合并。 */
  readonly rawText: string;
  /** 推断：对原文的解读，可为空；为空时本条证据不可用。 */
  readonly claim: string | null;
  readonly eventKind: EvidenceEventKind;
  readonly durability: EvidenceDurability;
  readonly signalKind: UserSignalKind;
  readonly answers: EvidenceFiveQuestions;
  readonly source: EvidenceSourceFacts;
  readonly sourceHash: string;
  readonly textHash: string;
  readonly createdAt: number;
};

export type EligibilityDecision = {
  readonly id: string;
  readonly sourceEvidenceIds: readonly string[];
  readonly classification: EligibilityClass;
  readonly route: EligibilityRoute;
  readonly rationale: string;
  readonly alternativeExplanations: readonly string[];
  readonly createdAt: number;
};

export const POLICY_DIMENSIONS = [
  "reporting_information_density",
  "work_artifact_workflow",
  "verification_audit",
  "planning_direct_execution",
  "architecture_refactor",
  "agent_autonomy",
] as const;

export type PolicyDimension = (typeof POLICY_DIMENSIONS)[number];

export const EVIDENCE_RELATION_TYPES = [
  "supports",
  "contradicts",
  "refines_scope",
  "explains",
  "conditions",
  "co_occurs",
  "same_underlying_pattern",
  "temporal_supersedes",
] as const;

export type EvidenceRelationType = (typeof EVIDENCE_RELATION_TYPES)[number];

export type EvidenceRelation = {
  readonly id: string;
  readonly userId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly type: EvidenceRelationType;
  readonly explanation: string;
  readonly createdAt: number;
};

export type ConclusionRecord = {
  readonly id: string;
  readonly userId: string;
  readonly statement: string;
  readonly dimension: PolicyDimension;
  readonly scopeFingerprint: string;
  readonly supporting: readonly string[];
  readonly counter: readonly string[];
  readonly contextual: readonly string[];
  readonly strength: number;
  readonly temporalState: "emerging" | "stable" | "drifting" | "disputed";
  readonly status: "active" | "superseded" | "retired";
  readonly version: number;
  readonly supersedes?: string;
  readonly stableKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type InferenceDistance = "D0" | "D1" | "D2" | "D3";

export type ConfidenceBand = "low" | "medium" | "high";

export type ConfidenceScore = {
  readonly score: number;
  readonly band: ConfidenceBand;
};

export type EffectivenessState = "unknown" | "helpful" | "harmful" | "mixed";

export type ConfirmationState =
  | "unconfirmed"
  | "user_confirmed"
  | "cognition_confirmed"
  | "behavior_confirmed";

/**
 * 总纲领 §3.6：四分置信分别保存，禁止共用一个 confidence。
 * truth：来源可信；scope：作用范围判断；effectiveness：实际是否有益
 * （默认 unknown，只有明确反馈才能离开 unknown）；
 * confirmation：是否被确认。D3 永不持久化（由 user-model.ts 强制）。
 */
export type UserModelRecord = {
  readonly id: string;
  readonly userId: string;
  readonly statement: string;
  readonly dimension: PolicyDimension;
  readonly scopeFingerprint: string;
  readonly truth: ConfidenceScore;
  readonly scope: ConfidenceScore;
  readonly effectiveness: EffectivenessState;
  readonly confirmation: ConfirmationState;
  readonly distance: Exclude<InferenceDistance, "D3">;
  readonly alternativeExplanations: readonly string[];
  readonly derivedFromConclusionIds: readonly string[];
  readonly counterevidence: readonly string[];
  readonly status: "active" | "disputed" | "superseded" | "retired";
  readonly version: number;
  readonly supersedes?: string;
  readonly stableKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type BehaviorDelta = {
  readonly decisionPoint: string;
  readonly baselineBehavior: string;
  readonly adaptedBehavior: string;
  readonly expectedBenefit: string;
  readonly rollbackBehavior: string;
};

export const COMMITMENT_STATES = [
  "candidate",
  "trial",
  "shadow",
  "active",
  "paused",
  "retracted",
  "superseded",
] as const;

export type CommitmentState = (typeof COMMITMENT_STATES)[number];

export type BehaviorCommitment = {
  readonly id: string;
  readonly userModelId: string;
  readonly scopeFingerprint: string;
  readonly conditions: readonly string[];
  readonly behaviorDelta: BehaviorDelta;
  readonly state: CommitmentState;
  readonly provenanceEvidenceIds: readonly string[];
  readonly activation: "explicit" | "confirmed_inference" | "time_bounded_trial";
  readonly stableKey: string;
  readonly version: number;
  readonly supersedes?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export const RECEIPT_REASONS = [
  "created",
  "behavior_changed",
  "scope_changed",
  "trial_started",
  "paused",
  "retracted",
] as const;

export type ReceiptReason = (typeof RECEIPT_REASONS)[number];

export type LearningReceipt = {
  readonly id: string;
  readonly commitmentId: string;
  readonly commitmentVersion: number;
  readonly dedupeKey: string;
  readonly reason: ReceiptReason;
  readonly scopeLabel: string;
  readonly effectSummary: string;
  /** 撤销行为：收据必须给出可逆出口。 */
  readonly revokeActions: readonly ("this_time_only" | "change_scope" | "pause" | "retract")[];
  readonly message: string;
  readonly createdAt: number;
};

export type CompiledPolicyRule = {
  readonly id: string;
  readonly bundleId: string;
  readonly domain: PolicyDimension;
  readonly kind: "prompt_directive";
  readonly strength: "hard" | "strong_default" | "soft" | "advisory";
  /** explicit = 用户原话可溯；inferred = 链上推断，永不冒充用户要求。 */
  readonly originMark: "explicit" | "inferred";
  readonly instruction: string;
  readonly sourceUserModelIds: readonly string[];
  readonly sourceConclusionIds: readonly string[];
  readonly sourceEvidenceIds: readonly string[];
  readonly sourceCommitmentIds: readonly string[];
  readonly status: "active";
  readonly version: number;
  readonly createdAt: number;
};

/**
 * 不可变政策包：只有编译（compile），没有渲染/注入。
 * 任何"应用"语义（render / resolve-at-run / 注入 promptMessages）都不在这里。
 */
export type ImmutablePolicyBundle = {
  readonly id: string;
  readonly userId: string;
  readonly ruleIds: readonly string[];
  readonly checksum: string;
  readonly version: number;
  readonly previousBundleId?: string;
  readonly status: "active" | "shadow" | "retired";
  readonly createdAt: number;
};

/** current pointer 与包内容分离：切换是原子替换，不原地修改任何包。 */
export type BundlePointerState = {
  readonly currentBundleId?: string;
  readonly bundles: readonly ImmutablePolicyBundle[];
};

export const OUTCOME_SIGNALS = [
  "explicit_helpful",
  "explicit_unhelpful",
  "repeated_correction",
  "material_rework",
  "rollback",
  "task_completed",
] as const;

export type OutcomeSignal = (typeof OUTCOME_SIGNALS)[number];

export type OutcomeObservation = {
  readonly id: string;
  readonly commitmentId: string;
  readonly traceId?: string;
  readonly signal: OutcomeSignal;
  readonly attribution: "direct" | "partial" | "unknown";
  readonly createdAt: number;
};
