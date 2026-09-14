import { groundEvidenceCandidates, type EvidenceCandidate } from './evidence-grounding';
import { newId } from './ids';
import { sourceHash } from './ids';
import { classifyTaskContext } from './task-context';
import { inferDimension } from './conclusion';
import type {
  ConclusionRecord,
  EvidenceRecord,
  EvidenceRelation,
  EvidenceScope,
  InferenceDistance,
  PolicyDimension,
  PolicyEffectMode,
  PolicyKind,
  PolicyRule,
  PolicyStrength,
  RelationType,
  UserDecisionTrace,
  LearningInferenceSettings,
  UserModelRecord,
} from './types';
import { POLICY_DIMENSIONS } from './types';

const RELATIONS: readonly RelationType[] = [
  'supports', 'contradicts', 'refines_scope', 'explains', 'conditions',
  'co_occurs', 'same_underlying_pattern', 'temporal_supersedes',
];
const DISTANCES: readonly InferenceDistance[] = ['D0', 'D1', 'D2', 'D3'];
const KINDS: readonly PolicyKind[] = [
  'constraint', 'conditional_decision', 'weighted_heuristic', 'prompt_directive', 'clarification_gate',
];
const STRENGTHS: readonly PolicyStrength[] = ['hard', 'strong_default', 'soft', 'advisory'];
const MODES: readonly PolicyEffectMode[] = ['require', 'forbid', 'prefer', 'avoid', 'route', 'ask', 'defer'];
const ALLOWED_ACTIONS = new Set([
  'duplicate_review', 'final_verification', 'direct_execution', 'plan_first',
  'process_narration', 'speculative_abstraction', 'semantic_checkpoint',
]);
const FORBIDDEN_HARD_ACTIONS = new Set(['skip_verification', 'skip_tests', 'skip_backup', 'weaken_security', 'drop_migration_check']);
const D3_RE = /懒|笨|差|讨厌|没有耐心|人格|性格|心理/;
const FOOD_RE = /吃|牛肉|食物|电影|音乐/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function inList<T extends string>(value: unknown, list: readonly T[]): T | null {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? value as T : null;
}

export function parseEvidenceSkillOutput(
  raw: unknown,
  trace: UserDecisionTrace,
  scope: EvidenceScope,
  now: number,
): readonly EvidenceRecord[] {
  if (!isObject(raw) || !Array.isArray(raw.evidence)) return [];
  const candidates: EvidenceCandidate[] = [];
  for (const row of raw.evidence) {
    if (!isObject(row)) continue;
    const claim = asString(row.claim);
    const observation = asString(row.raw) || asString(row.raw_observation);
    if (!claim || !observation) continue;
    if (FOOD_RE.test(claim)) continue;
    const eventId = asString(row.event_id) || asString(row.proposed_event_id);
    const span = isObject(row.raw_span)
      ? { start: asNumber(row.raw_span.start, 0), end: asNumber(row.raw_span.end, 0) }
      : undefined;
    candidates.push({
      candidateId: newId('ev', now),
      traceId: trace.id,
      proposedClaim: claim,
      proposedEventId: eventId,
      proposedRawSpan: span,
      extractor: 'llm',
      extractorVersion: 'evidence-grounding@0.2',
      proposedRaw: observation,
      semanticConfidence: asNumber(row.semantic_confidence, 0.7),
      engineeringRelevance: asNumber(row.engineering_relevance, 0.7),
    });
  }
  return groundEvidenceCandidates(candidates, trace, scope, now);
}

export function parseConclusionSkillOutput(
  raw: unknown,
  userId: string,
  evidence: readonly EvidenceRecord[],
  now: number,
): { conclusions: readonly ConclusionRecord[]; relations: readonly EvidenceRelation[] } {
  if (!isObject(raw)) return { conclusions: [], relations: [] };
  if (raw.no_stable_conclusion === true) return { conclusions: [], relations: [] };
  if (!Array.isArray(raw.conclusions)) return { conclusions: [], relations: [] };
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const conclusions: ConclusionRecord[] = [];
  const relations: EvidenceRelation[] = [];
  for (const row of raw.conclusions) {
    if (!isObject(row)) continue;
    const statement = asString(row.statement);
    if (!statement || D3_RE.test(statement)) continue;
    const dimension = inList(row.dimension, POLICY_DIMENSIONS)
      ?? inferDimension(statement);
    const supporting = Array.isArray(row.supporting)
      ? row.supporting.filter((id): id is string => typeof id === 'string' && byId.has(id))
      : evidence.map((e) => e.id);
    const counter = Array.isArray(row.counter)
      ? row.counter.filter((id): id is string => typeof id === 'string' && byId.has(id))
      : [];
    if (supporting.length === 0) continue;
    const id = newId('con', now);
    conclusions.push({
      id,
      userId,
      statement,
      dimension,
      scope: evidence[0]!.context,
      evidence: { supporting, counter, contextual: [] },
      relations: [],
      strength: {
        score: counter.length > 0 ? 0.62 : 0.8,
        band: counter.length > 0 ? 'medium' : 'high',
      },
      temporal: {
        firstObserved: now,
        lastSupported: now,
        state: counter.length > 0 ? 'disputed' : 'emerging',
      },
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    if (Array.isArray(row.relations)) {
      for (const rel of row.relations) {
        if (!isObject(rel)) continue;
        const type = inList(rel.type, RELATIONS);
        const fromId = asString(rel.from ?? rel.fromId);
        const toId = asString(rel.to ?? rel.toId);
        if (!type || !byId.has(fromId) || !byId.has(toId)) continue;
        relations.push({
          id: newId('erel', now),
          userId,
          fromId,
          toId,
          type,
          strength: 0.75,
          explanation: asString(rel.explanation) || type,
          confidence: 0.7,
          createdAt: now,
        });
      }
    }
  }
  return { conclusions, relations };
}

export function parseUserModelSkillOutput(
  raw: unknown,
  userId: string,
  conclusions: readonly ConclusionRecord[],
  now: number,
): readonly UserModelRecord[] {
  if (conclusions.length === 0) return [];
  if (!isObject(raw) || raw.no_user_model === true) return [];
  if (!Array.isArray(raw.user_models)) return [];
  const out: UserModelRecord[] = [];
  for (const row of raw.user_models) {
    if (!isObject(row)) continue;
    const statement = asString(row.statement);
    if (!statement || D3_RE.test(statement) || FOOD_RE.test(statement)) continue;
    const distance = inList(row.distance, DISTANCES);
    if (!distance || distance === 'D3') continue;
    const dimension = inList(row.dimension, POLICY_DIMENSIONS)
      ?? conclusions[0]?.dimension
      ?? 'agent_autonomy';
    const score = Math.min(
      distance === 'D0' ? 0.95 : distance === 'D1' ? 0.88 : 0.72,
      Math.max(0, asNumber(row.confidence, 0.7)),
    );
    const related = conclusions.filter((c) => c.dimension === dimension);
    out.push({
      id: newId('um', now),
      userId,
      statement,
      dimension,
      scope: related[0]?.scope ?? conclusions[0]!.scope,
      confidence: { score, band: score >= 0.8 ? 'high' : score >= 0.6 ? 'medium' : 'low' },
      inference: {
        distance,
        alternativeExplanations: Array.isArray(row.alternatives)
          ? row.alternatives.filter((item): item is string => typeof item === 'string')
          : ['该模式只是当前任务局部习惯'],
        rationaleSummary: asString(row.rationale) || 'skill',
      },
      derivedFrom: { conclusionIds: related.map((c) => c.id) },
      profileDependencies: [],
      counterevidence: related.flatMap((c) => c.evidence.counter),
      status: 'active',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  return out;
}

export function parsePolicySkillOutput(
  raw: unknown,
  userId: string,
  bundleId: string,
  projectId: string,
  sourceUserModelIds: readonly string[],
  now: number,
): readonly PolicyRule[] {
  if (!isObject(raw) || !Array.isArray(raw.policies)) return [];
  const out: PolicyRule[] = [];
  for (const row of raw.policies) {
    if (!isObject(row)) continue;
    const instruction = asString(row.instruction);
    const dimension = inList(row.dimension ?? row.domain, POLICY_DIMENSIONS);
    const kind = inList(row.kind, KINDS);
    const strength = inList(row.strength, STRENGTHS) ?? 'soft';
    const effect = isObject(row.effect) ? row.effect : {};
    const mode = inList(effect.mode, MODES);
    const action = asString(effect.action);
    if (!instruction || !dimension || !kind || !mode || !action) continue;
    if (!ALLOWED_ACTIONS.has(action) && action !== 'final_verification') continue;
    if (FORBIDDEN_HARD_ACTIONS.has(action)) continue;
    if (strength === 'hard' && (row.distance === 'D2' || row.inference_distance === 'D2')) continue;
    out.push({
      id: newId('pol', now),
      userId,
      bundleId,
      granularity: 'project',
      domain: dimension,
      kind,
      strength: strength === 'hard' && action === 'final_verification' ? 'hard' : strength === 'hard' ? 'strong_default' : strength,
      scope: { projectId, product: 'code' },
      when: [],
      effect: { mode, action },
      exceptions: Array.isArray(row.exceptions)
        ? row.exceptions.filter((item): item is string => typeof item === 'string')
        : ['core_runtime', 'persistent_state', 'security_boundary'],
      instruction,
      confidence: {
        score: 0.75,
        band: 'medium',
        userModelDistance: 'D1',
        translationDistance: 'T1',
      },
      governanceLevel: 2,
      sourceUserModelIds: [...sourceUserModelIds],
      sourceConclusionIds: [],
      sourceEvidenceIds: [],
      status: 'active',
      version: 1,
      createdAt: now,
    });
  }
  return out;
}

export function compactTraceForSkill(trace: UserDecisionTrace): string {
  return JSON.stringify({
    initial_request: trace.initialRequest.slice(0, 800),
    user_events: trace.userEvents
      .filter((event) => event.actor === 'user')
      .slice(-20)
      .map((event) => ({
        id: event.id,
        type: event.type,
        stage: event.stage,
        text: (event.text ?? '').slice(0, 400),
      })),
    outcome: trace.outcome,
  });
}

function redactLearningText(text: string): string {
  return text
    .replace(/\b(?:sk|api|key|token|secret|password)[-_]?[a-z0-9]{8,}\b/gi, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z]:\\[^\s"']+/g, '[REDACTED_PATH]')
    .replace(/(?:^|\s)\/(?:Users|home|var|tmp)\/[^\s"']+/g, ' [REDACTED_PATH]');
}

/** The only payload builder allowed for automatic assisted trace learning. */
export function compactTraceForLearning(
  trace: UserDecisionTrace,
  settings: LearningInferenceSettings,
): string {
  const task = classifyTaskContext({ prompt: trace.initialRequest, product: trace.product });
  return JSON.stringify({
    initial_request: redactLearningText(trace.initialRequest).slice(0, 800),
    user_events: trace.userEvents
      .filter((event) => event.actor === 'user')
      .slice(-20)
      .map((event) => ({
        id: event.id,
        type: event.type,
        stage: event.stage,
        text: redactLearningText(event.text ?? '').slice(0, 400),
      })),
    product: trace.product,
    task_risk: task.risk,
    scope_id: sourceHash([trace.workspaceId, trace.projectId, trace.product]),
    outcome: trace.outcome,
    ...(settings.allowExecutionContext
      ? { execution_result: redactLearningText(trace.executionResult ?? '').slice(0, 800) }
      : {}),
  });
}

export function compactEvidenceForSkill(items: readonly EvidenceRecord[]): string {
  return JSON.stringify(items.map((item) => ({
    id: item.id,
    claim: item.inference.claim,
    raw: item.rawObservation.text,
    channel: item.origin.channel,
    event_type: item.origin.eventType,
    stage: item.origin.stage,
    strength: item.strength.band,
    governance: item.governance.level,
    scope: item.context.scopeTags,
    project: item.context.projectId,
  })));
}

export type { PolicyDimension };
