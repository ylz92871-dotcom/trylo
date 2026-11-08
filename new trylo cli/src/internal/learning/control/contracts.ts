import { isExposureBinding } from "../agent/subsystems/method/domain/exposure-binding.js";

export const ASSET_KINDS = [
  "user_rule",
  "prompt_patch",
  "skill",
  "workflow",
  "tool_binding",
  "tool_package",
  "verification_recipe",
  "routing_policy",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export const LEARNING_DOMAINS = [
  "collaboration",
  "user",
  "prompt",
  "skill",
  "workflow",
  "tool",
  "verifier",
  "routing",
  "compound",
] as const;

export type LearningDomain = (typeof LEARNING_DOMAINS)[number];

export const PROPOSAL_SOURCES = ["user_explicit", "inferred"] as const;

export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

export const PROPOSAL_LIFECYCLES = [
  "draft",
  "quarantined",
  "evaluating",
  "shadow",
  "awaiting_approval",
  "validated",
  "active",
  "rejected",
  "suspended",
  "rolled_back",
  "retired",
] as const;

export type ProposalLifecycle = (typeof PROPOSAL_LIFECYCLES)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export const EVIDENCE_KINDS = [
  "external_verifier",
  "user_feedback",
  "execution_fact",
  "llm_critique",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EXTERNAL_VERDICTS = ["pass", "fail", "partial"] as const;

export type ExternalVerdict = (typeof EXTERNAL_VERDICTS)[number];

export const TURN_OUTCOMES = ["completed", "failed", "cancelled", "unknown"] as const;

export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const PRIVACY_CLASSES = ["redacted", "summary", "tombstone"] as const;

export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

export const ACTIVATION_POINTERS = [
  "active",
  "shadow",
  "suspended",
  "rolled_back",
  "retired",
] as const;

export type ActivationPointer = (typeof ACTIVATION_POINTERS)[number];

export const APPROVAL_ACTIONS = [
  "download",
  "install",
  "switch",
  "modify",
  "broad_enable",
  "upstream_submit",
  "activate",
] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const APPROVAL_STATUSES = ["pending", "granted", "denied", "revoked"] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const JOB_STATES = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_evidence",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const LEARNING_MODES = ["full", "last_known_good", "no_learning"] as const;

export type LearningMode = (typeof LEARNING_MODES)[number];

export type LearningObservation = {
  readonly observationId: string;
  readonly scope: string;
  readonly taskFamily: string;
  readonly snapshotRef?: string;
  readonly assetRefs: Readonly<Record<string, string>>;
  readonly outcome: TurnOutcome;
  readonly verdict?: ExternalVerdict;
  readonly tokenCost?: number;
  readonly latencyMs?: number;
  readonly causalRefs: ReadonlyArray<string>;
  readonly privacyClass: PrivacyClass;
  readonly occurredAt: string;
  readonly boardSequence?: number;
  readonly reason?: string;
  readonly inputRef?: string;
};

export type LearningProposal = {
  readonly proposalId: string;
  readonly domain: LearningDomain;
  readonly scope: string;
  readonly assetKind: AssetKind;
  readonly baseVersionId?: string;
  readonly candidateRef: string;
  readonly hypothesis: string;
  readonly observationRefs: ReadonlyArray<string>;
  readonly risk: RiskLevel;
  readonly requiredVerifiers: ReadonlyArray<string>;
  readonly requestedAuthorities: ReadonlyArray<string>;
  readonly source: ProposalSource;
  readonly lifecycle: ProposalLifecycle;
  readonly compoundChildIds?: ReadonlyArray<string>;
};

export type EvidenceDelta = {
  readonly metric: string;
  readonly baseline: number;
  readonly candidate: number;
};

/**
 * Board 侧对一条独立证据的**可追溯**引用（WP-F §7 D3.5）。
 *
 * Board reducer 保持纯函数，不持有 registry 端口；它只要求任何携带
 * external_verifier / user_feedback 权力的证据都必须能回查到一条权威收据。
 * 因此这里的字段是「审计坐标」而不是「权威判定」：判定发生在
 * `integration/contract/gateway.ts` 读回 registry 的那一刻，而 Board 只保证
 * 每次晋升都能被事后回查（收据缺失或不一致即可被独立审计发现）。
 */
export type EvidenceReceiptRef = {
  readonly receiptId: string;
  readonly checksDigest: string;
  readonly sourceDigest: string;
};

export type EvidenceBundle = {
  readonly evidenceId: string;
  readonly proposalId: string;
  readonly kinds: ReadonlyArray<EvidenceKind>;
  readonly baselineRef?: string;
  readonly candidateRef?: string;
  readonly dataVersion: string;
  readonly delta?: EvidenceDelta;
  readonly failureSamples: ReadonlyArray<string>;
  readonly provenance: string;
  readonly externalVerdict?: ExternalVerdict;
  /** 独立证据必须携带；llm_critique 单独成证时可以为空。 */
  readonly receipt?: EvidenceReceiptRef;
};

export type LearningAssetVersion = {
  readonly versionId: string;
  readonly kind: AssetKind;
  readonly schemaVersion: number;
  readonly content: unknown;
  readonly contentHash: string;
  readonly source: ProposalSource;
  readonly scope: string;
  readonly parentVersionId?: string;
  readonly createdAt: string;
  readonly createdFromProposalId?: string;
};

export type BreakerState = {
  readonly open: boolean;
  readonly reason: string;
  readonly consecutiveFailures: number;
};

export type ActivationRecord = {
  readonly activationId: string;
  readonly scope: string;
  readonly assetKind: AssetKind;
  readonly pointer: ActivationPointer;
  readonly versionId: string;
  readonly previousVersionId?: string;
  readonly boardSequence: number;
  readonly generation: number;
  readonly approvalRef?: string;
  readonly breaker?: BreakerState;
  readonly rollbackReason?: string;
};

export type ApprovalRequest = {
  readonly approvalId: string;
  readonly proposalId: string;
  readonly action: ApprovalAction;
  readonly status: ApprovalStatus;
  readonly requestedAuthorities: ReadonlyArray<string>;
};

export type LearningJob = {
  readonly jobId: string;
  readonly observationId: string;
  readonly domain: LearningDomain;
  readonly scope: string;
  readonly state: JobState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly breakerOpen: boolean;
  readonly dedupeKey: string;
  /** Centrally funded domain work; generic job commands cannot bypass its claim or budget. */
  readonly coordination?: { readonly issueId: string; readonly grantId: string; readonly resultRefs?: readonly string[] };
};

export type Tombstone = {
  readonly entityId: string;
  readonly entityType: "proposal" | "asset" | "observation" | "fragment";
  readonly boardSequence: number;
  readonly reason: string;
};

/**
 * 方法上场记录（M1，D-M1）。
 *
 * 一次真实发送边界固定的上场机会：`exposureId` 唯一标识一次展示，
 * 同一 `(turnId, versionId)` 去重计数时只算一次（`fieldedCount`），
 * `requestId` 明细保留用于排障。未知送达不算帮助证据（见反馈）。
 */
export type MethodLayer = "working" | "middle" | "stable";

export type MethodRetention = {
  readonly versionId: string;
  readonly layer: MethodLayer;
  readonly retention: "retained" | "evicted";
  readonly recordedAt: string;
};

export function isMethodRetention(value: unknown): value is MethodRetention {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.versionId === "string" && item.versionId.length > 0 && typeof item.recordedAt === "string" &&
    Number.isFinite(Date.parse(item.recordedAt)) &&
    (item.layer === "working" || item.layer === "middle" || item.layer === "stable") &&
    (item.retention === "retained" || item.retention === "evicted");
}

export type MethodFielding = {
  readonly useSequence?: number;
  readonly exposureId: string;
  readonly versionId: string;
  readonly proposalId: string;
  readonly turnId: string;
  readonly beat: number;
  readonly requestId: string;
  readonly scope: string;
  readonly binding?: import("../agent/subsystems/method/domain/exposure-binding.js").ExperienceExposureBinding;
  readonly recordedAt: string;
};

/**
 * 方法帮助反馈（M1，D-M1）。
 *
 * 只接受该轮实际展示过的版本（成员检查由写口承担，reducer 只做形状守卫）；
 * `helped` 明确 true 才算帮助，缺失保持 unknown（M2 消费，不在本包沉降）。
 */
export type MethodFeedback = {
  readonly feedbackSequence?: number;
  readonly versionId: string;
  readonly turnId: string;
  readonly helped: boolean;
  readonly exposureId?: string;
  readonly providerAttemptId?: string;
  readonly sourceEventId?: string;
  readonly recordedAt: string;
  readonly observation?: import("../agent/subsystems/method/domain/inference.js").MethodObservation;
};

const ASSET_KIND_SET: ReadonlySet<string> = new Set(ASSET_KINDS);

export function isAssetKind(value: string): value is AssetKind {
  return ASSET_KIND_SET.has(value);
}

/**
 * 快照解码守卫（E0M1 P2-4）。
 *
 * 持久读边界**绝不** blind cast：快照里的 `fieldings`/`feedbacks` 元素必须逐字段
 * 通过这两个守卫，否则整张快照按损坏处理（`normalizeBoardState` 返回 `undefined`，
 * 调用方回退到日志重放——日志才是权威，重放会从真实命令重建这两本账，自愈）。
 *
 * 守卫只校验**结构**（类型/必填/正整数 beat），不重复 reducer 的写入策略；它的职责
 * 是「present-but-illegal 元素绝不被断言为合法」，而不是再判一次业务规则。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isMethodFielding(value: unknown): value is MethodFielding {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const item = value as Record<string, unknown>;

  return (
    isNonEmptyString(item.exposureId) &&
    isNonEmptyString(item.versionId) &&
    isNonEmptyString(item.proposalId) &&
    isNonEmptyString(item.turnId) &&
    typeof item.beat === "number" &&
    Number.isInteger(item.beat) &&
    item.beat > 0 &&
    (item.useSequence === undefined || typeof item.useSequence === "number" && Number.isSafeInteger(item.useSequence) && item.useSequence > 0) &&
    isNonEmptyString(item.requestId) &&
    isNonEmptyString(item.scope) &&
    (item.binding === undefined || isExposureBinding(item.binding) && item.binding.context.taskId === item.turnId) &&
    isNonEmptyString(item.recordedAt)
  );
}

export function isMethodFeedback(value: unknown): value is MethodFeedback {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const item = value as Record<string, unknown>;

  return (
    isNonEmptyString(item.versionId) &&
    isNonEmptyString(item.turnId) &&
    typeof item.helped === "boolean" &&
    isOptionalString(item.exposureId) &&
    isOptionalString(item.providerAttemptId) &&
    isOptionalString(item.sourceEventId) &&
    isNonEmptyString(item.recordedAt)
  );
}

export function activationKey(scope: string, assetKind: AssetKind): string {
  return `${scope}\u0000${assetKind}`;
}

export function isBroadScope(scope: string): boolean {
  const normalized = scope.trim().toLowerCase();
  return normalized === "global" || normalized === "*" || normalized === "broad";
}
