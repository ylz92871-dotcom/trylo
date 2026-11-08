import type { JsonObject, TerminalReason } from "./envelope.js";
import type { ContinueReason } from "./kinds.js";

/**
 * 有损折叠表：Trylo 终态 / 继续原因 ↔ ACP 停止原因与会话态（D5 §6 末段、§9 第 6 条）。
 *
 * 这个模块是纯数据 + 纯函数：没有 IO、没有 envelope 生产、也不持有第二份词表。
 * 它存在的唯一理由，是把「Trylo 的 4 值终态怎么变成 ACP 的 6 值 `StopReason`」
 * 从投影器的 if/else 里搬出来，成为一张可以被单测逐行钉死的表。
 *
 * 对齐方向是**单向**的：Trylo 是事实源，ACP 是目标形状。因此本模块
 *
 * - 不修改 `TERMINAL_REASONS`（仍是 4 值，`protocol/envelope.ts`），
 * - 不新增第五个终态、也不改 domain 状态机，
 * - 只在 envelope **已经存在**的 payload 字段（`cause` / `finishReason`）上取值，
 *   取不到就保持粗值并标记有损。
 *
 * 「标记有损」不是注释，而是返回值里的 `lossy` 字段：它会进入帧体，可以被断言。
 */

export const ACP_STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
  "other",
] as const;

export type AcpStopReason = (typeof ACP_STOP_REASONS)[number];

/** ACP 会话三态（`Running` / `Idle` / `RequiresAction`）。 */
export const ACP_AGENT_STATES = ["running", "idle", "requires_action"] as const;

export type AcpAgentState = (typeof ACP_AGENT_STATES)[number];

export type StopReasonFold = {
  readonly stopReason: AcpStopReason;
  /** `true` 表示多个 Trylo 终态塌进同一个 ACP 值（D5 §6：Trylo 4 值更粗）。 */
  readonly lossy: boolean;
  /** 有损/无损的判定依据，逐行可读，避免只有作者知道为什么。 */
  readonly detail: string;
};

/**
 * 基值表。刻意**不**把 `failed` 拆成 `MaxTokens|MaxTurnRequests|Refusal`：
 * 那三种情况在 Trylo 里不是终态，把 ACP 的细节发明成 Trylo 的终态就是
 * 「用投影倒推事实源」。细化只允许发生在 {@link refineStopReason} 里，
 * 并且只能使用 payload 已有的字段。
 */
export const TERMINAL_STOP_REASON: Readonly<Record<TerminalReason, StopReasonFold>> = {
  completed: { stopReason: "end_turn", lossy: false, detail: "completed 与 EndTurn 语义一致" },
  cancelled: { stopReason: "cancelled", lossy: false, detail: "cancelled 与 Cancelled 语义一致" },
  failed: {
    stopReason: "other",
    lossy: true,
    detail: "failed 吞掉 MaxTokens/MaxTurnRequests/Refusal 三种情况，无对应字段时只能落 Other",
  },
  unknown: {
    stopReason: "other",
    lossy: true,
    detail: "unknown 是兜底终态，ACP 侧只有 Other 可以承载",
  },
};

/**
 * 细化表：把 payload 里**已经存在**的字段翻成更细的 ACP 值。
 *
 * 键来自两个真实词表，不是臆造的：
 *
 * - `domain/iteration.ts` 的 `evaluateBudget` 判定（成为 terminal payload 的 `cause`）；
 * - `adapters/provider/openai-translate.ts` 的 `mapFinishReason`（成为 `finishReason`）。
 *
 * 这张表**只能细化**：它只在基值已经是 `other` 时被查询，因此
 * `completed` 永远不会被翻成失败，`failed` 也永远不会被翻成 `end_turn`。
 */
export const REFINED_STOP_REASON: Readonly<Record<string, AcpStopReason>> = {
  // domain 的预算判定
  output_tokens_exhausted: "max_tokens",
  context_limit: "max_tokens",
  iterations_exhausted: "max_turn_requests",
  // provider 的统一收尾原因
  length: "max_tokens",
  content_filter: "refusal",
};

/** 细化时查询字段的**固定顺序**：domain 的显式决定优先于 provider 的收尾原因。 */
export const STOP_REASON_REFINE_FIELDS = ["cause", "finishReason"] as const;

/**
 * 折叠一个终态。`payload` 必须是已校验 envelope 的 payload（自由形 JsonObject）。
 *
 * 判定顺序写死为 {@link STOP_REASON_REFINE_FIELDS}：turn loop 的
 * `cause`（例如 `iterations_exhausted`）比 provider 的 `finishReason`
 * 更接近「谁做了这个决定」，所以它优先。
 */
export function foldAcpStopReason(reason: TerminalReason, payload: JsonObject): StopReasonFold {
  const base = TERMINAL_STOP_REASON[reason];
  if (base.stopReason !== "other") {
    return base;
  }

  const refined = refineStopReason(payload);
  if (refined === undefined) {
    return base;
  }

  return {
    stopReason: refined.value,
    lossy: true,
    detail: `${base.detail}；由 ${refined.field}=${refined.key} 细化为 ${refined.value}`,
  };
}

/**
 * 从 terminal payload 里取一个 ACP 更细值。
 * 两个字段都不认识时返回 `undefined`——投影层据此保持 `other`，不猜。
 */
export function refineStopReason(
  payload: JsonObject,
): { readonly field: string; readonly key: string; readonly value: AcpStopReason } | undefined {
  for (const field of STOP_REASON_REFINE_FIELDS) {
    const raw = payload[field];
    if (typeof raw !== "string") {
      continue;
    }

    const value = REFINED_STOP_REASON[raw];
    if (value !== undefined) {
      return { field, key: raw, value };
    }
  }
  return undefined;
}

/**
 * `CONTINUE_REASONS` → ACP 会话态。
 *
 * 唯一的桥是 `permission_block → requires_action`（D5 §6 末段、§8 第 7 条）：
 * ACP 的 `RequiresAction` 表示「阻塞于审批」，而 Trylo 没有等价的**状态字段**，
 * 只有 `approval_requested` 事件。把这条对应关系登记成数据，投影器就不需要
 * 自己判断「什么算阻塞」。
 *
 * 其余 continue reason 是 loop 的**内部续跑决定**（换一轮、重试、压缩、
 * 预算、有界复核），不改变对外可见的会话态，一律 `running`。
 */
export const CONTINUE_REASON_AGENT_STATE: Readonly<Record<ContinueReason, AcpAgentState>> = {
  next_turn: "running",
  retry: "running",
  compact: "running",
  token_budget: "running",
  permission_block: "requires_action",
  bounded_recheck: "running",
};

/** 桥接查询：给定的 continue reason 是否让会话进入「阻塞于审批」。 */
export function agentStateForContinueReason(reason: ContinueReason): AcpAgentState {
  return CONTINUE_REASON_AGENT_STATE[reason];
}
