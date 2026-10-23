import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "./runner.js";
import { createFakePermission, echoBinding, emptyProfileLoader, toolResult } from "./fakes.js";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import { toolPairingOf } from "../protocol/tool-pairing.js";

for (const ending of ["network", "eof", "length"] as const) test(`${ending}: resumed history distinguishes committed work from calls discarded at the stream boundary`, async () => {
  let requests = 0, executions = 0;
  const provider: ProviderPort = { async *stream() {
    requests++;
    yield { type: "stream_start", providerId: "fixture", model: "fixture", warnings: [] };
    yield { type: "tool_call", toolCallId: requests === 1 ? "done" : "not-run", name: "echo", arguments: { value: requests } };
    if (requests === 1) { yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true }; return; }
    if (ending === "network") yield { type: "error", class: "network", phase: "after_stream_started", retryable: false, message: "cut" };
    if (ending === "length") yield { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false };
  } };
  const ports = { provider, profile: emptyProfileLoader(), permission: createFakePermission("approved"), tools: {
    snapshot: () => [echoBinding()], cancel: async () => {}, execute: async () => { executions++; return toolResult({ completed: true }); },
  } };
  const result = await runTurn(ports, { sessionId: "saved", turnId: "t", correlationId: "c", model: "fixture", text: "work", budget: { maxIterations: 4 } });
  assert.equal(executions, 1);
  assert.equal(requests, 2, "an interrupted stream must not be retried implicitly");
  assert.deepEqual(toolPairingOf(result.transcript).orphans, []);
  const discarded = result.transcript.find(item => item.kind === "tool_result" && item.toolCallId === "not-run");
  assert.ok(discarded?.kind === "tool_result");
  assert.equal(discarded.outcome, "failed");
  assert.match(discarded.output, /not executed/i);
  assert.doesNotMatch(discarded.output, /by the user|partial effects/i);
  assert.ok(result.transcript.some(item => item.kind === "tool_result" && item.toolCallId === "done" && item.outcome === "succeeded"));
  let resumedRequest: ProviderRequest | undefined;
  await runTurn({ ...ports, provider: { async *stream(request) { resumedRequest = request; yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } } },
    { sessionId: "saved", turnId: "next", correlationId: "n", text: "continue", resumedTranscript: result.transcript });
  assert.equal(executions, 1);
  assert.ok(resumedRequest?.messages.some(message => message.role === "tool" && message.toolCallId === "not-run" && /not executed/i.test(message.content)));
});
