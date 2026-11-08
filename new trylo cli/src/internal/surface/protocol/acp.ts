import { ACP_ROWS } from "../../protocol/acp-map.js";
import { isEventKind } from "../../protocol/kinds.js";
import { checkPayload } from "../../protocol/payload-contract.js";
import type { AdmittedEnvelope } from "./admit.js";
import { buildBody, frameContextOf } from "./body.js";
import { freezeFrame, type AcpFrame, type ProjectionResult } from "./frames.js";

/**
 * Envelope → ACP 帧。纯函数：无 IO、无时间、无随机、无全局状态。
 *
 * 它做的事情只有四步，全部可被外部重放：
 *
 * 1. 确认 kind 已知（正常路径已由 `admit()` 拦掉；这里防御性再判一次，
 *    保证未知 kind 得到**拒绝**而不是抛异常或 undefined 解引用）；
 * 2. 用 `protocol/payload-contract.ts` 校验必需字段，缺字段即显式失败；
 * 3. 按 `protocol/acp-map.ts` 里那一行的 `body` 规格生成帧体
 *    （形状生成在 `./body.ts`，本文件不判断任何 kind 语义）；
 * 4. 把**表里的** `disposition` / `primitive` / `variant` / `agentState` /
 *    `omitted` 原样带进帧。
 *
 * 第 4 步是刻意的：测试可以逐行断言「帧上的策略字段 === 表里的那条」，
 * 于是「改代码不改表」这种漂移在门禁里就红了。
 *
 * 输入类型是 `AdmittedEnvelope`——只有 `admit()` 能构造它，所以本函数
 * 在编译期就拿到了「已校验 + 已脱敏」的保证，界面上没有任何原始 JSON 入口。
 */
export function projectAcp(admitted: AdmittedEnvelope): ProjectionResult<AcpFrame> {
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

  const row = ACP_ROWS[envelope.kind];
  const frame: AcpFrame = {
    surface: "acp",
    disposition: row.disposition,
    primitive: row.primitive,
    variant: row.variant,
    agentState: row.agentState,
    body: buildBody(row.body, frameContextOf(envelope, undefined)),
    source: { eventId: envelope.eventId, sequence: envelope.sequence, kind: envelope.kind },
    omitted: row.omitted,
  };

  return { ok: true, frame: freezeFrame(frame) };
}
