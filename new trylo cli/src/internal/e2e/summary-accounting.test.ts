import assert from "node:assert/strict";
import { test } from "node:test";
import type { IterationBudget, UsagePricing } from "../domain/iteration.js";
import { emptyUsage, type ProviderPort, type ProviderRequest, type ProviderUsage } from "../ports/provider.js";
import { createModelSummarizer, SUMMARIZER_INSTRUCTION } from "../surface/cli/compact-model-summarizer.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn, type RunTurnResult } from "../loop/runner.js";
import type { ExecutionProgressPort } from "../ports/execution-progress.js";
import type { Envelope } from "../protocol/envelope.js";

type Accounting = { readonly mainUsage?: ProviderUsage; readonly auxiliaryUsage?: ProviderUsage;
  readonly auxiliaryRequests?: readonly { readonly usageStatus: string }[]; readonly costUsd?: number };

async function scenario(options: { readonly budget?: IterationBudget; readonly pricing?: UsagePricing;
  readonly reject?: true; readonly missing?: true; readonly partial?: true; readonly legacy?: true; readonly rejectionUsage?: true;
  readonly cancellation?: AbortController; readonly summaryFailure?: Error; readonly progress?: ExecutionProgressPort } = {}) {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = {
    async prepareRequest() { return { apply: request => request }; },
    async *stream(request) {
      requests.push(request);
      const summary = request.messages[0]?.content === SUMMARIZER_INSTRUCTION;
      if (options.reject && !summary) {
        if (options.rejectionUsage) yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 2, outputTokens: 4, totalTokens: 6 } };
        yield { type: "error", class: "invalid_request", retryable: false, phase: "before_headers",
          message: "This model's maximum context length is 10000 tokens; however, your prompt has 11000" };
        return;
      }

      yield { type: "text_delta", blockId: summary ? "summary" : "main", text: summary ? "Observed progress; continue the task." : "Verified." };

      if (!summary || !options.missing) yield { type: "usage", usage: { ...emptyUsage(), inputTokens: summary ? 40 : 80,
        outputTokens: summary ? 4 : 5, totalTokens: summary ? 44 : 85 } };

      if (summary && options.partial) {
        yield { type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "fixture" };
        return;
      }

      if (summary && options.summaryFailure) throw options.summaryFailure;

      if (summary) options.cancellation?.abort();

      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const result: RunTurnResult & Accounting = await runTurn({ provider, tools: createFakeTools([], []),
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    permission: createFakePermission("approved"), profile: emptyProfileLoader(),
    compaction: compactionWiring({ nowMs: 0, summarize: options.legacy ? () => "Earlier progress." : createModelSummarizer({ provider, model: "local" }) }) },
  { sessionId: "summary-accounting", turnId: "turn", correlationId: "test", text: "Continue this task.", model: "local",
    budget: { contextTokenLimit: options.reject ? 10000 : 5000, ...options.budget },
    ...(options.pricing === undefined ? {} : { pricing: options.pricing }), resumedTranscript: [
      { kind: "user", sequence: 0, text: "An older task." },
      { kind: "assistant_text", sequence: 1, blockId: "history", text: "Observed history. ".repeat(options.reject ? 300 : 1500) },
    ], ...(options.cancellation === undefined ? {} : { cancelSignal: options.cancellation.signal }) });

  return { result, requests, summaries: requests.filter(request => request.messages[0]?.content === SUMMARIZER_INSTRUCTION),
    mains: requests.filter(request => request.messages[0]?.content !== SUMMARIZER_INSTRUCTION) };
}

test("preflight summary and legal last main share total allowance without consuming a main iteration", async () => {
  const { result, summaries, mains } = await scenario({ budget: { maxIterations: 1, maxOutputTokens: 20 },
    pricing: { inputPerMTok: 1000000, outputPerMTok: 1000000 } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(result.iterations, 1);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.maxOutputTokens, 20);
  assert.equal(mains.length, 1);
  assert.equal(mains[0]?.maxOutputTokens, 16);
  assert.equal(result.usage.totalTokens, 129);
  assert.equal(result.mainUsage?.totalTokens, 85);
  assert.equal(result.auxiliaryUsage?.totalTokens, 44);
  assert.equal(result.auxiliaryRequests?.length, 1);
  assert.equal(result.costUsd, 129);
});

for (const budget of [{ maxOutputTokens: 4 }, { maxCostUsd: 44 }] as const) test(`summary spending ${JSON.stringify(budget)} prevents the following main`, async () => {
  const { result, mains, summaries } = await scenario({ budget, pricing: { inputPerMTok: 1000000, outputPerMTok: 1000000 } });
  assert.equal(summaries.length, 1);
  assert.equal(mains.length, 0);
  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.inputs.some(input => input.type === "budget_exhausted" && input.reason === ("maxOutputTokens" in budget ? "output_tokens_exhausted" : "budget_usd_exhausted")));
  assert.equal(result.usage.totalTokens, 44);
});

test("reactive recovery checks a consumed request allowance before authoring a paid summary", async () => {
  const { result, summaries, mains } = await scenario({ reject: true, budget: { maxIterations: 1 } });
  assert.equal(mains.length, 1);
  assert.equal(summaries.length, 0);
  assert.ok(result.inputs.some(input => input.type === "budget_exhausted" && input.reason === "iterations_exhausted"));
});

for (const budget of [{ maxOutputTokens: 4 }, { maxCostUsd: 6 }] as const) test(`reactive recovery checks consumed ${JSON.stringify(budget)} before authoring`, async () => {
  const { result, summaries, mains } = await scenario({ reject: true, rejectionUsage: true, budget,
    pricing: { inputPerMTok: 1000000, outputPerMTok: 1000000 } });
  assert.equal(mains.length, 1);
  assert.equal(summaries.length, 0);
  assert.ok(result.inputs.some(input => input.type === "budget_exhausted"));
});

test("unknown auxiliary usage cannot be treated as zero under an explicit spending allowance", async () => {
  const { result, summaries, mains } = await scenario({ missing: true, budget: { maxOutputTokens: 20 } });
  assert.equal(summaries.length, 1);
  assert.equal(mains.length, 0);
  assert.equal(result.auxiliaryRequests?.[0]?.usageStatus, "missing");
  assert.ok(result.inputs.some(input => input.type === "turn_failed" && input.reason === "auxiliary_usage_unavailable"));
});

test("a partially reported failed summary is charged and cannot authorize more explicitly budgeted spending", async () => {
  const { result, summaries, mains } = await scenario({ partial: true, budget: { maxOutputTokens: 20 } });
  assert.equal(summaries.length, 1);
  assert.equal(mains.length, 0);
  assert.equal(result.usage.totalTokens, 44);
  assert.equal(result.auxiliaryRequests?.[0]?.usageStatus, "partial");
  assert.ok(result.inputs.some(input => input.type === "turn_failed" && input.reason === "auxiliary_usage_unavailable"));
});

test("caller cancellation during a billed summary remains cancellation ahead of spending diagnostics", async () => {
  const { result, mains } = await scenario({ cancellation: new AbortController(), budget: { maxOutputTokens: 20 } });
  assert.equal(mains.length, 0);
  assert.equal(result.state.terminalReason, "cancelled");
  assert.equal(result.auxiliaryUsage?.totalTokens, 44);
});

test("the final main response cannot complete after total parent cost reaches its explicit ceiling", async () => {
  const { result, mains, summaries } = await scenario({ budget: { maxCostUsd: 129 },
    pricing: { inputPerMTok: 1000000, outputPerMTok: 1000000 } });
  assert.equal(mains.length, 1);
  assert.equal(summaries.length, 1);
  assert.equal(result.costUsd, 129);
  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.inputs.some(input => input.type === "budget_exhausted" && input.reason === "budget_usd_exhausted"));
});

test("a throwing summary adapter flushes its already-reported bill through the existing progress writer", async () => {
  const saved: Envelope[] = [], failure = new Error("fixture summary adapter failure");

  await assert.rejects(scenario({ summaryFailure: failure, progress: {
    async flush(progress) {
      saved.push(...progress.envelopes);
      return { ok: true };
    },
    async issue() { return { ok: true }; }, async settle() { return { ok: true }; },
  } }), error => error === failure);
  const receipts = saved.filter(envelope => envelope.payload["component"] === "auxiliary_usage");

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.payload["usageStatus"], "partial");
});

test("an omitted spending allowance stays omitted even when an auxiliary bill is unavailable", async () => {
  const { result, summaries, mains } = await scenario({ missing: true });
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(summaries[0]?.maxOutputTokens, undefined);
  assert.equal(mains[0]?.maxOutputTokens, undefined);
  assert.equal(result.auxiliaryRequests?.[0]?.usageStatus, "missing");
});

test("legacy extractive wiring with no sixth parameter remains compatible", async () => {
  const { result, summaries, mains } = await scenario({ legacy: true, budget: { maxIterations: 1 } });
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(summaries.length, 0);
  assert.equal(mains.length, 1);
  assert.equal(result.usage.totalTokens, 85);
  assert.equal(result.auxiliaryRequests, undefined);
});
