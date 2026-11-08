import { testScratchPath } from "../../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type ProviderEvent, type ProviderPort, type ProviderRequest } from "../../../../../../ports/provider.js";
import { createBoardReader, withBoardWriter } from "../../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent } from "../../../../../control/coordination-contract.js";
import type { ToolLearningPlan } from "../../domain/evolution/pipeline.js";
import { enqueueToolLearningPlan } from "../../runtime/pipeline-queue.js";
import { createToolLearningFunding } from "../../runtime/learning-funding.js";
import { withToolLearningFunding } from "./funded-provider.js";

const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "workspace:tool-tail",
  capability: "bounded usage finality fixture", trigger: { runId: "task", proposalKey: "tail", action: "replace_or_add",
    evidenceRefs: ["receipt:fixture"] }, createdAt: "1970-01-01T00:00:00.000Z" };
const request: ProviderRequest = { attemptId: "tool-planning:tail", model: "synthetic", messages: [{ role: "user", content: "Inspect." }], tools: [] };
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const usage = (inputTokens: number, outputTokens = 0): ProviderEvent => ({ type: "usage",
  usage: { ...emptyUsage(), inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } });

/** The actual domain funding port supplies its complete typed contract; no narrowed mock or invented usage ledger. */
async function fixture(t: TestContext) {
  const base = testScratchPath("tool-funded-provider-tail-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), base);
    await rm(root, { recursive: true, force: true });
  });
  const queued = await enqueueToolLearningPlan(root, plan);
  assert.ok(queued.ok);
  const started = await withBoardWriter(root, store => store.apply({ type: "start_job", commandId: "start", issuedAt: plan.createdAt, jobId: queued.jobId }));

  assert.ok(started.ok);
  const funding = createToolLearningFunding({ boardRoot: root, scope: plan.scope, now: () => 0 });

  assert.ok(await funding.allowance(plan));
  let reservation = 0;

  return {
    wrap: (provider: ProviderPort) => withToolLearningFunding(provider, { funding, newId: () => `tail-call:${++reservation}` }),
    async grant() {
      const loaded = await createBoardReader(root).load();
      assert.ok(loaded.ok);
      const grants = loaded.state.centralLearningGrants;
      assert.equal(grants?.length, 1);
      assert.ok(grants?.[0]);
      return grants[0];
    },
  };
}

async function consume(provider: ProviderPort, signal = new AbortController().signal, stopAtFinish = false, wire = request) {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(wire, signal)) {
    events.push(event);
    if (stopAtFinish && event.type === "finish") break;
  }
  return events;
}

test("tool planning preserves a 32768 output allocation inside the original grant", async t => {
  const fx = await fixture(t);
  let sent: ProviderRequest | undefined;
  const provider = fx.wrap({ async *stream(wire) {
    sent = wire;
    yield { type: "text_delta", blockId: "plan", text: "{}" };
    yield usage(100, 9000);
    yield finish;
  } });

  await consume(provider, undefined, false, { ...request, maxOutputTokens: 32768 });
  assert.equal(sent?.maxOutputTokens, 32768);
  const grant = await fx.grant();
  assert.equal(grant.reservations[0]?.usage?.kind, "reported");
  assert.equal(centralLearningSpent(grant).tokens, 9100);
  assert.equal(grant.status, "open");
});

for (const ending of ["eof", "typed_error", "throw", "cancel", "error_finish"] as const) {
  test(`tool partial ${ending} retains the entire real Board reservation`, async t => {
    const fx = await fixture(t), cancellation = new AbortController();
    const error: ProviderEvent = { type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "synthetic redacted error" };
    const provider = fx.wrap({ async *stream() {
      yield usage(10);
      if (ending === "typed_error") yield error;
      else if (ending === "throw") throw new Error("synthetic_transport_end");
      else if (ending === "cancel") {
        cancellation.abort();
        yield { type: "cancel_ack" };
      }
      else if (ending === "error_finish") yield { ...finish, reason: "error" };
    } });

    if (ending === "throw") await assert.rejects(consume(provider, cancellation.signal), /synthetic_transport_end/);
    else if (ending === "cancel") await assert.rejects(consume(provider, cancellation.signal), /cancelled/);
    else {
      const events = await consume(provider, cancellation.signal);
      if (ending === "typed_error") assert.deepEqual(events.at(-1), error, "typed provider failure remains visible to the domain worker");
    }

    const grant = await fx.grant(), charged = grant.reservations[0]!;

    assert.equal(charged.state, "settled");
    assert.equal(charged.usage?.kind, "unknown");
    assert.ok(charged.maxTokens > 10);
    assert.equal(centralLearningSpent(grant).tokens, charged.maxTokens);
  });
}

test("tool wrapper reads actual post-finish usage before a real consumer breaks on finish", async t => {
  const fx = await fixture(t);
  let readTail = false, closedInner = false;
  const provider = fx.wrap({ async *stream() {
    try {
      yield usage(10);
      yield finish;
      readTail = true;
      yield usage(10, 5);
    }
    finally { closedInner = true; }
  } });
  const events = await consume(provider, undefined, true);

  assert.equal(readTail, true);
  assert.equal(closedInner, true);
  assert.equal(events.filter(event => event.type === "finish").length, 1);
  const grant = await fx.grant();

  assert.deepEqual(grant.reservations[0]!.usage, { kind: "reported", inputTokens: 10, outputTokens: 5, totalTokens: 15, model: request.model });
  assert.equal(centralLearningSpent(grant).tokens, 15);
});

for (const warningPosition of ["before_finish", "after_finish"] as const) {
  test(`tool tail timeout ${warningPosition} cannot turn partial usage into a final bill`, async t => {
    const fx = await fixture(t), warning: ProviderEvent = { type: "warning", code: "stream_finish_tail_timeout", message: "synthetic tail timeout" };
    const events = await consume(fx.wrap({ async *stream() {
      yield usage(10);
      if (warningPosition === "before_finish") yield warning;
      yield finish;
      if (warningPosition === "after_finish") yield warning;
    } }), undefined, true);

    assert.ok(events.some(event => event.type === "warning" && event.code === warning.code));
    const grant = await fx.grant(), charged = grant.reservations[0]!;

    assert.equal(charged.usage?.kind, "unknown");
    assert.equal(centralLearningSpent(grant).tokens, charged.maxTokens);
  });
}

test("tool observed overrun retains its measured lower bound and closes the original grant", async t => {
  const fx = await fixture(t);
  await assert.rejects(consume(fx.wrap({ async *stream() {
    yield usage(50_000);
    yield finish;
  } }), undefined, false,
    { ...request, maxOutputTokens: 128 }), /token_overrun/);
  const grant = await fx.grant();
  assert.equal(grant.status, "closed");
  assert.equal(grant.closedReason, "model_token_overrun");
  assert.equal(grant.reservations[0]!.usage?.kind, "reported");
  assert.equal(centralLearningSpent(grant).tokens, 50_000);
});
