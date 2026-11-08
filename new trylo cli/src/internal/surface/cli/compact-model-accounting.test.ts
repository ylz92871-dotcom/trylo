import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest, ProviderUsage } from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";
import type { TranscriptItem } from "../../protocol/transcript.js";
import type { SummaryAuthorReporter } from "../../ports/compaction.js";
import { createModelSummarizer } from "./compact-model-summarizer.js";

type Receipt = { readonly purpose: "compaction_summary"; readonly outcome: string; readonly usageStatus: string; readonly usage?: ProviderUsage };

type Context = { readonly maxOutputTokens?: number; readonly reportRequest: (receipt: Receipt) => void };

type Author = (items: readonly TranscriptItem[], previous?: string, signal?: AbortSignal,
  requestTranscript?: readonly TranscriptItem[], report?: SummaryAuthorReporter, context?: Context) => Promise<string>;

const ITEMS: readonly TranscriptItem[] = [{ kind: "user", sequence: 0, text: "Continue the observed task." }];
const STOP: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const TEXT: ProviderEvent = { type: "text_delta", blockId: "summary", text: "Observed progress; continue the current task." };
const usage = (inputTokens: number, outputTokens: number, mode: ProviderUsage["mode"] = "snapshot"): ProviderEvent =>
  ({ type: "usage", usage: { ...emptyUsage(mode), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } });

test("summary reports one request with snapshot/delta usage merged once and no implicit output cap", async () => {
  const requests: ProviderRequest[] = [], receipts: Receipt[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield TEXT;
    yield usage(7, 2);
    yield usage(7, 2);
    yield usage(0, 3, "delta");
    yield STOP;
  } };
  const author: Author = createModelSummarizer({ provider, model: "local" });

  await author(ITEMS, undefined, undefined, undefined, undefined, { reportRequest: receipt => receipts.push(receipt) });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.maxOutputTokens, undefined);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.usageStatus, "reported");
  assert.equal(receipts[0]?.usage?.inputTokens, 7);
  assert.equal(receipts[0]?.usage?.outputTokens, 5);
});

test("summary uses only the dynamic explicit remaining output allowance", async () => {
  const requests: ProviderRequest[] = [];
  const author: Author = createModelSummarizer({ model: "local", provider: { async *stream(request) {
    requests.push(request);
    yield TEXT;
    yield STOP;
  } } });
  await author(ITEMS, undefined, undefined, undefined, undefined, { maxOutputTokens: 23, reportRequest: () => {} });
  assert.equal(requests[0]?.maxOutputTokens, 23);
});

test("an exhausted explicit summary output allowance refuses a request with a typed fallback", async () => {
  let calls = 0;
  const reasons: string[] = [], receipts: Receipt[] = [];
  const author: Author = createModelSummarizer({ model: "local", provider: { async *stream() {
    calls++;
    yield STOP;
  } } });
  await author(ITEMS, undefined, undefined, undefined, report => reasons.push(report.reason ?? "model"),
    { maxOutputTokens: 0, reportRequest: receipt => receipts.push(receipt) });
  assert.equal(calls, 0);
  assert.equal(receipts.length, 0);
  assert.deepEqual(reasons, ["caller_budget_exhausted"]);
});

for (const ending of ["error", "cancel", "length", "eof", "throw"] as const) test(`summary preserves observed usage after ${ending}`, async () => {
  const receipts: Receipt[] = [];
  const failure = new Error("fixture adapter exception");
  const author: Author = createModelSummarizer({ model: "local", provider: { async *stream() {
    yield TEXT;
    yield usage(11, 4);
    if (ending === "error") yield { type: "error", class: "server", retryable: false, phase: "after_stream_started", message: "fixture" };
    if (ending === "cancel") yield { type: "cancel_ack" };
    if (ending === "length") yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: true };
    if (ending === "throw") throw failure;
  } } });
  const result = author(ITEMS, undefined, undefined, undefined, undefined, { reportRequest: receipt => receipts.push(receipt) });

  if (ending === "throw") await assert.rejects(result, error => error === failure); else await result;

  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.usage?.totalTokens, 15);
  assert.equal(receipts[0]?.usageStatus, ending === "length" ? "reported" : "partial");
});

test("missing provider usage remains an unknown receipt, including with no sixth parameter", async () => {
  const receipts: Receipt[] = [];
  const author: Author = createModelSummarizer({ model: "local", provider: { async *stream() {
    yield TEXT;
    yield STOP;
  } } });
  await author(ITEMS, undefined, undefined, undefined, undefined, { reportRequest: receipt => receipts.push(receipt) });
  assert.equal(receipts[0]?.usageStatus, "missing");
  assert.equal(receipts[0]?.usage, undefined);
  assert.equal(await author(ITEMS), TEXT.text);
});
