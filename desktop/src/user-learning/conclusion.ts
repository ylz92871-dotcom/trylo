import { eligibleForLongTerm } from './evidence-grounding';
import { newId } from './ids';
import { conclusionStableKey, fingerprintScope, sameStableScope } from './scope';
import type {
  ConclusionRecord,
  ConclusionRelation,
  EvidenceRecord,
  EvidenceRelation,
  PolicyDimension,
  RelationType,
  UserLearningSnapshot,
} from './types';
import { activeRecords } from './store';

const DIMENSION_HINTS: readonly { readonly dimension: PolicyDimension; readonly re: RegExp }[] = [
  { dimension: 'verification_audit', re: /审核|review|验证|smoke|test|检查/i },
  { dimension: 'work_artifact_workflow', re: /ppt|报告|周报|文档|文稿|草稿|提案|docx|xlsx|交付|成品|先看结构|方案.*结构/i },
  { dimension: 'planning_direct_execution', re: /直接|plan|规划|方案/i },
  { dimension: 'architecture_refactor', re: /抽象|架构|subsystem|复用|复杂/i },
  { dimension: 'reporting_information_density', re: /长篇|过程|叙述|汇报|只要结论|别列步骤/i },
  { dimension: 'git_change_management', re: /commit|提交|checkpoint|git/i },
  { dimension: 'security_data_integrity', re: /安全|迁移|持久|schema|integrity|账号|支付/i },
  { dimension: 'tool_workflow', re: /电脑|桌面|屏幕|浏览器|自己点|键鼠|截屏/i },
  { dimension: 'product_ux_acceptance', re: /太花|太乱|版式|观感|咨询风|重做|不好看/i },
  { dimension: 'agent_autonomy', re: /询问|打断|自主|先问|自己做|别每步问/i },
  { dimension: 'engineering_language_semantics', re: /收口|直接干|生产级/i },
];

export function inferDimension(text: string): PolicyDimension {
  if (/报告|周报|汇报|总结|交付说明/i.test(text) && /结论优先|先说结论|只要结论|背景优先|先说背景|依据展开|详细依据|少说过程|不要过程/.test(text)) {
    return 'reporting_information_density';
  }
  if (/方案|文稿|文档|PPT|幻灯片|提案|草稿/i.test(text) && /先(?:看|给|出)?结构|结构优先|先(?:出|给|写)?完整(?:草稿|一版)|先出一版|先草稿/.test(text)) {
    return 'work_artifact_workflow';
  }
  for (const hint of DIMENSION_HINTS) {
    if (hint.re.test(text)) return hint.dimension;
  }
  return 'agent_autonomy';
}

function related(a: EvidenceRecord, b: EvidenceRecord): boolean {
  if (a.id === b.id) return false;
  if (inferDimension(a.inference.claim) === inferDimension(b.inference.claim)) return true;
  const tagsA = new Set(a.context.scopeTags);
  return b.context.scopeTags.some((t) => tagsA.has(t));
}

function classifyPair(a: EvidenceRecord, b: EvidenceRecord): RelationType | null {
  const ta = a.inference.claim;
  const tb = b.inference.claim;
  const dimA = inferDimension(ta);
  const dimB = inferDimension(tb);
  if (dimA !== dimB) return null;
  const coreA = /核心|runtime|生产|持久|迁移/.test(ta) || a.context.corePath === true;
  const coreB = /核心|runtime|生产|持久|迁移/.test(tb) || b.context.corePath === true;
  const reduceA = /减少|重复|低收益|直接/.test(ta);
  const reduceB = /减少|重复|低收益|直接/.test(tb);
  const keepA = /必须|保留|最终|生产|验证/.test(ta);
  const keepB = /必须|保留|最终|生产|验证/.test(tb);
  if (a.origin.eventType === 'authoritative_correction' && a.createdAt > b.createdAt) {
    return 'temporal_supersedes';
  }
  if ((coreA && reduceB) || (coreB && reduceA)) return 'refines_scope';
  if ((reduceA && keepB && !coreB) || (reduceB && keepA && !coreA)) {
    return 'contradicts';
  }
  if (/如果|当.*时|仅限|只在|不适用于/.test(ta) || /如果|当.*时|仅限|只在|不适用于/.test(tb)) {
    return 'conditions';
  }
  if (/抱怨|消耗|token|浪费/.test(tb) || /抱怨|消耗|token|浪费/.test(ta)) return 'explains';
  if ((reduceA && reduceB) || (keepA && keepB && coreA === coreB)) return 'same_underlying_pattern';
  if (
    a.context.projectId === b.context.projectId
    && a.origin.stage === b.origin.stage
    && a.origin.eventType !== b.origin.eventType
  ) {
    return 'co_occurs';
  }
  return 'supports';
}

export function discoverEvidenceRelations(
  fresh: readonly EvidenceRecord[],
  existing: readonly EvidenceRecord[],
  now = Date.now(),
): readonly EvidenceRelation[] {
  const pool = [...existing, ...fresh];
  const relations: EvidenceRelation[] = [];
  for (const item of fresh) {
    const candidates = pool.filter((other) => related(item, other)).slice(0, 12);
    for (const other of candidates) {
      const type = classifyPair(item, other);
      if (!type) continue;
      relations.push({
        id: newId('erel', now),
        userId: item.userId,
        fromId: item.id,
        toId: other.id,
        type,
        strength: type === 'supports' ? 0.7 : 0.8,
        explanation: `${type} between ${item.origin.eventType} and ${other.origin.eventType}`,
        confidence: 0.72,
        createdAt: now,
      });
    }
  }
  return relations;
}

function scoreConclusion(items: readonly EvidenceRecord[], counterCount = 0): { score: number; band: 'low' | 'medium' | 'high' } {
  const channels = new Set(items.map((e) => e.origin.channel));
  const bands = items.map((e) => e.strength.band);
  const hasAuthoritative = bands.some((b) => b === 'authoritative');
  const hasStrong = bands.some((b) => b === 'strong' || b === 'authoritative');
  const hasExplicit = items.some((e) => e.governance.level >= 2);
  const diversity = channels.size;
  let score = 0.5 + Math.min(0.2, items.length * 0.06) + diversity * 0.08;
  if (hasExplicit) score += 0.12;
  if (hasStrong) score += 0.12;
  if (hasAuthoritative) score += 0.08;
  if (items.some((e) => e.origin.stage === 'post_execution' || e.origin.stage === 'post_outcome')) {
    score += 0.08;
  }
  score -= Math.min(0.25, counterCount * 0.12);
  score = Math.min(0.93, Math.max(0.2, score));
  const band = score >= 0.8 ? 'high' : score >= 0.6 ? 'medium' : 'low';
  return { score, band };
}

function synthesizeStatement(dimension: PolicyDimension, items: readonly EvidenceRecord[]): string {
  const claims = items.map((e) => e.inference.claim);
  if (dimension === 'verification_audit') {
    const reduces = claims.some((c) => /减少|重复/.test(c));
    const keeps = claims.some((c) => /核心|最终|smoke|生产/.test(c));
    if (reduces && keeps) {
      return '用户反感的主要是重复、低收益审核，而不是验证本身；进入核心路径时仍要求保留高价值最终验证。';
    }
    if (reduces) {
      return '在中低风险任务中，用户倾向减少重复、同质审核。';
    }
  }
  if (dimension === 'planning_direct_execution') {
    const direct = claims.some((c) => /直接/.test(c));
    const plan = claims.some((c) => /计划|规划|plan|边界/.test(c));
    if (direct && plan) {
      return '用户的 Plan 偏好受任务风险影响：低风险可回滚任务倾向直接执行，核心或高回滚成本任务要求先明确方案。';
    }
  }
  if (dimension === 'reporting_information_density') {
    return '在执行任务中，用户对低信息密度过程性叙述接受度较低，有效反馈集中在决策、状态、产物与风险。';
  }
  return claims[0] ?? 'no_stable_conclusion';
}

export function synthesizeConclusions(
  snapshot: UserLearningSnapshot,
  fresh: readonly EvidenceRecord[],
  relations: readonly EvidenceRelation[],
  now = Date.now(),
): readonly ConclusionRecord[] {
  return synthesizeConclusionBundle(snapshot, fresh, relations, now).conclusions;
}

export function synthesizeConclusionBundle(
  snapshot: UserLearningSnapshot,
  fresh: readonly EvidenceRecord[],
  relations: readonly EvidenceRelation[],
  now = Date.now(),
): { conclusions: readonly ConclusionRecord[]; conclusionRelations: readonly ConclusionRelation[] } {
  if (fresh.length === 0) return { conclusions: [], conclusionRelations: [] };
  const byKey = new Map<string, { dimension: PolicyDimension; items: EvidenceRecord[] }>();
  const all = uniqueById([...activeRelevant(snapshot.evidence, fresh[0]!.userId), ...fresh]);
  for (const ev of all) {
    const dim = inferDimension(ev.inference.claim);
    const key = `${ev.userId}::${dim}::${fingerprintScope(ev.context)}`;
    const bucket = byKey.get(key) ?? { dimension: dim, items: [] };
    bucket.items.push(ev);
    byKey.set(key, bucket);
  }
  const out: ConclusionRecord[] = [];
  for (const [, { dimension, items }] of byKey) {
    const unique = uniqueById(items);
    if (unique.length < 1) continue;
    const hasCognition = unique.some((e) => e.origin.channel === 'cognition' || e.governance.level >= 3);
    const supporting = unique.filter((e) => e.strength.band !== 'weak' || unique.length === 1 || hasCognition);
    if (supporting.length === 0) continue;
    if (!hasCognition && supporting.every((e) => e.strength.band === 'weak') && unique.length < 2) continue;
    if (!eligibleForLongTerm(unique) && !hasCognition) continue;
    const counter = unique.filter((e) => {
      return relations.some((r) =>
        r.type === 'contradicts' && (r.fromId === e.id || r.toId === e.id));
    });
    const scoped = unique.filter((e) =>
      relations.some((r) => r.type === 'refines_scope' && (r.fromId === e.id || r.toId === e.id)));
    const statement = synthesizeStatement(dimension, unique);
    if (statement === 'no_stable_conclusion') continue;
    const strength = scoreConclusion(unique, counter.length);
    const scope = unique[0]!.context;
    out.push({
      id: newId('con', now),
      userId: unique[0]!.userId,
      statement,
      dimension,
      scope: {
        ...scope,
        scopeTags: [...new Set(unique.flatMap((e) => e.context.scopeTags))],
        corePath: unique.some((e) => e.context.corePath) || scoped.length > 0 ? unique.some((e) => e.context.corePath) : scope.corePath,
      },
      evidence: {
        supporting: supporting.map((e) => e.id),
        counter: counter.map((e) => e.id),
        contextual: scoped.map((e) => e.id),
      },
      relations: relations
        .filter((r) => unique.some((e) => e.id === r.fromId || e.id === r.toId))
        .map((r) => r.id),
      strength,
      temporal: {
        firstObserved: Math.min(...unique.map((e) => e.createdAt)),
        lastSupported: Math.max(...unique.map((e) => e.createdAt)),
        state: counter.length > 1 && unique.length >= 3
          ? 'drifting'
          : counter.length > 0 ? 'disputed' : unique.length >= 2 ? 'stable' : 'emerging',
      },
      status: 'active',
      version: 1,
      stableKey: conclusionStableKey(unique[0]!.userId, dimension, unique[0]!.context),
      createdAt: now,
      updatedAt: now,
    });
  }
  const conclusions = mergeWithExisting(snapshot.conclusions, out, now);
  return {
    conclusions,
    conclusionRelations: discoverConclusionRelations(conclusions, relations, now),
  };
}

export function discoverConclusionRelations(
  conclusions: readonly ConclusionRecord[],
  evidenceRelations: readonly EvidenceRelation[],
  now = Date.now(),
): readonly ConclusionRelation[] {
  const active = activeRecords(conclusions);
  const out: ConclusionRelation[] = [];
  for (let i = 0; i < active.length; i += 1) {
    const a = active[i]!;
    for (let j = i + 1; j < active.length; j += 1) {
      const b = active[j]!;
      if (a.dimension !== b.dimension) continue;
      const shared = evidenceRelations.some((rel) => {
        const ids = new Set([...a.evidence.supporting, ...b.evidence.supporting]);
        return ids.has(rel.fromId) && ids.has(rel.toId);
      });
      const type = a.temporal.state === 'drifting' || b.temporal.state === 'drifting'
        ? 'temporal_supersedes'
        : a.evidence.counter.some((id) => b.evidence.supporting.includes(id))
          ? 'contradicts'
          : a.scope.corePath !== b.scope.corePath
            ? 'refines_scope'
            : shared ? 'supports' : 'same_underlying_pattern';
      out.push({
        id: newId('crel', now),
        userId: a.userId,
        fromId: a.id,
        toId: b.id,
        type,
        explanation: `${type} between ${a.dimension} conclusions`,
        createdAt: now,
      });
    }
  }
  return out;
}

function activeRelevant(items: readonly EvidenceRecord[], userId: string): readonly EvidenceRecord[] {
  return items.filter((e) => e.userId === userId);
}

function uniqueById(items: readonly EvidenceRecord[]): EvidenceRecord[] {
  const seen = new Set<string>();
  const out: EvidenceRecord[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function mergeWithExisting(
  existing: readonly ConclusionRecord[],
  incoming: readonly ConclusionRecord[],
  now: number,
): readonly ConclusionRecord[] {
  const active = activeRecords(existing);
  const result: ConclusionRecord[] = [];
  for (const next of incoming) {
    const prior = active.find((c) => (
      c.dimension === next.dimension
      && c.userId === next.userId
      && sameStableScope(c.scope, next.scope)
    ));
    if (!prior) {
      result.push(next);
      continue;
    }
    if (prior.statement === next.statement) {
      result.push({
        ...prior,
        evidence: {
          supporting: uniqueStrings([...prior.evidence.supporting, ...next.evidence.supporting]),
          counter: uniqueStrings([...prior.evidence.counter, ...next.evidence.counter]),
          contextual: uniqueStrings([...prior.evidence.contextual, ...next.evidence.contextual]),
        },
        strength: next.strength.score >= prior.strength.score ? next.strength : prior.strength,
        temporal: {
          firstObserved: prior.temporal.firstObserved,
          lastSupported: now,
          state: next.temporal.state,
        },
        updatedAt: now,
      });
      continue;
    }
    result.push({
      ...next,
      version: prior.version + 1,
      supersedes: prior.id,
    });
  }
  return result;
}

function uniqueStrings(items: readonly string[]): readonly string[] {
  return [...new Set(items)];
}
