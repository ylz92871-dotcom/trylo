import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import { emptyUsage } from "../../../../../ports/provider.js";
import { createWorkflowModelPort } from "./workflow-worker.js";

const task = { scope: "project-test", taskFamily: { id: "report", intentClass: "compile-report", checkKind: "acceptance" } };
const context = { text: "Build the report and verify its output.", scope: task.scope, families: [] };
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const body = (value: unknown): ProviderEvent => ({ type: "text_delta", blockId: "b", text: JSON.stringify(value) });
const usage = (total: number): ProviderEvent => ({ type: "usage", usage: { ...emptyUsage(), inputTokens: 3, outputTokens: total - 3, totalTokens: total } });

function worker(events: readonly ProviderEvent[], throws = false) {
  const requests: ProviderRequest[] = [];
  const provider: ProviderPort = { async *stream(request) {
    requests.push(request);
    for (const event of events) yield event;
    if (throws) throw new Error("stream ended unexpectedly");
  } };

  return { requests, model: createWorkflowModelPort({ provider, model: "test", allowance: 20000 }) };
}

test("workflow research uses its explicit allowance beyond 4096 tokens and advertises supported JSON", async () => {
  let sent: ProviderRequest | undefined;
  const provider: ProviderPort = { responseFormats: ["json_object"], async *stream(request) {
    sent = request;
    yield body(task);
    yield usage(10000);
    yield finish;
  } };
  const model = createWorkflowModelPort({ provider, model: "test", allowance: 20000 });

  assert.equal((await model.classify(context, new AbortController().signal, 20000)).ok, true);
  assert.ok(sent!.maxOutputTokens! > 4096);
  assert.deepEqual(sent!.responseFormat, { type: "json_object" });
  assert.equal(model.usage().tokens, 10000);
  assert.equal(model.usage().uncertain, false);
});

test("a truncated workflow response drains known billing without inventing a proposal", async () => {
  const fx = worker([body({ partial: true }), { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false }, usage(7000)]);
  const result = await fx.model.classify(context, new AbortController().signal, 20000);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "learning_incomplete");
  assert.equal(fx.model.usage().tokens, 7000);
  assert.equal(fx.model.usage().observedTokens, 7000);
  assert.equal(fx.model.usage().uncertain, false);
});

test("a workflow worker drains final usage after finish and snapshots replace earlier partial usage", async () => {
  const fx = worker([body(task), usage(5), finish, usage(30)]);
  assert.equal((await fx.model.classify(context, new AbortController().signal, 5000)).ok, true);
  assert.equal(fx.model.usage().tokens, 30);
  assert.equal(fx.model.usage().observedTokens, 30);
  assert.equal(fx.model.usage().uncertain, false);
  assert.deepEqual(fx.requests[0]?.tools, []);
});

test("finish followed by a transport failure reserves the bounded call instead of charging only partial usage", async () => {
  const fx = worker([body(task), usage(7), finish], true);
  const result = await fx.model.classify(context, new AbortController().signal, 5000);
  assert.equal(result.ok, false);
  assert.equal(fx.model.usage().tokens, 5000);
  assert.equal(fx.model.usage().observedTokens, 7);
  assert.equal(fx.model.usage().uncertain, true);
});

test("an unfinished proposal or forbidden tool call consumes reservation and never returns a learned proposal", async () => {
  for (const events of [[body(task), usage(7)], [{ type: "tool_call", toolCallId: "c", name: "run_shell", arguments: { command: "write something" } }]] as const) {
    const fx = worker(events);
    assert.equal((await fx.model.classify(context, new AbortController().signal, 5000)).ok, false);
    assert.equal(fx.model.usage().tokens, 5000);
    assert.equal(fx.model.usage().uncertain, true);
  }
});

test("post-finish content is rejected rather than amending a completed proposal", async () => {
  const fx = worker([body(task), usage(7), finish, body({ changed: true })]);
  const result = await fx.model.classify(context, new AbortController().signal, 5000);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "learning_post_finish_event");
  assert.equal(fx.model.usage().tokens, 5000);
});

test("the actual claim allowance bounds requests even when the reusable worker has a larger allocation", async () => {
  const fx = worker([body(task), usage(30), finish]);
  const refused = await fx.model.classify(context, new AbortController().signal, 100);

  assert.equal(refused.ok, false);
  assert.equal(fx.requests.length, 0);
  assert.equal(fx.model.usage().calls, 0);
  const accepted = await fx.model.classify(context, new AbortController().signal, 5000);

  assert.equal(accepted.ok, true);
  const request = fx.requests[0]!;
  const reservedInput = Buffer.byteLength(request.messages.map(message => message.content).join(""), "utf8") + 512;

  assert.ok(reservedInput + request.maxOutputTokens! <= 5000);
});

test("cold-start classification receives completed execution facts without requiring an existing family", async () => {
  const fx = worker([body(task), usage(30), finish]);
  const observed = { sessionId: "s", turnId: "t", terminal: "completed" as const, tokens: 10, wallMs: 10, mutations: [],
    checks: [{ toolCallId: "real-check", command: "node check.cjs", status: "passed" as const, evidenceRef: "receipt", sequence: 2 }] };
  assert.equal((await fx.model.classify({ ...context, observed }, new AbortController().signal, 8000)).ok, true);
  assert.match(fx.requests[0]!.messages[1]!.content, /real-check/);
  assert.match(fx.requests[0]!.messages[1]!.content, /"families":\[\]/);
});

test("graceful iterator end after cancellation cannot turn partial usage into a completed proposal", async () => {
  const cancel = new AbortController();
  const provider: ProviderPort = { async *stream() {
    yield body(task);
    yield usage(7);
    yield finish;
    cancel.abort(); // Some adapters honor cancellation by ending, not throwing.
  } };
  const model = createWorkflowModelPort({ provider, model: "test", allowance: 20000 });
  const result = await model.classify(context, cancel.signal, 5000);

  assert.equal(result.ok, false);

  if (!result.ok) assert.equal(result.code, "cancelled");

  assert.equal(model.usage().tokens, 5000);
  assert.equal(model.usage().observedTokens, 7);
  assert.equal(model.usage().uncertain, true);
});
