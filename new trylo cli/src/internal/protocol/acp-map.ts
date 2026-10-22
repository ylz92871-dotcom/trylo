import type { EventKind } from "./kinds.js";
import type { FrameFieldSpec } from "./frame-fields.js";
import type { AcpAgentState } from "./terminal-map.js";

/**
 * ACP 列：`EVENT_KINDS` 全 27 个 kind 逐行的目标形状（D5 §6）。
 *
 * 「形状对齐、类型自有」——这里手写的 `variant` 名与 ACP v2 的
 * `SessionUpdate` 变体对齐，但没有任何上游类型被引入产品，也没有一行 schema
 * 代码被复制；ACP schema 仓库始终只作为对照阅读材料（WP §1 末段）。
 *
 * 三档判定沿用 D5 的分类，并作为机器可读的 `disposition` 落到表里：
 *
 * - `direct`：Trylo kind 与某个 ACP 变体一对一；
 * - `aggregated`：多个 Trylo kind（或某个更粗的 ACP 原语）承载同一段目标语义，
 *   例如所有终态都折叠成 `StateUpdate::Idle + StopReason`；
 * - `custom`：ACP 没有对应原语，必须显式 CUSTOM。**禁止丢掉事件**。
 *
 * 表是投影器唯一的策略来源：`semantics/projection` 只按 `body` 规格取数，
 * 不在代码里重新判断「这个 kind 该映射成什么」。要改映射就改这张表，
 * 并在同一提交里改 `acp-map.test.ts`。
 */

export const ACP_PRIMITIVES = ["session_update", "request_permission", "notice", "custom"] as const;

export type AcpPrimitive = (typeof ACP_PRIMITIVES)[number];

export const ACP_DISPOSITIONS = ["direct", "aggregated", "custom"] as const;

export type AcpDisposition = (typeof ACP_DISPOSITIONS)[number];

export type AcpRow = {
  readonly disposition: AcpDisposition;
  readonly primitive: AcpPrimitive;
  /** ACP `SessionUpdate` 变体名；`custom` 行必须为 `null`。 */
  readonly variant: string | null;
  readonly agentState: AcpAgentState;
  readonly body: ReadonlyArray<FrameFieldSpec>;
  /**
   * 目标形状需要、而 Trylo 事实源里**没有**的字段。必须显式登记：
   * 缺字段就省略，绝不虚构（WP §2.5）。`omitted` 会原样进入帧，可被断言。
   */
  readonly omitted: ReadonlyArray<string>;
  /** 有损说明，必填（WP §2.1 要求逐行给出）。 */
  readonly note: string;
};

const CUSTOM_BODY: ReadonlyArray<FrameFieldSpec> = [
  { kind: "derived", name: "custom_name", as: "name" },
  { kind: "derived", name: "custom_envelope", as: "custom" },
];

const RAW_TAIL: FrameFieldSpec = { kind: "derived", name: "raw_payload", as: "raw" };

const STOP_REASON: FrameFieldSpec = { kind: "derived", name: "stop_reason", as: "terminal" };

/** 血缘缺口：ACP 侧同样没有子代理血缘，逐行登记而不是每行各写一遍。 */
const SUBAGENT_LINEAGE_OMITTED: ReadonlyArray<string> = [
  "parentAgentId",
  "parentSessionId",
  "subagentRunId",
];

export const ACP_ROWS: Readonly<Record<EventKind, AcpRow>> = {
  session_start: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: ["acpSessionId"],
    note: "ACP 的 session/new 是**请求**原语，没有对应的 SessionUpdate；Trylo session ↔ ACP session 的绑定属于上层约定，投影层不发明 id。",
  },
  session_end: {
    disposition: "aggregated",
    primitive: "session_update",
    variant: "state_update_idle",
    agentState: "idle",
    body: [STOP_REASON],
    omitted: [],
    note: "折叠成 Idle + StopReason。session_end 自身不带终态原因，无 reason 字段时落 Other 并在帧里标记有损。",
  },
  loop_start: {
    disposition: "aggregated",
    primitive: "session_update",
    variant: "state_update_running",
    agentState: "running",
    body: [],
    omitted: [],
    note: "ACP 只有 Running/Idle/RequiresAction 三态；Trylo 的 loop 边界折叠进会话态，不新增变体。",
  },
  loop_end: {
    disposition: "aggregated",
    primitive: "session_update",
    variant: "state_update_idle",
    agentState: "idle",
    body: [STOP_REASON],
    omitted: [],
    note: "loop 结束不等于会话终态，但仍按 Idle 投影；StopReason 只能来自 payload 已有的 reason/其他字段，取不到即 Other。",
  },
  turn_start: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: [],
    note: "ACP 没有 turn 概念（D5 §6：turn 折叠进 foreground work）。丢到 CUSTOM 而不是伪装成一个 step，避免把 Trylo 的层级写进 ACP 语义。",
  },
  turn_end: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: [],
    note: "同 turn_start：turn 的收尾在 ACP 里没有承载点，只能 CUSTOM。turn 是否结束由 terminal 事件另行表达。",
  },
  api_call: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: [],
    note: "ACP 没有 per-request 通知；只保留 attemptId 以便追溯，不映射到任何变体。",
  },
  api_retry: {
    disposition: "aggregated",
    primitive: "notice",
    variant: "notice",
    agentState: "running",
    body: [RAW_TAIL],
    omitted: ["noticeLevel"],
    note: "D5 §6 判定为「不稳定 Notice 近似」：ACP 的 Notice 仍是 unstable 变体，且没有 level 词表，因此 payload 原样带上。",
  },
  model_fallback: {
    disposition: "aggregated",
    primitive: "session_update",
    variant: "session_info_update",
    agentState: "running",
    body: [{ kind: "copy", from: "model", as: "model" }, RAW_TAIL],
    omitted: ["fallbackReason"],
    note: "ACP 只能表达 SessionInfoUpdate.model；Trylo 的切换原因在 ACP 里无处安放，随 raw 一起带上并登记为有损。",
  },
  text: {
    disposition: "direct",
    primitive: "session_update",
    variant: "agent_message_chunk",
    agentState: "running",
    body: [{ kind: "text_block", from: "text", as: "content" }],
    omitted: ["messageId"],
    note: "一对一。Trylo 没有 message/chunk id，不虚构 id：内容以文本块形式落在 content。",
  },
  thinking: {
    disposition: "direct",
    primitive: "session_update",
    variant: "agent_thought_chunk",
    agentState: "running",
    body: [{ kind: "text_block", from: "text", as: "content", onlyWhenFalse: "redacted" }],
    omitted: ["messageId"],
    note: "一对一。hidden reasoning 的脱敏有两道：进场时走唯一的 redact 规则表，投影时再由 onlyWhenFalse 守卫兜底——payload 未显式声明 redacted=false 时整条 content 不投影，失败方向朝隐私一侧闭合。",
  },
  usage: {
    disposition: "direct",
    primitive: "session_update",
    variant: "usage_update",
    agentState: "running",
    body: [
      { kind: "copy", from: "inputTokens", as: "inputTokens" },
      { kind: "copy", from: "outputTokens", as: "outputTokens" },
      { kind: "copy", from: "cacheReadTokens", as: "cacheReadTokens" },
      { kind: "copy", from: "cacheWriteTokens", as: "cacheWriteTokens" },
      { kind: "copy", from: "reasoningTokens", as: "reasoningTokens" },
      { kind: "copy", from: "totalTokens", as: "totalTokens" },
    ],
    omitted: ["costUsd", "contextWindow"],
    note: "ACP 有 UsageUpdate，字段名对齐但类型自有。Trylo 不记录费用与窗口大小，两者登记为 omitted。",
  },
  tool_use: {
    disposition: "direct",
    primitive: "session_update",
    variant: "tool_call_update",
    agentState: "running",
    body: [
      { kind: "copy", from: "toolCallId", as: "toolCallId" },
      { kind: "copy", from: "name", as: "name" },
      { kind: "literal", as: "status", value: "in_progress" },
    ],
    omitted: ["rawInput", "content"],
    note: "ag-ui 侧需要把 start/args 拆成两帧，本包只做单帧形状：tool_use 落 in_progress。Trylo 的 tool_use payload 不带参数原文（参数在 domain 的 toolCalls 里），因此 rawInput 登记为 omitted。",
  },
  tool_result: {
    disposition: "direct",
    primitive: "session_update",
    variant: "tool_call_update",
    agentState: "running",
    body: [
      { kind: "copy", from: "toolCallId", as: "toolCallId" },
      { kind: "literal", as: "status", value: "completed" },
      RAW_TAIL,
    ],
    omitted: ["contentChunk"],
    note: "一对一（完成态）。结果正文形状不固定，按 raw 带上而不是猜一个 ContentBlock；专门的内容块变体登记为 omitted。",
  },
  approval_requested: {
    disposition: "aggregated",
    primitive: "request_permission",
    variant: null,
    agentState: "requires_action",
    body: [
      { kind: "copy", from: "toolCallId", as: "toolCallId" },
      { kind: "copy", from: "ticketId", as: "ticketId" },
    ],
    omitted: ["options", "permissionId"],
    note: "跨原语：ACP 侧是**请求**（session/request_permission）而不是 update。这也是 CONTINUE_REASONS.permission_block ↔ RequiresAction 的落点：本帧的 agentState 必须是 requires_action，阻塞态才可表示。选项枚举（allow_once 等）不存在，登记为 omitted。",
  },
  permission_denied: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: [],
    note: "denied 是审批结果，在 ACP 里属于请求的应答（permission outcome），没有独立 update 变体；阻塞已被解决，因此会话态回到 running。",
  },
  subagent_spawn: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: SUBAGENT_LINEAGE_OMITTED,
    note: "ACP 无原生子代理事件（goose 亦走 custom notification）。子代理血缘字段在 Trylo envelope 里根本不存在，缺血缘不得虚构 parent。",
  },
  subagent_end: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: SUBAGENT_LINEAGE_OMITTED,
    note: "同 subagent_spawn：没有 parent 字段可填，宁可显式 omitted 也不伪造父子关系。",
  },
  subagent_update: {
    disposition: "custom", primitive: "custom", variant: null, agentState: "running",
    body: CUSTOM_BODY, omitted: SUBAGENT_LINEAGE_OMITTED,
    note: "Child round progress retains its own identity and remains non-terminal.",
  },
  compact: {
    disposition: "aggregated",
    primitive: "session_update",
    variant: "compaction_update",
    agentState: "running",
    body: [RAW_TAIL],
    omitted: [],
    note: "ACP 的 CompactionUpdate/CompactionSummaryChunk 仍是 **unstable 且需 feature 门控**（D5 §6），本包只做形状对齐；压缩载荷形状归 P04 包，这里原样带上不解释。",
  },
  user_cancel: {
    disposition: "aggregated",
    primitive: "session_update",
    variant: "state_update_idle",
    agentState: "idle",
    body: [
      {
        kind: "literal",
        as: "terminal",
        value: {
          stopReason: "cancelled",
          lossy: false,
          detail: "用户取消在 ACP 是 Idle + Cancelled，由事件语义直接决定，不经过终态折叠",
        },
      },
    ],
    omitted: [],
    note: "用户取消在 ACP 是 Idle + StopReason::Cancelled。这里用常量而不是终端折叠：user_cancel 本身不是终态事件，不能靠读 reason 字段推出取消。",
  },
  user_reject: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: [],
    note: "审批被用户拒绝，语义与 permission_denied 同源但事件不同；ACP 没有承载点，CUSTOM 保留原始坐标。",
  },
  observation: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: [],
    note: "迟观测/未知线数据在 ACP 无对应变体。CUSTOM 是唯一不丢事件的选择。",
  },
  error: {
    disposition: "aggregated",
    primitive: "notice",
    variant: "notice",
    agentState: "running",
    body: [
      { kind: "literal", as: "level", value: "error" },
      { kind: "copy", from: "message", as: "message" },
      RAW_TAIL,
    ],
    omitted: ["code"],
    note: "ACP 侧走 Notice(Error)（D5 §6 记为「需映射」）。注意 Trylo 的 error kind 与 terminal 是两个事实：本帧不结束会话，会话态仍为 running，终态只由 terminal 表达。",
  },
  terminal: {
    disposition: "aggregated",
    primitive: "session_update",
    variant: "state_update_idle",
    agentState: "idle",
    body: [STOP_REASON],
    omitted: [],
    note: "终态的唯一承载点：Idle + StopReason。failed 是多对一，细值只能来自 payload 已有字段（见 protocol/terminal-map.ts 的细化表）。",
  },
  file_write: {
    disposition: "aggregated",
    primitive: "session_update",
    variant: "tool_call_update",
    agentState: "running",
    body: [
      { kind: "copy", from: "toolCallId", as: "toolCallId" },
      { kind: "literal", as: "status", value: "completed" },
      RAW_TAIL,
    ],
    omitted: ["diff", "terminalId"],
    note: "D5 把 file_write 判为「需聚合」：ACP 侧是 edit 型 ToolCallUpdate（可能另配 TerminalUpdate）。本包只出一个帧，不伪造 diff。",
  },
  user_correction: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: [],
    note: "用户纠正模型输出，ACP 无对应变体；CUSTOM 保留坐标，学习侧如何使用它不在本包范围。",
  },
  check_result: {
    disposition: "custom",
    primitive: "custom",
    variant: null,
    agentState: "running",
    body: CUSTOM_BODY,
    omitted: [],
    note: "验证结论在 ACP 无对应变体。禁止用九维/observation 设计去投影它（WP 准入第 4 条），因此只做 CUSTOM。",
  },
};
