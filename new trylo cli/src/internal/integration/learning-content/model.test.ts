import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { buildContentPacket } from "../../learning/central/content/material.js";
import { prepareKnownApplication, runContentProcess } from "../../learning/central/content/process.js";
import { createContentGrantFunding } from "./model-funding.js";
import { createContentSemanticModel } from "./model.js";

const NOW = "2026-11-04T12:00:00.000Z", SCOPE = "project:content-model";
const APPLICATION = { schemaVersion: 1, knowledge: [], applications: [{ id: "a", requirementRefs: ["req:one"], answerRefs: ["answer:one"],
  binding: "Use the current upper-bound contract with maxFiles=1.", result: "The request permits returning at most one file.",
  conditions: "Same documented reading contract.", citations: [{ evidenceRef: "answer:one", quote: "maxFiles is an upper bound" }] }],
  relations: [{ id: "r", question: "Must exactly one file always be returned?", whenRelevant: "The current maxFiles=1 requirement.",
    expectedChange: "Distinguish an exact count from an upper bound.", citations: [{ evidenceRef: "req:one", quote: "Return at most one file." }] }],
  preparations: [] };
const REVIEW = { schemaVersion: 1, assessments: [{ relationId: "r", disposition: "answered", applicationIds: ["a"],
  reason: "The applied contract already permits zero or one file." }], comparisons: [], selectedRelationId: null,
  recommendation: { kind: "end", reason: "This bounded count question is answered by the documented contract.", citations: [] } };

function accounting() {
  let state = emptyBoardState(), enabled = true;
  const apply = async (command: BoardCommand) => {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  };
  const board = { load: async () => ({ ok: true as const, state, generation: 0 }), apply };

  return { board, state: () => state, disable: () => { enabled = false; },
    funding: createContentGrantFunding({ board, scope: SCOPE, domain: "prompt", grantId: "grant:content", claimId: "claim:content",
      now: () => NOW, enabled: () => enabled }), enabled: () => enabled };
}

async function fundedFixture() {
  const f = accounting();
  const act = async (action: Extract<BoardCommand, { type: "coordinate_learning" }>["action"]) => {
    const result = await f.board.apply({ type: "coordinate_learning", commandId: `fixture:${f.state().sequence}`, issuedAt: NOW, action });
    if (!result.ok) assert.fail(result.reason);
  };

  await act({ kind: "report", scope: SCOPE, problemKey: "content-count", issueId: "issue:content", report: { reportId: "report:content",
    source: { subsystem: "method", taskId: "task:one", versionId: "method:v1" }, facts: ["The exact-count interpretation needs review."],
    evidenceRefs: ["req:one", "answer:one"] } });
  await act({ kind: "decide", issueId: "issue:content", expectedRevision: 1, decision: "focused_learning", reason: "Apply the documented count contract.",
    sourceRefs: ["req:one"] });
  await act({ kind: "fund", issueId: "issue:content", expectedRevision: 2, grantId: "grant:content", domain: "prompt",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 80000 } });
  await act({ kind: "claim", jobId: f.state().centralLearningGrants![0]!.jobId, expectedAttempt: 0,
    claimId: "claim:content", ownerId: "owner:content", expiresAt: "2026-11-04T12:05:00.000Z" });
  const packet = buildContentPacket({ scope: SCOPE, domain: "prompt", boardSequence: f.state().sequence,
    focus: f.state().learningIssues![0]!, records: [{ ref: "req:one", runId: "run:one", sequence: 1, scope: SCOPE,
      origin: "user_statement", text: "Return at most one file." }, { ref: "answer:one", runId: "run:one", sequence: 2, scope: SCOPE,
      origin: "checker_result", text: "The reading contract states that maxFiles is an upper bound." }],
    requirements: [], answers: [], materials: [] });
  if (!packet.ok) assert.fail(packet.reason);

  return { ...f, packet: packet.value, jobId: f.state().centralLearningGrants![0]!.jobId };
}

function response(output: unknown, withUsage = true): Response {
  const content = typeof output === "string" ? output : JSON.stringify(output);
  const frames = [{ choices: [{ delta: { role: "assistant", content }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    ...(withUsage ? [{ choices: [], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } }] : [])];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } });
}

function modelFor(f: Awaited<ReturnType<typeof fundedFixture>>, fetchImpl: typeof globalThis.fetch) {
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://content-model.invalid/v1/chat/completions", model: "configured-model",
    apiKey: "test-only-local-transport", fetchImpl, maxAttemptsBeforeHeaders: 1 });
  return createContentSemanticModel({ provider, model: "configured-model", funding: f.funding, jobId: f.jobId,
    grantId: "grant:content", claimId: "claim:content", enabled: f.enabled, maxOutputTokens: 2048,
    contextMessages: [{ role: "user", content: "Original task context retained by the host." }] });
}

test("real Chat-compatible wire carries both strict content schemas and charges actual tail usage to the original grant", async () => {
  const f = await fundedFixture(), wires: Record<string, unknown>[] = [];
  const model = modelFor(f, async (_url, init) => {
    wires.push(JSON.parse(String(init?.body)));
    return response(wires.length === 1 ? APPLICATION : REVIEW);
  });
  const result = await runContentProcess({ packet: f.packet, model, maximumPromptChars: 80000, signal: new AbortController().signal });
  if (!result.ok) assert.fail(result.reason);

  assert.equal(result.value.remaining.length, 0);
  assert.equal(wires.length, 2);

  for (const wire of wires) {
    const format = wire.response_format as { type: string; json_schema: { strict: boolean; schema: { additionalProperties: boolean } } };
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.schema.additionalProperties, false);
    assert.match(JSON.stringify(wire.messages), /Original task context retained/);
  }

  assert.match(JSON.stringify(wires[1]), /The request permits returning at most one file/);
  const grant = f.state().centralLearningGrants![0]!;

  assert.equal(grant.grantId, "grant:content");
  assert.equal(grant.reservations.length, 2);
  assert.equal(grant.steps, 2);
  assert.ok(grant.reservations.every(row => row.state === "settled" && row.usage?.kind === "reported" && row.usage.totalTokens === 60));
  assert.deepEqual(model.receipts().map(row => [row.stage, row.settlement, row.boundary.kind]),
    [["apply_known", "confirmed", "complete"], ["residual_review", "confirmed", "complete"]]);
  const first = prepareKnownApplication(f.packet, 80000);
  assert.ok(first.ok);

  if (first.ok) await assert.rejects(model.generate(first.value, new AbortController().signal), /content_model_stage_unavailable/);

  assert.equal(wires.length, 2);
});

test("provider schema refusal is explicit and buys no retry or second stage", async () => {
  const f = await fundedFixture();
  let requests = 0;
  const model = modelFor(f, async () => {
    requests += 1;
    return new Response('{"error":{"message":"unsupported response schema"}}', { status: 400 });
  });
  const first = prepareKnownApplication(f.packet, 80000);
  if (!first.ok) assert.fail(first.reason);
  await assert.rejects(model.generate(first.value, new AbortController().signal), /content_model_provider_invalid_request/);
  assert.equal(requests, 1);
  assert.equal(model.receipts()[0]!.boundary.kind, "unknown");
  assert.equal(f.state().centralLearningGrants![0]!.reservations[0]!.usage?.kind, "unknown");
});

test("semantic rejection retains the actual bill while absent usage stays conservative", async () => {
  const f = await fundedFixture(), model = modelFor(f, async () => response({ schemaVersion: 1, fabricated: "not the schema" }));
  const first = prepareKnownApplication(f.packet, 80000);
  if (!first.ok) assert.fail(first.reason);

  await assert.rejects(model.generate(first.value, new AbortController().signal), /content_shape_invalid/);
  assert.equal(f.state().centralLearningGrants![0]!.reservations[0]!.usage?.kind, "reported");
  assert.equal(model.receipts()[0]!.response, "rejected");
  const pending = await fundedFixture(), noUsage = modelFor(pending, async () => response(APPLICATION, false));

  await noUsage.generate(first.value, new AbortController().signal);
  assert.equal(noUsage.receipts()[0]!.boundary.kind, "unknown");
  assert.equal(pending.state().centralLearningGrants![0]!.reservations[0]!.usage?.kind, "unknown");
});

test("collection disable after reservation still settles the original request without launching another", async () => {
  const f = await fundedFixture();
  let requests = 0;
  const model = modelFor(f, async () => {
    requests += 1;
    f.disable();
    return response(APPLICATION);
  });
  const first = prepareKnownApplication(f.packet, 80000);
  if (!first.ok) assert.fail(first.reason);
  await assert.rejects(model.generate(first.value, new AbortController().signal), /content_model_cancelled/);
  const reservation = f.state().centralLearningGrants![0]!.reservations[0]!;
  assert.equal(requests, 1);
  assert.equal(reservation.state, "settled");
  assert.equal(reservation.usage?.kind, "unknown");
});

test("cancellation during an actual adapter request releases the local wait and retains unknown remote usage", async () => {
  const f = await fundedFixture(), controller = new AbortController();
  let sent: (() => void) | undefined;
  const dispatched = new Promise<void>(resolve => { sent = resolve; });
  const model = modelFor(f, (_url, init) => new Promise<Response>((_resolve, reject) => {
    sent!();
    init?.signal?.addEventListener("abort", () => reject(new Error("transport_aborted")), { once: true });
  }));
  const first = prepareKnownApplication(f.packet, 80000);
  if (!first.ok) assert.fail(first.reason);

  const pending = model.generate(first.value, controller.signal);

  await dispatched;
  controller.abort();
  await assert.rejects(pending, /content_model_cancelled/);
  assert.equal(model.receipts()[0]!.boundary.kind, "unknown");
  assert.equal(f.state().centralLearningGrants![0]!.reservations[0]!.state, "settled");
});

test("observed usage above the reservation closes the same grant through the canonical reducer", async () => {
  const f = await fundedFixture();
  const model = modelFor(f, async () => {
    const frames = [{ choices: [{ delta: { content: JSON.stringify(APPLICATION) }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 90000, completion_tokens: 20000, total_tokens: 110000 } }];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const first = prepareKnownApplication(f.packet, 80000);
  if (!first.ok) assert.fail(first.reason);

  await assert.rejects(model.generate(first.value, new AbortController().signal), /content_model_token_overrun/);
  const grant = f.state().centralLearningGrants![0]!;

  assert.equal(grant.status, "closed");
  assert.equal(grant.closedReason, "model_token_overrun");
  assert.equal(model.receipts()[0]!.boundary.kind, "overrun");
});
