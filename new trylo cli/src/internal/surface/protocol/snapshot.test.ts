import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonObject, JsonValue } from "../../protocol/envelope.js";
import { projectAgui } from "./agui.js";
import { admit, type AdmittedEnvelope } from "./admit.js";
import type { AguiFrame } from "./frames.js";
import { createAguiState } from "./state.js";

/**
 * P3：ag-ui `STATE_SNAPSHOT` 的可重建性。
 *
 * 本包的实现是「截至该 sequence 的聚合对象」（WP §4 P3 允许、并禁止为此改
 * journal）。所以这一组用例的全部价值在于**独立重算**：测试里手写一遍
 * `independentAggregate()`，不复用 `state.ts` 的任何代码。如果只是拿
 * `applyAguiState` 自己和自己比，那证明不了任何东西。
 *
 * 同时钉死两件事：snapshot 是**有界标量集合**（不随会话长度增长），
 * 以及本包**没有**做 `STATE_DELTA`（无补丁库，HANDOFF 已登记为 OPEN）。
 */

type Fixture = { readonly kind: string; readonly envelope: Record<string, unknown> };

function loadFixtures(): ReadonlyArray<Fixture> {
  const path = join(process.cwd(), "testdata", "protocol", "projection", "envelopes.json");
  return JSON.parse(readFileSync(path, "utf8")) as ReadonlyArray<Fixture>;
}

const FIXTURES = loadFixtures();

function rawEnvelope(kind: string, payload: JsonObject): Record<string, unknown> {
  return {
    protocolVersion: "0.0",
    eventId: `evt-${kind}-snapshot`,
    sequence: 99,
    timestamp: "2026-09-15T00:00:00.000Z",
    kind,
    payload,
    producerId: "cli",
    producerSequence: 99,
  };
}

function admitOrFail(raw: unknown): AdmittedEnvelope {
  const result = admit(raw);
  if (!result.ok) {
    assert.fail(`应当通过校验，却返回 ${result.detail}`);
  }

  if (result.outcome !== "admitted") {
    assert.fail(`应当是已知 kind，却被忽略为 ${result.kind}`);
  }

  return result.admitted;
}

function projectStream(envelopes: ReadonlyArray<unknown>): ReadonlyArray<AguiFrame> {
  let state = createAguiState();
  const frames: AguiFrame[] = [];

  for (const envelope of envelopes) {
    const result = projectAgui(admitOrFail(envelope), state);
    if (!result.ok) {
      assert.fail(`${result.code}: ${result.detail}`);
    }
    frames.push(result.frame);
    state = result.state;
  }

  return frames;
}

/** 独立重算：只吃原始 envelope 数组，不 import 生产代码的任何函数。 */
function independentAggregate(envelopes: ReadonlyArray<Record<string, unknown>>): JsonObject {
  const kindCounts: { [key: string]: JsonValue } = {};
  let textChars = 0;
  let thinkingChars = 0;
  let toolCallCount = 0;
  let lastTerminalReason: JsonValue = null;
  let lastEventId: JsonValue = null;

  for (const envelope of envelopes) {
    const kind = String(envelope.kind);

    kindCounts[kind] = (Number(kindCounts[kind] ?? 0) + 1) as JsonValue;
    const payload = envelope.payload as Record<string, unknown>;
    if (kind === "text" && typeof payload.text === "string") {
      textChars += payload.text.length;
    }

    if (kind === "thinking" && typeof payload.text === "string") {
      thinkingChars += payload.text.length;
    }

    if (kind === "tool_use") {
      toolCallCount += 1;
    }

    if (kind === "terminal" && typeof payload.reason === "string") {
      const reason = payload.reason;
      if (reason === "completed" || reason === "failed" || reason === "cancelled" || reason === "unknown") {
        lastTerminalReason = reason;
      }
    }

    lastEventId = String(envelope.eventId);
  }

  return {
    eventCount: envelopes.length,
    kindCounts,
    textChars,
    thinkingChars,
    toolCallCount,
    lastTerminalReason,
    lastEventId,
  };
}

function snapshotOf(frame: AguiFrame): JsonObject {
  assert.equal(frame.type, "STATE_SNAPSHOT");
  const snapshot = frame.body.snapshot;
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    assert.fail("snapshot 应当是对象");
  }
  return snapshot as JsonObject;
}

test("compact 帧的 snapshot 与独立重算的聚合对象逐字相等", () => {
  const envelopes = FIXTURES.map((item) => item.envelope);
  const compactIndex = FIXTURES.findIndex((item) => item.kind === "compact");

  assert.equal(compactIndex > 0, true, "夹具里必须有 compact 才能测 snapshot");
  const frames = projectStream(envelopes);
  const frame = frames[compactIndex];

  assert.notEqual(frame, undefined);

  if (frame === undefined) {
    return;
  }

  assert.deepEqual(
    { ...snapshotOf(frame) },
    independentAggregate(envelopes.slice(0, compactIndex + 1)),
  );
});

test("连续 snapshot 单调可重建：后一个 snapshot 覆盖前一个的全部计数", () => {
  const envelopes = [
    ...FIXTURES.map((item) => item.envelope),
    rawEnvelope("compact", { compactId: "cmp-second", droppedEvents: 2 }),
  ];
  const frames = projectStream(envelopes);
  const snapshots = frames.filter((frame) => frame.type === "STATE_SNAPSHOT").map(snapshotOf);

  assert.equal(snapshots.length, 2);
  const [first, second] = snapshots;

  assert.notEqual(first, undefined);
  assert.notEqual(second, undefined);

  if (first === undefined || second === undefined) {
    return;
  }

  assert.equal(Number(second.eventCount) > Number(first.eventCount), true);
  assert.deepEqual({ ...second }, independentAggregate(envelopes));
});

test("snapshot 是有界标量集合：键集固定，不随会话增长", () => {
  const frames = projectStream(FIXTURES.map((item) => item.envelope));
  const frame = frames.find((item) => item.type === "STATE_SNAPSHOT");

  assert.notEqual(frame, undefined);

  if (frame === undefined) {
    return;
  }

  assert.deepEqual(Object.keys(snapshotOf(frame)).sort(), [
    "eventCount",
    "kindCounts",
    "lastEventId",
    "lastTerminalReason",
    "textChars",
    "thinkingChars",
    "toolCallCount",
  ]);
});

test("snapshot 不携带正文：正文只出现在它自己的那个事件的帧里", () => {
  const frames = projectStream(FIXTURES.map((item) => item.envelope));
  const frame = frames.find((item) => item.type === "STATE_SNAPSHOT");

  assert.notEqual(frame, undefined);

  if (frame === undefined) {
    return;
  }

  const serialized = JSON.stringify(snapshotOf(frame));

  assert.equal(serialized.includes("the failing test is protocol.test.ts"), false);
  assert.equal(serialized.includes("check the assertion before the fixture"), false);
});

test("本包只做 SNAPSHOT：整条流里不出现 STATE_DELTA", () => {
  const frames = projectStream(FIXTURES.map((item) => item.envelope));

  assert.equal(frames.length, FIXTURES.length);
  assert.equal(
    frames.some((frame) => frame.type === "STATE_DELTA"),
    false,
    "STATE_DELTA 需要 RFC6902 补丁生成器，本包不做（HANDOFF 已登记 OPEN）",
  );
});
