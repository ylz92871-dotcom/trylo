/**
 * 学习侧对第二型围栏的声明（P05 工具学习规格 §2 源③）。
 *
 * 与执行侧那份（同名文件在 `loop/`）是一对：那一份说「执行环会调用什么」，这一份
 * 说「学习层提供什么」。**两份手写、互不 import**——执行环是冻结核心，学习层不得
 * 伸手进去；它们只在合同测试里相遇，那里要求两个类型互相可赋值，于是「声明打架」
 * 变成一次编译错误，而不是一次运行时惊喜。
 *
 * 这个口刻意窄，窄到只有三件事：备好这一拍的自报围栏了没有、要不要给模型写一段
 * 请它自报的话、这一拍结算后自报了什么。它从不告诉学习层一个请求的形状、一个
 * envelope、一个工具的参数——所以「执行不被学习污染」在这里是接口层面的事实：
 * 能传出去的信息里没有一处能改变执行语义。
 */

/** 围栏标记。与执行侧那份逐字相同，由合同测试要求相等。 */
import type { ToolExecutionFact } from "./opportunity.js";

export type { ToolExecutionFact } from "./opportunity.js";

export const TOOL_GAP_FENCE = "trylo-tool-gap";

/**
 * 一条已结算的工具失败事实。
 *
 * 与执行侧的同名形状相同（`tool`/`code`/`fingerprint`），参数本身从不外传——
 * 只有它的哈希，因为账与提议都不该记住用户往工具里塞了什么。
 */
export type ObservedFailureFact = {
  readonly tool: string;
  readonly code: string;
  readonly fingerprint: string;
};

export type ToolGapBeatObservation = {
  readonly turnId: string;
  /** 1-based 迭代序号：一次 provider 请求加它结算的一切。 */
  readonly beat: number;
  readonly failures: ReadonlyArray<ObservedFailureFact>;
  /** Settled facts can corroborate an opportunity even when all calls returned successfully. */
  readonly executions?: readonly ToolExecutionFact[];
  /** 本拍真实的工具目录，由执行侧上报（`tools.snapshot()` 是执行侧的东西）。 */
  readonly toolNames: ReadonlyArray<string>;
  /**
   * 本拍第二型围栏抽出的自报原文（严格 JSON 文本）。
   *
   * 缺席（而不是空串）表示这一拍没有自报：模型没写围栏、围栏坏了、或者压根没被
   * 请求过。三种情况对学习层是同一种事实——这一拍没有自报，于是佐证规则判它
   * 「模型没说话」。
   */
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
 * `intentOn` 是同步的、纯读的，因为它决定**要不要装剥离器**，而那件事发生在流
 * 开始之前。`requestPrompt` 是异步的，但它**不跑 LLM、不读磁盘**——它只是把那段
 * 固定的话念一遍，所以它永远不增加 provider 调用数。这是规格 §10「围栏不加枪」
 * 在接口层面的样子：自报与回答共用同一枪。
 */
export type ToolGapPort = {
  observe(report: ToolGapBeatObservation): Promise<void>;
  intentOn(turnId: string, beat: number): boolean;
  requestPrompt(request: ToolGapPromptRequest): Promise<ToolGapPrompt | undefined>;
};
