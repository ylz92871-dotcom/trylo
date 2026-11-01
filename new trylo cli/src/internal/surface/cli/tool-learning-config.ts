import path from "node:path";
import {
  createFileRefinementStore,
  createFileToolLedger,
  createToolGapRuntime,
  type ToolGapRuntime,
} from "../../integration/tool-learning/index.js";
import { overlayFor } from "../../learning/domains/tool/refine/index.js";
import type { DescriptionOverlay } from "../../learning/domains/tool/refine/types.js";
import { switchEnablesTool, type LearningSwitch } from "../../integration/user-learning/index.js";
import { methodLearningRoot } from "./learning-sink.js";
import { handoffPendingToolPlans } from "../../integration/tool-learning/outbox-handoff.js";
import { ToolOutboxError } from "../../integration/tool-learning/outbox-reader.js";

/**
 * 工具学习的宿主侧装配（P05 工具学习 TP-1 §12）。
 *
 * 同型于 `user-learning-config.ts`，同样三条纪律：
 *
 *  - **家只有一个公式。** 工具账的根是 `methodLearningRoot(...)/tool`，而
 *    `methodLearningRoot` 是 `tryloHome(...)/learning` 的唯一一份。本文件不重拼
 *    任何一段路径。
 *  - **宿主只交事实，不交路径。** `homeDir` + `env` 进来，根在这里解；于是
 *    `TRYLO_HOME` 被设置的那天不会出现「两个家只搬一个」。
 *  - **缺席即零构造。** 开关没点名工具学习那一半，返回的就是空对象；没有 host，
 *    `createToolGapRuntime` 根本不会被调用，不建目录、不读账、不写一行。
 *
 * `toolGapHostFor` 这个函数存在的理由有一半是**行数**：`run-command.ts` 撞着包内
 * 400 行纪律（`exec-substrate-discipline.test.ts` #25），把开关判定与 host 构造
 * 搬到这里，调用点就只剩一个三行的 spread。这不是为了好看——尺寸门要求的是**拆件**，
 * 而不是把上限抬上去。
 */

/** 工具账的根：`tryloHome/learning/tool`。 */
export function toolLearningRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return path.join(methodLearningRoot(homeDir, env), "tool");
}

export type ToolLearningHost = {
  readonly workspaceId?: string;
  readonly afterEnqueue?: (jobIds: readonly string[]) => Promise<void>;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  /** 提议与降级说给谁听。每次运行最多几行。 */
  readonly warn: (message: string) => void;
};

/** 宿主交给组合根的那三样事实。 */
export type ToolLearningFacts = {
  readonly workspaceId?: string;
  readonly afterEnqueue?: (jobIds: readonly string[]) => Promise<void>;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  readonly stderr: (text: string) => void;
};

/**
 * 开关 + 宿主事实 → 组合根要的那半个输入。
 *
 * 判据只有一处（`switchEnablesTool`），所以「哪个取值点亮工具学习」这个问题在
 * 全仓只有一个答案。不点亮时返回 `{}`：调用点的 spread 于是什么都不加，这正是
 * 「关学习零差异」在命令行这一层的样子。
 */
export function toolGapHostFor(
  switchValue: LearningSwitch | undefined,
  facts: ToolLearningFacts,
): { readonly toolGap?: ToolLearningHost } {
  if (!switchEnablesTool(switchValue)) {
    return {};
  }
  return {
    toolGap: {
      homeDir: facts.homeDir,
      env: facts.env,
      now: facts.now,
      warn: (message) => facts.stderr(`warning: ${message}\n`),
      ...(facts.workspaceId === undefined ? {} : { workspaceId: facts.workspaceId }),
      ...(facts.afterEnqueue === undefined ? {} : { afterEnqueue: facts.afterEnqueue }),
    },
  };
}

export function createToolGapRuntimeFor(host: ToolLearningHost): ToolGapRuntime {
  const ledger = createFileToolLedger(toolLearningRoot(host.homeDir, host.env));
  const runtime = createToolGapRuntime({
    ledger,
    now: host.now,
    warn: host.warn,
    ...(host.workspaceId === undefined ? {} : { pipelineScope: host.workspaceId }),
  });
  let closing: Promise<void> | undefined;
  return { ...runtime, close: () => closing ??= flushToolGapPlans(host, runtime, ledger) };
}

async function flushToolGapPlans(host: ToolLearningHost, runtime: ToolGapRuntime, ledger: ReturnType<typeof createFileToolLedger>): Promise<void> {
  const details = runtime.proposalDetails();
  await runtime.close();
  if (host.workspaceId === undefined) {
    if (details.length > 0) host.warn("tool learning: workspace identity missing; gap was not queued");
    return;
  }
  try {
    const jobIds = await handoffPendingToolPlans({ ledger, boardRoot: path.join(methodLearningRoot(host.homeDir, host.env), "board"),
      scope: host.workspaceId, now: host.now, warn: host.warn });
    await host.afterEnqueue?.(jobIds);
  } catch (error) {
    // The user's answer is already complete; do not replace it with learning I/O failure.
    host.warn(`tool learning: post-turn work unavailable${error instanceof ToolOutboxError ? ` (${error.code})` : ""}; inspect tools jobs before retrying`);
  }
}

/**
 * A 描述精炼的覆盖层（P05 工具学习规格 §6 的注入点那一半）。
 *
 * 同 `toolGapHostFor` 的形状与理由：**判据只有一处**（`switchEnablesTool`），不点亮时
 * 返回 `{}`，于是关学习的运行里 `openMcpRuntime` 收到的描述覆盖层根本不存在——「关学习
 * 零可观察差异」（验收 #11）在这一层是字面事实，不是一句要记得遵守的纪律。
 *
 * **同步读一次，构造即完成。** `mount.ts::bindingForSpec` 是同步的，所以覆盖层必须在
 * 挂载那一刻就在内存里；`createFileRefinementStore` 因此在构造时把文件读进来，之后
 * 每次写同步落盘。代价是这里会有一次很小的同步读——换来的是「挂载不必先 await 一次
 * 覆盖层」，那个要求比这点读代价贵得多。
 *
 * 只在**工具学习点亮时**才碰这个文件：关学习时它不建目录、不读文件、不写一行，覆盖层
 * 是不存在的，不是空的。
 */
export function refineOverlayFor(
  switchValue: LearningSwitch | undefined,
  facts: ToolLearningFacts,
): { readonly descriptionOverlay?: DescriptionOverlay } {
  if (!switchEnablesTool(switchValue)) {
    return {};
  }
  const store = createFileRefinementStore(toolLearningRoot(facts.homeDir, facts.env));
  return { descriptionOverlay: overlayFor(store) };
}
