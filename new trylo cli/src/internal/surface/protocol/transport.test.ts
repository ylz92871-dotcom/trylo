import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import type { TransportFrame } from "../../ports/transport.js";
import { projectAcp } from "./acp.js";
import { admit, type AdmittedEnvelope } from "./admit.js";
import { projectAgui } from "./agui.js";
import { createAguiState } from "./state.js";
import { createInProcessTransport, toUnstampedFrame } from "./transport.js";

/**
 * P4：in-process transport + cursor replay。
 *
 * 全部用例都在**进程内**跑，没有任何 `listen()`：`listen(0)` 冒充 in-process
 * 是 WP §5 第 1 条明令禁止的（那会变成「测了一个真实网络端口」）。
 *
 * 三条核心断言：
 * - `transportSequence` 与 `Envelope.sequence` 是两个无关的计数器；
 * - 先订阅后 append 不丢，后订阅者拿不到历史（live 不补发），只能 replay；
 * - replay 与当时 live 是**同一批字节**（JSON 序列化后逐字比较）。
 */

function rawEnvelope(kind: string, payload: JsonObject, sequence: number): unknown {
  return {
    protocolVersion: "0.0",
    eventId: `evt-${kind}-${sequence}`,
    sequence,
    timestamp: "2026-09-15T00:00:00.000Z",
    kind,
    payload,
    producerId: "cli",
    producerSequence: sequence,
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

function acpFrame(raw: unknown) {
  const result = projectAcp(admitOrFail(raw));
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.detail}`);
  }
  return result.frame;
}

function aguiFrame(raw: unknown) {
  const result = projectAgui(admitOrFail(raw), createAguiState());
  if (!result.ok) {
    assert.fail(`${result.code}: ${result.detail}`);
  }
  return result.frame;
}

function textPayload(text: string): JsonObject {
  return { text };
}

test("transportSequence 是传输层自己的计数器，与 envelope.sequence 无关", () => {
  const transport = createInProcessTransport();
  const first = transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("a"), 11))));
  const second = transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("b"), 3))));
  const third = transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("c"), 11))));

  assert.deepEqual(
    [first, second, third].map((frame) => frame.transportSequence),
    [0, 1, 2],
  );
  assert.deepEqual(
    [first, second, third].map((frame) => frame.sourceSequence),
    [11, 3, 11],
  );
  assert.equal(transport.latestSequence(), 2);
});

test("先订阅后 append 不丢；append 之后才订阅的人只能靠 replay 找回历史", () => {
  const transport = createInProcessTransport();
  const live: TransportFrame[] = [];
  const unsubscribe = transport.subscribe((frame) => live.push(frame));

  const a = transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("a"), 0))));
  const b = transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("b"), 1))));

  assert.deepEqual(live, [a, b]);

  const late: TransportFrame[] = [];

  transport.subscribe((frame) => late.push(frame));
  const c = transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("c"), 2))));

  assert.deepEqual(late, [c], "后订阅者不得收到历史帧");

  const replayed = transport.replay({ sinceSequence: -1 });

  assert.equal(replayed.ok, true);

  if (!replayed.ok) {
    return;
  }

  assert.deepEqual(replayed.frames, [a, b, c], "历史只能靠 replay 找回");

  unsubscribe();
  transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("d"), 3))));
  assert.deepEqual(live, [a, b, c], "取消订阅后不再收到新帧");
});

test("replay 与 live 是同一批字节：JSON 序列化后逐字相等", () => {
  const transport = createInProcessTransport();
  const live: TransportFrame[] = [];

  transport.subscribe((frame) => live.push(frame));
  const inputs: ReadonlyArray<unknown> = [
    rawEnvelope("text", textPayload("alpha"), 0),
    rawEnvelope("usage", { inputTokens: 1, outputTokens: 2 }, 1),
    rawEnvelope("tool_use", { toolCallId: "call-1", name: "read_file" }, 2),
    rawEnvelope("tool_result", { toolCallId: "call-1", status: "succeeded" }, 3),
    rawEnvelope("terminal", { reason: "failed", cause: "iterations_exhausted" }, 4),
  ];

  for (const input of inputs) {
    transport.append(toUnstampedFrame(acpFrame(input)));
  }

  const replayed = transport.replay({ sinceSequence: -1 });

  assert.equal(replayed.ok, true);

  if (!replayed.ok) {
    return;
  }

  assert.deepEqual(
    replayed.frames.map((frame) => JSON.stringify(frame)),
    live.map((frame) => JSON.stringify(frame)),
  );
  assert.equal(replayed.latestSequence, 4);
});

test("中间游标：只返回其后的帧，升序且全局序号连续", () => {
  const transport = createInProcessTransport();

  for (let index = 0; index < 6; index += 1) {
    transport.append(
      toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload(`t${index}`), index))),
    );
  }

  const replayed = transport.replay({ sinceSequence: 2 });

  assert.equal(replayed.ok, true);

  if (!replayed.ok) {
    return;
  }

  assert.deepEqual(
    replayed.frames.map((frame) => frame.transportSequence),
    [3, 4, 5],
  );
  const tail = transport.replay({ sinceSequence: 5 });

  assert.equal(tail.ok, true);

  if (!tail.ok) {
    return;
  }

  assert.deepEqual(tail.frames, []);
});

test("非法游标被显式拒绝，不抛异常也不静默当成 0", () => {
  const transport = createInProcessTransport();

  transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("a"), 0))));

  for (const cursor of [-2, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = transport.replay({ sinceSequence: cursor });

    assert.equal(result.ok, false, String(cursor));

    if (result.ok) {
      continue;
    }

    assert.equal(result.code, "invalid_cursor");
    assert.equal(result.detail.length > 0, true);
  }

  // -1 是文档化的「从头开始」哨兵：第 0 帧必须可达。
  const fromStart = transport.replay({ sinceSequence: -1 });

  assert.equal(fromStart.ok, true);

  if (!fromStart.ok) {
    return;
  }

  assert.deepEqual(
    fromStart.frames.map((frame) => frame.transportSequence),
    [0],
  );
});

test("空 log：latestSequence 是 -1，任何非负游标都拿回空数组", () => {
  const transport = createInProcessTransport();

  assert.equal(transport.latestSequence(), -1);
  const result = transport.replay({ sinceSequence: 0 });

  assert.equal(result.ok, true);

  if (!result.ok) {
    return;
  }

  assert.deepEqual(result.frames, []);
  assert.equal(result.latestSequence, -1);
});

test("append 返回的就是订阅者收到的同一个对象（字节一致的前提）", () => {
  const transport = createInProcessTransport();
  const seen: TransportFrame[] = [];

  transport.subscribe((frame) => seen.push(frame));
  const stamped = transport.append(
    toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("x"), 0))),
  );

  assert.equal(seen[0], stamped);
  assert.equal(Object.isFrozen(stamped), true);
  assert.throws(() => {
    (stamped.body as unknown as Record<string, unknown>).injected = 1;
  });
});

test("订阅者抛异常不被吞掉，且事实已经入 log（不回滚）", () => {
  const transport = createInProcessTransport();

  transport.subscribe(() => {
    throw new Error("listener exploded");
  });
  assert.throws(() => {
    transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("boom"), 0))));
  }, /listener exploded/);
  const replayed = transport.replay({ sinceSequence: -1 });

  assert.equal(replayed.ok, true);

  if (!replayed.ok) {
    return;
  }

  assert.equal(replayed.frames.length, 1, "事实先落地：log 里已经有了这一帧");
});

test("两种表面可以共用一条 log：surface 字段区分，序号全局唯一", () => {
  const transport = createInProcessTransport();

  transport.append(toUnstampedFrame(acpFrame(rawEnvelope("text", textPayload("a"), 0))));
  transport.append(toUnstampedFrame(aguiFrame(rawEnvelope("text", textPayload("a"), 0))));
  const replayed = transport.replay({ sinceSequence: -1 });

  assert.equal(replayed.ok, true);

  if (!replayed.ok) {
    return;
  }

  assert.deepEqual(
    replayed.frames.map((frame) => frame.surface),
    ["acp", "agui"],
  );
  assert.deepEqual(
    replayed.frames.map((frame) => frame.transportSequence),
    [0, 1],
  );
});
