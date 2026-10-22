import type { TerminalReason } from "./envelope.js";
import type { EventKind } from "./kinds.js";
import type { FrameFieldSpec } from "./frame-fields.js";

/**
 * ag-ui 列：`EVENT_KINDS` 全 27 个 kind 逐行的目标形状（D5 §6）。
 *
 * 「形状对齐、类型自有」——`type` 里手写的名字与 ag-ui 的 `EventType` 对齐，
 * 但没有引入 ag-ui 的 SDK 类型，也没有一行上游代码进入产品。
 *
 * 与 ACP 列的两处差别，都写在表里而不是代码里：
 *
 * 1. **谱系绑定**：Trylo 有 sessionId/turnId/attemptId，ag-ui 要
 *    threadId/runId/parentRunId。本包的绑定决定只有两条——
 *    `threadId ← sessionId`、`runId ← turnId`——并且**只**以 `lineage`
 *    一个对象承载，与 ag-ui 原生字段在形状上分开，避免把投影决定
 *    伪装成事实源。`parentRunId` **永不发射**（Trylo 没有该事实）。
 * 2. **materialized state**：ag-ui 依赖 `STATE_SNAPSHOT`，而 journal 是
 *    append-only 事件流。本包用「截至该 sequence 的聚合对象」当 snapshot，
 *    不改 journal（WP §4 P3）。`STATE_DELTA` 需要 JsonPatch 生成器，
 *    本包不做，已在 HANDOFF 列为 OPEN。
 */

export const AGUI_DISPOSITIONS = ["direct", "aggregated", "custom"] as const;

export type AguiDisposition = (typeof AGUI_DISPOSITIONS)[number];

export type AguiRow = {
  readonly disposition: AguiDisposition;
  /** ag-ui `EventType` 名（自有拼写）。 */
  readonly type: string;
  readonly body: ReadonlyArray<FrameFieldSpec>;
  readonly omitted: ReadonlyArray<string>;
  readonly note: string;
  /**
   * 仅 `terminal` 行使用：Trylo 终态不同则目标事件类型不同
   * （成功/取消落 RUN_FINISHED，失败/未知落 RUN_ERROR）。
   * 用数据表达这个分支，投影器里就没有终态判断。
   */
  readonly typeByTerminalReason?: Readonly<Record<TerminalReason, string>>;
};

const LINEAGE: FrameFieldSpec = { kind: "derived", name: "lineage", as: "lineage" };

const CUSTOM_BODY: Readonly<Array<FrameFieldSpec>> = [
  { kind: "derived", name: "custom_name", as: "name" },
  { kind: "derived", name: "custom_envelope", as: "value" },
];

const RAW_TAIL: FrameFieldSpec = { kind: "derived", name: "raw_payload", as: "raw" };

const RUN_OUTCOME: FrameFieldSpec = { kind: "derived", name: "run_outcome", as: "outcome" };

export const AGUI_ROWS: Readonly<Record<EventKind, AguiRow>> = {
  session_start: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "ag-ui 的 RUN_STARTED 是 per-run（:255），没有 session 级开始事件；会话边界属于上层，投影层只能用 CUSTOM。",
  },
  session_end: {
    disposition: "aggregated",
    type: "RUN_FINISHED",
    body: [LINEAGE, RUN_OUTCOME],
    omitted: [],
    note: "折叠成 RUN_FINISHED。session_end 不带终态原因时 outcome 为 unknown，不猜成 success。",
  },
  loop_start: {
    disposition: "aggregated",
    type: "RUN_STARTED",
    body: [LINEAGE],
    omitted: [],
    note: "loop 边界就是 ag-ui 的 run 边界：RUN_STARTED 在这里，threadId/runId 由 lineage 绑定给出。",
  },
  loop_end: {
    disposition: "aggregated",
    type: "RUN_FINISHED",
    body: [LINEAGE, RUN_OUTCOME],
    omitted: [],
    note: "与 loop_start 配对。outcome 用 Trylo 终态原值（不做 ACP 折叠），因此这一列在终态上**不**引入额外有损。",
  },
  turn_start: {
    disposition: "aggregated",
    type: "STEP_STARTED",
    body: [LINEAGE],
    omitted: ["stepName"],
    note: "turn 折叠成 step。ag-ui 的 stepName 需要一个稳定名字，Trylo 的 turnId 不是 step 名，登记为 omitted 而不是拿 turnId 顶替。",
  },
  turn_end: {
    disposition: "aggregated",
    type: "STEP_FINISHED",
    body: [LINEAGE],
    omitted: ["stepName"],
    note: "与 turn_start 配对，同样不发明 stepName。",
  },
  api_call: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "ag-ui 没有 per-request 事件，CUSTOM 保留 attemptId 坐标。",
  },
  api_retry: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "ag-ui 无重试事件；CUSTOM 保留 attemptId 与 correlationId。",
  },
  model_fallback: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "D5 §6 判定 ag-ui 无对应（codex 有 model/rerouted，ag-ui 没有）；CUSTOM 而不是伪造 RUN_* 事件。",
  },
  text: {
    disposition: "direct",
    type: "TEXT_MESSAGE_CONTENT",
    body: [LINEAGE, { kind: "copy", from: "text", as: "delta" }],
    omitted: ["messageId"],
    note: "一对一：增量文本落 delta。Trylo 没有 messageId，不虚构：缺 id 的目标形状由消费方补，登记为 omitted。",
  },
  thinking: {
    disposition: "direct",
    type: "THINKING_TEXT_MESSAGE_CONTENT",
    body: [LINEAGE, { kind: "copy", from: "text", as: "delta", onlyWhenFalse: "redacted" }],
    omitted: ["messageId"],
    note: "一对一。delta 受 onlyWhenFalse 守卫：payload 未显式声明 redacted=false 时不投影内容；payload 里的 redacted 标记本身不进帧（帧体没有 declaredRedacted 这种字段）。",
  },
  usage: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "D5 §6：RUN_FINISHED 不含 usage，ag-ui 无用量事件 → CUSTOM。禁止把它塞进 RUN_FINISHED 的 outcome。",
  },
  tool_use: {
    disposition: "direct",
    type: "TOOL_CALL_START",
    body: [
      LINEAGE,
      { kind: "copy", from: "toolCallId", as: "toolCallId" },
      { kind: "copy", from: "name", as: "toolCallName" },
    ],
    omitted: ["args"],
    note: "一对一（开始帧）。参数不在 tool_use payload 里，args 登记为 omitted；本包不做 start/args 两帧拆分。",
  },
  tool_result: {
    disposition: "direct",
    type: "TOOL_CALL_RESULT",
    body: [LINEAGE, { kind: "copy", from: "toolCallId", as: "toolCallId" }, { kind: "derived", name: "raw_payload", as: "result" }],
    omitted: ["content"],
    note: "一对一（结果帧）。ag-ui 的 content 是字符串，Trylo 的 tool_result 正文是自由对象；把对象序列化成字符串是不可回退的有损编码，因此改为 result 原样带上并登记 content 为 omitted。",
  },
  approval_requested: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "ag-ui 无原生审批事件（D5 §6 记为 CUSTOM/interrupt）。本包不发明 interrupt 语义，只保留坐标。",
  },
  permission_denied: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "审批结果在 ag-ui 无承载点，CUSTOM。",
  },
  subagent_spawn: {
    disposition: "direct",
    type: "SUBAGENT_STARTED",
    body: [LINEAGE, { kind: "derived", name: "subagent_run_id", as: "subagentRunId" }],
    omitted: ["parentSubagentRunId", "parentToolCallId", "parentMessageId"],
    note: "ag-ui 有原生 SUBAGENT_STARTED，故直接对应。但父谱系三个字段在 Trylo 里根本不存在：缺血缘不得虚构 parent，只能显式 omitted（WP §2.5）。",
  },
  subagent_end: {
    disposition: "aggregated",
    type: "SUBAGENT_FINISHED",
    body: [LINEAGE, { kind: "derived", name: "subagent_run_id", as: "subagentRunId" }],
    omitted: ["parentSubagentRunId", "outcomeSuspended"],
    note: "SUBAGENT_FINISHED 的 outcome 有 success/suspended{interruptIds} 两态，而 Trylo 没有「挂起等待中断」这一事实；不发明 suspended，登记为 omitted。SUBAGENT_ERROR 需要终态信息，本包不从 subagent_end 单独推断。",
  },
  subagent_update: {
    disposition: "custom", type: "CUSTOM", body: CUSTOM_BODY, omitted: [],
    note: "Child round progress; retained as a custom event without inventing a terminal outcome.",
  },
  compact: {
    disposition: "aggregated",
    type: "STATE_SNAPSHOT",
    body: [
      { kind: "derived", name: "state_snapshot", as: "snapshot" },
      { kind: "derived", name: "raw_payload", as: "raw" },
    ],
    omitted: ["delta"],
    note: "本包只做 SNAPSHOT 不做 RFC6902 DELTA（无补丁库，WP §4 P3）。snapshot 是「**含**当前 envelope 在内、截至该 sequence 的聚合对象」，因此 `snapshot + 其后的事件` 就是当前状态；可被消费方独立重建，HANDOFF 已登记 STATE_DELTA 为 OPEN。",
  },
  user_cancel: {
    disposition: "aggregated",
    type: "RUN_FINISHED",
    body: [LINEAGE, { kind: "literal", as: "outcome", value: "cancelled" }],
    omitted: [],
    note: "ag-ui 无取消事件，落 RUN_FINISHED 并显式带 cancelled。用常量而不是读 payload.reason：user_cancel 不是终态事件。",
  },
  user_reject: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "同 permission_denied：审批结果的拒绝语义在 ag-ui 无对应事件。",
  },
  observation: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "迟观测/未知线数据在 ag-ui 无对应，CUSTOM。",
  },
  error: {
    disposition: "direct",
    type: "RUN_ERROR",
    body: [LINEAGE, { kind: "copy", from: "message", as: "message" }],
    omitted: ["code"],
    note: "ag-ui 有原生 RUN_ERROR（D5 §6 直接对应）。code 无对应词表，登记为 omitted。",
  },
  terminal: {
    disposition: "aggregated",
    type: "RUN_FINISHED",
    typeByTerminalReason: {
      completed: "RUN_FINISHED",
      cancelled: "RUN_FINISHED",
      failed: "RUN_ERROR",
      unknown: "RUN_ERROR",
    },
    body: [LINEAGE, RUN_OUTCOME],
    omitted: [],
    note: "终态唯一承载点。run 成功/取消落 RUN_FINISHED，失败/未知落 RUN_ERROR——这个分支是表里的一列，不是投影器里的 if。",
  },
  file_write: {
    disposition: "aggregated",
    type: "TOOL_CALL_RESULT",
    body: [LINEAGE, { kind: "copy", from: "toolCallId", as: "toolCallId" }, RAW_TAIL],
    omitted: ["content"],
    note: "D5 判为「需聚合」：ag-ui 侧是 TOOL_CALL_*/STATE_DELTA 的组合。本包只出一个结果帧，不生成 patch。",
  },
  user_correction: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "ag-ui 无对应事件，CUSTOM 保留坐标。",
  },
  check_result: {
    disposition: "custom",
    type: "CUSTOM",
    body: CUSTOM_BODY,
    omitted: [],
    note: "D5 §6 记为 CUSTOM/STATE。本包选 CUSTOM：用 STATE 表达验证结论会把学习语义偷渡进传输面（WP 准入第 4 条）。",
  },
};
