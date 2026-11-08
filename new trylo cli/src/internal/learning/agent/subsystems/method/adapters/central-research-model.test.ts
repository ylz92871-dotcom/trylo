import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderPort, type ProviderRequest } from "../../../../../ports/provider.js";
import { runCentralMethodResearchModel } from "./central-research-model.js";

test("method research advertises JSON and retains a rejected paid response", async () => {
  const output = '{"kind":"candidate","statement":"missing the required scope"}';
  let sent: ProviderRequest | undefined;
  const provider: ProviderPort = { responseFormats: ["json_object"], async *stream(request) {
    sent = request;
    yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
    yield { type: "text_delta", blockId: "text", text: output };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 60, outputTokens: 40, totalTokens: 100 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const result = await runCentralMethodResearchModel({ provider, model: "test", reservationId: "call:test",
    material: "Original material", maxTokens: 1000, maxOutputTokens: 500, enabled: () => true }, new AbortController().signal);

  assert.deepEqual(sent?.responseFormat, { type: "json_object" });
  assert.ok(sent?.messages[0]!.content.includes("6000"));
  assert.equal(result.reason, "method_research_output_invalid");
  assert.equal(result.finding, undefined);
  assert.deepEqual(result.settlement, { kind: "reported", totalTokens: 100, inputTokens: 60, outputTokens: 40, model: "test" });
  assert.match(result.rejectedOutputHash!, /^[a-f0-9]{64}$/);
});
