import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../../../../../ports/provider.js";
import type { WorkflowImprovementModelPort } from "../improvement/contracts.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import { createWorkflowImprovementModel } from "./improvement-model.js";

function context(): Parameters<WorkflowImprovementModelPort["propose"]>[0] {
  const fixture = searchImprovementFixture();
  return { opportunity: fixture.opportunity, evidence: fixture.evidence, feedback: [] };
}

const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };

function usage(totalTokens: number): ProviderEvent {
  return { type: "usage", usage: { ...emptyUsage(), inputTokens: 20, outputTokens: totalTokens - 20, totalTokens } };
}

function sequenceModel(events: readonly ProviderEvent[], options: { readonly maxPromptChars?: number } = {}) {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    for (const event of events) yield event;
  } };
  return { requests, model: createWorkflowImprovementModel({ provider, model: "test", ...options }) };
}

function requestReservation(request: ProviderRequest): number {
  return Buffer.byteLength(request.messages.map(item => item.content).join(""), "utf8") + 512 + (request.maxOutputTokens ?? 0);
}

test("cancellation returns even when provider.next ignores abort, and late rejection cannot change settled usage", { timeout: 1000 }, async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let rejectRead!: (error: Error) => void;
  const blockedRead = new Promise<IteratorResult<ProviderEvent>>((_resolve, reject) => { rejectRead = reject; });
  const requests: ProviderRequest[] = [];
  const iterator: AsyncIterableIterator<ProviderEvent> = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      entered();
      return blockedRead;
    },
  };
  const provider: ProviderPort = { stream(request) {
    requests.push(request);
    return iterator;
  } };
  const model = createWorkflowImprovementModel({ provider, model: "test", timeoutMs: 200 });
  const cancel = new AbortController();
  const pending = model.propose(context(), cancel.signal, 32000);

  await started;
  cancel.abort();
  const result = await pending;

  assert.equal(result.ok, false);

  if (!result.ok) assert.equal(result.code, "cancelled");

  assert.equal(requests.length, 1);
  assert.equal(model.usage().uncertain, true);
  assert.equal(model.usage().observedTokens, 0);
  assert.equal(model.usage().tokens, requestReservation(requests[0]!));
  const settled = model.usage();

  rejectRead(new Error("late provider rejection after the worker returned"));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(model.usage(), settled);
});

test("a timed-out usage tail preserves the full bounded call reservation despite complete proposal content", async () => {
  const proposal = searchImprovementFixture().proposal;
  const fx = sequenceModel([
    { type: "text_delta", blockId: "proposal", text: JSON.stringify(proposal) }, usage(30),
    { type: "warning", code: "stream_finish_tail_timeout", message: "usage includes only received frames" }, finish,
  ]);
  const result = await fx.model.propose(context(), new AbortController().signal, 32000);

  assert.equal(result.ok, true);
  assert.equal(fx.requests.length, 1);
  assert.deepEqual(fx.requests[0]?.tools, []);
  assert.equal(fx.model.usage().observedTokens, 30);
  assert.equal(fx.model.usage().uncertain, true);
  assert.equal(fx.model.usage().tokens, requestReservation(fx.requests[0]!));
  assert.ok(fx.model.usage().tokens > 30, "partial consumption cannot refund the unobserved part of the request");
});

test("complete final usage remains measured rather than being replaced by an unknown reservation", async () => {
  const fx = sequenceModel([
    { type: "text_delta", blockId: "proposal", text: JSON.stringify(searchImprovementFixture().proposal) }, usage(25), finish, usage(40),
  ]);

  assert.equal((await fx.model.propose(context(), new AbortController().signal, 32000)).ok, true);
  assert.equal(fx.model.usage().tokens, 40);
  assert.equal(fx.model.usage().observedTokens, 40);
  assert.equal(fx.model.usage().uncertain, false);
});

test("insufficient prompt or output space returns a typed failure before any provider call", async () => {
  for (const [allowance, maxPromptChars] of [[1024, 24000], [32000, 256]] as const) {
    const fx = sequenceModel([], { maxPromptChars });
    const result = await fx.model.propose(context(), new AbortController().signal, allowance);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "learning_budget_exhausted");
    assert.equal(fx.requests.length, 0);
    assert.deepEqual(fx.model.usage(), { calls: 0, tokens: 0, observedTokens: 0, uncertain: false });
  }
});
