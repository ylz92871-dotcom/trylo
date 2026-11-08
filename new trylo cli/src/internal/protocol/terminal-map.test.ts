import assert from "node:assert/strict";
import { test } from "node:test";
import { TERMINAL_REASONS, type JsonObject } from "./envelope.js";
import { CONTINUE_REASONS } from "./kinds.js";
import {
  ACP_AGENT_STATES,
  ACP_STOP_REASONS,
  CONTINUE_REASON_AGENT_STATE,
  REFINED_STOP_REASON,
  STOP_REASON_REFINE_FIELDS,
  TERMINAL_STOP_REASON,
  agentStateForContinueReason,
  foldAcpStopReason,
  refineStopReason,
} from "./terminal-map.js";

/**
 * P5：有损折叠表 + permission_block 桥。
 *
 * 这一组用例的目的是让「Trylo 4 值终态 → ACP 6 值 StopReason」的有损性
 * 成为**可执行的断言**，而不是文档里的一句话。任何想让 `failed` 变得更细、
 * 或者偷偷扩 `TERMINAL_REASONS` 的改动都会在这里红。
 */

function fold(reason: (typeof TERMINAL_REASONS)[number], payload: JsonObject = {}) {
  return foldAcpStopReason(reason, payload);
}

test("ACP 词表按形状对齐（6 个停止原因、3 个会话态）", () => {
  assert.deepEqual([...ACP_STOP_REASONS], [
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
    "cancelled",
    "other",
  ]);
  assert.deepEqual([...ACP_AGENT_STATES], ["running", "idle", "requires_action"]);
});

test("每个终态都有基值，且只有 completed/cancelled 是无损的", () => {
  assert.deepEqual(Object.keys(TERMINAL_STOP_REASON).sort(), [...TERMINAL_REASONS].sort());
  assert.equal(TERMINAL_STOP_REASON.completed.lossy, false);
  assert.equal(TERMINAL_STOP_REASON.cancelled.lossy, false);
  assert.equal(TERMINAL_STOP_REASON.failed.lossy, true);
  assert.equal(TERMINAL_STOP_REASON.unknown.lossy, true);
});

test("本包没有扩终态词表：仍是 4 值，且不含 ACP 才有的值", () => {
  assert.equal(TERMINAL_REASONS.length, 4);
  const values: readonly string[] = TERMINAL_REASONS;
  for (const invented of ["max_tokens", "max_turn_requests", "refusal", "other", "end_turn"]) {
    assert.equal(values.includes(invented), false, `${invented} 不得成为 Trylo 终态`);
  }
});

test("completed 与 cancelled 分别落 end_turn / cancelled，互不混淆", () => {
  assert.equal(fold("completed").stopReason, "end_turn");
  assert.equal(fold("cancelled").stopReason, "cancelled");
  assert.notEqual(fold("completed").stopReason, fold("cancelled").stopReason);
});

test("failed 的兜底是多对一的 other，并带出可用以解释的 detail", () => {
  const result = fold("failed");
  assert.equal(result.stopReason, "other");
  assert.equal(result.lossy, true);
  assert.equal(result.detail.length > 0, true);
});

test("细化只使用 payload 已有字段：domain 的 cause 优先于 provider 的 finishReason", () => {
  assert.deepEqual([...STOP_REASON_REFINE_FIELDS], ["cause", "finishReason"]);
  const both: JsonObject = { cause: "iterations_exhausted", finishReason: "length" };

  assert.equal(fold("failed", both).stopReason, "max_turn_requests");
  assert.equal(fold("failed", { cause: "output_tokens_exhausted" }).stopReason, "max_tokens");
  assert.equal(fold("failed", { cause: "context_limit" }).stopReason, "max_tokens");
  assert.equal(fold("failed", { finishReason: "length" }).stopReason, "max_tokens");
  assert.equal(fold("failed", { finishReason: "content_filter" }).stopReason, "refusal");
});

test("细化不是发明：陌生原因值仍然落 other 且标记有损", () => {
  assert.equal(fold("failed", { cause: "no_such_reason" }).stopReason, "other");
  assert.equal(fold("failed", { finishReason: "weird" }).stopReason, "other");
  assert.equal(fold("failed", { cause: 42 }).stopReason, "other");
  assert.equal(fold("failed", { cause: "no_such_reason" }).lossy, true);
});

test("细化表只能细化 other：不会把 completed 翻成失败，也不会翻成 end_turn", () => {
  const completed = fold("completed", { cause: "iterations_exhausted", finishReason: "length" });
  assert.equal(completed.stopReason, "end_turn");
  assert.equal(completed.lossy, false);
  const cancelled = fold("cancelled", { cause: "output_tokens_exhausted" });
  assert.equal(cancelled.stopReason, "cancelled");
  assert.equal(cancelled.lossy, false);
});

test("细化表的每个值都是合法 ACP 停止原因（防手滑写错枚举）", () => {
  for (const [key, value] of Object.entries(REFINED_STOP_REASON)) {
    assert.equal(
      (ACP_STOP_REASONS as readonly string[]).includes(value),
      true,
      `${key} → ${value} 不是 ACP 停止原因`,
    );
  }
});

test("refineStopReason 直接可用：命中时给出字段名与原始键，未命中返回 undefined", () => {
  assert.deepEqual(refineStopReason({ finishReason: "content_filter" }), {
    field: "finishReason",
    key: "content_filter",
    value: "refusal",
  });
  assert.equal(refineStopReason({ reason: "completed" }), undefined);
});

test("CONTINUE_REASONS 全覆盖，且只有 permission_block 桥到 requires_action", () => {
  assert.deepEqual(Object.keys(CONTINUE_REASON_AGENT_STATE).sort(), [...CONTINUE_REASONS].sort());
  const blocked = CONTINUE_REASONS.filter(
    (reason) => agentStateForContinueReason(reason) === "requires_action",
  );
  assert.deepEqual([...blocked], ["permission_block"]);
});

test("桥的值都是合法会话态（防手滑）", () => {
  for (const reason of CONTINUE_REASONS) {
    const state = agentStateForContinueReason(reason);
    assert.equal((ACP_AGENT_STATES as readonly string[]).includes(state), true, reason);
  }
});
