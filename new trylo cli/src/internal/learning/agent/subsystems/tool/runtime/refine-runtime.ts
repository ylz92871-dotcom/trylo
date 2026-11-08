import type { ToolRunnerPort } from "../../../../../ports/tool-runner-port.js";
import {
  parseRefinement,
  refinementPrompt,
  REFINE_MAX_EVIDENCE_IN_PROMPT,
} from "../domain/refine/analysis.js";
import {
  guardRefinedText,
  isConverged,
  promoteToEnforced,
  refineEntryFor,
  rollbackToShadow,
  shouldProposeRefinement,
} from "../domain/refine/overlay.js";
import type {
  RefinementEntry,
  RefinementStore,
  RefineTriggerVerdict,
} from "../domain/refine/types.js";

/**
 * A 描述精炼的运行时（P05 工具学习规格 §6 的「循环」那一段）。
 *
 * 它把三样东西接起来：**该不该精炼**（域层纯函数）、**精炼本身**（一次 LLM 往返，
 * 经 `ToolRunnerPort`）、**记在哪里**（覆盖层 store）。三个动作，一个都不多做：
 *
 *  - `attempt` —— 攒够了就分析一次，产出一版 **shadow**；
 *  - `promote` —— 人审通过 → enforced；
 *  - `rollback` —— 退回原文。
 *
 * `promote` 与 `rollback` 是**留给人的**，不是留给执行环的。所以它们在这里的形态是
 * 「可以被调用」，而不是「在某个时点被自动调用」——本层没有任何一行代码会在没有
 * 外部指令的情况下把一版精炼变成 enforced。这是「Agent 只提议」在 A 描述精炼上
 * 的落点，也是规格验收 #6 的第一句。
 *
 * ## 为什么经 ToolRunnerPort
 *
 * 规格 §8 要求获取/精炼/结晶**全部经 `ToolRunnerPort`** 跑。所以这里不直接调模型，
 * 而是提交一个后台任务再等它——TP-1 当时停下不做 A，正是因为真执行器没到位；
 * SAS 把 `SubagentToolRunner` 交了之后，这一段才有东西可接。
 */

export type RefineRuntimeHost = {
  readonly store: RefinementStore;
  readonly runner: ToolRunnerPort;
  readonly now: () => number;
  /** 降级说给谁听——精炼失败不该是静默的。 */
  readonly warn: (message: string) => void;
};

/**
 * 一次精炼尝试要的输入。
 *
 * `evidenceRefs` 是**证据的引用**（哪几条失败），不是失败正文：提示词要的是「模型在
 * 哪用错」，而引用能让人审时回去看原始那几条。上游把引用攒好交进来，本层不自己去
 * 翻执行环的历史——那样会让这一层依赖执行环的形状。
 */
export type RefineAttemptInput = {
  readonly tool: string;
  readonly originalDescription: string;
  readonly evidenceCount: number;
  readonly evidenceRefs: readonly string[];
  /** 上一版精炼之后有没有新的失败（规格 §6 无嵌入版的退化判据）。 */
  readonly hasNewEvidenceSince: boolean;
};

export type RefineOutcome =
  | { readonly kind: "written"; readonly entry: RefinementEntry }
  | {
      readonly kind: "skipped";
      readonly reason: Extract<RefineTriggerVerdict, { readonly kind: "skip" }>["reason"];
    }
  | {
      readonly kind: "failed";
      readonly reason: "runner_error" | "unparseable" | "converged" | "guarded";
    };

export type RefineRuntime = {
  readonly attempt: (input: RefineAttemptInput) => Promise<RefineOutcome>;
  /** 人审通过。返回改过的条目；没有这一版精炼时返回 `undefined`。 */
  readonly promote: (tool: string) => RefinementEntry | undefined;
  /** 退回原文。历史留着，见域层的 `rollbackToShadow`。 */
  readonly rollback: (tool: string) => RefinementEntry | undefined;
  /** 当前覆盖层里所有条目（人审界面/doctor 要看的）。 */
  readonly entries: () => readonly RefinementEntry[];
};

/** 后台任务的稳定名字，方便进度/日志认领。 */
export const REFINE_TASK_NAME = "tool-description-refine";

/** 一次精炼的分析预算。够一次重写，不够让执行器在里面绕圈。 */
export const REFINE_TASK_TIMEOUT_MS = 60_000;

export function createRefineRuntime(host: RefineRuntimeHost): RefineRuntime {
  let seq = 0;

  const attempt = async (input: RefineAttemptInput): Promise<RefineOutcome> => {
    const previous = host.store.entryFor(input.tool);
    const verdict = shouldProposeRefinement({
      evidenceCount: input.evidenceCount,
      entry: previous,
      hasNewEvidenceSince: input.hasNewEvidenceSince,
    });
    if (verdict.kind === "skip") {
      return { kind: "skipped", reason: verdict.reason };
    }

    const taskId = `refine-${host.now()}-${(seq += 1)}`;
    const submitted = await host.runner.submit({
      taskId,
      name: REFINE_TASK_NAME,
      input: {
        tool: input.tool,
        prompt: refinementPrompt({
          tool: input.tool,
          originalDescription: input.originalDescription,
          evidenceRefs: input.evidenceRefs.slice(0, REFINE_MAX_EVIDENCE_IN_PROMPT),
        }),
      },
      timeoutMs: REFINE_TASK_TIMEOUT_MS,
    });
    const result = await host.runner.wait(submitted.taskId, REFINE_TASK_TIMEOUT_MS);
    if (result.status !== "completed") {
      // 后台跑挂了、超时了、被取消了——都是「这一版没产出」，不是「工具有问题」。
      // 回原文，说一声，下一次有新证据再来。
      host.warn(`tool learning: description refinement for ${input.tool} did not complete (${result.status})\n`);
      return { kind: "failed", reason: "runner_error" };
    }

    const parsed = parseRefinement(textOf(result.output));
    if (!parsed.ok) {
      host.warn(`tool learning: description refinement for ${input.tool} was unreadable (${parsed.reason})\n`);
      return { kind: "failed", reason: "unparseable" };
    }

    // 收敛线（规格 §6）：与上一版几乎一样就别写。写下去只会让账里多一条没有信息量的
    // 变更，而它下次还要被人审一遍。
    if (previous !== undefined && isConverged(previous.refinedDescription, parsed.description)) {
      return { kind: "failed", reason: "converged" };
    }

    // 精炼文本自己也要过守卫。过不了就退回原文，不写这一版（域层 `guardRefinedText`
    // 解释了为什么不是「拒绝工具」）。
    const guarded = guardRefinedText({ refined: parsed.description, original: input.originalDescription });
    if (guarded.degraded) {
      host.warn(`tool learning: description refinement for ${input.tool} failed the description guard\n`);
      return { kind: "failed", reason: "guarded" };
    }

    const entry = refineEntryFor({
      tool: input.tool,
      originalDescription: input.originalDescription,
      refinedDescription: guarded.text,
      evidenceRefs: input.evidenceRefs,
      at: new Date(host.now()).toISOString(),
      previous,
    });

    host.store.save(entry);
    // 只提议、不改行为：这一行说的是「有一版精炼等人看」，不是「已生效」。
    host.warn(`tool learning: description refinement staged in shadow for ${input.tool}\n`);

    return { kind: "written", entry };
  };

  return {
    attempt,
    promote: (tool) => {
      const entry = host.store.entryFor(tool);
      if (entry === undefined) {
        return undefined;
      }

      const promoted = promoteToEnforced(entry);

      host.store.save(promoted);

      return promoted;
    },
    rollback: (tool) => {
      const entry = host.store.entryFor(tool);
      if (entry === undefined) {
        return undefined;
      }

      const rolled = rollbackToShadow(entry);

      host.store.save(rolled);

      return rolled;
    },
    entries: () => host.store.all(),
  };
}

/** 执行器交回来的输出 → 一段文本。不是字符串就当没答。 */
function textOf(output: unknown): string {
  return typeof output === "string" ? output : "";
}
