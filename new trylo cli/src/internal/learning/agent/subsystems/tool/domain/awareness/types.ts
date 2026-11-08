import type { Criticality, GapKind, ToolGapDraft } from "../../../../../../tooling/contract/types.js";
import type { ToolOpportunityEvidence } from "./opportunity.js";

/**
 * 意识层的形状（P05 工具学习规格 §2）。
 *
 * 这一层回答的是「工具不够这件事，什么时候算被意识到了」。规格给的答案是
 * **三源信号 + 佐证规则**：客观证据 × 模型自己的话，谁都不能单独触发。
 * 下面每个类型都只承载其中一源，合并的规则在 `corroboration.ts` 一处。
 *
 * 形状与执行环那一侧的同名声明**手写两份、互不 import**（`FailureFact` 对应拍级
 * 上报的失败三元组），只在合同测试里相遇：那里要求两个类型互相可赋值，于是
 * 「声明打架」变成一次编译错误，而不是一次运行时惊喜。这一层因此不必知道
 * 执行环长什么样，也就永远没法反过来影响它。
 */

/** 一件已经结算的失败事实：哪个工具、什么码、哪种输入指纹。 */
export type FailureFact = {
  readonly tool: string;
  readonly code: string;
  readonly fingerprint: string;
};

/**
 * 本 run 的任务坐标。
 *
 * 源② 缺了它就没有「这类事」可言——缺口检测按 `taskFamily + capability` 分组，
 * 所以坐标是这一层的输入，不是它自己去猜的东西。
 */
export type TaskScope = {
  readonly taskFamily: string;
  readonly capability: string;
  readonly criticality: Criticality;
  readonly fallbackAvailable: boolean;
};

/** 源① 的聚合结果：一个工具在本 run 里失败了几次、都因为什么。 */
export type FailureTally = {
  readonly tool: string;
  readonly failures: number;
  readonly codes: readonly string[];
  readonly fingerprints: readonly string[];
};

/**
 * 源③ 解析出来的自报（规格 §2 的两种原文）。
 *
 * `improve_tool` 带 `tool`：没有它这条自报就不可行动，所以解析时宁可判它无效，
 * 也不让它变成一条「改进某个说不清的东西」的提议。
 */
export type SelfReport =
  | { readonly kind: "new_tool"; readonly need: string }
  | { readonly kind: "improve_tool"; readonly tool: string; readonly need: string };

/** 客观佐证。两类分法直接对着规格 §5 决策树的两支。 */
export type ObjectiveSignal =
  | { readonly kind: "gap"; readonly gap: ToolGapDraft }
  | { readonly kind: "failure"; readonly tally: FailureTally }
  | { readonly kind: "opportunity"; readonly evidence: ToolOpportunityEvidence };

/** 客观信号的两类。缺口类 = 没有工具能做 X；失败类 = 工具在但老用错。 */
export type SignalClass = "gap" | "failure";

/** 一个 gap 种类归哪一类（`signalClassOf` 的查表口径）。 */
export type ClassifiedGapKind = { readonly kind: GapKind; readonly signalClass: SignalClass };

/**
 * 一次意识的结论。
 *
 * `observation` 是这一层唯一允许出现的「无动作」形态，且**必带原因**：规格要求
 * 「自报单独不触发」与「客观满足而模型没报」都必须留下可读的痕迹，而不是静默。
 */
export type AwarenessOutcome =
  | { readonly kind: "silent" }
  | {
      readonly kind: "observation";
      readonly reason: "no_self_report" | "no_objective_signal";
      readonly detail: string;
    }
  | {
      readonly kind: "proposal";
      readonly signal: ObjectiveSignal;
      readonly report: SelfReport;
      readonly evidenceRefs: readonly string[];
    };
