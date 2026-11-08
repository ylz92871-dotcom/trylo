import type { ObservedFailureFact } from "./method-port.js";

/**
 * 执行侧对第二型围栏的声明（P05 工具学习规格 §2 源③）。
 *
 * 与学习侧那份（同名文件在 `learning/domains/tool/awareness/`）是一对，两份手写、
 * 互不 import：执行环是冻结核心，学习层不得伸手进来（`boundary.test.ts` 会把任何
 * 一条 `执行侧 -> 学习侧` 的 import 判红，而那道门只看生产文件）。两份只在合同
 * 测试里相遇，那里要求互相可赋值。
 *
 * 为什么另起一个口而不是塞进学习方法子系统的口里：规格 §2 明写这台是**独立的
 * 一台**，不复用方法子系统的机器。共用会带来一个看不见的耦合——方法子系统改它的
 * 拍语义时，会顺手改到工具自报的触发时机，而这两件事只共享「模型的一拍回答」，
 * 不共享任何策略。
 */

/** 围栏标记。与学习侧那份逐字相同，由合同测试要求相等。 */
export const TOOL_GAP_FENCE = "trylo-tool-gap";

/** Settled execution facts only; task quality and causal diagnosis are separate reports. */
export type ToolExecutionFact = {
  readonly tool: string;
  readonly toolCallId: string;
  readonly versionId?: string;
  readonly inputHash?: string;
  readonly outputHash?: string;
  readonly execution: "returned" | "tool_error" | "timeout" | "protocol_error" | "cancelled" | "unavailable";
  readonly durationMs?: number;
};

export type ToolGapBeatObservation = {
  readonly turnId: string;
  readonly beat: number;
  readonly failures: ReadonlyArray<ObservedFailureFact>;
  readonly toolNames: ReadonlyArray<string>;
  readonly executions?: readonly ToolExecutionFact[];
  /** 本拍抽出的自报原文；缺席 = 这一拍没有自报。 */
  readonly selfReport?: string;
};

export type ToolGapPromptRequest = {
  readonly turnId: string;
  readonly beat: number;
  readonly toolNames: ReadonlyArray<string>;
};

/** 注入的那一条消息：`system`，且仅此一条。 */
export type ToolGapPrompt = {
  readonly role: "system";
  readonly content: string;
};

/**
 * 执行环持有的工具学习意识层。
 *
 * `intentOn` 同步且纯读：它决定要不要装剥离器，而那件事发生在流开始之前。
 * `requestPrompt` 不跑 LLM、不读磁盘，所以它不增加 provider 调用数——「围栏
 * 不加枪」在这里是接口层面的事实，而不是一句纪律。
 */
export type ToolGapPort = {
  observe(report: ToolGapBeatObservation): Promise<void>;
  intentOn(turnId: string, beat: number): boolean;
  requestPrompt(request: ToolGapPromptRequest): Promise<ToolGapPrompt | undefined>;
};
