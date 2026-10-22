import type { EventKind } from "./kinds.js";
import type { JsonObject } from "./envelope.js";

/**
 * per-kind payload 契约（D5 §8.4：`Envelope.payload` 是自由 `JsonObject`）。
 *
 * 本模块**不改** `protocol/envelope.ts` 的 payload 类型——那会牵动所有包；
 * 它只在投影需要的边界上加一层运行时校验，并把这个契约集中成一张表。
 *
 * 校验口径：**存在性 + JSON 类型**，不校验语义（非空、枚举、取值范围都属于
 * domain 状态机的职责）。例如 `api_call` 的 `attemptId` 允许是空字符串，
 * 因为 `domain/reduce.ts` 真的会发出空串，契约不该比事实源更严。
 *
 * 未知字段的政策**写死为「照原样带在 raw 里，不 fail-closed」**，理由：
 *
 * 1. 仓库既有的前向兼容取向是「忽略而不是拒绝」——`protocol/compat.ts` 对
 *    未知 kind 返回 `ignored_unknown_kind` 而不是报错。对未知**字段**采用相反
 *    的严格策略，会让同一个兼容观在两个方向上自相矛盾。
 * 2. 投影输入是**已经校验过**的 envelope（`parseEnvelope` 保证它是 JsonObject
 *    且不超过 `MAX_PAYLOAD_BYTES`）。再按字段白名单拒绝，等于让未来 provider
 *    多带一个字段就把合法流判成非法。
 * 3. 未知字段并不因此丢失：声明了 `raw` / `custom` 的帧会带上**已脱敏**的完整
 *    payload；没有声明的帧是契约内的有损投影，且始终带 `source` 坐标指回原事件。
 *
 * `required` 字段则**是** fail-closed：投影器读不到必需字段就无法忠实投影，
 * 此时返回显式失败，而不是产出半成品帧。
 */

export const PAYLOAD_FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "object",
  "string_array",
] as const;

export type PayloadFieldType = (typeof PAYLOAD_FIELD_TYPES)[number];

export type PayloadContract = {
  /** 投影器必须读到的字段；缺失或类型不符 → 显式失败。 */
  readonly required: ReadonlyArray<string>;
  /** 已知但可选的字段；缺失时对应规格整条跳过。 */
  readonly optional: ReadonlyArray<string>;
  /** 字段名 → JSON 类型。`required` 必须是它的子集（有测试钉死）。 */
  readonly types: Readonly<Record<string, PayloadFieldType>>;
};

export type PayloadContractCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "payload_contract_violation";
      readonly detail: string;
    };

export const PAYLOAD_CONTRACTS: Readonly<Record<EventKind, PayloadContract>> = {
  session_start: {
    required: [],
    optional: ["sessionId", "createdAt"],
    types: { sessionId: "string", createdAt: "string" },
  },
  session_end: { required: [], optional: ["reason"], types: { reason: "string" } },
  loop_start: { required: [], optional: ["iteration"], types: { iteration: "number" } },
  loop_end: { required: [], optional: ["reason"], types: { reason: "string" } },
  turn_start: {
    required: ["turnId", "text"],
    optional: [],
    types: { turnId: "string", text: "string" },
  },
  turn_end: { required: [], optional: ["reason"], types: { reason: "string" } },
  api_call: { required: ["attemptId"], optional: [], types: { attemptId: "string" } },
  api_retry: {
    required: ["attemptId"],
    optional: ["correlationId", "previous"],
    types: { attemptId: "string", correlationId: "string", previous: "string" },
  },
  model_fallback: {
    required: [],
    optional: ["model", "previousModel", "reason"],
    types: { model: "string", previousModel: "string", reason: "string" },
  },
  text: {
    required: ["text"],
    optional: ["role"],
    types: { text: "string", role: "string" },
  },
  thinking: {
    required: ["text"],
    optional: ["redacted"],
    types: { text: "string", redacted: "boolean" },
  },
  usage: {
    required: ["inputTokens", "outputTokens"],
    optional: [
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
      "totalTokens",
    ],
    types: {
      inputTokens: "number",
      outputTokens: "number",
      cacheReadTokens: "number",
      cacheWriteTokens: "number",
      reasoningTokens: "number",
      totalTokens: "number",
    },
  },
  tool_use: {
    required: ["toolCallId", "name"],
    optional: [],
    types: { toolCallId: "string", name: "string" },
  },
  tool_result: {
    required: ["toolCallId", "status"],
    optional: ["code", "message", "value"],
    types: {
      toolCallId: "string",
      status: "string",
      code: "string",
      message: "string",
      value: "object",
    },
  },
  approval_requested: {
    required: ["toolCallId", "ticketId"],
    optional: [],
    types: { toolCallId: "string", ticketId: "string" },
  },
  permission_denied: {
    required: ["toolCallId", "resolution"],
    optional: [],
    types: { toolCallId: "string", resolution: "string" },
  },
  subagent_spawn: {
    required: [],
    optional: ["subagentId", "toolCallId", "name", "prompt", "agentType", "canReceiveInput"],
    types: { subagentId: "string", toolCallId: "string", name: "string", prompt: "string", agentType: "string", canReceiveInput: "boolean" },
  },
  subagent_end: {
    required: [],
    optional: ["subagentId", "toolCallId", "status", "result", "error"],
    types: { subagentId: "string", toolCallId: "string", status: "string", result: "string", error: "string" },
  },
  subagent_update: {
    required: ["subagentId", "status", "round"], optional: ["prompt", "result", "displayName"],
    types: { subagentId: "string", status: "string", round: "number", prompt: "string", result: "string", displayName: "string" },
  },
  compact: {
    required: [],
    optional: ["compactId", "droppedEvents"],
    types: { compactId: "string", droppedEvents: "number" },
  },
  user_cancel: { required: ["phase"], optional: [], types: { phase: "string" } },
  user_reject: {
    required: ["toolCallId"],
    optional: ["ticketId"],
    types: { toolCallId: "string", ticketId: "string" },
  },
  observation: {
    required: [],
    optional: ["component", "late", "ignored", "terminalReason", "raw_unknown"],
    types: {
      component: "string",
      late: "boolean",
      ignored: "string",
      terminalReason: "string",
      raw_unknown: "string",
    },
  },
  error: {
    required: ["message"],
    optional: ["code"],
    types: { message: "string", code: "string" },
  },
  terminal: {
    required: ["reason"],
    optional: ["cause", "message", "errorClass", "finishReason", "requiresFollowUp", "toolCallIds"],
    types: {
      reason: "string",
      cause: "string",
      message: "string",
      errorClass: "string",
      finishReason: "string",
      requiresFollowUp: "boolean",
      toolCallIds: "string",
    },
  },
  file_write: {
    required: ["toolCallId"],
    optional: ["status", "path"],
    types: { toolCallId: "string", status: "string", path: "string" },
  },
  user_correction: { required: [], optional: ["text"], types: { text: "string" } },
  check_result: {
    required: ["checkId", "verdict"],
    optional: ["terminalReason"],
    types: { checkId: "string", verdict: "string", terminalReason: "string" },
  },
};

/**
 * 校验一个 kind 的 payload 是否满足投影所需的最小契约。
 * 纯函数：不抛异常，失败是返回值（仓库的 Result 取向）。
 */
export function checkPayload(kind: EventKind, payload: JsonObject): PayloadContractCheck {
  const contract = PAYLOAD_CONTRACTS[kind];
  for (const field of contract.required) {
    const expected = contract.types[field];
    if (expected === undefined) {
      return {
        ok: false,
        code: "payload_contract_violation",
        detail: `${kind}.${field} 在契约表里没有声明类型（表自身不一致）`,
      };
    }
    if (!hasType(payload[field], expected)) {
      return {
        ok: false,
        code: "payload_contract_violation",
        detail: `${kind}.${field} 必需且必须是 ${expected}`,
      };
    }
  }
  return { ok: true };
}

function hasType(value: unknown, expected: PayloadFieldType): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "string_array":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    default:
      return false;
  }
}
