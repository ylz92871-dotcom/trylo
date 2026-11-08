import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { providerWaitObservationHash, type ProviderWaitObservation } from "../../learning/central/runtime/provider-positive.js";
import { createParentProviderReturnObserver } from "./provider-return-observer.js";

const capture: ProviderWaitObservation = {
  schemaVersion: 1, scope: "scope", budgetId: "root", connectionRef: `central-learning-provider-connection:${"a".repeat(64)}`,
  sessionId: "session", turnId: "turn", model: "model", wait: { ref: "wait", factRef: "fact", boardSequence: 12 },
};
const request: ProviderRequest = { attemptId: "attempt-1", model: "model", messages: [], tools: [{ name: "read", description: "read", parameters: {} }] };
const text: ProviderEvent = { type: "text_delta", blockId: "text", text: "public answer" };
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false,
  returnObservation: { schemaVersion: 1, reportedTotalTokens: 5 } };
const error: ProviderEvent = { type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "unit failure" };

async function consume(provider: ProviderPort, input = request) {
  for await (const event of provider.stream(input, new AbortController().signal)) void event;
}

function observer() { return createParentProviderReturnObserver({ sessionId: "session", turnId: "turn", providerWaitObservation: capture }); }

test("parent observer binds actual request, leaves forks untouched and resets proof before a later failure", async () => {
  const seen: ProviderRequest[] = [];
  let events: ProviderEvent[] = [text, finish];
  const child: ProviderPort = { async *stream() { yield finish; } };
  const original: ProviderPort = { fork: () => child, async *stream(input) {
    seen.push(input);
    yield* events;
  } };
  const watch = observer();
  const wrapped = watch.wrap(original);

  assert.equal(wrapped.fork?.(), child);
  await consume(wrapped);
  assert.equal(seen[0]?.observeReturn, true);
  assert.deepEqual(watch.read(), { schemaVersion: 1, captureHash: providerWaitObservationHash(capture), attemptId: "attempt-1",
    model: "model", finishReason: "stop", reportedTotalTokens: 5 });
  events = [error];
  await consume(wrapped, { ...request, attemptId: "attempt-2" });
  assert.equal(watch.read(), undefined);
  events = [text, finish];
  await consume(wrapped, { ...request, model: "different-model" });
  assert.equal(seen.at(-1)?.observeReturn, undefined);
  assert.equal(watch.read(), undefined);
});

test("reasoning, empty output, invalid tool, protocol gaps and later errors cannot become positive notes", async () => {
  const reasoning: ProviderEvent = { type: "reasoning_delta", blockId: "r", text: "private", redacted: false };
  const invalid: ProviderEvent = { type: "tool_call_invalid", toolCallId: "t", name: "read", rawArguments: "{", message: "unit invalid" };

  for (const events of [[finish], [reasoning, finish], [text, invalid, finish], [text, finish, error],
    [text, { type: "raw_unknown", wire: "unit-gap", metadata: {} } as const, finish],
    [{ type: "tool_call", toolCallId: "t", name: "unknown-tool", arguments: {} } as const, finish]]) {
    const watch = observer();
    await consume(watch.wrap({ async *stream() { yield* events; } }));
    assert.equal(watch.read(), undefined);
  }

  const watch = observer();

  await consume(watch.wrap({ async *stream() {
    yield { type: "tool_call", toolCallId: "t", name: "read", arguments: {} };
    yield finish;
  } }));
  assert.equal(watch.read()?.reportedTotalTokens, 5, "a valid advertised tool is genuine accepted model output");
  const noCapture = createParentProviderReturnObserver({ sessionId: "other-session", turnId: "turn", providerWaitObservation: capture });
  const provider: ProviderPort = { async *stream() {
    yield text;
    yield finish;
  } };

  assert.equal(noCapture.wrap(provider), provider);
});
