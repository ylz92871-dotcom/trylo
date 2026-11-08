import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderPort } from "../../../../../ports/provider.js";
import type { TimerScheduler } from "../../../../../subagent/scheduler.js";
import { runCentralMethodResearchModel } from "./central-research-model.js";

test("central method research permits a normal late response and cancels its stage watchdog", async () => {
  let due = 0, fire: (() => void) | undefined, cancelled = false;
  const scheduler: TimerScheduler = (delay, callback) => {
    due = delay;
    fire = callback;
    return { cancel() { cancelled = true; } };
  };
  const finding = { kind: "finding", statement: "Read the declared schema before editing.",
    conditions: "A schema is declared", sourceRefs: ["source:business"], residual: [] };
  const provider: ProviderPort = { async *stream() {
    yield { type: "stream_start", providerId: "controlled", model: "controlled", warnings: [] };

    // Simulate a valid public answer after three minutes. The old 30-second
    // watchdog would already have fired; no real sleep or network is involved.
    if (due <= 180000) fire?.();

    yield { type: "text_delta", blockId: "public", text: JSON.stringify(finding) };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 5000, outputTokens: 9000, totalTokens: 14000 } };
    yield { type: "finish", reason: "stop", requiresFollowUp: false, rawReason: "stop" };
  } };
  const result = await runCentralMethodResearchModel({ provider, scheduler, model: "controlled", reservationId: "call:late",
    material: "Original material", maxTokens: 20000, maxOutputTokens: 12000, enabled: () => true }, new AbortController().signal);

  assert.equal(result.reason, undefined);
  assert.deepEqual(result.finding, finding);
  assert.equal(result.settlement.kind, "reported");
  assert.equal(cancelled, true);
});

test("the remaining segment deadline aborts a noncooperating wait and retains unknown usage", async () => {
  let fire: (() => void) | undefined, due = 0, cancelTimer = false, providerSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>(resolve => { release = resolve; });
  const scheduler: TimerScheduler = (delay, callback) => {
    due = delay;
    fire = callback;
    return { cancel() { cancelTimer = true; } };
  };
  const provider: ProviderPort = { async *stream(_request, signal) {
    providerSignal = signal;
    release?.();
    yield { type: "stream_start", providerId: "controlled", model: "controlled", warnings: [] };
    await new Promise<never>(() => {});
  } };
  const options = { provider, scheduler, timeoutMs: 17000, model: "controlled", reservationId: "call:remaining",
    material: "Original material", maxTokens: 20000, maxOutputTokens: 12000, enabled: () => true };
  const pending = runCentralMethodResearchModel(options, new AbortController().signal);

  await started;
  fire?.();
  const result = await pending;

  assert.equal(due, 17000, "the next call receives the stage's remaining time, not a new full window");
  assert.equal(result.reason, "method_research_timeout");
  assert.equal(result.settlement.kind, "unknown");
  assert.equal(providerSignal?.aborted, true);
  assert.equal(cancelTimer, true);
});
