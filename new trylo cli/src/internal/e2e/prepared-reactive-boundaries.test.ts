import assert from "node:assert/strict";
import { test } from "node:test";
import type { IterationBudget } from "../domain/iteration.js";
import type { ProviderPort, ProviderRequest } from "../ports/provider.js";
import { compactionWiring } from "../surface/cli/compaction-wiring.js";
import { createFakePermission, createFakeTools, echoBinding, emptyProfileLoader } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";

const SUMMARY = "Earlier observations are complete.";
const REJECTION = { type: "error", class: "invalid_request", retryable: false, phase: "before_headers",
  message: "This model's maximum context length is 8000 tokens; however, your prompt has 9000" } as const;

async function scenario(options: { readonly budget?: IterationBudget; readonly cancellation?: AbortController; readonly failRebase?: true } = {}) {
  const requests: ProviderRequest[] = [];
  let preparations = 0;
  const provider: ProviderPort = {
    async prepareRequest(request) {
      preparations++;
      const host = { role: "system" as const, content: `Frozen available tools: ${request.tools.map(tool => tool.name).join(",")}` };
      return { apply: base => {
        if (options.failRebase && base.messages.some(message => message.content.includes(SUMMARY))) throw new Error("Presentation cannot be applied");
        return { ...base, messages: [...base.messages, host] };
      } };
    },
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) yield REJECTION;
      else yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    },
  };
  const result = await runTurn({ provider, tools: createFakeTools([], [echoBinding({ needsApproval: false })]),
    permission: createFakePermission("approved"), profile: emptyProfileLoader(),
    compaction: compactionWiring({ nowMs: 0, summarize: () => {
      options.cancellation?.abort();
      return SUMMARY;
    } }) },
  { sessionId: "reactive-boundaries", turnId: "turn", correlationId: "test", text: "Continue the current task.",
    budget: { contextTokenLimit: 10_000, ...options.budget },
    ...(options.cancellation === undefined ? {} : { cancelSignal: options.cancellation.signal }), resumedTranscript: [
      { kind: "user", sequence: 0, text: "An older task." },
      // Leave the first send below the automatic byte threshold. Cancellation
      // and application failure must happen during reactive authoring/rebase.
      { kind: "assistant_text", sequence: 1, blockId: "old", text: "Older completed observation. ".repeat(100) },
    ] });

  return { requests, result, preparations };
}

test("a reactive retry cannot exceed an explicit request allowance", async () => {
  const { requests, result, preparations } = await scenario({ budget: { maxIterations: 1 } });
  assert.equal(requests.length, 1);
  assert.equal(preparations, 1);
  assert.equal(result.state.terminalReason, "failed");
  assert.ok(result.inputs.some(input => input.type === "budget_exhausted" && input.reason === "iterations_exhausted"));
});

test("a reactive transition into the reserved final report prepares the new tool purpose", async () => {
  const { requests, result, preparations } = await scenario({ budget: { maxIterations: 2, finalRequest: "report_only" } });

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(requests.length, 2);
  assert.equal(preparations, 2, "a changed purpose must not reuse the work request's host advertisement");
  assert.deepEqual(requests[0]!.tools.map(tool => tool.name), ["echo"]);
  assert.deepEqual(requests[1]!.tools, []);
  assert.ok(requests[1]!.messages.some(message => message.content === "Frozen available tools: "));
  assert.ok(!requests[1]!.messages.some(message => message.content === "Frozen available tools: echo"));
  assert.match(requests[1]!.messages.at(-2)!.content, /Final request at this turn/);
});

test("cancellation during reactive summary authoring remains cancelled without a retry", async () => {
  const { requests, result, preparations } = await scenario({ cancellation: new AbortController() });
  assert.equal(requests.length, 1);
  assert.equal(preparations, 1);
  assert.equal(result.compactions.length, 0);
  assert.equal(result.state.terminalReason, "cancelled");
  assert.equal(result.envelopes.filter(envelope => envelope.kind === "terminal").length, 1);
});

test("a failed reactive snapshot application has one failure terminal without another preparation", async () => {
  const { requests, result, preparations } = await scenario({ failRebase: true });
  assert.equal(requests.length, 1);
  assert.equal(preparations, 1);
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(result.envelopes.filter(envelope => envelope.kind === "terminal").length, 1);
  assert.ok(result.inputs.some(input => input.type === "transport_fail" && input.message === "request_preparation_failed"));
});
