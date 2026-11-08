import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPACT_WINDOW_KEYS } from "../ports/compaction.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createCompactionLedger } from "../loop/compact-ledger.js";
import type { CompactionInput, CompactionWiring } from "../loop/compact-boundary.js";
import { runCompactionFor } from "../loop/compaction-gap.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";

const BODY = "SUMMARY_BODY_REMAINS_IN_THE_COMPACT_WINDOW";

function inputFor(summarize: CompactionWiring["summarize"]): CompactionInput {
  return { seedMessages: [], transcript: [
    { kind: "user", sequence: 0, text: "Continue the original task." },
    { kind: "assistant_text", sequence: 1, blockId: "history", text: "Completed recorded progress. ".repeat(300) },
  ], ledger: createCompactionLedger(), sessionId: "summary-author", contextTokenLimit: 1_000,
  tools: undefined, reported: undefined, wiring: compactionWiring({ nowMs: 0, summarize }) };
}

test("a model author reports metadata without adding fields to the durable compact window", async () => {
  const input = inputFor((_items, _previous, _signal, _transcript, report) => {
    report?.({ author: "model" });
    return BODY;
  });
  const result = await runCompactionFor(input);

  assert.equal(result.storedWindow, true);
  const observations = result.events.filter(event => event.kind === "observation" && event.payload["author"] !== undefined);

  assert.deepEqual(observations.map(event => event.payload), [{ component: "compaction", author: "model" }]);
  assert.ok(input.ledger.window);
  assert.equal(input.ledger.window.formatVersion, "1");
  assert.deepEqual(Object.keys(input.ledger.window).sort(), [...COMPACT_WINDOW_KEYS].sort());
  assert.equal(input.ledger.window.summary, BODY);
  assert.equal(JSON.stringify(observations).includes(BODY), false);
});

test("an extractive fallback exposes its typed reason as a degraded canonical observation", async () => {
  const input = inputFor((_items, _previous, _signal, _transcript, report) => {
    report?.({ author: "extractive", reason: "provider_error" });
    return BODY;
  });
  const result = await runCompactionFor(input);

  assert.equal(result.storedWindow, true);
  const observation = result.events.find(event => event.kind === "observation" && event.payload["author"] === "extractive");

  assert.deepEqual(observation?.payload, { component: "compaction", author: "extractive", reason: "provider_error", degraded: true });
  assert.equal(JSON.stringify(observation).includes(BODY), false);
});

test("author metadata remains observable when the resulting window is refused", async () => {
  const input = inputFor((_items, _previous, _signal, _transcript, report) => {
    report?.({ author: "extractive", reason: "output_truncated" });
    return "password=not-approved-for-storage";
  });
  const result = await runCompactionFor(input);

  assert.equal(result.storedWindow, false);
  assert.ok(result.events.some(event => event.payload["author"] === "extractive" && event.payload["reason"] === "output_truncated"));
  assert.ok(result.events.some(event => event.payload["reason"] === "summary_unsafe"));
  assert.equal(JSON.stringify(result.events).includes("not-approved-for-storage"), false);
  assert.equal(input.ledger.entries.length, 0);
});

test("cancelled author selection reports only metadata and never stores its draft", async () => {
  const controller = new AbortController();
  const input = inputFor((_items, _previous, _signal, _transcript, report) => {
    report?.({ author: "extractive", reason: "cancelled" });
    controller.abort();
    return BODY;
  });
  const result = await runCompactionFor(input, { signal: controller.signal });

  assert.equal(result.storedWindow, false);
  assert.ok(result.events.some(event => event.payload["author"] === "extractive" && event.payload["reason"] === "cancelled"));
  assert.equal(JSON.stringify(result.events).includes(BODY), false);
  assert.equal(input.ledger.entries.length, 0);
});

test("an existing author without the optional reporter retains its original event shape", async () => {
  const input = inputFor(() => BODY);
  const result = await runCompactionFor(input);
  assert.equal(result.storedWindow, true);
  assert.deepEqual(result.events.map(event => event.kind), ["compact"]);
  assert.equal(result.events.some(event => event.payload["author"] !== undefined), false);
});

test("the execution loop emits fallback metadata on the canonical observation stream", async () => {
  const input = inputFor((_items, _previous, _signal, _transcript, report) => {
    report?.({ author: "extractive", reason: "empty_output" });
    return BODY;
  });
  const result = await runTurn({
    profile: emptyProfileLoader(), permission: createFakePermission("approved"), tools: createFakeTools([], []),
    compaction: input.wiring!, provider: { async *stream() {
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } },
  }, { sessionId: "summary-author", turnId: "turn", correlationId: "test", text: "Continue the existing work.",
    resumedTranscript: input.transcript, budget: { contextTokenLimit: 1_000 } });

  assert.equal(result.state.terminalReason, "completed");
  const observation = result.envelopes.find(envelope => envelope.kind === "observation" && envelope.payload["author"] === "extractive");

  assert.deepEqual(observation?.payload, { component: "compaction", author: "extractive", reason: "empty_output", degraded: true });
  assert.equal(JSON.stringify(observation).includes(BODY), false);
  assert.ok(result.compactions.length > 0);
  assert.deepEqual(Object.keys(result.compactions[0]!.payload).sort(), [...COMPACT_WINDOW_KEYS].sort());
});
