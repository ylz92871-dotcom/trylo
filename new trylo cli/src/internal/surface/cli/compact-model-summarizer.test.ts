import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createModelSummarizer,
  SUMMARIZER_INSTRUCTION,
} from "./compact-model-summarizer.js";
import { summarizeTranscript } from "../../compaction/summary.js";
import type {
  ProviderEvent,
  ProviderPort,
  ProviderRequest,
} from "../../ports/provider.js";
import type { TranscriptItem } from "../../protocol/transcript.js";

/**
 * 模型摘要器（`--compact-summary=model` 的写手）的单元合同。
 *
 * 三条线：
 *  1. 成功臂把模型的文本原样交给 `CompactionPort` 去校验和落盘；
 *  2. 一切失败臂（error 事件、空文本、过长、含路径/凭据形状）都**回落到
 *     extractive**——compaction 的价值在「窗口存下来了」，摘要降级不值得把
 *     整个窗口一起赔掉；回落不是静默换路，extractive 本来就是缺省写手；
 *  3. 发给 provider 的请求是可查事实：无工具、模型与运行一致、系统消息带
 *     判别标记（黑盒测试靠它把摘要请求从主请求里分出来）。
 */

const ITEMS: ReadonlyArray<TranscriptItem> = [
  { kind: "user", sequence: 0, text: "look at package.json" },
  { kind: "assistant_text", sequence: 1, blockId: "b1", text: "reading it now" },
];

type Captured = { request: ProviderRequest; signal: AbortSignal };

function scriptedProvider(events: ReadonlyArray<ProviderEvent>): {
  port: ProviderPort;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const port: ProviderPort = {
    async *stream(request, signal) {
      captured.push({ request, signal });
      for (const event of events) {
        yield event;
      }
    },
  };

  return { port, captured };
}

function textEvents(text: string): ReadonlyArray<ProviderEvent> {
  return [
    { type: "text_start", blockId: "t0" },
    { type: "text_delta", blockId: "t0", text },
    { type: "text_end", blockId: "t0" },
    { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
  ];
}

test("summary authoring receives the turn's cancellation rather than an unrelated signal", async () => {
  const provider = scriptedProvider(textEvents("safe summary"));
  const cancel = new AbortController();
  await createModelSummarizer({ provider: provider.port, model: "fixture" })(ITEMS, undefined, cancel.signal);
  assert.equal(provider.captured[0]?.signal, cancel.signal);
});

test("an already cancelled summary sends no provider request", async () => {
  const provider = scriptedProvider(textEvents("unused"));
  const cancel = new AbortController();
  cancel.abort();
  await createModelSummarizer({ provider: provider.port, model: "fixture" })(ITEMS, undefined, cancel.signal);
  assert.equal(provider.captured.length, 0);
});

test("a valid model summary is handed through untouched, on a tool-free request", async () => {
  const { port, captured } = scriptedProvider(textEvents("the model said: session about pkg metadata"));
  const summarize = createModelSummarizer({ provider: port, model: "compact-model" });
  const result = await summarize(ITEMS);

  assert.equal(result, "the model said: session about pkg metadata");
  assert.equal(captured.length, 1);
  const request = captured[0]!.request;

  assert.equal(request.model, "compact-model");
  assert.deepEqual(request.tools, []);
  assert.equal(request.messages[0]!.role, "system");
  assert.ok(request.messages[0]!.content.includes("trylo compaction summarizer"));
  assert.equal(request.messages[1]!.role, "user");
  // The model sees the raw items, the same fragments the extractive digest uses.
  assert.match(request.messages[1]!.content, /user: look at package\.json/);
  assert.match(request.messages[1]!.content, /assistant: reading it now/);
});

test("the instruction is exported so the black-box marker and the prompt cannot drift", () => {
  assert.ok(SUMMARIZER_INSTRUCTION.includes("trylo compaction summarizer"));
});

test("a provider error falls back to the extractive digest", async () => {
  const { port } = scriptedProvider([
    { type: "error", class: "network", retryable: false, phase: "before_headers", message: "boom" },
  ]);
  const summarize = createModelSummarizer({ provider: port, model: "m" });
  assert.equal(await summarize(ITEMS), summarizeTranscript(ITEMS));
});

test("partial model text followed by a provider error falls back without adopting partial output", async () => {
  const { port } = scriptedProvider([
    { type: "text_delta", blockId: "s", text: "Only a partial summary arrived." },
    { type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "fixture interruption" },
  ]);
  const summarize = createModelSummarizer({ provider: port, model: "fixture" });
  assert.equal(await summarize(ITEMS), summarizeTranscript(ITEMS));
});

test("partial model text without a finish is not a completed summary", async () => {
  const { port } = scriptedProvider([
    { type: "text_delta", blockId: "s", text: "The stream ended before its terminal event." },
  ]);
  assert.equal(await createModelSummarizer({ provider: port, model: "fixture" })(ITEMS), summarizeTranscript(ITEMS));
});

test("a length-limited model summary falls back even when its partial text validates", async () => {
  const { port } = scriptedProvider([
    { type: "text_delta", blockId: "s", text: "A short valid-looking fragment." },
    { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false },
  ]);
  assert.equal(await createModelSummarizer({ provider: port, model: "fixture" })(ITEMS), summarizeTranscript(ITEMS));
});

test("a cancellation acknowledgement after partial text cannot publish that text", async () => {
  const { port } = scriptedProvider([
    { type: "text_delta", blockId: "s", text: "An unfinished summary before cancellation." },
    { type: "cancel_ack" },
  ]);
  assert.equal(await createModelSummarizer({ provider: port, model: "fixture" })(ITEMS), summarizeTranscript(ITEMS));
});

test("cancellation between text and finish invalidates the authored summary", async () => {
  const cancel = new AbortController();
  const port: ProviderPort = { async *stream() {
    yield { type: "text_delta", blockId: "s", text: "A summary cancelled before commit." };
    cancel.abort();
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };

  assert.equal(await createModelSummarizer({ provider: port, model: "fixture" })(ITEMS, undefined, cancel.signal), summarizeTranscript(ITEMS));
});

test("tool or filtered finishes cannot complete a tool-free summary request", async () => {
  for (const reason of ["tool_calls", "content_filter", "error", "other"] as const) {
    const { port } = scriptedProvider([
      { type: "text_delta", blockId: "s", text: "Unfinished model authoring." },
      { type: "finish", reason, rawReason: reason, requiresFollowUp: false },
    ]);
    assert.equal(await createModelSummarizer({ provider: port, model: "fixture" })(ITEMS), summarizeTranscript(ITEMS), reason);
  }
});

test("empty model text falls back to the extractive digest", async () => {
  const { port } = scriptedProvider(textEvents("   "));
  const summarize = createModelSummarizer({ provider: port, model: "m" });
  assert.equal(await summarize(ITEMS), summarizeTranscript(ITEMS));
});

test("an over-long model summary falls back instead of losing the window", async () => {
  const { port } = scriptedProvider(textEvents("y".repeat(4_001)));
  const summarize = createModelSummarizer({ provider: port, model: "m" });
  assert.equal(await summarize(ITEMS), summarizeTranscript(ITEMS));
});

test("a model summary carrying an absolute path falls back", async () => {
  // The disclosure scanner is the same one the port would refuse on; refusing
  // here too keeps the fallback honest rather than spending a store attempt.
  const { port } = scriptedProvider(textEvents("edited /home/ana/app.ts and moved it"));
  const summarize = createModelSummarizer({ provider: port, model: "m" });
  assert.equal(await summarize(ITEMS), summarizeTranscript(ITEMS));
});

test("an unexpected provider exception is propagated with the original failure", async () => {
  const failure = new Error("fixture port violation");
  const port: ProviderPort = { async *stream() {
    yield { type: "text_delta", blockId: "s", text: "Not a successful summary." };
    throw failure;
  } };
  await assert.rejects(createModelSummarizer({ provider: port, model: "fixture" })(ITEMS), error => error === failure);
});

test("normal finish closes the stream without waiting for late usage or EOF", async () => {
  let closed = false;
  let consumedLateUsage = false;
  const port: ProviderPort = { async *stream() {
    try {
      yield { type: "text_delta", blockId: "s", text: "A complete safe summary." };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      consumedLateUsage = true;
    } finally { closed = true; }
  } };

  assert.equal(await createModelSummarizer({ provider: port, model: "fixture" })(ITEMS), "A complete safe summary.");
  assert.equal(closed, true);
  assert.equal(consumedLateUsage, false);
});

test("failed authoring retains the previous valid summary in its extractive fallback", async () => {
  const previousSummary = "Keep the verified result and do not edit unrelated files.";
  const { port, captured } = scriptedProvider([
    { type: "error", class: "network", retryable: false, phase: "before_headers", message: "fixture failure" },
  ]);
  const summary = await createModelSummarizer({ provider: port, model: "fixture" })(ITEMS, previousSummary);

  assert.equal(summary, summarizeTranscript(ITEMS, { previousSummary }));
  assert.ok(summary.includes(previousSummary));
  assert.ok(captured[0]!.request.messages[1]!.content.includes(previousSummary));
});
