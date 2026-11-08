import { shortId } from "../shared/hash.js";
import {
  type BehaviorCommitment,
  type BehaviorDelta,
  type CommitmentState,
  type EligibilityDecision,
  type UserEvidence,
  type UserModelRecord,
} from "./contracts.js";
import { inferDimension } from "./conclusion.js";

export const DECISION_POINTS = ["report.section_order", "artifact.structure_before_draft"] as const;

export type DecisionPoint = (typeof DECISION_POINTS)[number];

const PERSIST_MARK = /以后|今后|每次|一直|默认|项目里|这个项目|长期/;

/**
 * 用户模型 → 决策点：只有落到具体决策的模型才产承诺，
 * 落不上去的模型继续当判断养着，不硬编行为。
 */
export function decisionPointFor(dimension: UserModelRecord["dimension"]): DecisionPoint | null {
  switch (dimension) {
    case "reporting_information_density":
      return "report.section_order";
    case "work_artifact_workflow":
      return "artifact.structure_before_draft";
    default:
      return null;
  }
}

function deltaFor(point: DecisionPoint, evidence: readonly UserEvidence[]): BehaviorDelta {
  const text = evidence.map((item) => `${item.rawText} ${item.claim ?? ""}`).join(" ");

  if (point === "report.section_order") {
    const adapted = /背景优先|先说背景/.test(text)
      ? "先给必要背景，再给结论与依据"
      : /依据展开|详细依据/.test(text)
        ? "先给结论，并默认展开关键依据"
        : "先给结论，再按需展开背景与依据";
    return {
      decisionPoint: point,
      baselineBehavior: "按通用模板组织报告章节",
      adaptedBehavior: adapted,
      expectedBenefit: "减少用户为了找到结论而重新要求调整结构的成本",
      rollbackBehavior: "恢复通用报告章节顺序",
    };
  }

  const structureFirst = /先(?:看|给|出)?结构|结构优先/.test(text);

  return {
    decisionPoint: point,
    baselineBehavior: "按通用流程直接生成交付稿",
    adaptedBehavior: structureFirst ? "先提交结构供确认，再展开完整文稿" : "先给可看的完整草稿，再迭代结构",
    expectedBenefit: "减少文稿方向不合适导致的大范围返工",
    rollbackBehavior: "恢复通用文稿生成流程",
  };
}

export type CompileCommitmentsInput = {
  readonly userId: string;
  readonly models: readonly UserModelRecord[];
  readonly evidence: readonly UserEvidence[];
  readonly eligibility: readonly EligibilityDecision[];
  readonly existing?: readonly BehaviorCommitment[];
  readonly product?: "code" | "work" | "unknown";
  readonly mode?: "shadow" | "enforced" | "off";
  readonly now?: number;
};

/**
 * 行为承诺编译：每个 active 承诺必须能回溯到证据（provenance 链）。
 * 只有 personalization_candidate 的证据能当来源；无来源的模型不产承诺。
 * 状态机：disputed/retired 模型 → paused/retracted；显式表达且 mode 未关 →
 * shadow（默认）；其余 → candidate。active 只能由接线方以后推进，
 * 本模块永不自封 active。
 */
export function compileBehaviorCommitments(input: CompileCommitmentsInput): readonly BehaviorCommitment[] {
  const now = input.now ?? Date.now();
  const product = input.product ?? "unknown";
  const mode = input.mode ?? "shadow";
  let output = [...(input.existing ?? [])];
  const eligibleEvidenceIds = new Set(
    input.eligibility
      .filter((decision) => decision.classification === "personalization_candidate")
      .flatMap((decision) => decision.sourceEvidenceIds),
  );

  for (const model of input.models) {
    const point = decisionPointFor(model.dimension);
    if (point === null) {
      continue;
    }

    const sources = input.evidence.filter(
      (item) =>
        eligibleEvidenceIds.has(item.id) &&
        inferDimension(item.claim ?? "") === model.dimension &&
        input.eligibility.some((decision) => decision.sourceEvidenceIds.includes(item.id)),
    );
    if (sources.length === 0) {
      continue;
    }

    const stableKey = [input.userId, point, model.scopeFingerprint].join("::");
    const prior = [...output]
      .reverse()
      .find((item) => item.stableKey === stableKey && item.state !== "superseded");
    const explicit = sources.some(
      (item) =>
        (item.answers.governance ?? 1) >= 3 || PERSIST_MARK.test(`${item.rawText} ${item.claim ?? ""}`),
    );
    const state: CommitmentState =
      model.status === "disputed"
        ? "paused"
        : model.status === "retired" || model.status === "superseded"
          ? "retracted"
          : explicit && mode !== "off"
            ? "shadow"
            : "candidate";
    const commitment: BehaviorCommitment = {
      id: shortId("bc", [stableKey, model.id, String(prior?.version ?? 0)]),
      userModelId: model.id,
      scopeFingerprint: model.scopeFingerprint,
      conditions: [`product=${product}`],
      behaviorDelta: deltaFor(point, sources),
      state,
      provenanceEvidenceIds: sources.map((item) => item.id),
      activation: explicit ? "explicit" : "confirmed_inference",
      stableKey,
      version: (prior?.version ?? 0) + 1,
      ...(prior === undefined ? {} : { supersedes: prior.id }),
      createdAt: now,
      updatedAt: now,
    };

    output = [
      ...output.map((item) => (item.id === prior?.id ? { ...item, state: "superseded" as const } : item)),
      commitment,
    ];
  }

  return output;
}
