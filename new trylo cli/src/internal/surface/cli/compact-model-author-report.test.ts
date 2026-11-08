import assert from "node:assert/strict";
import test from "node:test";
import { SUMMARY_MAX_CHARS } from "../../ports/compaction.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { TranscriptItem } from "../../protocol/transcript.js";
import { summarizeTranscript } from "../../compaction/summary.js";
import { createModelSummarizer, SUMMARIZER_INSTRUCTION } from "./compact-model-summarizer.js";

const items: readonly TranscriptItem[] = [{ kind: "user", sequence: 0, text: "保留原始目标并验证最终文件。" }];

type ReportingSummary = (items: readonly TranscriptItem[], previous?: string, signal?: AbortSignal,
  requestTranscript?: readonly TranscriptItem[], report?: (value: unknown) => void) => Promise<string>;

function scripted(events: readonly ProviderEvent[]) {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield* events;
  } };
  return { provider, requests };
}

const completed = (text: string): readonly ProviderEvent[] => [
  { type: "text_delta", blockId: "summary", text },
  { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
];

test("a valid Chinese model summary is not truncated by an undocumented generation allowance", async () => {
  const chinese = "已经核对用户目标、原始约束和交付验证。".repeat(100);

  assert.ok(chinese.length < SUMMARY_MAX_CHARS);
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    if (request.maxOutputTokens !== undefined) {
      yield { type: "text_delta", blockId: "summary", text: chinese.slice(0, 800) };
      yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false };
    } else yield* completed(chinese);
  } };
  const summarize: ReportingSummary = createModelSummarizer({ provider, model: "local-no-network", contextTokenLimit: 65_536 });
  const observations: unknown[] = [];

  assert.equal(await summarize(items, undefined, undefined, undefined, value => observations.push(value)), chinese);
  assert.equal(requests[0]?.maxOutputTokens, undefined);
  assert.deepEqual(observations, [{ author: "model" }]);
});

test("the model is told the canonical persisted character limit explicitly", () => {
  assert.ok(SUMMARIZER_INSTRUCTION.includes(String(SUMMARY_MAX_CHARS)));
  assert.match(SUMMARIZER_INSTRUCTION, /character/i);
});

const cases: readonly { readonly reason: string; readonly events: readonly ProviderEvent[]; readonly contextLimit?: number; readonly cancelled?: true }[] = [
  { reason: "input_context_exceeded", events: completed("unused"), contextLimit: 1 },
  { reason: "provider_error", events: [{ type: "error", class: "network", retryable: false, phase: "before_headers", message: "private transport detail" }] },
  { reason: "empty_output", events: completed("   ") },
  { reason: "output_truncated", events: [{ type: "text_delta", blockId: "summary", text: "A syntactically valid partial summary." },
    { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false }] },
  { reason: "invalid_finish", events: [{ type: "text_delta", blockId: "summary", text: "A nonfinal summary." },
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: false }] },
  { reason: "missing_finish", events: [{ type: "text_delta", blockId: "summary", text: "An unfinished stream." }] },
  { reason: "summary_too_long", events: completed("验".repeat(SUMMARY_MAX_CHARS + 1)) },
  { reason: "summary_unsafe", events: completed("Changed /home/private/app.ts using password=private-credential.") },
  { reason: "cancelled", events: completed("unused"), cancelled: true },
];

for (const entry of cases) {
  test(`extractive fallback reports its actual author and typed reason: ${entry.reason}`, async () => {
    const fake = scripted(entry.events);
    const summarize: ReportingSummary = createModelSummarizer({ provider: fake.provider, model: "local-no-network",
      ...(entry.contextLimit === undefined ? {} : { contextTokenLimit: entry.contextLimit }) });
    const cancellation = new AbortController();

    if (entry.cancelled) cancellation.abort();

    const observations: unknown[] = [];

    assert.equal(await summarize(items, undefined, cancellation.signal, undefined, value => observations.push(value)), summarizeTranscript(items));
    assert.deepEqual(observations, [{ author: "extractive", reason: entry.reason }]);
    assert.doesNotMatch(JSON.stringify(observations), /private|credential|\/home/);

    if (entry.cancelled || entry.contextLimit === 1) assert.equal(fake.requests.length, 0);
  });
}
