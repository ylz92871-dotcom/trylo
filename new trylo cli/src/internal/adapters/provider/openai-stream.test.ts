import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { translateBody } from "./openai-stream.js";
import type { ProviderEvent } from "../../ports/provider.js";

test("DONE ends an open HTTP body, retains trailing usage, and closes the connection", { timeout: 5000 }, async t => {
  let closeResponse: () => void = () => {};
  const responseClosed = new Promise<void>(resolve => { closeResponse = resolve; });
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;

    response.on("close", closeResponse);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n');
    response.write('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n');
    response.write("data: [DONE]\n\n");
    // An SSE protocol terminator is sufficient: the server deliberately leaves HTTP open.
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();

  assert.ok(address !== null && typeof address !== "string");
  const provider = createOpenAiCompatibleProvider({
    endpoint: `http://127.0.0.1:${address.port}`, model: "local-contract", apiKey: "unit-credential",
  });
  const cancel = new AbortController();
  const timer = setTimeout(() => cancel.abort(), 2000);
  const events: ProviderEvent[] = [];

  try {
    for await (const event of provider.stream({ attemptId: "sse-end", model: "local-contract", messages: [], tools: [] }, cancel.signal)) events.push(event);
  } finally { clearTimeout(timer); }

  assert.equal(events.some(event => event.type === "error"), false, "DONE must finish before external cancellation");
  assert.equal(events.at(-1)?.type, "finish");
  assert.equal(events.find(event => event.type === "usage")?.type, "usage");
  const usage = events.find(event => event.type === "usage");

  assert.equal(usage?.type === "usage" ? usage.usage.totalTokens : undefined, 20);
  await responseClosed;
});

test("ordinary token fragments cannot consume the turn's event budget", async () => {
  const frames = Array.from({ length: 5000 }, () => 'data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}\n\n').join("");
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frames + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    controller.close();
  } });
  const events: ProviderEvent[] = [];

  for await (const event of translateBody(body, new AbortController().signal)) events.push(event);

  const deltas = events.filter(event => event.type === "text_delta");

  assert.equal(deltas.map(event => event.text).join(""), "a".repeat(5000));
  assert.ok(events.length < 4096, "provider fragment size must not exhaust a legitimate turn");
  assert.equal(events.at(-1)?.type, "finish");
});
