// Trylo User Learning v0.1 — Canonical Contract.
//
// Frozen from the core tech docs. Layers must not skip:
//   Trace → Evidence → Conclusion → Profile/UserModel → Policy → ActivePolicy
// Cognition produces Evidence only. D3 never persists. Silence ≠ approval.

export const USER_LEARNING_SCHEMA_VERSION = 3 as const;
export const LOCAL_USER_ID = 'local-user';
export const ACTIVE_POLICY_TAG = 'trylo_active_engineering_policy';
export const MAX_ACTIVE_POLICIES = 7;
export const MAX_ACTIVE_POLICY_TOKENS = 600;

export type EvidenceChannel = 'work' | 'interaction' | 'cognition';
export type EvidenceEventType =
  | 'explicit_statement'
  | 'correction'
  | 'choice'
  | 'approval'
  | 'rejection'
  | 'override'
  | 'intervention'
  | 'rollback'
  | 'manual_edit'
  | 'outcome_feedback'
  | 'cognition_answer'
  | 'cognition_confirmation'
  | 'authoritative_correction';

export type ContextStage =
  | 'abstract'
  | 'task_context'
  | 'post_plan'
  | 'post_execution'
  | 'post_outcome';

export type StrengthBand = 'weak' | 'medium' | 'strong' | 'authoritative';
export type GovernanceLevel = 1 | 2 | 3 | 4;
export type InferenceDistance = 'D0' | 'D1' | 'D2' | 'D3';
export type TranslationDistance = 'T0' | 'T1' | 'T2' | 'T3';
export type ConfidenceBand = 'low' | 'medium' | 'high';
export type RiskLevel = 'low' | 'medium' | 'high';
export type RecordStatus = 'active' | 'disputed' | 'superseded' | 'retired';
export type TemporalState = 'emerging' | 'stable' | 'drifting' | 'disputed';
export type ProductSurface = 'code' | 'work';
export type EnforcementMode = 'shadow' | 'enforced' | 'off';

export type RelationType =
  | 'supports'
  | 'contradicts'
  | 'refines_scope'
  | 'explains'
  | 'conditions'
  | 'co_occurs'
  | 'same_underlying_pattern'
  | 'temporal_supersedes';

export type PolicyDimension =
  | 'agent_autonomy'
  | 'planning_direct_execution'
  | 'engineering_depth'
  | 'architecture_refactor'
  | 'verification_audit'
  | 'git_change_management'
  | 'cost_time_quality'
  | 'interaction_interruption'
  | 'reporting_information_density'
  | 'tool_workflow'
  | 'product_ux_acceptance'
  | 'domain_capability_feedback_reliability'
  | 'engineering_language_semantics'
  | 'security_data_integrity'
  | 'work_artifact_workflow';

export const POLICY_DIMENSIONS: readonly PolicyDimension[] = [
  'agent_autonomy',
  'planning_direct_execution',
  'engineering_depth',
  'architecture_refactor',
  'verification_audit',
  'git_change_management',
  'cost_time_quality',
  'interaction_interruption',
  'reporting_information_density',
  'tool_workflow',
  'product_ux_acceptance',
  'domain_capability_feedback_reliability',
  'engineering_language_semantics',
  'security_data_integrity',
  'work_artifact_workflow',
];

export type PolicyKind =
  | 'constraint'
  | 'conditional_decision'
  | 'weighted_heuristic'
  | 'prompt_directive'
  | 'clarification_gate';

export type PolicyStrength = 'hard' | 'strong_default' | 'soft' | 'advisory';
export type PolicyEffectMode =
  | 'require'
  | 'forbid'
  | 'prefer'
  | 'avoid'
  | 'route'
  | 'ask'
  | 'defer';

export type ProfileCategory =
  | 'role_identity'
  | 'domain_industry'
  | 'capability_background'
  | 'long_term_work_context';

export type CognitionTriggerType =
  | 'high_value_gap'
  | 'significant_drift'
  | 'explicit_dissatisfaction'
  | 'scope_boundary'
  | 'model_conflict'
  | 'bootstrap_optional'
  | 'user_opened'
  | 'team_clarification'
  | 'explicit_signal';

export type CognitionDismissKind =
  | 'dismiss'
  | 'not_now'
  | 'snooze'
  | 'dont_ask_similar'
  | 'answered'
  | 'corrected';

export type ScopeLevel =
  | 'global'
  | 'product'
  | 'workspace'
  | 'project'
  | 'component'
  | 'task_category'
  | 'task';

export type EvidenceDurability =
  | 'task_local'
  | 'session_local'
  | 'long_term_candidate'
  | 'authoritative_long_term';

export type UserSignalKind =
  | 'task_requirement'
  | 'task_override'
  | 'collaboration_preference'
  | 'correction'
  | 'cognition_answer'
  | 'impact_resolution';

export interface EvidenceScope {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskCategory?: string;
  readonly component?: string;
  readonly taskStage?: string;
  readonly riskLevel?: RiskLevel;
  readonly scopeTags: readonly string[];
  readonly corePath?: boolean;
  readonly reversible?: boolean;
  readonly product?: ProductSurface;
  readonly level?: ScopeLevel;
  readonly fingerprint?: string;
}

export interface UserDecisionEvent {
  readonly id: string;
  readonly at: number;
  readonly actor: 'user' | 'agent' | 'system';
  readonly type: EvidenceEventType | 'user_message' | 'agent_decision' | 'execution_result' | 'steer' | 'stop';
  readonly stage: ContextStage;
  readonly text?: string;
  readonly structured?: Readonly<Record<string, unknown>>;
}

export interface UserDecisionTrace {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly product: ProductSurface;
  readonly codeMode?: 'chat' | 'plan' | 'agent' | 'cognition';
  readonly initialRequest: string;
  readonly agentDecisions: readonly string[];
  readonly userEvents: readonly UserDecisionEvent[];
  readonly executionResult?: string;
  readonly outcome?: 'completed' | 'failed' | 'cancelled' | 'exited';
  readonly createdAt: number;
  readonly closedAt?: number;
}

export interface EvidenceRecord {
  readonly id: string;
  readonly userId: string;
  readonly source: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly turnIds: readonly string[];
    readonly actionIds: readonly string[];
    readonly sourceHash: string;
    readonly traceId: string;
  };
  readonly origin: {
    readonly channel: EvidenceChannel;
    readonly eventType: EvidenceEventType;
    readonly stage: ContextStage;
  };
  readonly rawObservation: {
    readonly text: string;
    readonly structured?: Readonly<Record<string, unknown>>;
  };
  readonly inference: {
    readonly claim: string;
    readonly semanticConfidence: number;
    readonly engineeringRelevance: number;
  };
  readonly context: EvidenceScope;
  readonly strength: {
    readonly contextInformedness: ContextStage;
    readonly band: StrengthBand;
  };
  readonly governance: {
    readonly level: GovernanceLevel;
    readonly userLocked: boolean;
  };
  readonly durability?: EvidenceDurability;
  readonly signalKind?: UserSignalKind;
  readonly createdAt: number;
}

export interface EvidenceRelation {
  readonly id: string;
  readonly userId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly type: RelationType;
  readonly strength: number;
  readonly explanation: string;
  readonly confidence: number;
  readonly createdAt: number;
}

export interface ConclusionRecord {
  readonly id: string;
  readonly userId: string;
  readonly statement: string;
  readonly dimension: PolicyDimension;
  readonly scope: EvidenceScope;
  readonly evidence: {
    readonly supporting: readonly string[];
    readonly counter: readonly string[];
    readonly contextual: readonly string[];
  };
  readonly relations: readonly string[];
  readonly strength: {
    readonly score: number;
    readonly band: ConfidenceBand;
  };
  readonly temporal: {
    readonly firstObserved: number;
    readonly lastSupported: number;
    readonly state: TemporalState;
  };
  readonly status: RecordStatus;
  readonly version: number;
  readonly supersedes?: string;
  readonly stableKey?: string;
  readonly inputRevision?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConclusionRelation {
  readonly id: string;
  readonly userId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly type: RelationType;
  readonly explanation: string;
  readonly createdAt: number;
}

export interface ProfessionalProfileFact {
  readonly id: string;
  readonly userId: string;
  readonly category: ProfileCategory;
  readonly statement: string;
  readonly evidenceRefs: readonly string[];
  readonly confidence: { readonly score: number; readonly band: ConfidenceBand };
  readonly status: RecordStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UserModelRecord {
  readonly id: string;
  readonly userId: string;
  readonly statement: string;
  readonly dimension: PolicyDimension;
  readonly scope: EvidenceScope;
  readonly confidence: { readonly score: number; readonly band: ConfidenceBand };
  readonly inference: {
    readonly distance: Exclude<InferenceDistance, 'D3'>;
    readonly alternativeExplanations: readonly string[];
    readonly rationaleSummary: string;
  };
  readonly derivedFrom: { readonly conclusionIds: readonly string[] };
  readonly profileDependencies: readonly string[];
  readonly counterevidence: readonly string[];
  readonly status: RecordStatus;
  readonly version: number;
  readonly supersedes?: string;
  readonly stableKey?: string;
  readonly inputRevision?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UserModelDerivation {
  readonly id: string;
  readonly userId: string;
  readonly userModelId: string;
  readonly conclusionIds: readonly string[];
  readonly profileIds: readonly string[];
  readonly inferenceDistance: Exclude<InferenceDistance, 'D3'>;
  readonly rejected: boolean;
  readonly rejectReason?: string;
  readonly createdAt: number;
}

export interface ProjectContextSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly product: ProductSurface;
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly components: readonly string[];
  readonly criticalPaths: readonly string[];
  readonly git: {
    readonly branch?: string;
    readonly dirty: boolean;
    readonly rollbackAvailable: boolean;
  };
  readonly verification: {
    readonly typecheck: boolean;
    readonly unit: boolean;
    readonly integration: boolean;
    readonly e2e: boolean;
    readonly smoke: boolean;
  };
  readonly risk: {
    readonly persistentStateComponents: readonly string[];
    readonly securitySensitiveAreas: readonly string[];
    readonly dataIntegrityAreas: readonly string[];
  };
  readonly reversibility: 'high' | 'medium' | 'low';
  readonly hash: string;
  readonly discoveredFrom: readonly string[];
  readonly createdAt: number;
}

export interface TaskContext {
  readonly product: ProductSurface;
  readonly taskType: string;
  readonly risk: RiskLevel;
  readonly corePath: boolean;
  readonly reversible: boolean;
  readonly components: readonly string[];
  readonly changeType: string;
  readonly explicitInstruction: string;
  readonly prompt: string;
}

export interface PolicyCondition {
  readonly field: string;
  readonly op: 'eq' | 'neq' | 'lte' | 'gte' | 'in' | 'not_in';
  readonly value: unknown;
}

export interface PolicyRule {
  readonly id: string;
  readonly userId: string;
  readonly bundleId: string;
  readonly granularity: 'global' | 'project' | 'task';
  readonly domain: PolicyDimension;
  readonly kind: PolicyKind;
  readonly strength: PolicyStrength;
  readonly scope: {
    readonly product?: ProductSurface;
    readonly projectId?: string;
    readonly taskRisk?: readonly RiskLevel[];
    readonly changeType?: readonly string[];
    readonly coreRuntimePath?: boolean;
  };
  readonly when: readonly PolicyCondition[];
  readonly effect: {
    readonly mode: PolicyEffectMode;
    readonly action: string;
    readonly parameters?: Readonly<Record<string, unknown>>;
  };
  readonly exceptions: readonly string[];
  readonly instruction: string;
  readonly confidence: {
    readonly score: number;
    readonly band: ConfidenceBand;
    readonly userModelDistance: Exclude<InferenceDistance, 'D3'>;
    readonly translationDistance: Exclude<TranslationDistance, 'T3'>;
  };
  readonly governanceLevel: GovernanceLevel;
  readonly sourceUserModelIds: readonly string[];
  readonly sourceConclusionIds: readonly string[];
  readonly sourceEvidenceIds: readonly string[];
  readonly status: RecordStatus;
  readonly version: number;
  readonly supersedes?: string;
  readonly createdAt: number;
}

export interface PolicyBundle {
  readonly id: string;
  readonly userId: string;
  readonly projectId: string;
  readonly granularity: 'global' | 'project';
  readonly bundleVersion: number;
  readonly schemaVersion: number;
  readonly skillVersion: string;
  readonly userModelBundleVersion: number;
  readonly projectContextHash: string;
  readonly ruleIds: readonly string[];
  readonly status: 'active' | 'shadow' | 'retired';
  readonly checksum: string;
  readonly createdAt: number;
}

export interface ActivePolicyRule {
  readonly policyId: string;
  readonly domain: PolicyDimension;
  readonly mode: PolicyEffectMode;
  readonly instruction: string;
  readonly applicationScore: number;
  readonly reason: string;
}

export interface SuppressedPolicyRule {
  readonly policyId: string;
  readonly domain: PolicyDimension;
  readonly instruction: string;
  readonly reason: string;
}

export interface PolicyDecision {
  readonly id: string;
  readonly userId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly bundleVersion: number;
  readonly contextHash: string;
  readonly currentBundleId?: string;
  readonly matchedRuleIds: readonly string[];
  readonly suppressedRuleIds: readonly string[];
  readonly resolvedActions: readonly string[];
  readonly active: readonly ActivePolicyRule[];
  readonly enforced: readonly ActivePolicyRule[];
  readonly shadow: readonly ActivePolicyRule[];
  readonly off: readonly ActivePolicyRule[];
  readonly suppressed: readonly SuppressedPolicyRule[];
  readonly injectionText: string;
  readonly tokenCountEstimate: number;
  readonly clarificationRequired: boolean;
  readonly clarificationQuestion?: string;
  readonly conflicts: readonly string[];
  readonly mode: EnforcementMode;
  readonly injected: boolean;
  readonly resolveLatencyMs: number;
  readonly createdAt: number;
  readonly impactCheck?: {
    readonly triggered: boolean;
    readonly interruptUser: boolean;
    readonly reason: string;
    readonly suppressedActions: readonly string[];
    readonly baselineActions: readonly string[];
  };
}

export type PendingRunChoice = 'baseline' | 'personalization' | 'dismiss';

export interface PendingRunIntent {
  readonly id: string;
  readonly projectKey: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly userPrompt: string;
  readonly workspaceRoot: string;
  readonly product: ProductSurface;
  readonly baseSystemPrompt: string;
  readonly resolvedAttachments: readonly string[];
  readonly baselineDecision: PolicyDecision;
  readonly personalizedDecision: PolicyDecision;
  readonly expiresAt: number;
  readonly resumeCount: number;
  readonly choice?: PendingRunChoice;
  /** Parallel team-spawn fields; PendingRunChoice is NOT extended
   *  (spec §7.2) so impact-card branches stay untouched. */
  readonly teamSpawn?: import('./team-access/spawn-score').TeamSpawnDecision;
  readonly teamChoice?: import('./team-access/spawn-score').TeamPendingChoice;
  readonly status: 'pending' | 'resumed' | 'dismissed' | 'expired';
}

export interface LearningInferenceSettings {
  readonly mode: 'deterministic' | 'assisted';
  readonly enabled: boolean;
  readonly allowExecutionContext: boolean;
  readonly maxCallsPerHour: number;
  readonly maxCallsPerTrace: number;
}

export const DEFAULT_LEARNING_INFERENCE: LearningInferenceSettings = {
  mode: 'deterministic',
  enabled: false,
  allowExecutionContext: false,
  maxCallsPerHour: 12,
  maxCallsPerTrace: 0,
};

export interface CognitionQuestion {
  readonly id: string;
  readonly dimension: PolicyDimension;
  readonly trigger: CognitionTriggerType;
  readonly prompt: string;
  readonly options?: readonly string[];
  readonly scopeHint: string;
}

export interface CognitionChatMessage {
  readonly id: string;
  readonly role: 'assistant' | 'user';
  readonly text: string;
  readonly at: number;
}

export interface CognitionSession {
  readonly id: string;
  readonly userId: string;
  readonly trigger: CognitionTriggerType;
  readonly dimension: PolicyDimension;
  readonly questions: readonly CognitionQuestion[];
  readonly answers: readonly {
    readonly questionId: string;
    readonly text: string;
    readonly at: number;
  }[];
  /** Chat transcript for the fifth mode. Older sessions may omit this;
   *  the surface derives bubbles from questions/answers when empty. */
  readonly messages?: readonly CognitionChatMessage[];
  /** Human-language recap shown when the chat ends. */
  readonly recap?: string;
  readonly status: 'open' | 'resolved' | 'dismissed' | 'snoozed';
  readonly dismissKind?: CognitionDismissKind;
  readonly evidenceIds: readonly string[];
  /** True while an over-broad answer awaits a scope-confirmation turn
   *  (Skill doc §13.3). The surface shows the boundary prompt; resolving
   *  it via `confirmCognitionScope` writes a `cognition_confirmation`
   *  Evidence. When set, the session stays 'open'. */
  readonly pendingConfirmScope?: boolean;
  /** Which surface this session belongs to (TRYLO-DUAL-SURFACE-SPEC §3.4).
   *  Fifth mode is isolated PER PRODUCT so a Work interview can never write
   *  Evidence into the Code domain. Older sessions without the field (and any
   *  Code session) default to 'code'. */
  readonly product?: ProductSurface;
  readonly workspaceId?: string;
  readonly projectId?: string;
  readonly taskId?: string;
  /** The in-task conversation this card was inserted into (spec §3.2 M4).
   *  Present for in-task sessions; the fifth mode has none. Drives the
   *  per-conversation 6h card cap (`conversation:<id>` cooldown key). */
  readonly conversationId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Result of answering / confirming a cognition turn. The surface uses
 *  this to decide whether to keep the thread open. */
export interface CognitionResolution {
  readonly followUp: 'confirm_scope' | 'next' | 'done';
  readonly evidenceIds: readonly string[];
  readonly nextQuestion?: CognitionQuestion;
}

export interface CognitionCooldown {
  readonly dimension: PolicyDimension;
  readonly until: number;
  readonly reason: CognitionDismissKind | 'asked' | 'demoted';
  /** Optional scope key. Team clarifications cool down per
   *  `${contractId}:${hash}` instead of per dimension. */
  readonly key?: string;
}

/** Single proactive / in-task Cognition ask, recorded in the snapshot's
 *  `cognitionAskLog` (TRYLO-COGNITION-PROACTIVE-REDESIGN-2026-09-06 §3.1).
 *  The unique source of truth for the global proactive caps (§3.2) and the
 *  ignore-demote streak (§3.3). Only the most recent 100 are retained. */
export type CognitionAskOutcome =
  | 'pending'
  | 'answered'
  | 'dismissed'
  | 'ignored'
  | 'ignored_demoted';

export interface CognitionAskEntry {
  readonly id: string;
  readonly dimension: PolicyDimension;
  readonly conversationId?: string;
  readonly trigger: CognitionTriggerType;
  readonly askedAt: number;
  outcome: CognitionAskOutcome;
  resolvedAt?: number;
}

export interface LearningRun {
  readonly id: string;
  readonly kind:
    | 'evidence.extract'
    | 'conclusion.synthesize'
    | 'user_model.reason'
    | 'policy.compile'
    | 'policy.resolve'
    | 'cognition.answer'
    // Team access additive kinds (spec §18.1 / §22). `contract.compile`
    // records EngineeringContract compilation (failed ⇒ fallbackContract);
    // `team_translation.compile` records the per-seat Translation bundle.
    | 'contract.compile'
    | 'team_translation.compile';
  readonly status: 'ok' | 'empty' | 'failed' | 'skipped';
  readonly error?: string;
  readonly reasonCode?:
    | 'no_llm'
    | 'parse_reject'
    | 'no_user_sourced_event'
    | 'no_stable_conclusion'
    | 'idempotent'
    | 'in_flight'
    | 'disabled';
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface UserLearningSettings {
  readonly enabled: boolean;
  readonly defaultMode: EnforcementMode;
  readonly dimensionMode: Readonly<Partial<Record<PolicyDimension, EnforcementMode>>>;
  readonly cognitionEnabled: boolean;
  readonly inference?: LearningInferenceSettings;
  /** Stage II Team Access. Default false: off must be indistinguishable
   *  from today (spec §0 rule 11). migrateUserLearning whitelists it. */
  readonly teamAccessEnabled?: boolean;
  /** Foundation spec §9.4: composer gate. Effective only when
   *  `teamAccessEnabled` is also true (composerLive = A && B). */
  readonly teamComposerEnabled?: boolean;
}

export const DEFAULT_USER_LEARNING_SETTINGS: UserLearningSettings = {
  enabled: true,
  defaultMode: 'shadow',
  dimensionMode: {},
  cognitionEnabled: true,
  inference: DEFAULT_LEARNING_INFERENCE,
  teamAccessEnabled: false,
  teamComposerEnabled: false,
};

export interface LearningDiagnostics {
  readonly persistFailed?: boolean;
  readonly persistError?: string;
  readonly incompatible?: boolean;
  readonly readOnly?: boolean;
}

export interface UserLearningSnapshot {
  readonly schemaVersion: number;
  readonly userId: string;
  readonly traces: readonly UserDecisionTrace[];
  readonly evidence: readonly EvidenceRecord[];
  readonly evidenceRelations: readonly EvidenceRelation[];
  readonly conclusions: readonly ConclusionRecord[];
  readonly conclusionRelations: readonly ConclusionRelation[];
  readonly profileFacts: readonly ProfessionalProfileFact[];
  readonly userModels: readonly UserModelRecord[];
  readonly userModelDerivations: readonly UserModelDerivation[];
  readonly projectContexts: readonly ProjectContextSnapshot[];
  readonly policyRules: readonly PolicyRule[];
  readonly policyBundles: readonly PolicyBundle[];
  readonly policyDecisions: readonly PolicyDecision[];
  readonly cognitionSessions: readonly CognitionSession[];
  readonly cognitionCooldowns: readonly CognitionCooldown[];
  /** Proactive-ask ledger (§3.1), single source of truth for global caps and
   *  ignore-demote. Missing on older snapshots migrates to `[]` (fail-open). */
  readonly cognitionAskLog: readonly CognitionAskEntry[];
  readonly learningRuns: readonly LearningRun[];
  readonly dirtyDimensions: readonly PolicyDimension[];
  readonly pendingRuns?: readonly PendingRunIntent[];
  readonly currentBaseBundleId?: string;
  readonly currentProjectBundleIds?: Readonly<Record<string, string>>;
  readonly inputRevision?: string;
  readonly persisted?: boolean;
  readonly diagnostics?: LearningDiagnostics;
  readonly createdAt: number;
  readonly updatedAt: number;
}
