import { CRYSTAL_MIN_SUCCESSES } from "./constants.js";
import { signalClassOf } from "./corroboration.js";
import type { ObjectiveSignal, SelfReport } from "./types.js";

/**
 * 换还是升级（规格 §5 的决策树）。
 *
 * **确定性，不跑 LLM。** 这一条是规格明写的，也是这一层能被用例逐支钉住的前提：
 * 同一个信号永远得到同一个动作，所以提议可复现、可对账、可被审计方重放。
 *
 * 两支的分法不是口味：对「没有工具能做 X」去精炼一个不存在的描述是白费力气，
 * 对「工具有但描述让我用错」去换个新工具也是白换——换完还是同一个描述。
 *
 * 第二步（A 做过还在错）才用到「换 Y 还是重升级」。判据是手上有没有可复用的
 * **成功**轨迹（Voyager 门的精神：只有成功才值得结晶）。运行时从已保存的精炼历史
 * 与有来源的任务反馈读取这两个输入；返回成功本身不构成已解决任务的证据。
 */

/** 提议的动作。前两个换、后两个升级，与规格 §5 三行一一对应。 */
export type ProposalAction =
  | { readonly kind: "replace_or_add"; readonly reason: string }
  | { readonly kind: "light_upgrade"; readonly tool: string }
  | { readonly kind: "replace_tool"; readonly tool: string }
  | { readonly kind: "heavy_upgrade"; readonly tool: string };

export type DecisionInput = {
  readonly signal: ObjectiveSignal;
  readonly report: SelfReport;
  /**
   * A（描述精炼）已经做过的工具。
   *
   * 是**工具名单**而不是布尔：一个 run 里可能有好几个工具在失败，A 只做过其中一个，
   * 另外几个仍该走轻升级。用布尔会让「做过一次」变成「大家都做过了」。
   */
  readonly refinementAttemptedFor: readonly string[];
  readonly successfulTrajectories: number;
};

const NO_TOOL_COVERS_IT = "no tool covers this capability";
const NOTHING_TO_REFINE = "no named tool to refine";

export function decideProposalAction(input: DecisionInput): ProposalAction {
  const signal = input.signal;
  if (signal.kind === "gap" && signalClassOf(signal.gap.kind) === "gap") {
    return { kind: "replace_or_add", reason: NO_TOOL_COVERS_IT };
  }

  const tool = signal.kind === "failure" ? signal.tally.tool : toolOfReport(input.report);
  if (tool === undefined) {
    // 失败类缺口但自报没点名工具：连该精炼哪个描述都不知道，只能退到「找一个
    // 现成的」。宁可少做一件事，也不去猜一个工具名。
    return { kind: "replace_or_add", reason: NOTHING_TO_REFINE };
  }

  if (!input.refinementAttemptedFor.includes(tool)) {
    return { kind: "light_upgrade", tool };
  }

  return input.successfulTrajectories >= CRYSTAL_MIN_SUCCESSES
    ? { kind: "heavy_upgrade", tool }
    : { kind: "replace_tool", tool };
}

function toolOfReport(report: SelfReport): string | undefined {
  return report.kind === "improve_tool" ? report.tool : undefined;
}
