import assert from "node:assert/strict";
import test from "node:test";
import type { Envelope } from "../../protocol/envelope.js";
import type { SessionPort } from "../../ports/session.js";
import { persistTurn } from "./session-record.js";

/**
 * D7 P1-②：journal 每条记录自带真实时间，不再共享一个 flush 时刻。
 *
 * envelope 记录用发射时刻（envelope.timestamp）；turn_start 用 turn 开始；
 * terminal 用落盘；其余逐条落盘时刻。时间线不可用，事后审计与"哪一步慢"
 * 无从谈起——这是 hard-eval T1 被挡住定位的直接原因。
 */

type Captured = Parameters<SessionPort["append"]>[0];

function envelopeAt(timestamp: string, sequence: number): Envelope {
  return {
    protocolVersion: "0.0",
    eventId: `e${sequence}`,
    sequence,
    timestamp,
    kind: "text_delta",
    payload: {},
    producerId: "p",
    producerSequence: sequence,
  };
}

function capturingSession(captured: Captured[]): SessionPort {
  return {
    start: async () => ({ ok: true }) as const,
    attach: async () => ({ ok: true }) as const,

    append: async (record) => {
      captured.push(record);
      return { ok: true, sequence: captured.length } as const;
    },

    repairTornTail: async () => ({ ok: true, removedBytes: 0 }) as const,
    read: async () => ({ ok: false, code: "missing_session", detail: "x" }) as const,
    readRecords: async () => ({ ok: true, view: { records: [], window: undefined, tornTail: false } }) as const,
    release: async () => {},
  };
}

test("D7: envelope records keep their emission time, brackets use turn bounds", async () => {
  const captured: Captured[] = [];
  let tick = 0;
  const clock = (): string => `2026-09-27T14:00:00.${String(100 + tick++).padStart(3, "0")}Z`;
  const warnings = await persistTurn(capturingSession(captured), {
    sessionId: "s",
    turnId: "t",
    newTranscript: [],
    envelopes: [envelopeAt("2026-09-27T13:00:00.000Z", 0), envelopeAt("2026-09-27T13:30:00.000Z", 1)],
    issuedKeys: [],
    committedKeys: [],
    terminalReason: "completed",
    finishReason: "stop",
    iterations: 2,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    startedAt: "2026-09-27T12:59:00.000Z",
    finishedAt: "2026-09-27T14:00:00.000Z",
    clock,
  });

  assert.deepEqual(warnings, []);
  const byType = (type: Captured["type"]): Captured[] => captured.filter((record) => record.type === type);

  assert.equal(byType("turn_start")[0]?.at, "2026-09-27T12:59:00.000Z");
  assert.deepEqual(
    byType("envelope").map((record) => record.at),
    ["2026-09-27T13:00:00.000Z", "2026-09-27T13:30:00.000Z"],
  );
  assert.equal(byType("terminal")[0]?.at, "2026-09-27T14:00:00.000Z");
  // 不再是同一个 flush 时刻：时间线可单调读。
  const stamps = captured.map((record) => record.at);

  assert.equal(new Set(stamps).size > 1, true, "every record still shares one timestamp");
  const sorted = [...stamps].sort();

  assert.deepEqual(stamps, sorted);
});

test("D7: non-envelope records are stamped per append, not from one value", async () => {
  const captured: Captured[] = [];
  let tick = 0;
  const clock = (): string => `2026-09-27T14:00:00.${String(100 + tick++).padStart(3, "0")}Z`;

  await persistTurn(capturingSession(captured), {
    sessionId: "s",
    turnId: "t",
    newTranscript: [{ kind: "user", sequence: 1, text: "hi" }],
    envelopes: [],
    issuedKeys: ["k1"],
    committedKeys: ["k1"],
    terminalReason: "completed",
    finishReason: "stop",
    iterations: 1,
    usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    startedAt: "2026-09-27T12:59:00.000Z",
    finishedAt: "2026-09-27T14:00:00.000Z",
    clock,
  });
  const middle = captured.filter((record) => record.type !== "turn_start" && record.type !== "terminal");

  assert.equal(middle.length > 0, true);
  const stamps = middle.map((record) => record.at);

  assert.equal(new Set(stamps).size, stamps.length, "records made at different appends share a stamp");
});
