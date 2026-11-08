import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ACP_ROWS } from "../../protocol/acp-map.js";
import { AGUI_ROWS } from "../../protocol/agui-map.js";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { TERMINAL_REASONS } from "../../protocol/envelope.js";
import { FRAME_CUSTOM_PREFIX } from "../../protocol/frame-fields.js";
import type { EventKind } from "../../protocol/kinds.js";
import { projectAcp } from "./acp.js";
import { admit, type AdmittedEnvelope } from "./admit.js";
import { projectAgui } from "./agui.js";
import type { AcpFrame, AguiFrame } from "./frames.js";
import { createAguiState } from "./state.js";

/**
 * P1/P2/P3：27 行全覆盖的端到端投影。
 *
 * 断言方式刻意「对着表比」而不是「对着上一次的输出比」：每一条用例都从
 * `protocol/{acp,agui}-map.ts` 里读出期望值，所以「改了代码没改表」和
 * 「改了表没改代码」都会红。夹具是独立的 27 条数据，两个方向都不互相迁就。
 */

type Fixture = { readonly kind: string; readonly envelope: Record<string, unknown> };

function loadFixtures(): ReadonlyArray<Fixture> {
  const path = join(process.cwd(), "testdata", "protocol", "projection", "envelopes.json");
  return JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<Fixture>;
}

const FIXTURES = loadFixtures();

function fixtureOf(kind: EventKind): Fixture {
  const found = FIXTURES.find((item) => item.kind === kind);
  if (found === undefined) {
    assert.fail(`夹具缺少 ${kind}`);
  }
  return found;
}

/** 内联构造原始 envelope，用于测表里没有夹具覆盖的组合（终态、缺字段等）。 */
function rawEnvelope(kind: string, payload: JsonObject, extra: JsonObject = {}): unknown {
  return {
    protocolVersion: "0.0",
    eventId: `evt-${kind}-inline`,
    sequence: 7,
    timestamp: "2026-09-15T00:00:00.000Z",
    kind,
    payload,
    producerId: "cli",
    producerSequence: 3,
    ...extra,
  };
}

function admitOrFail(raw: unknown): AdmittedEnvelope {
  const result = admit(raw);
  if (!result.ok) {
    assert.fail(`应当通过校验，却返回 ${result.code}/${result.detail}`);
  }

  if (result.outcome !== "admitted") {
    assert.fail(`应当是已知 kind，却被忽略为 ${result.kind}`);
  }

  return result.admitted;
}

function acpFrameOf(raw: unknown): AcpFrame {
  const result = projectAcp(admitOrFail(raw));
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.detail}`);
  }
  return result.frame;
}

function aguiFrameOf(raw: unknown): AguiFrame {
  const result = projectAgui(admitOrFail(raw), createAguiState());
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.detail}`);
  }
  return result.frame;
}

function objectAt(value: JsonValue | undefined, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    assert.fail(`${label} 应当是对象，实际是 ${JSON.stringify(value)}`);
  }
  // 运行时已排除数组与 null；`readonly JsonValue[]` 无法被 Array.isArray 收窄，
  // 因此这里留一个明确的断言式转换，而不是偷偷用 any。
  return value as JsonObject;
}

test("27 条夹具逐行投影出 ACP 帧，策略字段与表完全一致", () => {
  for (const fixture of FIXTURES) {
    const kind = fixture.kind as EventKind;
    const row = ACP_ROWS[kind];
    const frame = acpFrameOf(fixture.envelope);

    assert.equal(frame.surface, "acp");
    assert.equal(frame.disposition, row.disposition, kind);
    assert.equal(frame.primitive, row.primitive, kind);
    assert.equal(frame.variant, row.variant, kind);
    assert.equal(frame.agentState, row.agentState, kind);
    assert.deepEqual([...frame.omitted], [...row.omitted], kind);
    assert.deepEqual(
      { ...frame.source },
      {
        eventId: fixture.envelope.eventId,
        sequence: fixture.envelope.sequence,
        kind: fixture.envelope.kind,
      },
      kind,
    );
  }
});

test("27 条夹具逐行投影出 ag-ui 帧，事件类型与表完全一致", () => {
  for (const fixture of FIXTURES) {
    const kind = fixture.kind as EventKind;
    const row = AGUI_ROWS[kind];
    const frame = aguiFrameOf(fixture.envelope);

    assert.equal(frame.surface, "agui");
    assert.equal(frame.disposition, row.disposition, kind);
    assert.equal(frame.type, row.type, kind);
    assert.deepEqual([...frame.omitted], [...row.omitted], kind);
    assert.equal(frame.source.eventId, fixture.envelope.eventId, kind);
    assert.equal(frame.source.kind, fixture.envelope.kind, kind);
  }
});

test("CUSTOM 帧不得为空：必须带名字、重建坐标与脱敏 payload 副本", () => {
  for (const fixture of FIXTURES) {
    const admitted = admitOrFail(fixture.envelope);
    const acp = projectAcp(admitted);
    if (acp.ok && acp.frame.disposition === "custom") {
      assert.equal(acp.frame.body.name, `${FRAME_CUSTOM_PREFIX}${fixture.kind}`);
      const custom = objectAt(acp.frame.body.custom, `${fixture.kind}.custom`);
      assert.deepEqual({ ...objectAt(custom.source, "custom.source") }, { ...acp.frame.source });
      assert.deepEqual(objectAt(custom.payload, "custom.payload"), admitted.envelope.payload);
    }

    const agui = projectAgui(admitted, createAguiState());
    if (agui.ok && agui.frame.disposition === "custom") {
      assert.equal(agui.frame.type, "CUSTOM");
      assert.equal(agui.frame.body.name, `${FRAME_CUSTOM_PREFIX}${fixture.kind}`);
      const value = objectAt(agui.frame.body.value, `${fixture.kind}.value`);
      assert.deepEqual({ ...objectAt(value.source, "value.source") }, { ...agui.frame.source });
      assert.deepEqual(objectAt(value.payload, "value.payload"), admitted.envelope.payload);
    }
  }
});

test("终态：ag-ui 用 RUN_ERROR 区分失败，ACP 只给 StopReason 并把有损写进帧", () => {
  const cases: ReadonlyArray<{
    reason: string;
    acp: string;
    lossy: boolean;
    agui: string;
  }> = [
    { reason: "completed", acp: "end_turn", lossy: false, agui: "RUN_FINISHED" },
    { reason: "cancelled", acp: "cancelled", lossy: false, agui: "RUN_FINISHED" },
    { reason: "failed", acp: "other", lossy: true, agui: "RUN_ERROR" },
    { reason: "unknown", acp: "other", lossy: true, agui: "RUN_ERROR" },
  ];
  for (const item of cases) {
    const raw = rawEnvelope("terminal", { reason: item.reason }, { turnId: "trn-inline" });
    const acp = acpFrameOf(raw);
    const terminal = objectAt(acp.body.terminal, `${item.reason}.terminal`);

    assert.equal(terminal.stopReason, item.acp, item.reason);
    assert.equal(terminal.lossy, item.lossy, item.reason);
    assert.equal(String(terminal.detail).length > 0, true, item.reason);
    const agui = aguiFrameOf(raw);

    assert.equal(agui.type, item.agui, item.reason);
    assert.equal(agui.body.outcome, item.reason, item.reason);
  }
});

test("failed 的细值只来自 payload 已有字段（cause 优先于 finishReason）", () => {
  const byCause = acpFrameOf(
    rawEnvelope("terminal", { reason: "failed", cause: "iterations_exhausted" }),
  );

  assert.equal(objectAt(byCause.body.terminal, "terminal").stopReason, "max_turn_requests");
  const byFinish = acpFrameOf(
    rawEnvelope("terminal", { reason: "failed", finishReason: "content_filter" }),
  );

  assert.equal(objectAt(byFinish.body.terminal, "terminal").stopReason, "refusal");
  const unknown = acpFrameOf(rawEnvelope("terminal", { reason: "failed", errorClass: "auth" }));

  assert.equal(objectAt(unknown.body.terminal, "terminal").stopReason, "other");
});

test("终态词表仍是 4 值：本包没有把 failed 悄悄扩成五值", () => {
  assert.deepEqual([...TERMINAL_REASONS], ["completed", "failed", "cancelled", "unknown"]);
});

test("approval_requested 表示「阻塞于审批」：请求原语 + requires_action", () => {
  const frame = acpFrameOf(fixtureOf("approval_requested").envelope);

  assert.equal(frame.primitive, "request_permission");
  assert.equal(frame.agentState, "requires_action");
  assert.equal(frame.body.toolCallId, "call-p07-1");
  assert.equal(frame.body.ticketId, "tkt-p07-1");
  const blocked = Object.values(ACP_ROWS).filter((row) => row.agentState === "requires_action");

  assert.equal(blocked.length, 1, "requires_action 只允许由 permission_block 桥产生");
});

test("未知 kind：进场被忽略且保留坐标，绕过进场也被拒绝且不抛异常", () => {
  const raw = rawEnvelope("future_vendor_blob", { anything: 1 });
  const result = admit(raw);

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.equal(result.outcome, "ignored_unknown_kind");
  assert.equal(result.kind, "future_vendor_blob");

  const forged = {
    envelope: {
      protocolVersion: "0.0",
      eventId: "evt-forged",
      sequence: 0,
      timestamp: "2026-09-15T00:00:00.000Z",
      kind: "future_vendor_blob",
      payload: {},
      producerId: "cli",
      producerSequence: 0,
    },
  } as unknown as AdmittedEnvelope;
  const acp = projectAcp(forged);

  assert.equal(acp.ok, false);

  if (acp.ok) {
    return;
  }

  assert.equal(acp.code, "unknown_kind");
  assert.equal(projectAgui(forged, createAguiState()).ok, false);
});

test("未过校验的 envelope 被拒绝，不进入投影", () => {
  const result = admit({ kind: "text" });

  assert.equal(result.ok, false);

  if (result.ok) {
    return;
  }

  assert.equal(result.code, "invalid_envelope");
  assert.equal(result.detail, "missing_event_id");
});

test("payload 缺必需字段 → 显式失败，不产出半成品帧", () => {
  const admitted = admitOrFail(rawEnvelope("tool_use", { toolCallId: "call-1" }));
  const acp = projectAcp(admitted);

  assert.equal(acp.ok, false);

  if (acp.ok) {
    return;
  }

  assert.equal(acp.code, "payload_contract_violation");
  assert.equal(acp.detail.includes("tool_use.name"), true);
  assert.equal(projectAgui(admitted, createAguiState()).ok, false);
});

test("帧与帧体都被冻结：订阅方改不动（replay 字节一致的前提）", () => {
  const frame = acpFrameOf(fixtureOf("text").envelope);
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(Object.isFrozen(frame.body), true);
  assert.throws(() => {
    (frame.body as unknown as Record<string, unknown>).injected = 1;
  });
});

test("缺血缘不得虚构 parent：帧体里不出现任何父谱系字段，只在 omitted 里登记", () => {
  for (const fixture of FIXTURES) {
    const acpBody = JSON.stringify(acpFrameOf(fixture.envelope).body);

    assert.equal(acpBody.includes("parentAgentId"), false, fixture.kind);
    const aguiBody = JSON.stringify(aguiFrameOf(fixture.envelope).body);

    for (const field of [
      "parentSubagentRunId",
      "parentToolCallId",
      "parentMessageId",
      "parentRunId",
    ]) {
      assert.equal(aguiBody.includes(field), false, `${fixture.kind}: ${field}`);
    }
  }
});

test("子代理帧只吐 payload 自带的 id，并显式登记缺失的父谱系", () => {
  const spawn = aguiFrameOf(fixtureOf("subagent_spawn").envelope);
  assert.equal(spawn.type, "SUBAGENT_STARTED");
  assert.equal(spawn.body.subagentRunId, "sub-p07-1");
  assert.equal(spawn.omitted.includes("parentSubagentRunId"), true);
  assert.equal(spawn.omitted.includes("parentToolCallId"), true);
});

test("未知 payload 字段不 fail-closed：声明了 raw 的行照原样带上，其余安静忽略但坐标仍在", () => {
  const withExtra = acpFrameOf(
    rawEnvelope("tool_result", { toolCallId: "call-1", status: "succeeded", vendorField: "v1" }),
  );
  const raw = objectAt(withExtra.body.raw, "tool_result.raw");

  assert.equal(raw.vendorField, "v1");

  const textFrame = acpFrameOf(rawEnvelope("text", { text: "hi", vendorField: "v1" }));

  assert.equal(JSON.stringify(textFrame.body).includes("vendorField"), false);
  assert.equal(textFrame.source.kind, "text");
  assert.equal(textFrame.source.eventId, "evt-text-inline");
});
