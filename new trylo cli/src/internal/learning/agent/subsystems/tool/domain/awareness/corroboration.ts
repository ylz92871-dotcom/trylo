import { detectToolGap } from "../gap-detector.js";
import type { GapKind, ToolGapDraft, ToolLearningObservation } from "../../../../../../tooling/contract/types.js";
import { ok, type Result } from "../../../../../../tooling/contract/result.js";
import { tallyToolFailures, toolsAtOrOverThreshold } from "./failure-stats.js";
import { observationsFromFailures } from "./gap-adapt.js";
import { parseSelfReport } from "./self-report.js";
import type { AwarenessOutcome, FailureFact, ObjectiveSignal, SignalClass, TaskScope } from "./types.js";

/**
 * 佐证规则：这一层存在的全部理由（规格 §2 末段）。
 *
 * 规格把难点写成一句话——客观失败只说明「这次没成」，模型自己的感受又不可全信，
 * 所以 **谁都不能单独触发**。落到代码上就是一次与：
 *
 * ```
 * 提议 = 模型说了话  AND  客观证据也在
 * ```
 *
 * 两个方向都要能失败，而且**失败的样子必须不同**：
 *
 *  - 模型说了话、客观没有 → `observation(no_objective_signal)`：它可能只是这次运气
 *    不好，记下来，别动工具。
 *  - 客观有、模型没说（或者围栏坏了） → `observation(no_self_report)`：数据说工具
 *    有问题，但没人能说清问题是什么，换个工具也是乱换。
 *  - 两边都没有 → `silent`：无证据时不自言自语。
 *
 * 于是「意识到」这个词在这里是**可证伪**的：它不是模型的一次表态，也不是一次
 * 失败计数，而是两者相遇的那一刻。
 */

/**
 * 缺口类 = 没有工具能做这件事。其余 gap 种类都归失败类（工具有，但老用错）。
 *
 * 分法直接对着规格 §5 决策树的两支：缺口类去候选获取层找新工具，失败类先试
 * A 描述精炼——对「没有工具能用」去精炼一个不存在的描述是白费力气，反过来对
 * 「描述让我用错」去换个新工具也是白换。所以这个分类是决策树的地基，不是装饰。
 */
const GAP_CLASS_KINDS: ReadonlySet<GapKind> = new Set<GapKind>([
  "tool_not_found",
  "capability_mismatch",
  "excessive_manual_workaround",
]);

export function signalClassOf(kind: GapKind): SignalClass {
  return GAP_CLASS_KINDS.has(kind) ? "gap" : "failure";
}

/**
 * 客观信号（源① ∪ 源②）。
 *
 * 两条都在时**缺口类优先**：「没有工具能做 X」比「工具有但用错」更根本，而且
 * 前者的修法（找替代）对后者不适用、后者的修法（精炼描述）对前者无效——两个
 * 都要动，但一次只提议一件，先动更根本的那件。
 *
 * 返回 `undefined` 表示**没有客观证据**，不是出错。出错只有一种：适配都做不了
 * （坐标非法），那时 `assessToolAwareness` 会 fail closed 成静默。
 */
export function objectiveSignalOf(
  observations: readonly ToolLearningObservation[],
  facts: readonly FailureFact[],
): Result<ObjectiveSignal | undefined, "invalid_observation"> {
  const over = toolsAtOrOverThreshold(tallyToolFailures(facts));
  const detection = detectToolGap(observations);
  if (detection.ok && detection.value.decision === "gap") {
    const gap: ToolGapDraft = detection.value.gap;
    if (signalClassOf(gap.kind) === "gap") {
      return ok({ kind: "gap", gap });
    }
    const tally = over[0];
    return ok(tally === undefined ? { kind: "gap", gap } : { kind: "failure", tally });
  }

  const tally = over[0];

  return ok(tally === undefined ? undefined : { kind: "failure", tally });
}

export type AwarenessInput = {
  readonly failures: readonly FailureFact[];
  readonly scope: TaskScope;
  readonly recordedAt: string;
  /** 围栏原文，**未解析**。缺席 = 模型没写围栏。 */
  readonly selfReport?: unknown;
};

const NO_REPORT_DETAIL = "objective failure evidence without a model self-report";
const NO_SIGNAL_DETAIL = "model self-report without objective corroboration";

export function assessToolAwareness(input: AwarenessInput): AwarenessOutcome {
  const report = parseSelfReport(input.selfReport);
  const adapted = observationsFromFailures(input.failures, input.scope, input.recordedAt);
  if (!adapted.ok) {
    return { kind: "silent" };
  }

  const signal = objectiveSignalOf(adapted.value, input.failures);
  const objective = signal.ok ? signal.value : undefined;

  if (report === undefined) {
    return objective === undefined
      ? { kind: "silent" }
      : { kind: "observation", reason: "no_self_report", detail: NO_REPORT_DETAIL };
  }

  if (objective === undefined) {
    return { kind: "observation", reason: "no_objective_signal", detail: NO_SIGNAL_DETAIL };
  }

  return {
    kind: "proposal",
    signal: objective,
    report,
    evidenceRefs: adapted.value.map((observation) => observation.observationId),
  };
}
