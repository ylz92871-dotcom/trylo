import assert from "node:assert/strict";
import { test } from "node:test";
import { runTurn } from "../loop/runner.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../loop/fakes.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { estimateToolSpecsTokens } from "../compaction/token-estimate.js";
import type { ProviderEvent, ProviderRequest } from "../ports/provider.js";
import * as promptMeasurement from "../loop/prompt-measurement.js";

for (const explicit of [false, true]) test(`one final native measurement serves admission, association and observation; explicit output=${explicit}`, async () => {
  let nativeMeasurements = 0;
  const sent: ProviderRequest[] = [];
  const result = await runTurn({
    profile: emptyProfileLoader(), tools: createFakeTools([], []), permission: createFakePermission("approved"),
    compaction: compactionWiring({ nowMs: 0, estimatePromptTokens: () => 100, estimateTextPromptTokens: () => 100,
      estimateOverheadTokens: () => 0 }),
    provider: {
      continuation: { capture: () => undefined, restore: () => {}, measureRequestIdentity(request) {
        nativeMeasurements++;
        return { requestDigest: "a".repeat(64), messageFieldDigests: request.messages.map(() => "b".repeat(64)),
          messageOverheadTokens: request.messages.map(() => 0) };
      } },
      async *stream(request): AsyncIterable<ProviderEvent> {
        sent.push(request);
        yield { type: "text_start", blockId: "final" };
        yield { type: "text_delta", blockId: "final", text: "Completed." };
        yield { type: "text_end", blockId: "final" };
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      },
    },
  }, { sessionId: "budget-decision", turnId: "single", correlationId: "c", model: "fixture", text: "Complete the task.",
    budget: { contextTokenLimit: 1000, ...(explicit ? { maxOutputTokens: 2000 } : {}) } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.tools.length, 0);
  assert.equal(nativeMeasurements, 1, "logging/capture must reuse the actual fitted request measurement");
  const localWithSchema = 100 + estimateToolSpecsTokens([]);

  assert.equal(sent[0]?.maxOutputTokens, explicit ? 1000 - localWithSchema : undefined);
  const observations = result.envelopes.filter(envelope => envelope.kind === "observation" && envelope.payload.component === "prompt_budget");

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.payload.tokens, localWithSchema);
  assert.match(String(observations[0]?.payload.requestDigest), /^[a-f0-9]{64}$/);
  const actual = sent[0]!;
  const expected = promptMeasurement.evaluatePreparedRequestBudget(actual, localWithSchema, undefined, undefined, () => 100, {
    requestDigest: "a".repeat(64), messageFieldDigests: actual.messages.map(() => "b".repeat(64)),
    messageOverheadTokens: actual.messages.map(() => 0),
  }, () => 100);

  assert.equal(observations[0]?.payload.requestDigest, expected.decision.requestDigest,
    "association describes the request after explicit output clamping");
});

for (const phase of ["automatic", "reactive"] as const) test(`${phase} rebuilding associates only the final sent request`, async () => {
  const sent: ProviderRequest[] = [];
  let preparations = 0;
  const result = await runTurn({
    profile: emptyProfileLoader(), tools: createFakeTools([], []), permission: createFakePermission("approved"),
    compaction: compactionWiring({ nowMs: 0, summarize: () => "Earlier work is complete; preserve the current input." }),
    provider: {
      async prepareRequest() {
        preparations++;
        const context = { role: "system" as const, content: `Frozen prepared host ${preparations}` };
        return { apply: (request: ProviderRequest) => ({ ...request, messages: [...request.messages, context] }) };
      },
      async *stream(request): AsyncIterable<ProviderEvent> {
        sent.push(request);
        if (phase === "reactive" && sent.length === 1) {
          yield { type: "error", class: "invalid_request", retryable: false, phase: "before_headers",
            message: "This model's maximum context length is 8000 tokens; however, your prompt has 9000" };
        } else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      },
    },
  }, { sessionId: "budget-rebuilding", turnId: phase, correlationId: "c", model: "fixture", text: "Preserve this current input.",
    budget: { contextTokenLimit: phase === "automatic" ? 1000 : 10_000 }, resumedTranscript: [
      { kind: "user", sequence: 0, text: "An earlier task." },
      { kind: "assistant_text", sequence: 1, blockId: "earlier", text: "An older completed observation. ".repeat(300) },
    ] });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(preparations, 1, "rebuilding must reuse its prepared snapshot");
  assert.equal(sent.length, phase === "automatic" ? 1 : 2);
  const observations = result.envelopes.filter(envelope => envelope.kind === "observation" && envelope.payload.component === "prompt_budget");

  assert.equal(observations.length, sent.length, "each actual send has exactly one final budget observation");

  for (const [index, request] of sent.entries()) {
    const payload = observations[index]!.payload;
    const expected = promptMeasurement.evaluatePreparedRequestBudget(request, Number(payload.localEstimate), undefined,
      undefined, () => 0);
    assert.equal(payload.requestDigest, expected.decision.requestDigest, "the associated view must be the one actually sent");
    assert.ok(request.messages.some(message => message.role === "user" && message.content === "Preserve this current input."));
  }

  if (phase === "reactive") assert.notEqual(observations[0]?.payload.requestDigest, observations[1]?.payload.requestDigest,
    "the recovery must replace the old bundle decision");
});
