import type { Envelope, JsonObject, JsonValue } from "../../protocol/envelope.js";
import {
  FRAME_CUSTOM_PREFIX,
  type FrameDerivation,
  type FrameFieldSpec,
} from "../../protocol/frame-fields.js";
import { foldAcpStopReason } from "../../protocol/terminal-map.js";
import { isTerminalReason, type AguiMaterializedState } from "./state.js";

/**
 * 把 {@link FrameFieldSpec} 求值成帧体。**这是投影层唯一的「形状生成器」**：
 * 两个表面共用它，各自的差异全部留在 `protocol/{acp,agui}-map.ts` 的表里。
 *
 * 因此这里没有任何 `switch (kind)`：要改某个 kind 的映射，改表；
 * 要改一个**派生规则**（例如终态怎么折叠），改下面 `evaluateDerivation`
 * 里唯一的那个分支，表会自动跟着变。
 *
 * 缺字段一律**安静跳过**（不填空字符串、不补 0、不造 `undefined`）：
 * 目标形状缺什么，由表里的 `omitted` 显式登记，而不是靠塞一个假值蒙过去。
 */

export type FrameContext = {
  readonly kind: string;
  readonly payload: JsonObject;
  readonly eventId: string;
  readonly sequence: number;
  readonly sessionId: string | undefined;
  readonly turnId: string | undefined;
  /** 只有 ag-ui 的 `state_snapshot` 派生会读它；ACP 传 `undefined`。 */
  readonly state: AguiMaterializedState | undefined;
};

export function frameContextOf(
  envelope: Envelope,
  state: AguiMaterializedState | undefined,
): FrameContext {
  return {
    kind: envelope.kind,
    payload: envelope.payload,
    eventId: envelope.eventId,
    sequence: envelope.sequence,
    sessionId: envelope.sessionId,
    turnId: envelope.turnId,
    state,
  };
}

export function buildBody(specs: ReadonlyArray<FrameFieldSpec>, ctx: FrameContext): JsonObject {
  const body: { [key: string]: JsonValue } = {};

  for (const spec of specs) {
    const entry = evaluateSpec(spec, ctx);
    if (entry !== undefined) {
      body[entry.as] = entry.value;
    }
  }

  return body;
}

type Entry = { readonly as: string; readonly value: JsonValue };

function evaluateSpec(spec: FrameFieldSpec, ctx: FrameContext): Entry | undefined {
  switch (spec.kind) {
    case "literal":
      return { as: spec.as, value: spec.value };
    case "copy": {
      if (!guardAllows(spec.onlyWhenFalse, ctx)) {
        return undefined;
      }
      const source = ctx.payload[spec.from];
      return source === undefined ? undefined : { as: spec.as, value: source };
    }
    case "text_block": {
      if (!guardAllows(spec.onlyWhenFalse, ctx)) {
        return undefined;
      }

      const text = ctx.payload[spec.from];
      if (typeof text !== "string") {
        return undefined;
      }

      return { as: spec.as, value: { type: "text", text } };
    }
    case "derived":
      return evaluateDerivation(spec.name, spec.as, ctx);
  }
}

/**
 * `onlyWhenFalse` 守卫：只在 payload 里那个字段**显式等于 `false`** 时放行。
 *
 * 两种情况要分清：
 * - 规格**没有**声明守卫（`field === undefined`）：无条件放行，这是绝大多数规格。
 * - 声明了守卫但 payload 里**没有**那个字段：**不放行**。这正是它被用在推理内容
 *   上的原因——provider 没有声明「这是未脱敏文本」时，宁可不投影，也不把可能
 *   未脱敏的内容推进帧里。失败方向朝隐私一侧闭合。
 */
function guardAllows(field: string | undefined, ctx: FrameContext): boolean {
  return field === undefined || ctx.payload[field] === false;
}

function evaluateDerivation(
  name: FrameDerivation,
  as: string,
  ctx: FrameContext,
): Entry | undefined {
  switch (name) {
    case "stop_reason":
      return { as, value: terminalBlock(ctx) };
    case "raw_payload":
      return { as, value: ctx.payload };
    case "custom_name":
      return { as, value: `${FRAME_CUSTOM_PREFIX}${ctx.kind}` };
    case "custom_envelope":
      return { as, value: customEnvelope(ctx) };
    case "subagent_run_id": {
      const id = firstString(ctx.payload, ["subagentId", "toolCallId"]);
      return id === undefined ? undefined : { as, value: id };
    }
    case "state_snapshot":
      return { as, value: ctx.state ?? {} };
    case "run_outcome":
      return { as, value: outcomeOf(ctx) };
    case "lineage":
      return { as, value: lineageOf(ctx) };
  }
}

/**
 * 终态注解区块 `terminal`。
 *
 * 用 `payload.reason` 作为输入，但它**不一定**存在：`session_end` / `loop_end`
 * 这类「边界事件」也走这条派生。没有合法的终态值时落 `unknown`（→ ACP `other`）
 * 并标记有损，而不是猜一个 `completed`。
 *
 * `lossy` / `detail` 一起进帧体：有损是结论的一部分，不能只写在文档里。
 */
function terminalBlock(ctx: FrameContext): JsonObject {
  const declared = ctx.payload.reason;
  const reason = isTerminalReason(declared) ? declared : "unknown";
  const fold = foldAcpStopReason(reason, ctx.payload);
  return { stopReason: fold.stopReason, lossy: fold.lossy, detail: fold.detail };
}

/**
 * CUSTOM 的可重建载荷（WP §5 第 5 条：禁止空 CUSTOM）。
 *
 * 带三样东西：来源坐标、已脱敏的完整 payload、以及由表提供的 `name`。
 * `payload` 是进场时脱敏后的副本，所以 CUSTOM 不会成为绕过脱敏的后门。
 */
function customEnvelope(ctx: FrameContext): JsonObject {
  return {
    source: { eventId: ctx.eventId, sequence: ctx.sequence, kind: ctx.kind },
    payload: ctx.payload,
  };
}

/**
 * Trylo 终态原值，**不做** ACP 折叠。ag-ui 的 `RUN_FINISHED` 用它当 outcome，
 * 因此 ag-ui 这一列在「哪个终态」上不引入额外有损（是否 RUN_ERROR 由表里的
 * `typeByTerminalReason` 决定）。
 */
function outcomeOf(ctx: FrameContext): JsonValue {
  const declared = ctx.payload.reason;
  return isTerminalReason(declared) ? declared : "unknown";
}

/**
 * session/turn → thread/run 的绑定。**这是本包唯一的谱系绑定决定**：
 * `threadId ← sessionId`、`runId ← turnId`。
 *
 * `parentRunId` 永不发射——Trylo envelope 里根本没有父链字段。缺就是缺，
 * 由表里的 `omitted` 登记，不靠 `correlationId` 之类语义泛化的字段顶替。
 */
function lineageOf(ctx: FrameContext): JsonObject {
  const lineage: { [key: string]: JsonValue } = {};

  if (ctx.sessionId !== undefined) {
    lineage.threadId = ctx.sessionId;
  }

  if (ctx.turnId !== undefined) {
    lineage.runId = ctx.turnId;
  }

  return lineage;
}

function firstString(payload: JsonObject, fields: ReadonlyArray<string>): string | undefined {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
