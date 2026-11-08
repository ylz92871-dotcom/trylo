import assert from "node:assert/strict";
import { test } from "node:test";
import { preserveRequestObservations } from "../../compaction/summary.js";
import { SUMMARY_MAX_CHARS, type SummaryAuthorReport } from "../../ports/compaction.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { TranscriptItem } from "../../protocol/transcript.js";
import { createModelSummarizer } from "./compact-model-summarizer.js";

const items: readonly TranscriptItem[] = [
  { kind: "user", sequence: 0, text: "Continue the release audit." },
  { kind: "assistant_text", sequence: 1, blockId: "prior", text: "The audit is ongoing." },
  { kind: "user", sequence: 2, text: "Inspect the current source and preserve its verified state." },
  { kind: "tool_call", sequence: 3, toolCallId: "read", name: "read_file", arguments: { path: "source.txt" } },
  { kind: "tool_result", sequence: 4, toolCallId: "read", name: "read_file", output: "Current release VERIFIED-END", outcome: "succeeded", truncated: false },
];
const budget = SUMMARY_MAX_CHARS - preserveRequestObservations("", items).length;

function provider(text: string): { port: ProviderPort; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return { requests, port: { async *stream(request) {
    requests.push(request);
    yield { type: "text_delta", blockId: "summary", text };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } } };
}

test("model text that exceeds its composed storage allowance falls back instead of being silently clipped", async () => {
  assert.ok(budget > 0 && budget < SUMMARY_MAX_CHARS);
  const text = "x".repeat(budget) + " VERIFIED-END", stub = provider(text), reports: SummaryAuthorReport[] = [];
  await createModelSummarizer({ provider: stub.port, model: "fixture" })(items, undefined, undefined, items, report => reports.push(report));
  assert.deepEqual(reports, [{ author: "extractive", reason: "summary_too_long" }]);
  assert.equal(stub.requests.length, 1, "composition does not add another paid authoring attempt");
  assert.equal(stub.requests[0]?.maxOutputTokens, undefined, "a character contract is not a generation token cap");
});

test("the author sees the available character allowance and its complete valid passage survives composition", async () => {
  const text = "x".repeat(budget - " VERIFIED-END".length) + " VERIFIED-END", stub = provider(text);
  const reports: SummaryAuthorReport[] = [];
  const result = await createModelSummarizer({ provider: stub.port, model: "fixture" })(items, undefined, undefined, items, report => reports.push(report));

  assert.deepEqual(reports, [{ author: "model" }]);
  assert.equal(result.length, SUMMARY_MAX_CHARS);
  assert.ok(result.includes(text), "neither the passage tail nor an exact literal can be lost during host composition");
  assert.ok(stub.requests[0]?.messages.some(message => message.content.includes(`${budget} characters`)));
  assert.equal(stub.requests[0]?.maxOutputTokens, undefined);
});

test("a request without pinned observations retains the full existing author allowance", async () => {
  const text = "x".repeat(SUMMARY_MAX_CHARS - " END".length) + " END", stub = provider(text);
  const result = await createModelSummarizer({ provider: stub.port, model: "fixture" })(items.slice(0, 1));
  assert.equal(result, text);
  assert.equal(stub.requests.length, 1);
});
