import assert from "node:assert/strict";
import test from "node:test";
import { createMechanismMeter } from "./hermes-internalization-real-meter.mjs";

test("a consumer returning on finish cannot make missing usage look healthy or fund another call", async () => {
  const meter = createMechanismMeter({ origin: "https://synthetic.invalid", mergeUsage: () => assert.fail("fixture emits no usage"),
    emptyUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }) });
  let started = 0;
  const provider = meter.guard({ async *stream() {
    started += 1;
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } });

  try {
    meter.begin("source");
    const request = { maxOutputTokens: 128 }, signal = new AbortController().signal;

    for await (const event of provider.stream(request, signal)) {
      if (event.type === "finish") break; // Mirrors the execution consumer's iterator return.
    }

    assert.equal(meter.snapshot().usageComplete, false);
    assert.equal(meter.snapshot().failure, "real_usage_missing");
    assert.throws(() => meter.assertHealthy(), /real_usage_missing/);
    await assert.rejects(provider.stream(request, signal).next(), /real_usage_missing/);
    assert.equal(started, 1, "the missing first bill must prevent another provider stream");
    assert.equal(meter.snapshot().totalCalls, 1);
  } finally { meter.close(); }
});

test("invalid usage cannot turn the output allowance into an unknown numeric budget", async () => {
  const meter = createMechanismMeter({ origin: "https://synthetic.invalid", mergeUsage: () => assert.fail("invalid usage must not merge"),
    emptyUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }) });
  let started = 0;
  const provider = meter.guard({ async *stream() {
    started += 1;
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 1, outputTokens: Number.NaN, totalTokens: 2,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
  } });

  try {
    meter.begin("source");
    await assert.rejects(provider.stream({}, new AbortController().signal).next(), /real_usage_invalid/);
    assert.throws(() => meter.assertHealthy(), /real_usage_missing|real_usage_invalid/);
    await assert.rejects(provider.stream({}, new AbortController().signal).next());
    assert.equal(started, 1);
  } finally { meter.close(); }
});

test("partial usage without a successful finish stays a lower bound and prevents another paid attempt", async () => {
  const usage = { mode: "snapshot", inputTokens: 10, outputTokens: 5, totalTokens: 15,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const meter = createMechanismMeter({ origin: "https://synthetic.invalid", mergeUsage: (_before, value) => value,
    emptyUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }) });
  let started = 0;
  const provider = meter.guard({ async *stream() {
    started++;
    yield { type: "usage", usage };
  } });

  try {
    meter.begin("source");

    for await (const _event of provider.stream({}, new AbortController().signal)) { /* Observe the interrupted stream. */ }

    const snapshot = meter.snapshot();

    assert.equal(snapshot.usageComplete, false);
    assert.equal(snapshot.calls[0].usageStatus, "partial");
    assert.deepEqual(snapshot.totalObservedUsage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    assert.deepEqual(snapshot.totalReportedUsage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.throws(() => meter.assertHealthy(), /real_stream_incomplete/);
    await assert.rejects(provider.stream({}, new AbortController().signal).next());
    assert.equal(started, 1);
  } finally { meter.close(); }
});
