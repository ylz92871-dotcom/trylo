import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import { emptyUsage, type ProviderRequest } from "../../ports/provider.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";
import { executeCompaction } from "./compact-maintenance.js";
import { compactionWiring } from "./compaction-wiring.js";
import { createModelSummarizer } from "./compact-model-summarizer.js";
import type { TurnHostInput } from "./host.js";
import type { Wiring } from "./wiring.js";

for (const scenario of ["reported", "output_spent", "cost_spent", "missing"] as const) test(`manual compaction accounts for its real auxiliary call: ${scenario}`, async () => {
  const allowance = scenario === "output_spent" ? 0 : 7;
  const records: SessionRecord[] = [
    { formatVersion: "1", sequence: 0, type: "session_start", sessionId: "manual-accounting", at: "1970-01-01T00:00:00Z", payload: {} },
    { formatVersion: "1", sequence: 1, type: "transcript_item", sessionId: "manual-accounting", at: "1970-01-01T00:00:00Z",
      payload: { kind: "user", sequence: 0, text: "Continue the task." } },
    { formatVersion: "1", sequence: 2, type: "transcript_item", sessionId: "manual-accounting", at: "1970-01-01T00:00:00Z",
      payload: { kind: "assistant_text", sequence: 1, blockId: "old", text: "Observed history. ".repeat(1000) } },
  ];
  const session: SessionPort = { async start() { throw new Error("unused"); }, async attach() { throw new Error("unused"); },
    async read() { throw new Error("unused"); }, async repairTornTail() { throw new Error("unused"); }, async release() {},
    async readRecords() { return { ok: true, view: { records, tornTail: false } }; },

    async append(draft) {
      const sequence = records.length;
      records.push({ ...draft, sequence, formatVersion: "1" });
      return { ok: true, sequence };
    } };
  const requests: ProviderRequest[] = [], output: string[] = [];
  const provider = { async *stream(request: ProviderRequest) { requests.push(request);
    yield { type: "text_delta" as const, blockId: "summary", text: "Observed progress; continue the task." };
    if (scenario !== "missing") yield { type: "usage" as const, usage: { ...emptyUsage(), inputTokens: 12, outputTokens: 3, totalTokens: 15 } };
    yield { type: "finish" as const, reason: "stop" as const, rawReason: "stop", requiresFollowUp: false };
  } };
  const input: TurnHostInput = { text: "/compact", sessionId: "manual-accounting", turnId: "manual", correlationId: "test",
    workspaceRoot: ".", checkpointRoot: ".", workspaceId: "fixture", providerId: "fixture", model: "local", endpoint: "", apiKey: undefined,
    permission: createFakePermission("approved"), session, format: "stream-json", now: () => 0, maxTokens: allowance,
    inputPricePerMTok: 1000000, outputPricePerMTok: 1000000,
    ...(scenario === "cost_spent" ? { maxBudgetUsd: 15 } : {}),
    sink: { stdout: line => output.push(line), stderr: () => {} } };
  const wiring: Wiring = { close: async () => {}, providerId: "fixture", model: "local", toolCatalogHash: "fixture",
    ports: { provider, tools: createFakeTools([], []), permission: input.permission, profile: emptyProfileLoader(),
      compaction: compactionWiring({ nowMs: 0, summarize: createModelSummarizer({ provider, model: "local" }) }) } };
  const outcome = await executeCompaction(input, wiring);
  const final = JSON.parse(output.join("").trim().split("\n").at(-1) ?? "{}");

  assert.equal(outcome.result.iterations, 0);

  if (allowance === 0) {
    assert.equal(requests.length, 0);
    assert.equal(final.status, "failed");
    assert.equal(final.finishReason, "output_tokens_exhausted");
  }
  else if (scenario === "cost_spent" || scenario === "missing") {
    assert.equal(requests.length, 1);
    assert.equal(final.status, "failed");
    assert.equal(final.finishReason, scenario === "missing" ? "auxiliary_usage_unavailable" : "budget_usd_exhausted");
    assert.equal(final.auxiliaryRequests[0].usageStatus, scenario === "missing" ? "missing" : "reported");
  }
  else { assert.equal(requests.length, 1);
  assert.equal(requests[0]?.maxOutputTokens, 7);
    assert.equal(final.status, "completed");
  assert.equal(final.usage.totalTokens, 15);
    assert.equal(final.mainUsage.totalTokens, 0);
  assert.equal(final.auxiliaryUsage.totalTokens, 15);
    assert.equal(final.auxiliaryRequests.length, 1);
  assert.equal(final.costUsd, 15);
  }
});
