import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import { emptyUsage } from "../../../../../ports/provider.js";
import type { CollaborationAnalysisWindowV2 } from "../domain/v2-contracts.js";
import { createCollaborationModelAnalyzerV2 } from "./model-analysis-v2.js";

const window: CollaborationAnalysisWindowV2 = { schemaVersion: 2, scope: "workspace:test", boardSequence: 0,
  events: [], episodes: [], outcomes: [], practices: [] };
const request = () => ({ cycleId: "cycle", step: 1, window, maxTokens: 16000, signal: new AbortController().signal });
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };

function provider(events: readonly ProviderEvent[], seen: ProviderRequest[] = []): ProviderPort {
  const isolated: ProviderPort = { async *stream(value) {
    seen.push(value);
    yield* events;
  } };
  return { fork: () => isolated, async *stream() { throw new Error("parent continuation must never be used"); } };
}

const text: ProviderEvent = { type: "text_delta", blockId: "a", text: '{"status":"no_change","reason":"insufficient evidence"}' };
const usage = (tokens: number): ProviderEvent => ({ type: "usage", usage: { ...emptyUsage(), inputTokens: tokens - 2, outputTokens: 2, totalTokens: tokens } });

test("analysis uses an isolated inert provider, accounts snapshots once and returns a strictly decoded result", async () => {
  const seen: ProviderRequest[] = [];
  const analyzer = createCollaborationModelAnalyzerV2({ provider: provider([text, usage(10), usage(20), finish], seen),
    model: "configured", nowMs: () => 100 });
  const result = await analyzer.analyze(request());

  assert.equal(result.status, "no_change");
  assert.equal(result.tokenCost, 20);
  assert.deepEqual(result.usage, { status: "reported", elapsedMs: 0, model: "configured", inputTokens: 18, outputTokens: 2, totalTokens: 20 });
  assert.deepEqual(seen[0]?.tools, []);
  assert.equal(seen[0]?.continuationScope, "collaboration-learning:cycle");
  assert.equal(seen[0]?.model, "configured");
  assert.ok((seen[0]?.maxOutputTokens ?? 0) <= 4096);
});

test("missing usage is an unknown full reservation, never a free or measured successful call", async () => {
  const result = await createCollaborationModelAnalyzerV2({ provider: provider([text, finish]), model: "m", nowMs: () => 0 }).analyze(request());
  assert.equal(result.status, "no_change");
  assert.equal(result.tokenCost, 16000);
  assert.deepEqual(result.usage, { status: "reserved_unknown", elapsedMs: 0, model: "m" });
  const zero = await createCollaborationModelAnalyzerV2({ provider: provider([text, { type: "usage", usage: emptyUsage() }, finish]), model: "m", nowMs: () => 0 }).analyze(request());
  assert.equal(zero.tokenCost, 16000);
  assert.equal(zero.usage?.status, "reserved_unknown");
});

test("malformed output, tool requests and provider failures cannot produce a practice", async () => {
  for (const events of [[{ ...text, text: '{"status":"no_change","reason":"x","permission":"grant"}' }, finish],
    [{ ...text, text: "unparseable" }, finish],
    [{ type: "tool_call", toolCallId: "a", name: "write_file", arguments: {} }, finish],
    [{ type: "error", class: "rate_limit", phase: "before_headers", retryable: true, message: "private provider response" }]] satisfies ProviderEvent[][]) {
    const result = await createCollaborationModelAnalyzerV2({ provider: provider(events), model: "m" }).analyze(request());
    assert.equal(result.status, "failed");
    assert.ok(!JSON.stringify(result).includes("private provider response"));
    assert.equal(result.tokenCost, 16000);
  }
});

test("disabled, aborted, insufficient input allowance and unavailable isolation perform no model call", async () => {
  const seen: ProviderRequest[] = [];
  const base = provider([text, finish], seen);
  const disabled = await createCollaborationModelAnalyzerV2({ provider: base, model: "m", enabled: () => false }).analyze(request());
  const controller = new AbortController();
  controller.abort();
  const aborted = await createCollaborationModelAnalyzerV2({ provider: base, model: "m" }).analyze({ ...request(), signal: controller.signal });
  const tooSmall = await createCollaborationModelAnalyzerV2({ provider: base, model: "m" }).analyze({ ...request(), maxTokens: 1 });
  const unavailable = await createCollaborationModelAnalyzerV2({ provider: { stream: base.stream }, model: "m" }).analyze(request());

  for (const result of [disabled, aborted, tooSmall, unavailable]) {
    assert.equal(result.status, "failed");
    assert.equal(result.tokenCost, 0);
  }

  assert.equal(seen.length, 0);
  const estimating = createCollaborationModelAnalyzerV2({ provider: base, model: "m" });
  const estimate = estimating.estimateInputTokens?.(window);

  assert.ok(typeof estimate === "number" && estimate > 0);
  assert.equal(seen.length, 0, "window planning cannot spend a provider call");
});

test("mid-stream cancellation and collection withdrawal discard model proposals and preserve their charge", async () => {
  for (const mode of ["cancel", "withdraw"] as const) {
    const controller = new AbortController();
    let enabled = true;
    const isolated: ProviderPort = { async *stream() {
      yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
      if (mode === "cancel") controller.abort(); else enabled = false;
      yield text;
      yield finish;
    } };
    const result = await createCollaborationModelAnalyzerV2({ provider: { ...isolated, fork: () => isolated }, model: "m", enabled: () => enabled })
      .analyze({ ...request(), signal: controller.signal });

    assert.equal(result.status, "failed");

    if (result.status === "failed") assert.equal(result.reason, mode === "cancel" ? "learning_aborted" : "collect_disabled");

    assert.equal(result.tokenCost, 16000);
  }
});

test("actual usage above the grant is visible and stops learning rather than being clamped", async () => {
  const result = await createCollaborationModelAnalyzerV2({ provider: provider([text, usage(17000), finish]), model: "m" }).analyze(request());
  assert.equal(result.status, "failed");
  assert.equal(result.tokenCost, 17000);
  assert.equal(result.usage?.totalTokens, 17000);
  if (result.status === "failed") assert.equal(result.reason, "collaboration_model_budget_exceeded");
});

test("bounded source projections reach the model with uncertainty instead of pretending omitted events never occurred", async () => {
  const seen: ProviderRequest[] = [];
  const projection = { omittedEventCount: 12, fullEventSetHash: "a".repeat(64) };
  const analyzer = createCollaborationModelAnalyzerV2({ provider: provider([text, finish], seen), model: "m" });

  assert.equal((await analyzer.analyze({ ...request(), window: { ...window, projection } })).status, "no_change");
  const userContent = seen[0]!.messages[1]!.content, systemContent = seen[0]!.messages[0]!.content;

  assert.ok(typeof userContent === "string" && typeof systemContent === "string");
  const material = JSON.parse(userContent);

  assert.deepEqual(material.projection, projection);
  assert.match(systemContent, /Omitted bodies are not missing executions/);
});
