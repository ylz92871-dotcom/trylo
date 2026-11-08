import { AGUI_ROWS, type AguiRow } from "../../protocol/agui-map.js";
import { isEventKind } from "../../protocol/kinds.js";
import { checkPayload } from "../../protocol/payload-contract.js";
import type { AdmittedEnvelope } from "./admit.js";
import { buildBody, frameContextOf, type FrameContext } from "./body.js";
import { freezeFrame, type AguiFrame, type SurfaceProjectionFailure } from "./frames.js";
import { applyAguiState, isTerminalReason, type AguiMaterializedState } from "./state.js";

/**
 * Envelope → ag-ui 帧。纯函数，但**带显式的聚合态**：
 *
 * ```text
 * (envelope, state) → { frame, state' }
 * ```
 *
 * 为什么不是 `envelope → frame`：ag-ui 要 `STATE_SNAPSHOT`，而 snapshot 的值是
 * 「截至该 sequence 的聚合对象」。把聚合态做成显式入参而不是模块级变量，
 * 换来三件事：投影仍然可重放、两个消费者互不干扰、`compact` 那一帧的 snapshot
 * 可以被独立重算比对（见 `./state.ts` 与 P3 的测试）。
 *
 * 与 ACP 侧同构的纪律：策略字段（`disposition` / `type` / `omitted`）全部取自
 * `protocol/agui-map.ts` 的那一行，本文件不判断任何 kind 语义。
 * `terminal` 的 `RUN_FINISHED` / `RUN_ERROR` 二选一也在表里
 * （`typeByTerminalReason`），不是这里的 if。
 */
export type AguiProjection =
  | {
      readonly ok: true;
      readonly frame: AguiFrame;
      /** 累积后的聚合态；失败时调用方应保持原态。 */
      readonly state: AguiMaterializedState;
    }
  | { readonly ok: false; readonly code: SurfaceProjectionFailure; readonly detail: string };

export function projectAgui(
  admitted: AdmittedEnvelope,
  state: AguiMaterializedState,
): AguiProjection {
  const envelope = admitted.envelope;
  if (!isEventKind(envelope.kind)) {
    return {
      ok: false,
      code: "unknown_kind",
      detail: `kind ${envelope.kind} 不在 EVENT_KINDS 里，拒绝投影`,
    };
  }

  const contract = checkPayload(envelope.kind, envelope.payload);
  if (!contract.ok) {
    return { ok: false, code: contract.code, detail: contract.detail };
  }

  const row = AGUI_ROWS[envelope.kind];
  // snapshot 语义：**含**当前 envelope。这样 `snapshot + 其后的事件` 就是当前状态，
  // 消费方不必再猜「这个 snapshot 到底包不包含触发它的那个事件」。
  const nextState = applyAguiState(state, envelope);
  const ctx = frameContextOf(envelope, nextState);
  const frame: AguiFrame = {
    surface: "agui",
    disposition: row.disposition,
    type: eventTypeOf(row, ctx),
    body: buildBody(row.body, ctx),
    source: { eventId: envelope.eventId, sequence: envelope.sequence, kind: envelope.kind },
    omitted: row.omitted,
  };

  return { ok: true, frame: freezeFrame(frame), state: nextState };
}

/**
 * 目标事件类型：静态行直接返回 `type`；带 `typeByTerminalReason` 的行
 * （只有 `terminal`）按 payload 里的终态原值查表，取不到合法终态时落 `unknown`。
 */
function eventTypeOf(row: AguiRow, ctx: FrameContext): string {
  const table = row.typeByTerminalReason;
  if (table === undefined) {
    return row.type;
  }
  const declared = ctx.payload.reason;
  return isTerminalReason(declared) ? table[declared] : table.unknown;
}
