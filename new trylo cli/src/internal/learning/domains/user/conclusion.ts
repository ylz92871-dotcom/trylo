import { shortId } from "../shared/hash.js";
import {
  type ConclusionRecord,
  type EvidenceRelation,
  type PolicyDimension,
  type UserEvidence,
} from "./contracts.js";

const DIMENSION_HINTS: ReadonlyArray<{ readonly dimension: PolicyDimension; readonly pattern: RegExp }> = [
  { dimension: "verification_audit", pattern: /审核|验证|检查|测试|review/i },
  { dimension: "work_artifact_workflow", pattern: /报告|周报|文档|文稿|草稿|提案|交付|成品|方案.*结构/i },
  { dimension: "planning_direct_execution", pattern: /直接执行|先规划|先计划|plan|规划|方案/i },
  { dimension: "architecture_refactor", pattern: /抽象|架构|复用|复杂|subsystem/i },
  { dimension: "reporting_information_density", pattern: /长篇|过程|叙述|汇报|只要结论|先说结论/i },
];

/**
 * dimension 映射：报告/产物两对强式优先，其余按 hint 落子，
 * 兜底 agent_autonomy。映射只决定"规律放在哪个抽屉"，
 * 不改变证据本身，错了可在合并时被 supersede 纠正。
 */
export function inferDimension(text: string): PolicyDimension {
  if (
    /报告|周报|汇报|总结|交付说明/i.test(text) &&
    /结论优先|先说结论|只要结论|背景优先|先说背景|依据展开|详细依据|少说过程|不要过程/.test(text)
  ) {
    return "reporting_information_density";
  }

  if (
    /方案|文稿|文档|幻灯片|提案|草稿/i.test(text) &&
    /先(?:看|给|出)?结构|结构优先|先(?:出|给|写)?完整|先出一版|先草稿/.test(text)
  ) {
    return "work_artifact_workflow";
  }

  for (const hint of DIMENSION_HINTS) {
    if (hint.pattern.test(text)) {
      return hint.dimension;
    }
  }

  return "agent_autonomy";
}

function pairType(a: UserEvidence, b: UserEvidence): EvidenceRelation["type"] | null {
  if (a.id === b.id) {
    return null;
  }

  if (inferDimension(a.claim ?? "") !== inferDimension(b.claim ?? "")) {
    return null;
  }

  const textA = `${a.rawText} ${a.claim ?? ""}`;
  const textB = `${b.rawText} ${b.claim ?? ""}`;
  const coreA = /核心|生产|持久|迁移/.test(textA);
  const coreB = /核心|生产|持久|迁移/.test(textB);
  const reduceA = /减少|重复|低收益|直接/.test(textA);
  const reduceB = /减少|重复|低收益|直接/.test(textB);
  const keepA = /必须|保留|最终|验证/.test(textA);
  const keepB = /必须|保留|最终|验证/.test(textB);

  if ((coreA && reduceB) || (coreB && reduceA)) {
    return "refines_scope";
  }

  if ((reduceA && keepB && !coreB) || (reduceB && keepA && !coreA)) {
    return "contradicts";
  }

  if (/如果|当.*时|仅限|只在|不适用于/.test(textA) || /如果|当.*时|仅限|只在|不适用于/.test(textB)) {
    return "conditions";
  }

  return "supports";
}

/**
 * 证据关系发现：只在同 dimension 内连边；单条 fresh 最多连 12 条，
 * 防止一次输入把关系图炸成完全图。纯函数，不写任何存储。
 */
export function discoverEvidenceRelations(input: {
  readonly userId: string;
  readonly fresh: readonly UserEvidence[];
  readonly existing: readonly UserEvidence[];
  readonly now?: number;
}): readonly EvidenceRelation[] {
  const now = input.now ?? Date.now();
  const pool = [...input.existing, ...input.fresh];
  const relations: EvidenceRelation[] = [];

  for (const item of input.fresh) {
    const candidates = pool.filter((other) => other.id !== item.id).slice(0, 12);
    for (const other of candidates) {
      const type = pairType(item, other);
      if (type === null) {
        continue;
      }

      relations.push({
        id: shortId("erel", [item.id, other.id, type]),
        userId: input.userId,
        fromId: item.id,
        toId: other.id,
        type,
        explanation: `${type} between ${item.eventKind} and ${other.eventKind}`,
        createdAt: now,
      });
    }
  }

  return relations;
}

function scoreConclusion(supporting: readonly UserEvidence[], counterCount: number): number {
  const bands = supporting.map((item) => item.answers.governance ?? 1);
  let score = 0.5 + Math.min(0.2, supporting.length * 0.06);

  if (bands.some((level) => level >= 2)) {
    score += 0.12;
  }

  if (supporting.some((item) => item.answers.contextInformedness === "post_execution" || item.answers.contextInformedness === "post_outcome")) {
    score += 0.08;
  }

  score -= Math.min(0.25, counterCount * 0.12);

  return Math.min(0.93, Math.max(0.2, score));
}

function synthesizeStatement(dimension: PolicyDimension, items: readonly UserEvidence[]): string | null {
  const claims = items.map((item) => item.claim ?? "");

  if (dimension === "verification_audit") {
    const reduces = claims.some((claim) => /减少|重复/.test(claim));
    const keeps = claims.some((claim) => /核心|最终|生产/.test(claim));
    if (reduces && keeps) {
      return "用户反感的主要是重复、低收益审核，而不是验证本身；进入核心路径时仍要求保留高价值最终验证。";
    }

    if (reduces) {
      return "在中低风险任务中，用户倾向减少重复、同质审核。";
    }
  }

  if (dimension === "planning_direct_execution") {
    const direct = claims.some((claim) => /直接/.test(claim));
    const plan = claims.some((claim) => /计划|规划|边界/.test(claim));
    if (direct && plan) {
      return "用户的计划偏好受任务风险影响：低风险可回滚任务倾向直接执行，核心或高回滚成本任务要求先明确方案。";
    }
  }

  if (dimension === "reporting_information_density") {
    return "在执行任务中，用户对低信息密度过程性叙述接受度较低，有效反馈集中在决策、状态、产物与风险。";
  }

  const first = claims.find((claim) => claim.trim().length > 0);

  return first === undefined || first.trim().length === 0 ? null : first;
}

export type SynthesizeConclusionsInput = {
  readonly userId: string;
  readonly fresh: readonly UserEvidence[];
  readonly existing: readonly ConclusionRecord[];
  readonly relations: readonly EvidenceRelation[];
  readonly scopeFingerprint: string;
  readonly now?: number;
};

/**
 * 结论合成 + 去重合并：按 dimension 分桶；单条弱证据不成结论
 * （除非治理 ≥3 或凑成 ≥2 条）；同 stableKey 同 statement 合并 id 列表，
 * 换 statement 则 version+1 并 supersede 旧版。旧结论只读传入，不原地改。
 */
export function synthesizeConclusions(input: SynthesizeConclusionsInput): readonly ConclusionRecord[] {
  const now = input.now ?? Date.now();

  if (input.fresh.length === 0) {
    return [];
  }

  const byDimension = new Map<PolicyDimension, UserEvidence[]>();

  for (const item of input.fresh) {
    const dimension = inferDimension(item.claim ?? "");
    const bucket = byDimension.get(dimension) ?? [];
    bucket.push(item);
    byDimension.set(dimension, bucket);
  }

  const incoming: ConclusionRecord[] = [];

  for (const [dimension, items] of byDimension) {
    const strong = items.filter((item) => (item.answers.governance ?? 1) >= 2);
    if (strong.length === 0 && items.length < 2) {
      continue;
    }

    const counter = items.filter((item) =>
      input.relations.some(
        (relation) =>
          relation.type === "contradicts" &&
          (relation.fromId === item.id || relation.toId === item.id),
      ),
    );
    const contextual = items.filter((item) =>
      input.relations.some(
        (relation) =>
          relation.type === "refines_scope" &&
          (relation.fromId === item.id || relation.toId === item.id),
      ),
    );
    const statement = synthesizeStatement(dimension, items);
    if (statement === null) {
      continue;
    }

    const strength = scoreConclusion(items, counter.length);
    const stableKey = [input.userId, dimension, input.scopeFingerprint].join("::");

    incoming.push({
      id: shortId("con", [stableKey, statement]),
      userId: input.userId,
      statement,
      dimension,
      scopeFingerprint: input.scopeFingerprint,
      supporting: items.map((item) => item.id),
      counter: counter.map((item) => item.id),
      contextual: contextual.map((item) => item.id),
      strength,
      temporalState: counter.length > 0 ? "disputed" : items.length >= 2 ? "stable" : "emerging",
      status: "active",
      version: 1,
      stableKey,
      createdAt: now,
      updatedAt: now,
    });
  }

  return mergeWithExisting(input.existing, incoming, now);
}

function mergeWithExisting(
  existing: readonly ConclusionRecord[],
  incoming: readonly ConclusionRecord[],
  now: number,
): ConclusionRecord[] {
  const active = existing.filter((item) => item.status === "active");
  return incoming.map((next) => {
    const prior = active.find((item) => item.stableKey === next.stableKey);
    if (prior === undefined) {
      return next;
    }

    if (prior.statement === next.statement) {
      return {
        ...prior,
        supporting: [...new Set([...prior.supporting, ...next.supporting])],
        counter: [...new Set([...prior.counter, ...next.counter])],
        contextual: [...new Set([...prior.contextual, ...next.contextual])],
        strength: Math.max(prior.strength, next.strength),
        updatedAt: now,
      };
    }

    return { ...next, version: prior.version + 1, supersedes: prior.id };
  });
}
