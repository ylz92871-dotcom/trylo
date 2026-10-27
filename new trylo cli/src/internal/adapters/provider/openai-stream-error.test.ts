import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent } from "../../ports/provider.js";
import { translateBody } from "./openai-stream.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";

const sse = (frames: ReadonlyArray<unknown>): string => frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
const body = (frames: ReadonlyArray<unknown>): ReadableStream<Uint8Array> => new Response(sse(frames)).body!;
const collect = async (stream: AsyncIterable<ProviderEvent>) => {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

test("HTTP 200 gateway error frames retain server classification and cannot complete partial tool calls", async () => {
  const events = await collect(translateBody(body([
    { choices: [{ delta: { content: "partial answer" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "pending-write", type: "function",
      function: { name: "write_file", arguments: '{"path":"file.txt","content":"partial"}' } }] } }] },
    { error: { type: "gateway_error", code: "streaming_error", message: "PRIVATE_UPSTREAM_PAYLOAD",
      details: { statusCode: 502 } } },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]), new AbortController().signal));
  const errors = events.filter(event => event.type === "error");
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], { type: "error", class: "server", retryable: false,
    phase: "after_stream_started", message: "provider_stream_server_error" });
  assert.equal(events.some(event => event.type === "finish" || event.type === "tool_call"), false);
  assert.equal(events.some(event => event.type === "text_delta" && event.text === "partial answer"), true);
  assert.equal(JSON.stringify(events).includes("PRIVATE_UPSTREAM_PAYLOAD"), false);
});

test("stream error codes classify auth, rate limits and invalid requests without copying provider bodies", async () => {
  for (const [error, expected] of [[{ code: "invalid_api_key" }, "auth"], [{ type: "rate_limit_error" }, "rate_limit"],
    [{ type: "invalid_request_error" }, "invalid_request"], [{ code: "unrecognized" }, "unknown"]] as const) {
    const events = await collect(translateBody(body([{ error: { ...error, message: "PRIVATE_ERROR_BODY" } }]), new AbortController().signal));
    const failure = events.find(event => event.type === "error");
    assert.equal(failure?.type === "error" ? failure.class : undefined, expected);
    assert.equal(JSON.stringify(events).includes("PRIVATE_ERROR_BODY"), false);
  }
});

test("a gateway error after headers never replays the provider request", async () => {
  let requests = 0;
  const provider = createOpenAiCompatibleProvider({ endpoint: "http://local.invalid/v1/chat/completions", model: "test",
    apiKey: "unit-key", fetchImpl: async () => { requests += 1; return new Response(sse([
      { error: { type: "gateway_error", details: { statusCode: 502 } } },
    ]), { headers: { "content-type": "text/event-stream" } }); } });
  const events = await collect(provider.stream({ attemptId: "no-replay", model: "test", messages: [], tools: [] }, new AbortController().signal));
  assert.equal(requests, 1);
  assert.equal(events.find(event => event.type === "error")?.class, "server");
});
