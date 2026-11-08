import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderPort, type ProviderRequest } from "../../../../../../ports/provider.js";
import { createCheckerProviderGenerator } from "./provider-generator.js";

const INPUT = { requestId: "checker:request-1", prompt: "Generate the checker JSON under the supplied requirement.", maxOutputTokens: 256,
  signal: new AbortController().signal };

test("checker generator forks provider state, forbids tools and preserves actual usage with the domain instruction", async () => {
  const requests: ProviderRequest[] = [];
  let forks = 0;
  const child: ProviderPort = { async *stream(request) {
    requests.push(request);
    yield { type: "text_delta", blockId: "answer", text: '{"schemaVersion":2,"decision":"no_change","reason":"no new evidence"}' };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 25, outputTokens: 12 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const parent: ProviderPort = { fork: () => {
    forks += 1;
    return child;
  }, stream: () => { throw new Error("must fork"); } };
  const result = await createCheckerProviderGenerator({ provider: parent, model: "real-configured-model" }).generate(INPUT);

  assert.equal(result.status, "generated");
  assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 12 });
  assert.equal(forks, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.attemptId, "check-learning:checker:request-1");
  assert.deepEqual(requests[0]?.tools, []);
  assert.equal(requests[0]?.maxOutputTokens, 256);
  assert.ok(requests[0]?.messages[0]?.content.includes("check-learning"));
  assert.equal(requests[0]?.continuationScope, undefined);
});

test("provider attempt to call tools fails generation and retains charged usage", async () => {
  const provider: ProviderPort = { async *stream() {
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 2 } };
    yield { type: "tool_input_start", toolCallId: "call-1", name: "run_shell" };
  } };
  const result = await createCheckerProviderGenerator({ provider, model: "selected-model" }).generate(INPUT);

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.code, "tool_call_forbidden");

  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 2 });
});

test("cancelled or invalid generation grants do not request a provider", async () => {
  let calls = 0;
  const provider: ProviderPort = { async *stream() { calls += 1; } };
  const generator = createCheckerProviderGenerator({ provider, model: "selected-model" });

  assert.equal((await generator.generate({ ...INPUT, maxOutputTokens: 0 })).status, "failed");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await generator.generate({ ...INPUT, signal: controller.signal })).status, "cancelled");
  assert.equal(calls, 0);
});

test("partial model output without a normal terminal is not a generated checker", async () => {
  const provider: ProviderPort = { async *stream() { yield { type: "text_delta", blockId: "answer", text: '{"partial":' }; } };
  const result = await createCheckerProviderGenerator({ provider, model: "selected-model" }).generate(INPUT);
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.code, "incomplete_generation");
});
