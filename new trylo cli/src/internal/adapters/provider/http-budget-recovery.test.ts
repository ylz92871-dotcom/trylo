import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { httpFailureMessage } from "./http-failure-message.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";
import { compactionWiring } from "../../surface/cli/compaction-wiring.js";

const endpoint = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", model = "glm-5.3-flash";
const diagnostics = { error: { code: "context_length_exceeded", message: "maximum context length exceeded PRIVATE-MARKER" } };

for (const repeated of [false, true]) test(`actual HTTP context rejection retries a shrinking wire; repeated=${repeated}`, async () => {
  const bodies: Array<{ messages: Array<{ content: string }> }> = [];
  const provider = createOpenAiCompatibleProvider({ endpoint, model, apiKey: "fixture-key", fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 || repeated ? new Response(JSON.stringify(diagnostics), { status: 400 })
      : new Response('data: {"choices":[{"delta":{"content":"Recovered."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } });
  const compact = compactionWiring({ nowMs: 0, summarize: () => "SUMMARY-MARKER" });
  const result = await runTurn({ provider, profile: emptyProfileLoader(), tools: createFakeTools([]),
    permission: createFakePermission("approved"), compaction: compact,
  }, { sessionId: "s", turnId: "t", correlationId: "c", text: "Current input.", model,
    budget: { maxIterations: 6, contextTokenLimit: 8000 }, resumedTranscript: [
      { kind: "user", sequence: 0, text: "An older completed task." },
      { kind: "assistant_text", sequence: 1, blockId: "old", text: "Older completed observations. ".repeat(100) },
    ] });

  assert.equal(bodies.length, 2);
  assert.ok(result.compactions.some(record => record.payload.summary.includes("SUMMARY-MARKER")),
    "the older-prefix summary is recorded");
  assert.equal(result.state.terminalReason, repeated ? "failed" : "completed");
  assert.ok(bodies[1]!.messages.some(item => item.content.includes("SUMMARY-MARKER")));
  assert.ok(Buffer.byteLength(JSON.stringify(bodies[1]!.messages)) < Buffer.byteLength(JSON.stringify(bodies[0]!.messages)),
    "the retried wire must shrink actual older history rather than delete the current request");

  for (const body of bodies) assert.ok(body.messages.some(item => item.content === "Current input."));

  assert.equal(JSON.stringify(result.envelopes).includes("PRIVATE-MARKER"), false);
});

test("HTTP diagnostics expose only fixed budget vocabulary, never provider prose", async () => {
  const signal = new AbortController().signal;
  for (const [body, status, category, expected] of [
    [JSON.stringify(diagnostics), 400, "invalid_request", "prompt is too long"],
    ['{"error":{"code":"context_length_exceeded"}}', 422, "invalid_request", "prompt is too long"],
    ['{"error":{"message":"image exceeds maximum PRIVATE-MARKER"}}', 400, "invalid_request", "media is too large"],
    ['{"error":{"message":"unknown PRIVATE-MARKER"}}', 400, "invalid_request", "http_400"],
    ["malformed PRIVATE-MARKER", 400, "invalid_request", "http_400"],
    [JSON.stringify(diagnostics), 401, "auth", "http_401"],
    [JSON.stringify({ ...diagnostics, padding: "x".repeat(8192) }), 400, "invalid_request", "http_400"],
  ] as const) assert.equal(await httpFailureMessage(new Response(body, { status }), category, signal), expected);
});

test("a stalled diagnostic body is cancelled by an injected deadline without masking the HTTP status", async () => {
  const deadline = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = httpFailureMessage(new Response(body, { status: 400 }), "invalid_request", new AbortController().signal,
    { timeoutSignal: deadline.signal });

  deadline.abort();
  assert.equal(await pending, "http_400");
  assert.equal(cancelled, true);
});

test("an unreadable diagnostic body preserves its classified failure", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("PRIVATE-MARKER")); } });
  assert.equal(await httpFailureMessage(new Response(body, { status: 400 }), "invalid_request", new AbortController().signal), "http_400");
});
