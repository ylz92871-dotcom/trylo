import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeTranscript, transcriptLines } from "../../compaction/summary.js";
import { estimateMessagesTokens } from "../../compaction/token-estimate.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { TranscriptItem } from "../../protocol/transcript.js";
import { createModelSummarizer, SUMMARIZER_INSTRUCTION } from "./compact-model-summarizer.js";

const SUMMARY = "The complete model summary.";
const GOAL: TranscriptItem = { kind: "user", sequence: 0, text: "Preserve the original goal and verify the actual artifacts." };

function provider(): { port: ProviderPort; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return { requests, port: { async *stream(request) {
    requests.push(request);
    yield { type: "text_delta", blockId: "summary", text: SUMMARY };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } } };
}

function promptTokens(items: readonly TranscriptItem[]): number {
  return estimateMessagesTokens([
    { role: "system", content: SUMMARIZER_INSTRUCTION },
    { role: "user", content: transcriptLines(items).join("\n") },
  ]);
}

test("oversized summary material never bypasses the configured context ceiling", async () => {
  const fake = provider();
  const items: readonly TranscriptItem[] = [GOAL,
    { kind: "assistant_reasoning", sequence: 1, blockId: "large", text: "x".repeat(300_000), redacted: false },
  ];
  const options = { provider: fake.port, model: "fixture", contextTokenLimit: 65_536 };
  const previousSummary = "Retain the verified checkpoint and the standing constraints.";
  const summary = await createModelSummarizer(options)(items, previousSummary);
  assert.equal(fake.requests.length, 0, "an over-limit auxiliary request must not be sent");
  assert.equal(summary, summarizeTranscript(items, { previousSummary }));
  assert.ok(summary.includes(previousSummary));
});

test("the output reservation is part of the summary request's context budget", async () => {
  const fake = provider();
  const items = [GOAL];
  const options = { provider: fake.port, model: "fixture", contextTokenLimit: promptTokens(items) + 1023 };
  assert.equal(await createModelSummarizer(options)(items), summarizeTranscript(items));
  assert.equal(fake.requests.length, 0);
});

test("a summary whose prompt and reserved output fit exactly is authored normally", async () => {
  const fake = provider();
  const items = [GOAL];
  const options = { provider: fake.port, model: "fixture", contextTokenLimit: promptTokens(items) + 1024 };
  assert.equal(await createModelSummarizer(options)(items), SUMMARY);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]?.maxOutputTokens, 1024);
});

test("UTF-8 bytes and previous summary text both count toward the auxiliary ceiling", async () => {
  const fake = provider();
  const items: readonly TranscriptItem[] = [GOAL,
    { kind: "assistant_text", sequence: 1, blockId: "unicode", text: "验证🙂".repeat(1000) },
  ];
  const options = { provider: fake.port, model: "fixture", contextTokenLimit: promptTokens(items) + 1024 };
  const previousSummary = "Preserve the earlier user constraint. ".repeat(50);
  assert.equal(await createModelSummarizer(options)(items, previousSummary), summarizeTranscript(items, { previousSummary }));
  assert.equal(fake.requests.length, 0);
});

test("an unconfigured ceiling preserves existing model summary authoring", async () => {
  const fake = provider();
  assert.equal(await createModelSummarizer({ provider: fake.port, model: "fixture" })([GOAL]), SUMMARY);
  assert.equal(fake.requests.length, 1);
});
