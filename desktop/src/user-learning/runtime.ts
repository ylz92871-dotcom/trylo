import { synthesizeConclusionBundle, discoverEvidenceRelations } from './conclusion';
import {
  askStreak,
  chatSeedQuestion,
  COOLDOWN_MS,
  cooldownFor,
  conversationCardCooling,
  conversationCooldownFor,
  conversationCooldownKey,
  evaluateCognitionTrigger,
  isCognitionStop,
  openCognitionSession,
  resolveAnswer,
} from './cognition';
import { inferDimension } from './conclusion';
import {
  isGracefulClose,
  isNegativeBoundary,
  isPositiveBoundary,
  nextInterviewerReply,
  openingMessage,
  recapFromSnapshot,
  sessionMessages,
} from './cognition-skill/interviewer';
import { QUESTION_BANK } from './cognition-skill/map';
import { dimensionForWorkText } from './work-signals';
import { extractEvidenceFromTrace, ingestCognitionEvidence, ingestLateWorkEvent } from './evidence';
import { newId, sourceHash } from './ids';
import { composeSystemPrompt, stripPolicyInjection } from './injection';
import type { LearningLlm } from './llm';
import { completeJson } from './llm';
import {
  createPendingRun,
  explicitInstructionFor,
  pendingLaunchDecision,
  startForDecision,
} from './decision-governor';
import type { PrepareStart } from './decision-governor';
import type { TeamPendingChoice, TeamSpawnDecision } from './team-access/spawn-score';
import type { TeamAccessSeatId, EngineeringContract, ContractClause } from './team-access/contract-types';
import type { TeamTranslationBundle, TeamTranslationProjection } from './team-access/translation-compiler';
import { compileEngineeringContract, reviseContract } from './team-access/contract-compiler';
import { compileTeamTranslation } from './team-access/translation-compiler';
import { projectAllSeats } from './team-access/translation-resolve';
import { scoreTeamSpawn, teamSpawnSignalsFromPrompt } from './team-access/spawn-score';
import { startForTeamDecision } from './decision-governor';
import { renderTeamAccessBlock, renderStaySoloProtocol } from './team-access/render-team-access';
import type { TeamProfile } from './team-access/profiles/profile-types';
import { createSymbolicPreferenceScorer, spawnCandidates } from './team-access/preference-stub';
import { clarificationFromPersonOutput, resolveTeamClarificationKey, teamClarificationCooling, type TeamClarificationRequest } from './team-access/clarification';
import { inferenceSettings, shouldRunLearningLlm } from './learning-scheduler';
import { finishLearningCall, reserveLearningCall, type LearningCallPermit } from './learning-budget';
import { compileBehaviorCommitments } from './behavior-commitment';
import { appendReceiptsForNewCommitments, createLearningReceipt } from './learning-receipt';
import { evaluateTraceOutcome } from './outcome-evaluator';
import { classifyPersonalizationEligibility } from './personalization-eligibility';
import { commitCompiledPolicyBundle, compilePolicies, currentBundleFor, resolvePolicies } from './policy';
import { canonicalScope, fingerprintScopeV2 } from './scope';
import {
  compactTraceForLearning,
  parseEvidenceSkillOutput,
} from './skills';
import { buildProjectContext, inferLanguagesFromRoot } from './project-context';
import { clearDirty, createUserLearningStore, markDirty, type UserLearningStore } from './store';
import { classifyTaskContext } from './task-context';
import type {
  CognitionAskEntry,
  CognitionAskOutcome,
  CognitionChatMessage,
  CognitionDismissKind,
  CognitionQuestion,
  CognitionResolution,
  CognitionSession,
  ContextStage,
  EvidenceEventType,
  EvidenceRecord,
  EnforcementMode,
  EvidenceScope,
  LearningReceipt,
  LearningDirective,
  LearningRun,
  PendingRunChoice,
  PendingRunIntent,
  PolicyDecision,
  PolicyDimension,
  CognitionTriggerType,
  ProductSurface,
  UserDecisionEvent,
  UserDecisionTrace,
  UserLearningSettings,
  UserLearningSnapshot,
} from './types';
import { DEFAULT_LEARNING_DIRECTIVE, DEFAULT_LEARNING_INFERENCE, DEFAULT_USER_LEARNING_SETTINGS, LOCAL_USER_ID } from './types';
import { ingestProfileFact, reasonUserModels } from './user-model';
import { projectIdFromRoot, workspaceIdFromRoot } from './ids';

export interface OpenTraceInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly workspaceRoot: string;
  readonly product: ProductSurface;
  readonly prompt: string;
  readonly codeMode?: 'chat' | 'plan' | 'agent' | 'cognition';
  readonly explicitInstruction?: string;
  readonly learningDirective?: LearningDirective;
}

export interface UserLearningRuntime {
  snapshot(): UserLearningSnapshot;
  settings(): UserLearningSettings;
  setSettings(next: Partial<UserLearningSettings>): UserLearningSettings;
  openTrace(input: OpenTraceInput): UserDecisionTrace;
  recordEvent(traceId: string, event: Omit<UserDecisionEvent, 'id'>): void;
  closeTrace(
    traceId: string,
    outcome: NonNullable<UserDecisionTrace['outcome']>,
    executionResult?: string,
  ): readonly LearningRun[];
  listPendingReceipts(product: ProductSurface, conversationId?: string): readonly LearningReceipt[];
  acknowledgeReceipt(receiptId: string): void;
  activateCommitment(commitmentId: string): void;
  updateCommitmentScope(commitmentId: string, scope: EvidenceScope): void;
  pauseCommitment(commitmentId: string): void;
  retractCommitment(commitmentId: string): void;
  applyCommitmentThisTimeOnly(commitmentId: string, traceId: string): void;
  preparePrompt(input: {
    readonly workspaceRoot: string;
    readonly product: ProductSurface;
    readonly prompt: string;
    readonly baseSystemPrompt?: string;
    readonly explicitInstruction?: string;
    readonly conversationId?: string;
    readonly turnId?: string;
    readonly projectKey?: string;
    /** True ONLY when the user clicked 开始 on the Team composer. */
    readonly confirmedSpawn?: boolean;
    /** The frozen profile snapshot. confirmedSpawn without this must
     *  never compile a contract (Foundation spec §7.2.1). */
    readonly frozenProfile?: TeamProfile;
  }): {
    systemPrompt: string;
    decision: PolicyDecision;
    taskRisk: string;
    start: PrepareStart;
    pendingRun?: PendingRunIntent;
    teamSpawn?: TeamSpawnDecision;
    contract?: EngineeringContract;
    translation?: TeamTranslationBundle;
    seatProjections?: Readonly<Record<TeamAccessSeatId, TeamTranslationProjection>>;
  };
  resumePendingRun(id: string, choice: PendingRunChoice | TeamPendingChoice): {
    started: number;
    systemPrompt: string;
    reason: 'resumed' | 'already_started' | 'missing' | 'expired' | 'dismissed';
    decision?: PolicyDecision;
  };
  /** Team clarification → Cognition (PR-12, spec §11.2). Fills contract
   *  identity from the per-conversation cache, checks the keyed cooldown,
   *  opens a team_clarification session. Null = nothing to ask / cooled. */
  enqueueTeamClarification(request: TeamClarificationRequest): CognitionSession | null;
  exportForUser(): unknown;
  deleteUserData(): void;
  maybeCognitionPrompt(input: { prompt: string; dissatisfaction?: boolean; product?: ProductSurface; conversationId?: string }): CognitionQuestion | null;
  /** §3.1: sweep stale `pending` ask-log entries → `ignored`, then demote any
   *  dimension whose trailing-ignore streak reaches 2. Idempotent; called at
   *  `maybeCognitionPrompt` entry and from the App session-switch callback. */
  sweepIgnoredAsks(): void;
  startCognition(question: CognitionQuestion, workspaceRoot?: string, product?: ProductSurface, conversationId?: string): CognitionSession;
  /** Fifth-mode chat. Opening line is conversational, not a questionnaire. */
  startCognitionConversation(workspaceRoot?: string, product?: ProductSurface): CognitionSession;
  /** Resolves the current unanswered turn. Writes Evidence (per resolved
   *  scope fragment), then either keeps the session open for a scope
   *  confirmation, appends the next question into the SAME session (a
   *  continuous thread), or resolves it. Returns the outcome for the UI. */
  answerCognition(sessionId: string, text: string): CognitionResolution;
  /** Resolves the pending scope-confirmation turn (Skill doc §13.3) by
   *  writing a `cognition_confirmation` Evidence, then continues the
   *  thread exactly like `answerCognition`. */
  confirmCognitionScope(sessionId: string, confirmed: boolean, refinedScope?: EvidenceScope): CognitionResolution;
  dismissCognition(sessionId: string, kind: CognitionDismissKind): void;
  handleCognitionTurn(text: string, workspaceRoot: string): Promise<{
    readonly reply: string;
    readonly promptSession?: CognitionSession;
    readonly answeredSessionId?: string;
    readonly dismissedSessionId?: string;
    readonly recap?: string;
    readonly stopped?: boolean;
  }>;
  recordImpactResolution(input: {
    readonly workspaceRoot: string;
    readonly acceptPersonalization: boolean;
    readonly reason: string;
    /** Surface the Impact was resolved on (Code | Work) — never hardcode
     *  'code' (spec §3.5). */
    readonly product: ProductSurface;
  }): void;
  rememberProjectFacts(input: {
    readonly workspaceRoot: string;
    readonly product: ProductSurface;
    readonly languages?: readonly string[];
    readonly frameworks?: readonly string[];
    readonly hasTests?: boolean;
    readonly gitDirty?: boolean;
    readonly gitBranch?: string;
  }): void;
  seedFixture(snapshot: Partial<UserLearningSnapshot>): void;
  enrichAfterTrace(traceId: string): Promise<void>;
  /** PR-5: Ingest a late Work event (praise/promote/template) for a closed
   *  trace. Returns the new Evidence id — or the EXISTING id when the same
   *  event (stable identity: traceId+eventType+text+dedupKey) was already
   *  ingested — or null if the trace is gone. */
  ingestLateEvent(input: {
    readonly traceId: string;
    readonly eventType: EvidenceEventType;
    readonly text: string;
    readonly claim: string;
    readonly structured?: Record<string, unknown>;
    /** Stable caller-supplied identity for dedup (e.g. the UI action id). */
    readonly dedupKey?: string;
  }): string | null;
}

function run(
  kind: LearningRun['kind'],
  status: LearningRun['status'],
  refs: readonly string[],
  now: number,
  error?: string,
  reasonCode?: LearningRun['reasonCode'],
): LearningRun {
  return {
    id: newId('lr', now),
    kind,
    status,
    error,
    ...(reasonCode ? { reasonCode } : {}),
    inputRefs: refs,
    outputRefs: [],
    startedAt: now,
    finishedAt: now,
  };
}

export function conversationTraceKey(projectKey: string, conversationId: string): string {
  return `${projectKey}::${conversationId}`;
}

// ── 主动提问频率层（§3.1–§3.3）────────────────────────────────────────
const MAX_ASK_LOG = 100;
const PROACTIVE_DAY_CAP = 1;
const PROACTIVE_WEEK_CAP = 3;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NON_PROACTIVE_TRIGGERS: ReadonlySet<CognitionTriggerType> = new Set<CognitionTriggerType>([
  'user_opened',
  'bootstrap_optional',
  'team_clarification',
]);

/** §3.2: a proactive ask degree — TRIGGERS not reachable by a user-opened /
 *  bootstrap / team path count toward the global caps. */
function isProactive(trigger: CognitionTriggerType): boolean {
  return !NON_PROACTIVE_TRIGGERS.has(trigger);
}

/** §3.2: 自然日内 ≥1、滚动 7 天 ≥3 条 proactive 条目 ⇒ 不再主动问。 */
function proactiveCapReached(snapshot: UserLearningSnapshot, now: number): boolean {
  const log = snapshot.cognitionAskLog.filter((e) => isProactive(e.trigger));
  if (log.length === 0) return false;
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  if (log.filter((e) => e.askedAt >= dayStart.getTime()).length >= PROACTIVE_DAY_CAP) return true;
  const weekStart = now - WEEK_MS;
  if (log.filter((e) => e.askedAt >= weekStart).length >= PROACTIVE_WEEK_CAP) return true;
  return false;
}

/** §3.1 sweep：`pending` 且（会话已终止 ∨ askedAt+6h 过期 ∨ 会话非 open）→
 *  `ignored`；随后对 streak≥2 的维度写 7 天 demote 并改写两条 `ignored_demoted`
 *  （防重复累加）。纯函数、幂等。 */
function sweepIgnoredAsks(snapshot: UserLearningSnapshot, now: number): UserLearningSnapshot {
  const byId = new Map<string, CognitionSession>();
  for (const s of snapshot.cognitionSessions) byId.set(s.id, s);
  let askLog: CognitionAskEntry[] = [...snapshot.cognitionAskLog];
  askLog = askLog.map((entry) => {
    if (entry.outcome !== 'pending') return entry;
    const session = byId.get(entry.id);
    const stale = !session || session.status !== 'open' || entry.askedAt + COOLDOWN_MS <= now;
    return stale ? { ...entry, outcome: 'ignored' as const, resolvedAt: now } : entry;
  });
  let cooldowns = snapshot.cognitionCooldowns;
  const demoted = new Set<PolicyDimension>();
  for (const entry of askLog) {
    if (entry.outcome !== 'ignored' || demoted.has(entry.dimension)) continue;
    if (askStreak(askLog, entry.dimension) < 2) continue;
    demoted.add(entry.dimension);
    cooldowns = [
      ...cooldowns.filter((c) => c.dimension !== entry.dimension),
      cooldownFor(entry.dimension, 'demoted', now),
    ];
    let rewrites = 0;
    for (let i = askLog.length - 1; i >= 0; i -= 1) {
      const e = askLog[i]!;
      if (e.dimension !== entry.dimension || e.outcome !== 'ignored') break;
      if (rewrites >= 2) break;
      askLog[i] = { ...e, outcome: 'ignored_demoted' as const, resolvedAt: e.resolvedAt ?? now };
      rewrites += 1;
    }
  }
  if (askLog === snapshot.cognitionAskLog && cooldowns === snapshot.cognitionCooldowns) return snapshot;
  return { ...snapshot, cognitionCooldowns: cooldowns, cognitionAskLog: askLog.slice(-MAX_ASK_LOG) };
}

/** §3.1 / §3.3：把某个 ask entry 的 outcome 覆写为 answered/dismissed（用户处置
 *  信号覆写 pending），返回新 askLog。 */
function withAskOutcome(
  log: readonly CognitionAskEntry[],
  sessionId: string,
  outcome: Exclude<CognitionAskOutcome, 'pending'>,
  at: number,
): readonly CognitionAskEntry[] {
  return log.map((entry) => (
    entry.id === sessionId ? { ...entry, outcome, resolvedAt: at } : entry
  ));
}

/**
 * Runs the Evidence → Conclusion → User Model → Policy chain for a set of
 * freshly added Evidence, returning the next snapshot. Shared by both the
 * answer path and the scope-confirmation path so cognition answers never
 * write a User Model directly — they always flow through the chain.
 */
function runLearningChain(
  snapshot: UserLearningSnapshot,
  newEvidence: readonly EvidenceRecord[],
  t: number,
  mode: EnforcementMode = 'shadow',
): UserLearningSnapshot {
  const existingDecisions = new Set(snapshot.eligibilityDecisions.flatMap((item) => item.sourceEvidenceIds));
  const eligibility = newEvidence
    .filter((item) => !existingDecisions.has(item.id))
    .map((item) => classifyPersonalizationEligibility({
      evidence: item,
      trace: snapshot.traces.find((trace) => trace.id === item.source.traceId),
      now: t,
    }));
  const candidateIds = new Set(eligibility
    .filter((item) => item.classification === 'personalization_candidate')
    .flatMap((item) => item.sourceEvidenceIds));
  const candidates = newEvidence.filter((item) => candidateIds.has(item.id));
  const lastExcluded = [...eligibility].reverse().find((item) => item.classification !== 'personalization_candidate');
  const gated: UserLearningSnapshot = {
    ...snapshot,
    eligibilityDecisions: [...snapshot.eligibilityDecisions, ...eligibility],
    diagnostics: lastExcluded ? {
      ...snapshot.diagnostics,
      lastEligibilityExclusion: {
        evidenceId: lastExcluded.sourceEvidenceIds[0]!,
        classification: lastExcluded.classification as Exclude<typeof lastExcluded.classification, 'personalization_candidate'>,
        at: t,
      },
    } : snapshot.diagnostics,
  };
  if (candidates.length === 0) return gated;
  const relations = discoverEvidenceRelations(candidates, gated.evidence, t);
  const bundle = synthesizeConclusionBundle(gated, candidates, relations, t);
  const conclusions = bundle.conclusions;
  const { models, derivations } = reasonUserModels(
    { ...gated, conclusions: mergeById(gated.conclusions, conclusions) },
    conclusions,
    t,
  );
  let next: UserLearningSnapshot = {
    ...gated,
    evidenceRelations: [...gated.evidenceRelations, ...relations],
    conclusions: mergeById(gated.conclusions, conclusions),
    conclusionRelations: [...gated.conclusionRelations, ...bundle.conclusionRelations].slice(-400),
    userModels: supersede(gated.userModels, models),
    userModelDerivations: [...gated.userModelDerivations, ...derivations],
  };
  if (models.length > 0) {
    const beforeCommitments = next.behaviorCommitments;
    const behaviorCommitments = compileBehaviorCommitments({
      models,
      evidence: next.evidence,
      eligibility: next.eligibilityDecisions,
      existing: beforeCommitments,
      mode,
      now: t,
    });
    next = {
      ...next,
      behaviorCommitments,
      learningReceipts: appendReceiptsForNewCommitments({
        before: beforeCommitments,
        after: behaviorCommitments,
        evidence: next.evidence,
        existing: next.learningReceipts,
        now: t,
      }),
    };
    const compiled = compilePolicies(next, next.projectContexts.at(-1) ?? null, t);
    next = commitCompiledPolicyBundle(next, compiled);
  }
  return next;
}

interface TraceLearningReduction {
  readonly snapshot: UserLearningSnapshot;
  readonly runs: readonly LearningRun[];
}

/** Pure terminal reducer. The caller commits its returned snapshot together
 * with the closed trace and exactly-once marker in one store transaction. */
function reduceTraceLearning(
  snapshot: UserLearningSnapshot,
  trace: UserDecisionTrace,
  t: number,
  mode: EnforcementMode,
): TraceLearningReduction {
  const runs: LearningRun[] = [];
  try {
    const scope = {
      workspaceId: trace.workspaceId,
      projectId: trace.projectId,
      product: trace.product,
      scopeTags: [trace.product, trace.codeMode ?? 'agent'],
      riskLevel: classifyTaskContext({ prompt: trace.initialRequest, product: trace.product }).risk,
    };
    const evidence = extractEvidenceFromTrace(trace, scope, t);
    runs.push(run(
      'evidence.extract',
      evidence.length ? 'ok' : 'empty',
      [trace.id],
      t,
      undefined,
      evidence.length ? undefined : 'no_user_sourced_event',
    ));
    if (evidence.length === 0) {
      return {
        snapshot: { ...snapshot, learningRuns: [...snapshot.learningRuns, ...runs].slice(-200) },
        runs,
      };
    }

    const eligibility = evidence.map((item) => classifyPersonalizationEligibility({ evidence: item, trace, now: t }));
    const candidateIds = new Set(eligibility
      .filter((item) => item.classification === 'personalization_candidate')
      .flatMap((item) => item.sourceEvidenceIds));
    const candidates = evidence.filter((item) => candidateIds.has(item.id));
    const lastExcluded = [...eligibility].reverse().find((item) => item.classification !== 'personalization_candidate');
    const relations = discoverEvidenceRelations(candidates, snapshot.evidence, t);
    const withEvidence: UserLearningSnapshot = {
      ...snapshot,
      evidence: [...snapshot.evidence, ...evidence],
      eligibilityDecisions: [...snapshot.eligibilityDecisions, ...eligibility],
      diagnostics: lastExcluded ? {
        ...snapshot.diagnostics,
        lastEligibilityExclusion: {
          evidenceId: lastExcluded.sourceEvidenceIds[0]!,
          classification: lastExcluded.classification as Exclude<typeof lastExcluded.classification, 'personalization_candidate'>,
          at: t,
        },
      } : snapshot.diagnostics,
      evidenceRelations: [...snapshot.evidenceRelations, ...relations],
    };
    const bundle = synthesizeConclusionBundle(withEvidence, candidates, relations, t);
    const conclusions = bundle.conclusions;
    const withConclusions: UserLearningSnapshot = {
      ...withEvidence,
      conclusions: mergeById(withEvidence.conclusions, conclusions),
      conclusionRelations: [
        ...withEvidence.conclusionRelations,
        ...bundle.conclusionRelations,
      ].slice(-400),
    };
    const { models, derivations } = reasonUserModels(withConclusions, conclusions, t);
    let next: UserLearningSnapshot = {
      ...withConclusions,
      userModels: supersede(withConclusions.userModels, models),
      userModelDerivations: [...withConclusions.userModelDerivations, ...derivations],
    };

    if (models.length > 0) {
      const beforeCommitments = next.behaviorCommitments;
      const behaviorCommitments = compileBehaviorCommitments({
        models,
        evidence: next.evidence,
        eligibility: next.eligibilityDecisions,
        existing: beforeCommitments,
        mode,
        now: t,
      });
      next = {
        ...next,
        behaviorCommitments,
        learningReceipts: appendReceiptsForNewCommitments({
          before: beforeCommitments,
          after: behaviorCommitments,
          evidence: next.evidence,
          existing: next.learningReceipts,
          now: t,
        }),
      };
      const project = next.projectContexts.find((item) => item.projectId === trace.projectId)
        ?? buildProjectContext({
          workspaceId: trace.workspaceId,
          projectId: trace.projectId,
          product: trace.product,
          now: t,
        });
      const compiled = compilePolicies(next, project, t);
      next = commitCompiledPolicyBundle({
        ...next,
        projectContexts: upsert(next.projectContexts, project),
      }, compiled);
      runs.push(run(
        'conclusion.synthesize',
        conclusions.length ? 'ok' : 'empty',
        evidence.map((item) => item.id),
        t,
        undefined,
        conclusions.length ? undefined : 'no_stable_conclusion',
      ));
      runs.push(run('user_model.reason', models.length ? 'ok' : 'empty', conclusions.map((item) => item.id), t));
      runs.push(run('policy.compile', compiled.rules.length ? 'ok' : 'empty', models.map((item) => item.id), t));
    } else {
      next = markDirty(next, conclusions.map((item) => item.dimension));
      runs.push(run(
        'conclusion.synthesize',
        conclusions.length ? 'ok' : 'empty',
        evidence.map((item) => item.id),
        t,
        undefined,
        conclusions.length ? undefined : 'no_stable_conclusion',
      ));
      runs.push(run(
        'user_model.reason',
        'empty',
        conclusions.map((item) => item.id),
        t,
        undefined,
        'no_stable_conclusion',
      ));
    }

    return {
      snapshot: { ...next, learningRuns: [...next.learningRuns, ...runs].slice(-200) },
      runs,
    };
  } catch (err) {
    runs.push(run(
      'evidence.extract',
      'failed',
      [trace.id],
      t,
      err instanceof Error ? err.message : String(err),
    ));
    return {
      snapshot: { ...snapshot, learningRuns: [...snapshot.learningRuns, ...runs].slice(-200) },
      runs,
    };
  }
}

export function createUserLearningRuntime(options: {
  readonly store?: UserLearningStore;
  readonly settings?: UserLearningSettings;
  readonly now?: () => number;
  readonly llm?: LearningLlm | null | (() => LearningLlm | null | undefined);
} = {}): UserLearningRuntime {
  const store = options.store ?? createUserLearningStore();
  const now = options.now ?? (() => Date.now());
  const resolveLlm = (): LearningLlm | null => {
    const value = typeof options.llm === 'function' ? options.llm() : options.llm;
    return value ?? null;
  };
  let settings: UserLearningSettings = {
    ...DEFAULT_USER_LEARNING_SETTINGS,
    ...options.settings,
    dimensionMode: { ...DEFAULT_USER_LEARNING_SETTINGS.dimensionMode, ...options.settings?.dimensionMode },
    inference: { ...DEFAULT_LEARNING_INFERENCE, ...options.settings?.inference },
  };
  const pendingRuns = new Map<string, PendingRunIntent>();
  // In-session authority for live contracts (spec §8.6). reviseContract /
  // team clarification read this; disk persistence is App-side. Deliberately
  // NOT part of the UL snapshot (v2 stays untouched).
  const teamContracts = new Map<string, {
    contract: EngineeringContract;
    projections: Readonly<Record<TeamAccessSeatId, TeamTranslationProjection>>;
    teamRunId: string;
    /** 'worker' while a blocking high-risk clarification is open (§11.2). */
    hold?: 'none' | 'worker';
  }>();
  // Open team clarifications, keyed by CognitionSession id. The user's
  // answer revises the contract (§11.3) — never the User Model directly.
  const teamClarifications = new Map<string, {
    request: TeamClarificationRequest;
    unknownItems: readonly string[];
  }>();
  const open = new Map<string, UserDecisionTrace>();
  const enriching = new Set<string>();
  // Invalidates every async learning/cognition write that started before a
  // user-data deletion. Clearing a Set cannot cancel an already awaited call.
  let deletionEpoch = store.snapshot().deletionEpoch;

  const persistTrace = (trace: UserDecisionTrace): void => {
    store.update((snap) => ({
      ...snap,
      traces: [...snap.traces.filter((t) => t.id !== trace.id), trace],
    }));
  };

  const compileAfterCommitmentChange = (
    snapshot: UserLearningSnapshot,
    commitment: UserLearningSnapshot['behaviorCommitments'][number],
    t: number,
  ): UserLearningSnapshot => {
    const projectId = commitment.scope.projectId;
    if (!projectId) {
      return commitCompiledPolicyBundle(snapshot, compilePolicies(snapshot, null, t));
    }
    const project = snapshot.projectContexts.find((item) => item.projectId === projectId)
      ?? buildProjectContext({
        workspaceId: commitment.scope.workspaceId ?? 'global',
        projectId,
        product: commitment.scope.product ?? 'code',
        now: t,
      });
    return commitCompiledPolicyBundle({
      ...snapshot,
      projectContexts: upsert(snapshot.projectContexts, project),
    }, compilePolicies(snapshot, project, t));
  };

  const correctedReceipt = (
    receipt: LearningReceipt,
    message: string,
    t: number,
  ): LearningReceipt => ({ ...receipt, message, state: 'corrected', updatedAt: t });

  return {
    snapshot: () => store.snapshot(),
    settings: () => settings,
    setSettings(next) {
      settings = {
        ...settings,
        ...next,
        dimensionMode: { ...settings.dimensionMode, ...next.dimensionMode },
        inference: { ...DEFAULT_LEARNING_INFERENCE, ...settings.inference, ...next.inference },
      };
      return settings;
    },
    listPendingReceipts(product, conversationId) {
      if (settings.userLearningReceipts === false) return [];
      return store.snapshot().learningReceipts.filter((receipt) => (
        receipt.product === product
        && receipt.state === 'pending'
        && (conversationId === undefined || receipt.conversationId === conversationId)
      ));
    },
    acknowledgeReceipt(receiptId) {
      const t = now();
      store.update((snapshot) => ({
        ...snapshot,
        learningReceipts: snapshot.learningReceipts.map((receipt) => (
          receipt.id === receiptId
            ? { ...receipt, state: 'acknowledged' as const, updatedAt: t }
            : receipt
        )),
      }));
    },
    activateCommitment(commitmentId) {
      const t = now();
      store.update((snapshot) => {
        const commitment = snapshot.behaviorCommitments.find((item) => item.id === commitmentId);
        if (!commitment || !['candidate', 'trial', 'shadow', 'paused'].includes(commitment.state)) return snapshot;
        const active = { ...commitment, state: 'active' as const, updatedAt: t };
        const changed: UserLearningSnapshot = {
          ...snapshot,
          behaviorCommitments: snapshot.behaviorCommitments.map((item) => item.id === commitmentId ? active : item),
          learningReceipts: snapshot.learningReceipts.map((receipt) => (
            receipt.commitmentId === commitmentId && receipt.state === 'pending'
              ? { ...receipt, message: `以后将这样做：${active.behaviorDelta.adaptedBehavior}`, updatedAt: t }
              : receipt
          )),
        };
        return compileAfterCommitmentChange(changed, active, t);
      });
    },
    updateCommitmentScope(commitmentId, scope) {
      const t = now();
      store.update((snapshot) => {
        const prior = snapshot.behaviorCommitments.find((item) => item.id === commitmentId);
        if (!prior || ['retracted', 'expired', 'superseded'].includes(prior.state)) return snapshot;
        const nextScope = canonicalScope(scope);
        const replacement = {
          ...prior,
          id: newId('bc', t),
          scope: nextScope,
          conditions: scope.scopeTags,
          stableKey: `${snapshot.userId}::${prior.decisionPoint}::${fingerprintScopeV2(scope)}`,
          version: prior.version + 1,
          supersedes: prior.id,
          createdAt: t,
          updatedAt: t,
        };
        let receipts = snapshot.learningReceipts.map((receipt) => (
          receipt.commitmentId === prior.id && receipt.state === 'pending'
            ? correctedReceipt(receipt, '适用范围已修改', t)
            : receipt
        ));
        const receipt = createLearningReceipt({
          commitment: replacement,
          evidence: snapshot.evidence,
          existing: receipts,
          reason: 'scope_changed',
          now: t,
        });
        if (receipt) receipts = [...receipts, receipt];
        const changed: UserLearningSnapshot = {
          ...snapshot,
          behaviorCommitments: snapshot.behaviorCommitments
            .map((item) => item.id === prior.id ? { ...item, state: 'superseded' as const, updatedAt: t } : item)
            .concat(replacement),
          learningReceipts: receipts,
        };
        return compileAfterCommitmentChange(changed, replacement, t);
      });
    },
    pauseCommitment(commitmentId) {
      const t = now();
      store.update((snapshot) => {
        const prior = snapshot.behaviorCommitments.find((item) => item.id === commitmentId);
        if (!prior || ['paused', 'retracted', 'expired', 'superseded'].includes(prior.state)) return snapshot;
        const paused = { ...prior, state: 'paused' as const, updatedAt: t };
        const changed: UserLearningSnapshot = {
          ...snapshot,
          behaviorCommitments: snapshot.behaviorCommitments.map((item) => item.id === prior.id ? paused : item),
          learningReceipts: snapshot.learningReceipts.map((receipt) => (
            receipt.commitmentId === prior.id
              ? correctedReceipt(receipt, `已暂停：${prior.behaviorDelta.adaptedBehavior}`, t)
              : receipt
          )),
        };
        return compileAfterCommitmentChange(changed, paused, t);
      });
    },
    retractCommitment(commitmentId) {
      const t = now();
      store.update((snapshot) => {
        const prior = snapshot.behaviorCommitments.find((item) => item.id === commitmentId);
        if (!prior || ['retracted', 'expired', 'superseded'].includes(prior.state)) return snapshot;
        const retracted = { ...prior, state: 'retracted' as const, updatedAt: t };
        const changed: UserLearningSnapshot = {
          ...snapshot,
          behaviorCommitments: snapshot.behaviorCommitments.map((item) => item.id === prior.id ? retracted : item),
          userModels: snapshot.userModels.map((model) => (
            model.id === prior.userModelId ? { ...model, status: 'disputed' as const, updatedAt: t } : model
          )),
          policyRules: snapshot.policyRules.map((rule) => (
            rule.sourceCommitmentIds?.includes(prior.id)
              ? { ...rule, status: 'superseded' as const }
              : rule
          )),
          learningReceipts: snapshot.learningReceipts.map((receipt) => (
            receipt.commitmentId === prior.id
              ? correctedReceipt(receipt, `已撤回：${prior.behaviorDelta.adaptedBehavior}`, t)
              : receipt
          )),
        };
        return compileAfterCommitmentChange(changed, retracted, t);
      });
    },
    applyCommitmentThisTimeOnly(commitmentId, traceId) {
      const t = now();
      store.update((snapshot) => {
        const prior = snapshot.behaviorCommitments.find((item) => item.id === commitmentId);
        const trace = snapshot.traces.find((item) => item.id === traceId);
        if (!prior || !trace || !prior.provenanceEvidenceIds.some((evidenceId) => (
          snapshot.evidence.some((evidence) => evidence.id === evidenceId && evidence.source.traceId === trace.id)
        ))) return snapshot;
        const retracted = { ...prior, state: 'retracted' as const, updatedAt: t };
        const changed: UserLearningSnapshot = {
          ...snapshot,
          behaviorCommitments: snapshot.behaviorCommitments.map((item) => item.id === prior.id ? retracted : item),
          userModels: snapshot.userModels.map((model) => (
            model.id === prior.userModelId ? { ...model, status: 'disputed' as const, updatedAt: t } : model
          )),
          policyRules: snapshot.policyRules.map((rule) => (
            rule.sourceCommitmentIds?.includes(prior.id)
              ? { ...rule, status: 'superseded' as const }
              : rule
          )),
          learningReceipts: snapshot.learningReceipts.map((receipt) => (
            receipt.commitmentId === prior.id
              ? correctedReceipt(receipt, '已设为仅本次，不再用于后续任务', t)
              : receipt
          )),
        };
        return compileAfterCommitmentChange(changed, retracted, t);
      });
    },
    openTrace(input) {
      const t = now();
      const workspaceId = workspaceIdFromRoot(input.workspaceRoot);
      const projectId = projectIdFromRoot(input.workspaceRoot);
      const trace: UserDecisionTrace = {
        id: newId('tr', t),
        userId: LOCAL_USER_ID,
        sessionId: input.sessionId,
        taskId: input.turnId,
        turnId: input.turnId,
        workspaceId,
        projectId,
        product: input.product,
        codeMode: input.codeMode,
        initialRequest: input.prompt,
        learningDirective: { ...DEFAULT_LEARNING_DIRECTIVE, ...input.learningDirective },
        agentDecisions: [],
        userEvents: [{
          id: newId('ue', t),
          at: t,
          actor: 'user',
          type: 'user_message',
          stage: 'task_context',
          text: input.prompt,
        }],
        createdAt: t,
      };
      open.set(trace.id, trace);
      persistTrace(trace);
      return trace;
    },
    recordEvent(traceId, event) {
      const snapshot = store.snapshot();
      const current = open.get(traceId) ?? snapshot.traces.find((t) => t.id === traceId);
      // A late terminal callback must never reopen a closed trace. Legitimate
      // post-terminal learning enters through ingestLateEvent's own boundary.
      if (!current) return;
      if (
        current.closedAt !== undefined
        || snapshot.traceLearningCommits.some((item) => item.traceId === traceId)
      ) {
        store.update((state) => ({
          ...state,
          diagnostics: {
            ...state.diagnostics,
            lastRejectedLateEvent: { traceId, eventType: event.type, at: event.at },
          },
        }));
        return;
      }
      const next: UserDecisionTrace = {
        ...current,
        userEvents: [...current.userEvents, { ...event, id: newId('ue') }],
        agentDecisions: event.actor === 'agent' && event.text
          ? [...current.agentDecisions, event.text]
          : current.agentDecisions,
      };
      open.set(traceId, next);
      persistTrace(next);
    },
    closeTrace(traceId, outcome, executionResult) {
      const initialSnapshot = store.snapshot();
      const current = open.get(traceId) ?? initialSnapshot.traces.find((t) => t.id === traceId);
      if (!current) return [];
      const priorCommit = initialSnapshot.traceLearningCommits.find((item) => item.traceId === traceId);
      if (current.closedAt !== undefined || priorCommit) {
        const committedOutcome = priorCommit?.outcome ?? current.outcome ?? 'exited';
        if (committedOutcome !== outcome) {
          store.update((snapshot) => ({
            ...snapshot,
            diagnostics: {
              ...snapshot.diagnostics,
              lastTerminalConflict: {
                traceId,
                committedOutcome,
                attemptedOutcome: outcome,
                at: now(),
              },
            },
          }));
        }
        return [run('evidence.extract', 'skipped', [current.id], now(), undefined, 'idempotent')];
      }
      const t = now();
      const closed: UserDecisionTrace = {
        ...current,
        outcome,
        executionResult,
        closedAt: t,
      };
      const terminalKey = `trace:${sourceHash([
        closed.id,
        ...closed.userEvents.map((event) => `${event.id}:${event.type}:${event.at}`),
      ])}`;
      let resultRuns: readonly LearningRun[] = [];
      store.update((snapshot) => {
        if (snapshot.traceLearningCommits.some((item) => item.traceId === traceId)) {
          resultRuns = [run('evidence.extract', 'skipped', [closed.id], t, undefined, 'idempotent')];
          return snapshot;
        }
        const withClosed: UserLearningSnapshot = {
          ...snapshot,
          traces: [...snapshot.traces.filter((trace) => trace.id !== traceId), closed],
        };
        const collectNewLearning = closed.learningDirective?.collectNewLearning ?? true;
        const reduced = settings.enabled && collectNewLearning
          ? reduceTraceLearning(withClosed, closed, t, settings.defaultMode)
          : {
            snapshot: withClosed,
            runs: [run(
              'evidence.extract',
              'skipped',
              [closed.id],
              t,
              undefined,
              settings.enabled ? 'directive_no_collect' : 'disabled',
            )],
          };
        resultRuns = reduced.runs;
        const appliedDecision = [...snapshot.policyDecisions].reverse().find((decision) => (
          decision.traceId === closed.id
          || decision.taskId === closed.turnId
            && (!decision.conversationId || decision.conversationId === closed.sessionId)
        ));
        const evaluation = settings.enabled
          && collectNewLearning
          && settings.userLearningOutcomeEvaluation !== false
          ? evaluateTraceOutcome({ snapshot: reduced.snapshot, trace: closed, decision: appliedDecision, now: t })
          : { observations: [], pauseCommitmentIds: [], expireTrialIds: [] };
        const pausedIds = new Set(evaluation.pauseCommitmentIds);
        const expiredIds = new Set(evaluation.expireTrialIds);
        let learningReceipts = [...reduced.snapshot.learningReceipts];
        for (const commitment of settings.userLearningReceipts === false
          ? []
          : reduced.snapshot.behaviorCommitments) {
          if (!pausedIds.has(commitment.id)) continue;
          const receipt = createLearningReceipt({
            commitment: { ...commitment, state: 'paused' },
            evidence: reduced.snapshot.evidence,
            existing: learningReceipts,
            reason: 'correction_detected',
            product: closed.product,
            conversationId: closed.sessionId,
            now: t,
          });
          if (receipt) {
            learningReceipts.push({
              ...receipt,
              message: `已暂停，等待你纠正：${commitment.behaviorDelta.adaptedBehavior}`,
            });
          }
        }
        let outcomeSnapshot: UserLearningSnapshot = {
          ...reduced.snapshot,
          outcomeObservations: [
            ...reduced.snapshot.outcomeObservations,
            ...evaluation.observations,
          ].slice(-1000),
          behaviorCommitments: reduced.snapshot.behaviorCommitments.map((commitment) => (
            pausedIds.has(commitment.id)
              ? { ...commitment, state: 'paused' as const, updatedAt: t }
              : expiredIds.has(commitment.id)
                ? { ...commitment, state: 'candidate' as const, updatedAt: t }
                : commitment
          )),
          userModels: reduced.snapshot.userModels.map((model) => {
            const linkedIds = reduced.snapshot.behaviorCommitments
              .filter((commitment) => commitment.userModelId === model.id)
              .map((commitment) => commitment.id);
            const signals = evaluation.observations
              .filter((observation) => linkedIds.includes(observation.commitmentId))
              .map((observation) => observation.signal);
            if (signals.length === 0) return model;
            const helpful = signals.includes('explicit_helpful');
            const harmful = signals.some((signal) => (
              signal === 'explicit_unhelpful' || signal === 'rollback' || signal === 'repeated_correction'
            ));
            const prior = model.effectivenessState ?? 'unknown';
            const effectivenessState = helpful && harmful
              || helpful && prior === 'harmful'
              || harmful && prior === 'helpful'
              ? 'mixed' as const
              : helpful
                ? 'helpful' as const
                : harmful
                  ? 'harmful' as const
                  : prior;
            return {
              ...model,
              effectivenessState,
              lastRelevantOpportunityAt: signals.includes('task_completed')
                ? t
                : model.lastRelevantOpportunityAt,
              updatedAt: helpful || harmful ? t : model.updatedAt,
            };
          }),
          policyRules: reduced.snapshot.policyRules.map((rule) => (
            rule.sourceCommitmentIds?.some((id) => pausedIds.has(id) || expiredIds.has(id))
              ? { ...rule, status: 'superseded' as const }
              : rule
          )),
          learningReceipts,
        };
        const changedCommitment = outcomeSnapshot.behaviorCommitments.find((commitment) => (
          pausedIds.has(commitment.id) || expiredIds.has(commitment.id)
        ));
        if (changedCommitment) {
          outcomeSnapshot = compileAfterCommitmentChange(outcomeSnapshot, changedCommitment, t);
        }
        if (closed.learningDirective?.retention === 'session_only') {
          outcomeSnapshot = {
            ...outcomeSnapshot,
            traces: outcomeSnapshot.traces.map((trace) => trace.id === closed.id
              ? {
                ...trace,
                initialRequest: '',
                agentDecisions: [],
                userEvents: [],
                executionResult: undefined,
              }
              : trace),
          };
        }
        return {
          ...outcomeSnapshot,
          learningRuns: settings.enabled && collectNewLearning
            ? outcomeSnapshot.learningRuns
            : [...outcomeSnapshot.learningRuns, ...reduced.runs].slice(-200),
          traceLearningCommits: [
            ...outcomeSnapshot.traceLearningCommits.filter((item) => item.traceId !== traceId),
            {
              terminalKey,
              traceId,
              outcome: outcome ?? 'exited',
              status: 'committed' as const,
              committedAt: t,
            },
          ].slice(-500),
        };
      });
      open.delete(traceId);
      return resultRuns;
    },
    preparePrompt(input) {
      const task = classifyTaskContext({
        prompt: input.prompt,
        product: input.product,
        explicitInstruction: input.explicitInstruction,
      });
      const projectId = projectIdFromRoot(input.workspaceRoot);
      const snap = store.snapshot();
      const linkedTrace = input.turnId
        ? [...open.values()].reverse().find((trace) => (
          trace.turnId === input.turnId
          && (!input.conversationId || trace.sessionId === input.conversationId)
        ))
        : undefined;
      const applyPersonalization = linkedTrace?.learningDirective?.applyExistingPreferences ?? true;
      const applyBehaviorCommitments = settings.userLearningBehaviorCommitments !== false;
      if (!settings.enabled || settings.defaultMode === 'off') {
        const decision = resolvePolicies({
          snapshot: snap, task, projectId, mode: 'off', now: now(), applyPersonalization, applyBehaviorCommitments,
        });
        return { systemPrompt: input.baseSystemPrompt ?? '', decision, taskRisk: task.risk, start: 'ready' };
      }
      let working = snap;
      const currentBundle = currentBundleFor(working, projectId);
      const needsCompile = (
        working.dirtyDimensions.length > 0
        || !currentBundle
      ) && working.userModels.some((m) => m.status === 'active');
      if (needsCompile) {
        const project = working.projectContexts.find((p) => p.projectId === projectId)
          ?? buildProjectContext({
            workspaceId: workspaceIdFromRoot(input.workspaceRoot),
            projectId,
            product: input.product,
            languages: inferLanguagesFromRoot(input.workspaceRoot),
            now: now(),
          });
        const compiled = compilePolicies(working, project, now());
        working = store.update((s) => commitCompiledPolicyBundle({
          ...s,
          projectContexts: upsert(s.projectContexts, project),
        }, compiled));
      }
      const mode = settings.defaultMode;
      const askedSince = now() - 6 * 60 * 60 * 1000;
      const recentlyAsked = working.policyDecisions.some((item) => (
        item.impactCheck?.interruptUser === true && item.createdAt >= askedSince
      )) || working.cognitionSessions.some((item) => item.createdAt >= askedSince && item.status === 'open');
      const resolvedDecision = resolvePolicies({
        snapshot: working,
        task,
        projectId,
        mode,
        now: now(),
        recentlyAsked,
        dimensionMode: settings.dimensionMode,
        applyPersonalization,
        applyBehaviorCommitments,
      });
      const decision: PolicyDecision = {
        ...resolvedDecision,
        taskId: input.turnId ?? resolvedDecision.taskId,
        conversationId: input.conversationId,
        traceId: linkedTrace?.id,
      };
      const start = startForDecision(decision);
      let pendingRun = start === 'pending_impact'
        ? createPendingRun({
          workspaceRoot: input.workspaceRoot,
          product: input.product,
          prompt: input.prompt,
          decision,
          now: now(),
          baseSystemPrompt: input.baseSystemPrompt,
          conversationId: input.conversationId,
          turnId: input.turnId,
          projectKey: input.projectKey,
        })
        : undefined;
      if (pendingRun) pendingRuns.set(pendingRun.id, pendingRun);
      // ── Team Access gate (Foundation spec §7.2 priority order) ──
      // Runs AFTER the impact gate. Flag off ⇒ scorer never runs and the
      // start value is byte-identical to today (never pending_team/blocked).
      // Without `confirmedSpawn` the scorer returns stay_solo (or refuse);
      // there is no pending_team card and no contract compile. `spawn_team`
      // is reachable only through `confirmedSpawn` (Team composer 开始).
      const teamEnabled = settings.teamAccessEnabled === true;
      let teamSpawn: TeamSpawnDecision | undefined;
      let contract: EngineeringContract | undefined;
      let translationBundle: TeamTranslationBundle | undefined;
      let seatProjections: Readonly<Record<TeamAccessSeatId, TeamTranslationProjection>> | undefined;
      let teamAccessText: string | undefined;
      let finalStart = start;
      if (teamEnabled && start === 'ready' && input.conversationId) {
        const signals = teamSpawnSignalsFromPrompt(input.prompt, input.product);
        const preference = createSymbolicPreferenceScorer().score({
          task,
          snapshot: working,
          candidates: spawnCandidates(),
        });
        teamSpawn = scoreTeamSpawn({
          task,
          teamAccessEnabled: true,
          preference,
          recentlyAsked,
          ...signals,
          confirmedSpawn: input.confirmedSpawn,
        });
        const teamStart = startForTeamDecision(teamSpawn);
        if (teamStart === 'blocked') {
          finalStart = teamStart;
          pendingRun = undefined;
        } else if (teamSpawn.decision === 'spawn_team' && input.confirmedSpawn === true && input.frozenProfile) {
          const teamRunId = `team-${input.conversationId}`;
          const compiled = compileEngineeringContract({
            snapshot: working,
            task,
            workspaceRoot: input.workspaceRoot,
            personConversationId: input.conversationId,
            now: now(),
          });
          // Keep the deterministic id stable per run: cache wins on re-send.
          contract = teamContracts.get(input.conversationId)?.contract ?? compiled;
          if (!contract.teamRunId || contract.teamRunId !== teamRunId) {
            contract = { ...contract, teamRunId };
          }
          const { bundle, rules } = compileTeamTranslation({
            snapshot: working,
            contract,
            product: input.product,
            now: now(),
          });
          translationBundle = bundle;
          seatProjections = projectAllSeats(rules, settings.defaultMode);
          const hold = teamContracts.get(input.conversationId)?.hold;
          // Foundation spec §8.3/§8.4: roster from the frozen profile
          // (Person first, unique baseRoles) — never the heuristic seats.
          const uniqueBaseRoles: TeamAccessSeatId[] = [];
          for (const member of input.frozenProfile.members) {
            const role = member.baseRole as TeamAccessSeatId;
            if (!uniqueBaseRoles.includes(role)) uniqueBaseRoles.push(role);
          }
          teamSpawn = { ...teamSpawn, recommendedSeats: uniqueBaseRoles };
          teamAccessText = renderTeamAccessBlock({
            decision: teamSpawn,
            contract,
            seatProjections,
            mode: settings.defaultMode,
            teamRunId,
            frozenProfile: input.frozenProfile,
            hold,
          });
          teamContracts.set(input.conversationId, {
            contract,
            projections: seatProjections,
            teamRunId,
            ...(hold ? { hold } : {}),
          });
        } else if (teamSpawn.decision === 'stay_solo' && input.product === 'work') {
          // Work negative protocol: no contract, no translation (§14.3).
          teamAccessText = renderStaySoloProtocol();
        }
      }
      store.update((s) => ({
        ...s,
        learningReceipts: settings.userLearningReceipts !== false
          && decision.injected && finalStart === 'ready'
          ? s.behaviorCommitments
            .filter((commitment) => (
              commitment.state === 'active'
              && s.policyRules.some((rule) => (
                rule.sourceCommitmentIds?.includes(commitment.id)
                && decision.enforced.some((active) => active.policyId === rule.id)
              ))
            ))
            .reduce<LearningReceipt[]>((receipts, commitment) => {
              const receipt = createLearningReceipt({
                commitment,
                evidence: s.evidence,
                existing: receipts,
                reason: 'first_applied',
                product: input.product,
                conversationId: input.conversationId,
                now: now(),
              });
              return receipt ? [...receipts, receipt] : receipts;
            }, [...s.learningReceipts])
          : s.learningReceipts,
        policyDecisions: [...s.policyDecisions, decision].slice(-300),
        pendingRuns: pendingRun
          ? [...(s.pendingRuns ?? []).filter((item) => item.id !== pendingRun!.id), pendingRun]
          : s.pendingRuns,
        learningRuns: [
          ...s.learningRuns,
          run('policy.resolve', 'ok', decision.matchedRuleIds, now()),
          // Observability (spec §22): additive team compile runs. Emitted only
          // on the spawn_team path where a contract / translation was compiled.
          ...(contract ? [run('contract.compile', 'ok', [contract.contractId], now())] : []),
          ...(translationBundle
            ? [run('team_translation.compile', 'ok', [contract?.teamRunId ?? ''], now())]
            : []),
        ].slice(-200),
      }));
      return {
        systemPrompt: composeSystemPrompt(
          input.baseSystemPrompt,
          decision.injectionText,
          decision.injected && finalStart === 'ready',
          teamAccessText,
        ),
        decision,
        taskRisk: task.risk,
        start: finalStart,
        pendingRun,
        teamSpawn,
        contract,
        translation: translationBundle,
        seatProjections,
      };
    },
    resumePendingRun(id, choice) {
      const pending = pendingRuns.get(id) ?? store.snapshot().pendingRuns?.find((item) => item.id === id);
      const reason = pendingLaunchDecision(pending, choice, now());
      if (reason !== 'launch' || !pending) {
        if (pending && (reason === 'expired' || reason === 'dismissed')) {
          const next = {
            ...pending,
            resumeCount: pending.resumeCount + 1,
            status: reason === 'expired' ? 'expired' as const : 'dismissed' as const,
            ...(choice === 'spawn_team' || choice === 'stay_solo' ? { teamChoice: choice } : { choice }),
          };
          pendingRuns.set(id, next);
          store.update((s) => ({
            ...s,
            pendingRuns: (s.pendingRuns ?? []).map((item) => item.id === id ? next : item),
          }));
        }
        return {
          started: 0,
          systemPrompt: pending?.baseSystemPrompt ?? '',
          reason: reason === 'launch' ? 'missing' : reason,
        };
      }
      // Team choices resolve without a second ask (spec §7.3):
      // spawn_team short-circuits the scorer via confirmedSpawn;
      // stay_solo composes the (Work-only) negative protocol directly —
      // re-running the scorer could ask_user again and loop.
      if (choice === 'spawn_team' || choice === 'stay_solo') {
        const next = {
          ...pending,
          resumeCount: 1,
          status: 'resumed' as const,
          teamChoice: choice as TeamPendingChoice,
        };
        pendingRuns.set(id, next);
        store.update((s) => ({
          ...s,
          pendingRuns: (s.pendingRuns ?? []).map((item) => item.id === id ? next : item),
        }));
        if (choice === 'spawn_team') {
          const resolved = this.preparePrompt({
            workspaceRoot: pending.workspaceRoot,
            product: pending.product,
            prompt: pending.userPrompt,
            baseSystemPrompt: pending.baseSystemPrompt,
            explicitInstruction: explicitInstructionFor('personalization'),
            conversationId: pending.conversationId,
            turnId: pending.turnId,
            projectKey: pending.projectKey,
            confirmedSpawn: true,
          });
          return { started: 1, systemPrompt: resolved.systemPrompt, reason: 'resumed', decision: resolved.decision };
        }
        const staySoloPrompt = composeSystemPrompt(
          pending.baseSystemPrompt,
          '',
          false,
          pending.product === 'work' ? renderStaySoloProtocol() : undefined,
        );
        return {
          started: 1,
          systemPrompt: staySoloPrompt,
          reason: 'resumed',
          decision: { ...pending.baselineDecision, injected: false, injectionText: '' },
        };
      }
      const next = { ...pending, resumeCount: 1, status: 'resumed' as const, choice };
      pendingRuns.set(id, next);
      store.update((s) => ({
        ...s,
        pendingRuns: (s.pendingRuns ?? []).map((item) => item.id === id ? next : item),
      }));
      const resolved = this.preparePrompt({
        workspaceRoot: pending.workspaceRoot,
        product: pending.product,
        prompt: pending.userPrompt,
        baseSystemPrompt: pending.baseSystemPrompt,
        explicitInstruction: explicitInstructionFor(choice),
        conversationId: pending.conversationId,
        turnId: pending.turnId,
        projectKey: pending.projectKey,
      });
      const systemPrompt = choice === 'baseline'
        // Impact-baseline resume still carries the team-access block
        // (the contract is a task spec, not personalization, spec §7.3);
        // only the Personal Policy tag is removed.
        ? stripPolicyInjection(resolved.systemPrompt)
        : resolved.systemPrompt;
      const decision = choice === 'baseline'
        ? {
          ...pending.baselineDecision,
          taskId: pending.turnId,
          conversationId: pending.conversationId,
          injected: false,
          injectionText: '',
          appliedCommitmentIds: [],
          opportunityKeys: [],
        }
        : resolved.decision;
      if (choice === 'baseline') {
        // preparePrompt above resolves the personalized branch to preserve the
        // existing resume path. Append the user's actual baseline choice so
        // closeTrace attributes outcomes to what really ran.
        store.update((snapshot) => ({
          ...snapshot,
          policyDecisions: [...snapshot.policyDecisions, decision].slice(-300),
        }));
      }
      return { started: 1, systemPrompt, reason: 'resumed', decision };
    },
    exportForUser() {
      const snap = store.snapshot();
      return {
        schemaVersion: snap.schemaVersion,
        exportedAt: now(),
        userId: snap.userId,
        evidence: snap.evidence,
        eligibilityDecisions: snap.eligibilityDecisions,
        conclusions: snap.conclusions,
        userModels: snap.userModels,
        behaviorCommitments: snap.behaviorCommitments,
        learningReceipts: snap.learningReceipts,
        outcomeObservations: snap.outcomeObservations,
        policyRules: snap.policyRules,
        policyDecisions: snap.policyDecisions,
        profileFacts: snap.profileFacts,
      };
    },
    deleteUserData() {
      deletionEpoch += 1;
      pendingRuns.clear();
      open.clear();
      enriching.clear();
      teamContracts.clear();
      teamClarifications.clear();
      const cleared = store.clear();
      if (cleared.persisted !== false) {
        store.replace({ ...cleared, deletionEpoch });
      }
    },
    maybeCognitionPrompt(input) {
      if (!settings.enabled || !settings.cognitionEnabled) return null;
      // §3.1: sweep stale pending asks (and demote) at entry, so an ignored
      // card from a previous conversation can never re-trigger silently.
      const swept = store.update((s) => sweepIgnoredAsks(s, now()));
      // §3.2 M4: the per-conversation 6h card cap gates the in-task trigger
      // before any question is selected — after the last card on THIS
      // conversation resolved/dismissed, no new card for 6h (any dimension).
      if (
        input.conversationId
        && conversationCardCooling(swept.cognitionCooldowns, input.conversationId, now())
      ) {
        return null;
      }
      // §3.2: global proactive caps (day ≤1, rolling 7d ≤3) — derived from
      // the ask log, before the trigger runs.
      if (proactiveCapReached(swept, now())) return null;
      // §2.2: in-task trigger is signal-driven + intent-gated (a bare greeting
      // or a pure gap produces NO question). Shadow default stays Question-only.
      return evaluateCognitionTrigger({
        snapshot: swept,
        prompt: input.prompt,
        dissatisfaction: input.dissatisfaction,
        product: input.product ?? 'code',
        intent: 'in_task',
        now: now(),
      });
    },
    sweepIgnoredAsks() {
      store.update((s) => sweepIgnoredAsks(s, now()));
    },
    startCognition(question, workspaceRoot, product, conversationId) {
      const t = now();
      const session = openCognitionSession({
        userId: LOCAL_USER_ID,
        question,
        trigger: question.trigger,
        workspaceId: workspaceRoot ? workspaceIdFromRoot(workspaceRoot) : undefined,
        projectId: workspaceRoot ? projectIdFromRoot(workspaceRoot) : undefined,
        product,
        // §3.2 M4: in-task cards remember their conversation so resolve /
        // dismiss can write the per-conversation 6h card cap.
        conversationId,
        now: t,
      });
      store.update((s) => ({
        ...s,
        cognitionSessions: [...s.cognitionSessions, session],
        // §3.1: the proactive-ask ledger. Non-proactive triggers (user-opened
        // fifth mode, bootstrap, team clarification) never enter this ledger so
        // they can't pollute the global caps or the ignore-demote streak.
        cognitionAskLog: isProactive(question.trigger)
          ? [...s.cognitionAskLog, {
            id: session.id,
            dimension: question.dimension,
            ...(conversationId ? { conversationId } : {}),
            trigger: question.trigger,
            askedAt: t,
            outcome: 'pending' as const,
          }].slice(-MAX_ASK_LOG)
          : s.cognitionAskLog,
        // §3.2 (P2-5 补充): ASKING is itself a cooldown event. Without this
        // the 'asked' reason was dead code and the only anti-repeat gate was
        // the transient live-message check — an IGNORED card (conversation
        // switched, app restarted, card swept away) never resolved, so the
        // same question re-carded on every subsequent send. Both the
        // per-dimension gap and the per-conversation cap start HERE; resolve
        // / dismiss overwrite them with the user's actual signal.
        cognitionCooldowns: [
          ...s.cognitionCooldowns.filter((c) => c.dimension !== question.dimension),
          cooldownFor(question.dimension, 'asked', t),
          ...(conversationId
            ? [conversationCooldownFor(conversationId, 'asked', t)]
            : []),
        ],
      }));
      return session;
    },
    startCognitionConversation(workspaceRoot, product) {
      const snap = store.snapshot();
      const opening = openingMessage(snap);
      const session = openCognitionSession({
        userId: LOCAL_USER_ID,
        question: chatSeedQuestion(),
        trigger: 'user_opened',
        workspaceId: workspaceRoot ? workspaceIdFromRoot(workspaceRoot) : undefined,
        projectId: workspaceRoot ? projectIdFromRoot(workspaceRoot) : undefined,
        product,
        now: now(),
        opening,
      });
      store.update((s) => ({ ...s, cognitionSessions: [...s.cognitionSessions, session] }));
      return session;
    },
    enqueueTeamClarification(request) {
      if (!settings.enabled || !settings.cognitionEnabled || !settings.teamAccessEnabled) return null;
      const conversationId = request.teamRunId.startsWith('team-')
        ? request.teamRunId.slice(5)
        : request.teamRunId;
      const cached = teamContracts.get(conversationId);
      const full: TeamClarificationRequest = {
        ...request,
        contractId: request.contractId ?? cached?.contract.contractId ?? 'unknown',
        contractVersion: request.contractVersion ?? cached?.contract.version ?? 0,
        cooldownKey: resolveTeamClarificationKey({
          ...request,
          contractId: request.contractId ?? cached?.contract.contractId ?? 'unknown',
        }),
      };
      const question = clarificationFromPersonOutput({ snapshot: store.snapshot(), request: full });
      if (!question) return null;
      // Keyed cooldown only: blocking+high-risk bypasses ordinary gap
      // cooldowns but still respects dont_ask_similar on the same key.
      if (teamClarificationCooling(store.snapshot(), full, now())) return null;
      const session = openCognitionSession({
        userId: LOCAL_USER_ID,
        question,
        trigger: 'team_clarification',
        now: now(),
      });
      store.update((s) => ({ ...s, cognitionSessions: [...s.cognitionSessions, session] }));
      teamClarifications.set(session.id, { request: full, unknownItems: request.unknownItems ?? [] });
      if (full.blocking && full.risk === 'high' && cached) {
        teamContracts.set(conversationId, { ...cached, hold: 'worker' });
      }
      return session;
    },
    answerCognition(sessionId, text) {
      const t = now();
      let result: CognitionResolution = { followUp: 'done', evidenceIds: [] };
      store.update((s) => {
        const session = s.cognitionSessions.find((c) => c.id === sessionId);
        if (!session) return s;
        const question = session.questions[session.questions.length - 1];
        if (!question) return s;

        const eventType: Extract<EvidenceEventType, 'cognition_answer' | 'authoritative_correction'> =
          session.trigger === 'user_opened' && session.dismissKind === 'corrected'
            ? 'authoritative_correction'
            : 'cognition_answer';
        const scopeBase = {
          workspaceId: session.workspaceId ?? 'global',
          projectId: session.projectId ?? 'global',
          // §3.4: the session belongs to a product (default 'code'). A Work
          // interview must never write Evidence into the Code domain.
          product: session.product ?? 'code',
        } as const;

        const resolution = resolveAnswer(question, text);
        const evidences: EvidenceRecord[] = [];
        for (const cand of resolution.candidates) {
          const scope: EvidenceScope = {
            ...scopeBase,
            scopeTags: cand.scope.scopeTags,
            corePath: cand.scope.corePath,
            taskCategory: cand.scope.taskCategory,
          };
          evidences.push(ingestCognitionEvidence({
            userId: session.userId,
            sessionId,
            text,
            claim: cand.claim,
            eventType,
            scope,
            now: t,
          }));
        }
        const evidenceIds = evidences.map((e) => e.id);
        const profile = /工程师|设计|机械|学生|产品/.test(text)
          ? ingestProfileFact({
            userId: session.userId,
            category: 'role_identity',
            statement: text.slice(0, 120),
            evidenceRefs: evidenceIds,
            now: t,
          })
          : null;

        let followUp: CognitionResolution['followUp'] = 'done';
        let pendingConfirm = false;
        if (resolution.followUp === 'confirm_scope') {
          followUp = 'confirm_scope';
          pendingConfirm = true;
        }

        const userMsg: CognitionChatMessage = {
          id: newId('cmsg', t),
          role: 'user',
          text,
          at: t,
        };
        const prior = sessionMessages(session);
        const updatedSession: CognitionSession = {
          ...session,
          answers: [...session.answers, { questionId: question.id, text, at: t }],
          messages: [...prior, userMsg],
          status: followUp === 'done' && session.trigger !== 'user_opened' && session.trigger !== 'bootstrap_optional'
            ? 'resolved'
            : 'open',
          pendingConfirmScope: pendingConfirm || undefined,
          evidenceIds: [...session.evidenceIds, ...evidenceIds],
          updatedAt: t,
        };

        const withEv = {
          ...s,
          evidence: [...s.evidence, ...evidences],
          profileFacts: profile ? [...s.profileFacts, profile] : s.profileFacts,
          cognitionSessions: s.cognitionSessions.map((c) => c.id === sessionId ? updatedSession : c),
          // §3.1/§3.3: answering writes the user signal over the pending ask.
          cognitionAskLog: withAskOutcome(s.cognitionAskLog, sessionId, 'answered', t),
          cognitionCooldowns: [
            // One clean filter pass: drop the old per-dimension entry AND the
            // old per-conversation entry (the ask-time stamps), then append
            // the refreshed pair. Two stacked spreads over the ORIGINAL array
            // would re-add what the first pass removed.
            ...s.cognitionCooldowns.filter((c) => (
              c.dimension !== question.dimension
              && (updatedSession.conversationId === undefined
                || c.key !== conversationCooldownKey(updatedSession.conversationId))
            )),
            cooldownFor(question.dimension, 'answered', t),
            // §3.2 M4: the per-conversation 6h cap, stamped at ask time, is
            // REFRESHED with the user's signal whenever the turn resolves the
            // thread (followUp done) — otherwise the cap silently expires
            // 6h after ASK. While the thread stays open (scope confirm /
            // next question) the ask-time entry stays in force: the filter
            // above removed it, so re-add it untouched.
            ...(updatedSession.conversationId
              ? [followUp === 'done'
                ? conversationCooldownFor(updatedSession.conversationId, 'answered', t)
                : s.cognitionCooldowns.find(
                  (c) => c.key === conversationCooldownKey(updatedSession.conversationId!),
                ) ?? conversationCooldownFor(updatedSession.conversationId, 'asked', t)]
              : []),
          ],
        };

        const next = clearDirty(runLearningChain(withEv, evidences, t, settings.defaultMode));
        result = { followUp, evidenceIds };
        return next;
      });
      // PR-12 (spec §11.3): a team-clarification answer revises the live
      // contract — answer becomes explicit, resolved unknowns leave
      // inferred — and records a keyed cooldown. Never writes the UM.
      const teamClarification = teamClarifications.get(sessionId);
      if (teamClarification) {
        teamClarifications.delete(sessionId);
        const key = resolveTeamClarificationKey(teamClarification.request);
        const conversationId = teamClarification.request.teamRunId.startsWith('team-')
          ? teamClarification.request.teamRunId.slice(5)
          : teamClarification.request.teamRunId;
        const cached = teamContracts.get(conversationId);
        if (cached) {
          const field: ContractClause['field'] = /安全|密钥|权限/.test(text) ? 'security' : 'acceptance';
          const revised = reviseContract(cached.contract, {
            newExplicit: [{ id: '', authority: 'explicit', text, field }],
            resolvedUnknown: teamClarification.unknownItems,
            now: t,
          });
          teamContracts.set(conversationId, { ...cached, contract: revised, hold: 'none' });
        }
        store.update((s) => ({
          ...s,
          cognitionCooldowns: [
            ...s.cognitionCooldowns,
            { ...cooldownFor('engineering_language_semantics', 'answered', t), key },
          ],
        }));
      }
      return result;
    },
    confirmCognitionScope(sessionId, confirmed, refinedScope) {
      const t = now();
      let result: CognitionResolution = { followUp: 'done', evidenceIds: [] };
      store.update((s) => {
        const session = s.cognitionSessions.find((c) => c.id === sessionId);
        if (!session || session.status !== 'open' || !session.pendingConfirmScope) return s;
        const question = session.questions[session.questions.length - 1];
        const lastAnswer = session.answers[session.answers.length - 1];
        if (!question || !lastAnswer) return s;

        const scope: EvidenceScope = refinedScope ?? {
          workspaceId: session.workspaceId ?? 'global',
          projectId: session.projectId ?? 'global',
          scopeTags: [question.dimension],
          // §3.4/M2: the fallback scope follows `session.product` (default
          // 'code'). Without this, a Work fifth-mode scope confirmation would
          // write its Evidence into the Code domain (Security P1).
          product: session.product ?? 'code',
        };
        const claim = confirmed
          ? `用户确认：「${lastAnswer.text.slice(0, 40)}」在核心或高价值路径同样适用。`
          : '用户澄清：该偏好不适用于核心/高价值场景，核心路径需保留严格工程基线。';
        const ev = ingestCognitionEvidence({
          userId: session.userId,
          sessionId,
          text: lastAnswer.text,
          claim,
          eventType: 'cognition_confirmation',
          scope,
          now: t,
        });

        const chat = session.trigger === 'user_opened' || session.trigger === 'bootstrap_optional';
        const updatedSession: CognitionSession = {
          ...session,
          status: chat ? 'open' : 'resolved',
          pendingConfirmScope: undefined,
          evidenceIds: [...session.evidenceIds, ev.id],
          updatedAt: t,
        };
        const withEv = {
          ...s,
          evidence: [...s.evidence, ev],
          cognitionSessions: s.cognitionSessions.map((c) => c.id === sessionId ? updatedSession : c),
          // §3.2 M4: resolving the thread via scope confirmation refreshes the
          // conversation cap with the user's signal too (the ask-time stamp
          // would otherwise expire 6h after ASK, not after RESOLVE).
          cognitionCooldowns: session.conversationId
            ? [
              ...s.cognitionCooldowns.filter(
                (c) => c.key !== conversationCooldownKey(session.conversationId!),
              ),
              conversationCooldownFor(session.conversationId, 'answered', t),
            ]
            : s.cognitionCooldowns,
        };
        const next = clearDirty(runLearningChain(withEv, [ev], t, settings.defaultMode));
        result = {
          followUp: 'done',
          evidenceIds: [ev.id],
        };
        return next;
      });
      return result;
    },
    async handleCognitionTurn(text, workspaceRoot) {
      const operationEpoch = deletionEpoch;
      const projectId = projectIdFromRoot(workspaceRoot);
      const workspaceId = workspaceIdFromRoot(workspaceRoot);
      const findOpenChat = (): CognitionSession | undefined => store.snapshot().cognitionSessions.find((s) => (
        s.status === 'open'
        && s.trigger !== 'team_clarification'
        && (s.projectId ? s.projectId === projectId : true)
        && (s.workspaceId ? s.workspaceId === workspaceId : true)
      ));
      let openSession = findOpenChat();
      const stop = isCognitionStop(text);
      if (stop) {
        if (openSession) this.dismissCognition(openSession.id, stop);
        return {
          reply: '好，先不继续问。我会从真实任务里慢慢学，不会打断你。',
          dismissedSessionId: openSession?.id,
          stopped: true,
        };
      }
      if (isGracefulClose(text)) {
        if (!openSession) {
          return { reply: '好。之后你在真实任务里纠正我，我也会慢慢学。', stopped: true };
        }
        const recap = recapFromSnapshot(store.snapshot(), openSession.evidenceIds);
        const t = now();
        store.update((s) => ({
          ...s,
          cognitionSessions: s.cognitionSessions.map((c) => c.id === openSession!.id
            ? {
              ...c,
              status: 'resolved' as const,
              recap,
              messages: [...sessionMessages(c),
                { id: newId('cmsg', t), role: 'user' as const, text, at: t },
                { id: newId('cmsg', t + 1), role: 'assistant' as const, text: recap, at: t + 1 },
              ],
              updatedAt: t,
            }
            : c),
        }));
        return { reply: recap, answeredSessionId: openSession.id, recap, stopped: true };
      }

      if (!openSession) {
        openSession = this.startCognitionConversation(workspaceRoot);
        const greeting = /^(你好|hi|hello|开始|开始了解|嗨)$/i.test(text.trim());
        if (greeting) {
          const tGreet = now();
          store.update((s) => ({
            ...s,
            cognitionSessions: s.cognitionSessions.map((c) => c.id === openSession!.id
              ? {
                ...c,
                messages: [...sessionMessages(c), { id: newId('cmsg', tGreet), role: 'user' as const, text, at: tGreet }],
                updatedAt: tGreet,
              }
              : c),
          }));
          return {
            reply: sessionMessages(openSession)[0]?.text ?? openingMessage(store.snapshot()),
            promptSession: store.snapshot().cognitionSessions.find((c) => c.id === openSession!.id),
          };
        }
      }

      let handledConfirm = false;
      if (openSession.pendingConfirmScope) {
        if (isNegativeBoundary(text)) this.confirmCognitionScope(openSession.id, false);
        else if (isPositiveBoundary(text)) this.confirmCognitionScope(openSession.id, true);
        else this.confirmCognitionScope(openSession.id, !/核心|账号|保留/.test(text));
        const tConfirm = now();
        store.update((s) => ({
          ...s,
          cognitionSessions: s.cognitionSessions.map((c) => c.id === openSession!.id
            ? {
              ...c,
              messages: [...sessionMessages(c), { id: newId('cmsg', tConfirm), role: 'user' as const, text, at: tConfirm }],
              updatedAt: tConfirm,
            }
            : c),
        }));
        openSession = findOpenChat() ?? openSession;
        handledConfirm = true;
      }

      const dim = dimensionForWorkText(text) ?? inferDimension(text);
      const topic = QUESTION_BANK.find((item) => item.dimension === dim) ?? chatSeedQuestion();
      if (!handledConfirm) {
        store.update((s) => {
          const session = s.cognitionSessions.find((c) => c.id === openSession!.id);
          if (!session) return s;
          const last = session.questions[session.questions.length - 1];
          const unanswered = last && session.answers.length < session.questions.length;
          const questions = unanswered && last?.id === 'q_chat'
            ? [...session.questions.slice(0, -1), { ...topic, id: last.id, trigger: last.trigger }]
            : unanswered
              ? session.questions
              : [...session.questions, topic];
          return {
            ...s,
            cognitionSessions: s.cognitionSessions.map((c) => c.id === session.id
              ? { ...c, dimension: topic.dimension, questions }
              : c),
          };
        });
      }

      const substantial = !handledConfirm
        && text.trim().length > 8
        && !/^(你好|hi|hello|开始|开始了解|嗨)$/i.test(text.trim());
      let resolution = resolveAnswer(topic, text);
      if (substantial) {
        const res = this.answerCognition(openSession.id, text);
        resolution = res.followUp === 'confirm_scope'
          ? { candidates: [], followUp: 'confirm_scope', reason: 'over_broad' }
          : resolveAnswer(topic, text);
      } else if (handledConfirm) {
        resolution = { candidates: [], followUp: 'none', reason: 'scoped' };
      }

      const live = findOpenChat() ?? openSession;
      const snap = store.snapshot();
      let next = nextInterviewerReply({
        snapshot: snap,
        session: live,
        lastUserText: text,
        resolution,
      });
      const llm = resolveLlm();
      if (llm) {
        try {
          const parsed = await completeJson(llm, 'cognition', JSON.stringify({
            user: text,
            known: snap.userModels.filter((m) => m.status === 'active').slice(0, 5).map((m) => m.statement),
            hint: next.reply,
          }));
          if (operationEpoch !== deletionEpoch) {
            return { reply: '用户学习数据已清除。', stopped: true };
          }
          if (parsed && typeof parsed === 'object' && parsed !== null && 'reply' in parsed) {
            const row = parsed as { reply?: unknown; stop?: unknown; recap?: unknown };
            if (typeof row.reply === 'string' && row.reply.trim()) {
              next = {
                reply: row.reply.trim(),
                stop: row.stop === true || next.stop,
                recap: typeof row.recap === 'string' ? row.recap : next.recap,
              };
            }
          }
        } catch {
          // Deterministic interviewer is the fallback.
        }
      }

      const t = now();
      const recap = next.stop ? (next.recap ?? recapFromSnapshot(store.snapshot(), live.evidenceIds)) : undefined;
      const assistantText = next.reply;
      store.update((s) => ({
        ...s,
        cognitionSessions: s.cognitionSessions.map((c) => c.id === live.id
          ? {
            ...c,
            messages: [...sessionMessages(c), { id: newId('cmsg', t), role: 'assistant' as const, text: assistantText, at: t }],
            status: next.stop ? 'resolved' as const : c.status,
            recap: recap ?? c.recap,
            pendingConfirmScope: resolution.followUp === 'confirm_scope' ? true : c.pendingConfirmScope,
            updatedAt: t,
          }
          : c),
      }));
      return {
        reply: assistantText,
        answeredSessionId: live.id,
        promptSession: store.snapshot().cognitionSessions.find((c) => c.id === live.id),
        recap,
        stopped: next.stop,
      };
    },
    recordImpactResolution(input) {
      const t = now();
      const text = input.acceptPersonalization
        ? `这次任务按我的偏好执行。背景：${input.reason}`
        : `这次任务保留工程基线：核心或高回滚路径必须先计划并保留最终验证。背景：${input.reason}`;
      const claim = input.acceptPersonalization
        ? '高影响任务可以采用个性化，但不能越过安全与数据完整性'
        : '高影响任务必须保留最终验证，减少审核不等于取消验证';
      store.update((s) => {
        const evidence = ingestCognitionEvidence({
          userId: LOCAL_USER_ID,
          sessionId: `impact-${t}`,
          text,
          claim,
          eventType: 'cognition_confirmation',
          scope: {
            workspaceId: workspaceIdFromRoot(input.workspaceRoot),
            projectId: projectIdFromRoot(input.workspaceRoot),
            scopeTags: ['verification_audit', 'impact_check'],
            // §3.5: never hardcode 'code' — the Impact was resolved on a
            // surface (pendingAgentRunRef.kind) and the Evidence must follow it.
            product: input.product,
          },
          now: t,
        });
        return {
          ...s,
          evidence: [...s.evidence, { ...evidence, durability: 'long_term_candidate', signalKind: 'impact_resolution' }],
        };
      });
    },
    rememberProjectFacts(input) {
      const project = buildProjectContext({
        workspaceId: workspaceIdFromRoot(input.workspaceRoot),
        projectId: projectIdFromRoot(input.workspaceRoot),
        product: input.product,
        languages: input.languages,
        frameworks: input.frameworks,
        hasTests: input.hasTests,
        gitDirty: input.gitDirty,
        gitBranch: input.gitBranch,
        now: now(),
      });
      store.update((s) => ({
        ...s,
        projectContexts: upsert(s.projectContexts, { ...project, discoveredFrom: ['workspace-scan'] }),
      }));
    },
    dismissCognition(sessionId, kind) {
      const t = now();
      store.update((s) => {
        const session = s.cognitionSessions.find((c) => c.id === sessionId);
        if (!session) return s;
        return {
          ...s,
          cognitionSessions: s.cognitionSessions.map((c) => c.id === sessionId
            ? { ...c, status: 'dismissed', dismissKind: kind, updatedAt: t }
            : c),
          // §3.1/§3.3: dismissing writes the user signal over the pending ask.
          cognitionAskLog: withAskOutcome(s.cognitionAskLog, sessionId, 'dismissed', t),
          cognitionCooldowns: [
            // One clean filter pass: drop the old per-dimension entry AND the
            // old per-conversation entry (the ask-time stamps), then append
            // the refreshed pair.
            ...s.cognitionCooldowns.filter((c) => (
              c.dimension !== session.dimension
              && (session.conversationId === undefined
                || c.key !== conversationCooldownKey(session.conversationId))
            )),
            cooldownFor(session.dimension, kind, t),
            // §3.2 M4: a dismissal refreshes the per-conversation 6h card cap
            // (stamped at ask time) with the user's signal.
            ...(session.conversationId
              ? [conversationCooldownFor(session.conversationId, kind, t)]
              : []),
          ],
        };
      });
    },
    seedFixture(partial) {
      store.update((s) => {
        const bundles = partial.policyBundles ?? s.policyBundles;
        const pointers: Record<string, string> = { ...(s.currentProjectBundleIds ?? {}) };
        for (const bundle of bundles) {
          if (bundle.status === 'active') pointers[bundle.projectId] = bundle.id;
        }
        return { ...s, ...partial, userId: s.userId, currentProjectBundleIds: pointers };
      });
    },
    async enrichAfterTrace(traceId) {
      if (enriching.has(traceId)) return;
      const operationEpoch = deletionEpoch;
      const llm = resolveLlm();
      if (!llm || !settings.enabled || !shouldRunLearningLlm(settings, 'trace')) return;
      const snap = store.snapshot();
      const trace = snap.traces.find((item) => item.id === traceId);
      if (!trace) return;
      let permit: LearningCallPermit | null = null;
      const reservedAt = now();
      store.update((current) => {
        const provider = llm.metadata?.provider === 'openai' || llm.metadata?.provider === 'anthropic'
          ? llm.metadata.provider
          : undefined;
        const reserved = reserveLearningCall({
          snapshot: current,
          settings: inferenceSettings(settings),
          skill: 'evidence',
          traceId,
          provider,
          model: llm.metadata?.model,
          now: reservedAt,
        });
        permit = reserved.permit;
        return reserved.snapshot;
      });
      if (!permit) return;
      enriching.add(traceId);
      const t = now();
      try {
        const evJson = await completeJson(
          llm,
          'evidence',
          compactTraceForLearning(trace, inferenceSettings(settings)),
        );
        if (operationEpoch !== deletionEpoch) return;
        if (!evJson) {
          store.update((current) => finishLearningCall(current, permit!, 'failed', now()));
          return;
        }
        const extraEvidence = parseEvidenceSkillOutput(evJson, trace, {
          workspaceId: trace.workspaceId,
          projectId: trace.projectId,
          product: trace.product,
          scopeTags: [trace.product],
          riskLevel: classifyTaskContext({ prompt: trace.initialRequest, product: trace.product }).risk,
        }, t);
        if (extraEvidence.length === 0) {
          store.update((current) => finishLearningCall(current, permit!, 'rejected', now()));
          return;
        }
        store.update((current) => {
          const knownHashes = new Set(current.evidence.map((item) => item.source.sourceHash));
          const fresh = extraEvidence.filter((item) => !knownHashes.has(item.source.sourceHash));
          if (fresh.length === 0) return finishLearningCall(current, permit!, 'rejected', now());
          const withEvidence: UserLearningSnapshot = {
            ...current,
            evidence: [...current.evidence, ...fresh],
          };
          const learned = runLearningChain(withEvidence, fresh, t, settings.defaultMode);
          return finishLearningCall({
            ...learned,
            learningRuns: [...current.learningRuns, run(
              'evidence.extract',
              'ok',
              [traceId],
              t,
            )].slice(-200),
          }, permit!, 'completed', now());
        });
      } catch (err) {
        if (operationEpoch !== deletionEpoch) return;
        store.update((current) => finishLearningCall({
          ...current,
          learningRuns: [...current.learningRuns, run(
            'evidence.extract',
            'failed',
            [traceId],
            t,
            err instanceof Error ? err.message : String(err),
            'parse_reject',
          )].slice(-200),
        }, permit!, 'failed', now()));
      } finally {
        enriching.delete(traceId);
      }
    },
    ingestLateEvent(input) {
      const t = now();
      const snap = store.snapshot();
      const trace = snap.traces.find((tr) => tr.id === input.traceId);
      if (!trace) return null;
      const ev = ingestLateWorkEvent({
        userId: LOCAL_USER_ID,
        traceId: input.traceId,
        trace: {
          sessionId: trace.sessionId,
          taskId: trace.taskId,
          turnId: trace.turnId,
          product: trace.product,
          workspaceId: trace.workspaceId,
          projectId: trace.projectId,
        },
        eventType: input.eventType,
        text: input.text,
        claim: input.claim,
        structured: input.structured,
        dedupKey: input.dedupKey,
        now: t,
      });
      if (!ev) return null;
      // Idempotent append (§4.4): the stable sourceHash IS the dedup
      // identity. A duplicate delivery (double-click, repeated terminal)
      // must never stack a second Evidence row — return the existing id.
      const existing = snap.evidence.find((e) => e.source.sourceHash === ev.source.sourceHash);
      if (existing) return existing.id;
      store.update((s) => ({ ...s, evidence: [...s.evidence, ev] }));
      return ev.id;
    },
  };
}

function mergeById<T extends { id: string }>(existing: readonly T[], incoming: readonly T[]): readonly T[] {
  if (incoming.length === 0) return existing;
  const map = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    if (item && 'supersedes' in item && typeof (item as { supersedes?: string }).supersedes === 'string') {
      const prev = existing.find((e) => e.id === (item as { supersedes?: string }).supersedes);
      if (prev && 'status' in prev) {
        map.set(prev.id, { ...prev, status: 'superseded' } as T);
      }
    }
    map.set(item.id, item);
  }
  return [...map.values()];
}

function supersede<T extends { id: string; status: string; dimension?: PolicyDimension; userId?: string; stableKey?: string; scope?: { projectId?: string; product?: string } }>(
  existing: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  if (incoming.length === 0) return existing;
  const next = existing.map((item) => {
    const replacement = incoming.find((inc) => {
      if (inc.stableKey && item.stableKey) return inc.stableKey === item.stableKey;
      return inc.dimension === item.dimension
        && inc.userId === item.userId
        && (inc.scope?.projectId ?? '') === (item.scope?.projectId ?? '')
        && (inc.scope?.product ?? '') === (item.scope?.product ?? '');
    });
    if (replacement && item.status === 'active') return { ...item, status: 'superseded' };
    return item;
  });
  return [...next, ...incoming];
}

function upsert<T extends { id: string; projectId?: string }>(existing: readonly T[], item: T): readonly T[] {
  const idx = existing.findIndex((e) => e.projectId && e.projectId === item.projectId);
  if (idx < 0) return [...existing, item];
  const copy = existing.slice();
  copy[idx] = item;
  return copy;
}

export function stageForOutcome(outcome: UserDecisionTrace['outcome']): ContextStage {
  if (outcome === 'completed') return 'post_outcome';
  return 'post_execution';
}

export function eventFromApproval(allow: boolean, preview: string, at = Date.now()): Omit<UserDecisionEvent, 'id'> {
  return {
    at,
    actor: 'user',
    type: allow ? 'approval' : 'rejection',
    stage: 'post_plan',
    text: `${allow ? 'approved' : 'rejected'} ${preview}`.slice(0, 240),
  };
}

export function eventFromStop(at = Date.now()): Omit<UserDecisionEvent, 'id'> {
  return { at, actor: 'user', type: 'stop', stage: 'post_execution', text: 'user stopped the run' };
}

export function eventFromSteer(text: string, at = Date.now()): Omit<UserDecisionEvent, 'id'> {
  return { at, actor: 'user', type: 'steer', stage: 'post_execution', text };
}

export function eventFromArtifact(input: {
  readonly action: 'promote' | 'redo' | 'accept';
  readonly fileName?: string;
  readonly packageId?: string;
  readonly at?: number;
}): Omit<UserDecisionEvent, 'id'> {
  const at = input.at ?? Date.now();
  const kind = input.action === 'redo' ? 'artifact_redo' : 'artifact_promote';
  const label = input.action === 'redo' ? '重做产物' : '提升产物';
  return {
    at,
    actor: 'user',
    type: input.action === 'redo' ? 'outcome_feedback' : 'choice',
    stage: 'post_outcome',
    text: input.fileName ? `${label} ${input.fileName}` : label,
    structured: { kind, fileName: input.fileName, packageId: input.packageId },
  };
}

export function eventFromLeaseGrant(input: {
  readonly kind: 'windows-screen' | 'windows-click' | 'browser-origin' | string;
  readonly origin?: string;
  readonly conversationId?: string;
  readonly at?: number;
}): Omit<UserDecisionEvent, 'id'> {
  const at = input.at ?? Date.now();
  const leaseKind = input.kind === 'windows-screen'
    ? 'lease_grant_screen'
    : input.kind === 'windows-click'
      ? 'lease_grant_click'
      : 'lease_grant_browser';
  return {
    at,
    actor: 'user',
    type: 'approval',
    stage: 'post_plan',
    text: input.origin ? `authorized ${input.kind} ${input.origin}` : `authorized ${input.kind}`,
    structured: { kind: leaseKind, origin: input.origin, leaseKind: input.kind },
  };
}

export function eventFromWorkStop(at = Date.now()): Omit<UserDecisionEvent, 'id'> {
  return {
    at,
    actor: 'user',
    type: 'stop',
    stage: 'post_execution',
    text: 'user stopped the Work run',
    structured: { kind: 'work_stop' },
  };
}

export type { EvidenceEventType };
