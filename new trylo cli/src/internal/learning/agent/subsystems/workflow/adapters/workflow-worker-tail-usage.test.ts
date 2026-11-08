import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderPort } from "../../../../../ports/provider.js";
import { createWorkflowModelPort } from "./workflow-worker.js";

test("a completed classification with a timed-out usage tail cannot refund its unobserved reservation", async () => {
  const task = { scope: "project:tail", taskFamily: { id: "report", intentClass: "compile-report", checkKind: "acceptance" } };
  const provider: ProviderPort = { async *stream() {
    yield { type: "text_delta", blockId: "answer", text: JSON.stringify(task) };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 20, outputTokens: 10, totalTokens: 30 } };
    // The canonical OpenAI translator emits this before its held finish.
    yield { type: "warning", code: "stream_finish_tail_timeout", message: "usage includes only received frames" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const worker = createWorkflowModelPort({ provider, model: "test", allowance: 20000 });
  const classified = await worker.classify({ text: "Build the report and verify its output.", scope: task.scope, families: [] },
    new AbortController().signal, 5000);

  assert.equal(classified.ok, true, "the content can be complete while usage is incomplete");
  assert.equal(worker.usage().calls, 1);
  assert.equal(worker.usage().observedTokens, 30);
  assert.equal(worker.usage().uncertain, true);
  assert.equal(worker.usage().tokens, 5000, "later learning must not spend the unobserved portion again");
});
