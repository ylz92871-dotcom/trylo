import { shortId } from "../shared/hash.js";
import {
  type ConclusionRecord,
  type ConfidenceScore,
  type ConfirmationState,
  type InferenceDistance,
  type UserModelRecord,
} from "./contracts.js";

const TRAIT_MARK = /懒|笨|差|讨厌|没有耐心|人格|性格|心理/;
const RELIABILITY_MARK = /信号|可靠性|不应|不适合作为|验收/;

const DISTANCE_CAP: Record<Exclude<InferenceDistance, "D3">, number> = {
  D0: 0.95,
  D1: 0.88,
  D2: 0.72,
};

/**
 * 推断距离：D0 用户原话直给；D1 可靠信号转述；D2 需要跨一步的解读；
 * D3 人格/特质评判——永不持久化，由 reasonUserModels 强制拒绝。
 */
export function classifyInferenceDistance(statement: string, conclusion: string): InferenceDistance {
  if (TRAIT_MARK.test(statement)) {
    return "D3";
  }

  if (RELIABILITY_MARK.test(statement)) {
    return "D1";
  }

  const head = conclusion.slice(0, 24);
  if ((head.length > 0 && statement.startsWith(head)) || similar(statement, conclusion)) {
    return "D0";
  }

  return "D2";
}

function similar(a: string, b: string): boolean {
  return a.slice(0, 40) === b.slice(0, 40) || (a.length >= 18 && b.startsWith(a.slice(0, 18)));
}

/**
 * 模型陈述不照抄结论：stable 且无反证 → 原话直给（D0）；
 * 有反证/漂移 → 加可靠性护栏（D1）；emerging → 加语境限定（D2）。
 * 距离由 classifyInferenceDistance 独立判定，这里只负责措辞。
 */
function modelStatementFor(conclusion: ConclusionRecord): string {
  if (conclusion.counter.length > 0 || conclusion.temporalState === "disputed") {
    return `${conclusion.statement}（该信号可靠性仍受反证约束，不应直接作为跨任务验收标准。）`;
  }

  if (conclusion.temporalState === "emerging") {
    return `在当前项目语境下，用户可能倾向：${conclusion.statement}`;
  }

  return conclusion.statement;
}

function bandFor(score: number): ConfidenceScore {
  return {
    score,
    band: score >= 0.8 ? "high" : score >= 0.6 ? "medium" : "low",
  };
}

export type UserModelRejection = {
  readonly conclusionId: string;
  readonly reason: "d3_forbidden" | "weak_conclusion" | "empty_statement";
};

export type ReasonUserModelsInput = {
  readonly userId: string;
  readonly conclusions: readonly ConclusionRecord[];
  readonly existing?: readonly UserModelRecord[];
  /** 调用方按 scope 指纹给出的作用范围置信（0..1），缺省 0.7，不许代答。 */
  readonly scopeConfidence?: number;
  readonly confirmations?: Readonly<Record<string, ConfirmationState>>;
  readonly now?: number;
};

export type ReasonUserModelsResult = {
  readonly models: readonly UserModelRecord[];
  readonly rejected: readonly UserModelRejection[];
};

/**
 * 由结论推断分域用户模型：四分置信分别保存。
 * truth ← 结论强度经距离封顶；scope ← 调用方传入；
 * effectiveness ← 永远 unknown（只有明确 outcome 反馈才能改，那是接线的活）；
 * confirmation ← 调用方传入，缺省 unconfirmed。
 * D3、空 statement、弱结论 + D2 一律拒绝且不持久化。
 */
export function reasonUserModels(input: ReasonUserModelsInput): ReasonUserModelsResult {
  const now = input.now ?? Date.now();
  const scopeScore = input.scopeConfidence ?? 0.7;
  const models: UserModelRecord[] = [];
  const rejected: UserModelRejection[] = [];
  const live = (input.existing ?? []).filter((item) => item.status === "active");

  for (const conclusion of input.conclusions) {
    if (conclusion.status !== "active") {
      continue;
    }

    if (conclusion.statement.trim().length === 0) {
      rejected.push({ conclusionId: conclusion.id, reason: "empty_statement" });
      continue;
    }

    const statement = modelStatementFor(conclusion);
    const distance = classifyInferenceDistance(statement, conclusion.statement);
    if (distance === "D3") {
      rejected.push({ conclusionId: conclusion.id, reason: "d3_forbidden" });
      continue;
    }

    if (conclusion.strength < 0.6 && distance === "D2") {
      rejected.push({ conclusionId: conclusion.id, reason: "weak_conclusion" });
      continue;
    }

    const truth = bandFor(Math.min(DISTANCE_CAP[distance], conclusion.strength));
    const stableKey = [input.userId, conclusion.dimension, conclusion.scopeFingerprint].join("::");
    const prior = live.find((item) => item.stableKey === stableKey);

    models.push({
      id: shortId("um", [stableKey, conclusion.id, String(prior?.version ?? 0)]),
      userId: input.userId,
      statement,
      dimension: conclusion.dimension,
      scopeFingerprint: conclusion.scopeFingerprint,
      truth,
      scope: bandFor(scopeScore),
      effectiveness: "unknown",
      confirmation: input.confirmations?.[conclusion.id] ?? "unconfirmed",
      distance,
      alternativeExplanations:
        conclusion.counter.length > 0
          ? ["反证表明该模式可能只适用于特定任务类型或风险等级"]
          : ["该模式可能只是当前项目局部习惯", "该模式可能只适用于单一任务类型"],
      derivedFromConclusionIds: [conclusion.id],
      counterevidence: [...conclusion.counter],
      status: "active",
      version: (prior?.version ?? 0) + 1,
      ...(prior === undefined ? {} : { supersedes: prior.id }),
      stableKey,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { models, rejected };
}
