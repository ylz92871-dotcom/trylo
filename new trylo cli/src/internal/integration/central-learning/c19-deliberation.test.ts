import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralLearningOperation } from "../../learning/central/runtime/contracts.js";
import { emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { canonicalJson } from "../../learning/control/hash.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import type { CentralLearningChange } from "./change-contract.js";
import { learningChangeBody, learningChangeEvents, readLearningChangeWire } from "./change-test-support.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { blocksAutomaticSemanticRecovery, semanticRecoveryBlock, semanticResourceCondition } from "./runtime-recovery.js";

const SCOPE = "project:c19-deliberation", BUDGET = "budget:c19-deliberation", NOW = "2026-11-06T00:00:00.000Z";
const SOURCE = "source:c19-original", TEXT = "Compare the original handoff conditions before changing the research program.";
const CHOSEN = 12288, CONFIGURED_GENERATION = "generation:c19-low-default-8192";

type Think = Extract<CentralLearningOperation, { readonly kind: "think" }>;

type Script = (request: ProviderRequest, call: number) => readonly ProviderEvent[];

function publicChange(wire: ProviderRequest, chooseFuture: boolean): CentralLearningChange {
  const view = readLearningChangeWire(wire), body = learningChangeBody(view, TEXT);

  if (!chooseFuture) {
    const intent = view.agenda[0];
    assert.ok(intent);
    return { checkpoint: view.checkpoint, changes: [{ kind: "revise", target: intent.intentId, why: "The bounded comparison has returned; actual use remains unknown.",
      set: { next: { kind: "wait", for: "use_feedback", sources: [body.handle], reason: "Wait for original use feedback." } } }],
    explanation: "Keep the unresolved use question without claiming quality.", sources: [body.handle] };
  }

  const opportunity = view.opportunities[0];
  assert.ok(opportunity);

  return { checkpoint: view.checkpoint, changes: [{ kind: "create", key: "bounded-comparison", subject: opportunity.handle,
    goal: "Resolve the original handoff uncertainty", why: "A larger bounded comparison may resolve the remaining condition.",
    sources: [body.handle], next: { kind: "think", maxOutputTokens: CHOSEN,
      purpose: "Compare the original handoff conditions", expectedChange: "Identify the remaining condition without claiming successful use.",
      sources: [body.handle] } }], explanation: "Choose one future generation bound, not new root credit.", sources: [body.handle] };
}

async function fixture(t: TestContext, script: Script) {
  const root = await mkdtemp(join(tmpdir(), "trylo-c19-deliberation-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const write = (command: BoardCommand) => withBoardWriter(root, store => store.apply(command));
  const opened = await write({ type: "coordinate_learning", commandId: "open:c19", issuedAt: NOW, action: {
    kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: BUDGET, scope: SCOPE,
      unit: "total_model_tokens", limits: { tokens: 400000, calls: 8, steps: 8 }, authorizationRef: "authorization:c19" } } });

  assert.ok(opened.ok);
  const original = createCentralAccountingFundingAtRoot({ boardRoot: root, scope: SCOPE, budgetId: BUDGET,
    owner: { kind: "central_deliberation", ownerId: BUDGET }, now: () => NOW, enabled: () => true });
  const reservations: { readonly reservationId: string; readonly maxTokens: number }[] = [], wires: ProviderRequest[] = [];
  const funding = { ...original, reserve: (input: Parameters<typeof original.reserve>[0]) => {
    reservations.push({ reservationId: input.reservationId, maxTokens: input.maxTokens });
    return original.reserve(input);
  } };

  // Scripted public provider events only: no network, credentials or private reasoning.
  async function* stream(input: ProviderRequest): AsyncIterable<ProviderEvent> {
    wires.push(input);
    yield* script(input, wires.length - 1);
  }

  const provider: ProviderPort = { stream, fork: () => ({ stream }) };
  const receipts = () => createCentralDeliberationReceiptsAtRoot({ boardRoot: root, scope: SCOPE, budgetId: BUDGET, enabled: () => true });
  const newModel = (explicitMaximum?: number) => createCentralModelDeliberation({ provider, model: "scripted-c19-no-http", funding, receipts: receipts(),
    ...(explicitMaximum === undefined ? {} : { maxOutputTokens: explicitMaximum }) });

  async function request(operation: Think = { kind: "think", operationId: "thought:c19-choose-future",
    purpose: "Choose a bounded comparison", expectedChange: "Select the next useful original inquiry", sourceRefs: [SOURCE] },
    intents: readonly CentralLearningIntentDraft[] = []): Promise<CentralDeliberationRequest> {
    const inspected = await original.inspect();
    assert.ok(inspected.ok);

    if (!inspected.ok) throw new Error("original funding unavailable");

    const p = inspected.projection;

    return { schemaVersion: 1, scope: SCOPE, budgetId: BUDGET, stateRef: initialCentralRuntimeRef(SCOPE), boardSequence: inspected.boardSequence,
      configuration: { schemaVersion: 1, configurationRef: "configuration:c19", authorizationRef: "authorization:c19",
        generationRef: CONFIGURED_GENERATION, generationLimits: { defaultMaxOutputTokens: 8192, maxOutputTokens: 16384 },
        thoughtMaxTokens: 120000,
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 400000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 } },
      resources: { boardSequence: inspected.boardSequence, budgetId: BUDGET, limits: p.budget.limits,
        occupied: p.occupied, available: p.available, status: p.status, holdReason: p.holdReason ?? null },
      state: { ...emptyCentralRuntimeState(SCOPE), intents }, operation,
      opportunities: [{ subject: { plane: "agent", domain: "workflow", issueId: "issue:c19-original" }, sourceRef: SOURCE,
        description: "The original handoff comparison remains unresolved.", constraints: [] }],
      materials: [{ ref: SOURCE, kind: "source", text: TEXT, sourceRefs: [SOURCE] }], organization: [] };
  }

  return { original, reservations, wires, receipts, newModel, request, write, funding };
}

test("a fresh automatic thought selects affordable generation before issue without changing the default or spending", async t => {
  const f = await fixture(t, () => { throw new Error("A quote must not call the model"); });
  let available = 400000, inspected = 0, quoted = 0;
  const funding = { ...f.funding, async inspect() {
    inspected++;
    const current = await f.funding.inspect();
    assert.ok(current.ok);
    return { ...current, projection: { ...current.projection, available: { ...current.projection.available, tokens: available } } };
  }, async reserve(input: { readonly reservationId: string; readonly maxTokens: number }) {
    quoted = input.maxTokens;
    return { ok: false as const, reason: "quote_only_no_spending" };
  } };
  const provider: ProviderPort = { async *stream() { throw new Error("No quote may invoke transport"); },
    fork: () => ({ async *stream() { throw new Error("No quote may invoke transport"); } }) };
  const model = createCentralModelDeliberation({ provider, model: "scripted-quote-only", funding, outputMode: "action_tool" });
  const signal = new AbortController().signal, base = await f.request();
  const operation = { ...base.operation, kind: "think" as const, operationId: "central-agenda:affordable-generation" };
  const request = { ...base, operation, state: { ...base.state, completed: [{ intentId: "central:agenda",
    operation: { kind: "read" as const, operationId: "read:original-necessary-body", purpose: "Read the original condition",
      expectedChange: "Return the exact condition", sourceRefs: [SOURCE], refs: [SOURCE], maximumChars: 2048 },
    outcome: "returned" as const, resultRefs: [SOURCE], publicResult: "Original source returned." }, { intentId: "central:agenda", operation,
    outcome: "unknown" as const, resultRefs: [], publicResult: "Not issued in this pure quote." }] } };
  const constraints = { sourceProgressFits: (candidate: CentralDeliberationRequest) => candidate.activePurposeDelivery === undefined
    && candidate.materials.some(row => row.ref === SOURCE && row.text === TEXT) };
  const before = canonicalJson(request);

  assert.ok(model.selectAutomaticOutput, "The native model port must provide automatic resource selection");
  assert.equal(await model.selectAutomaticOutput(request, signal, constraints), undefined, "An affordable default stays unchanged");
  await assert.rejects(model.deliberate(request, signal, constraints), /quote_only_no_spending/);
  available = quoted - 2000;
  await assert.rejects(model.prepareDelivery!(request, signal, constraints), /central_deliberation_context_capacity/);
  inspected = 0;
  const chosen = await model.selectAutomaticOutput(request, signal, constraints);

  assert.ok(chosen !== undefined && chosen >= 256 && chosen < 8192);
  assert.equal(inspected, 1, "One original resource snapshot serves the complete local selection");
  const selecting = (maxOutputTokens: number) => { const selected = { ...operation, maxOutputTokens };
  return { ...request,
    operation: selected, state: { ...request.state, completed: request.state.completed.map(row => row.operation.operationId === operation.operationId
      ? { ...row, operation: selected } : row) } }; };

  await assert.rejects(model.deliberate(selecting(chosen), signal, constraints), /quote_only_no_spending/);
  assert.ok(quoted <= available);
  await assert.rejects(model.prepareDelivery!(selecting(chosen + 1), signal, constraints), /central_deliberation_context_capacity/,
    "The selection must be the largest generation fitting the necessary context, not a fixed reduced cap");
  assert.equal(await model.selectAutomaticOutput(selecting(7000), signal), undefined, "Never replace an explicit operation choice");
  available = 1;
  assert.equal(await model.selectAutomaticOutput(request, signal, constraints), undefined,
    "An impossible necessary context remains waiting without an invented output allowance");
  assert.equal(canonicalJson(request), before);
  assert.equal(f.reservations.length, 0);
  assert.equal(f.wires.length, 0);
});

function future(output: CentralDeliberationOutput): Think {
  const continuation = output.intents[0]?.continuation;
  assert.ok(continuation);
  assert.equal(continuation.kind, "ready");
  if (continuation.kind !== "ready" || continuation.operation.kind !== "think") throw new Error("expected an actual future think");
  assert.equal(continuation.operation.maxOutputTokens, CHOSEN);
  return continuation.operation;
}

function expectedQuote(wire: ProviderRequest, chosen: number): number {
  const final = wire.messages.at(-1);
  assert.ok(final);
  assert.equal(final.role, "user");
  const body = JSON.parse(final.content);

  assert.equal(body.role, "host_original_root_after_this_computation_reservation");
  const ceiling = { tokens: 1_000_000_000, calls: 1_000_000_000, steps: 1_000_000_000 };
  const quote = { ...body, occupied: ceiling, available: ceiling, status: "exhausted",
    thisComputation: { ...body.thisComputation, maxTokens: 1_000_000_000 } };
  const messages = [...wire.messages.slice(0, -1), { role: "user", content: canonicalJson(quote) }];

  return new TextEncoder().encode(canonicalJson({ messages, tools: wire.tools })).length + 512 + chosen;
}

test("C19 a raw public change selects a future 12k think whose original quote, sender and cold receipt retain that exact bound", async t => {
  const f = await fixture(t, (wire, call) => learningChangeEvents(publicChange(wire, call === 0))), model = f.newModel();
  const initial = await f.request(), first = await model.deliberate(initial, new AbortController().signal);
  const operation = future(first), input = await f.request(operation, first.intents);
  const beforeRefusal = { sends: f.wires.length, reservations: f.reservations.length };
  let capabilityFailure: unknown;

  try { await f.newModel(8192).deliberate(input, new AbortController().signal); }
  catch (error) { capabilityFailure = error; } // The expected local refusal and its absence of side effects are asserted below.

  if (f.wires.length !== beforeRefusal.sends) {
    assert.equal(f.wires[beforeRefusal.sends]?.maxOutputTokens, CHOSEN, "frozen C18 must expose its actual 8192 sender, not hide behind a later decode error");
  }

  assert.ok(capabilityFailure instanceof CentralDeliberationError);
  assert.equal(capabilityFailure.reason, "central_deliberation_generation_capability_invalid");
  assert.equal(f.wires.length, beforeRefusal.sends);
  assert.equal(f.reservations.length, beforeRefusal.reservations);
  let result: CentralDeliberationOutput | undefined, executionFailure: unknown;

  try { result = await model.deliberate(input, new AbortController().signal); }
  catch (error) { executionFailure = error; } // Assert the actual sender first; any other failure is then rethrown.

  assert.equal(f.wires[0]?.maxOutputTokens, 8192, "no selection retains the original default");
  const sent = f.wires[1];
  assert.ok(sent);
  assert.equal(sent.maxOutputTokens, CHOSEN, "the actual future sender must use 12288, including on the frozen C18 red path");

  if (executionFailure !== undefined) throw executionFailure;

  assert.ok(result);
  const reservation = f.reservations[1];
  assert.ok(reservation);
  assert.equal(reservation.maxTokens, expectedQuote(sent, CHOSEN), "the complete schema/input quote includes the exact selected generation bound");
  const postReserve = JSON.parse(sent.messages.at(-1)!.content);

  assert.equal(postReserve.thisComputation.reservationId, reservation.reservationId);
  assert.equal(postReserve.thisComputation.maxTokens, reservation.maxTokens);
  assert.equal(postReserve.available.tokens, postReserve.limits.tokens - postReserve.occupied.tokens);
  const inspected = await f.original.inspect();
  assert.ok(inspected.ok);

  if (!inspected.ok) throw new Error("original funding unavailable");

  const charged = inspected.projection.budget.accounting?.find(row => row.reservationId === reservation.reservationId);
  assert.ok(charged);
  assert.equal(charged.maxTokens, reservation.maxTokens);
  assert.equal(charged.state, "settled");

  if (charged.state !== "settled") throw new Error("original reservation did not settle");

  assert.deepEqual(charged.usage, { kind: "reported", totalTokens: 160, inputTokens: 90, outputTokens: 70, model: "scripted-c19-no-http" });
  const cold = await f.receipts().read(operation.operationId);
  assert.ok(cold);
  assert.deepEqual(cold.output, result);
  assert.deepEqual(cold.request.operation, operation);
  assert.equal(cold.request.configuration.generationRef, CONFIGURED_GENERATION);
  assert.equal(cold.wireEvidence?.maxOutputTokens, CHOSEN);
  assert.equal((await f.receipts().read(initial.operation.operationId))?.wireEvidence?.maxOutputTokens, 8192);
  assert.equal((await f.newModel().inspect!({ scope: SCOPE, budgetId: BUDGET, operationId: operation.operationId }, new AbortController().signal)).status, "returned");
  await assert.rejects(f.newModel().deliberate(input, new AbortController().signal), /already_reserved/);
  assert.equal(f.wires.length, 2, "cold receipt recovery and duplicate refusal never send another request");
});

test("C19 complete selected-cap exhaustion keeps its reported charge and configured-generation hold despite a new candidate or more local funds", async t => {
  const f = await fixture(t, (wire, call) => call === 0 ? learningChangeEvents(publicChange(wire, true)) : [
    { type: "finish", reason: "length", rawReason: "length", requiresFollowUp: false },
    { type: "usage", usage: { mode: "snapshot", inputTokens: 90, outputTokens: CHOSEN, totalTokens: 90 + CHOSEN,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } },
  ]), model = f.newModel();
  const first = await model.deliberate(await f.request(), new AbortController().signal);
  const operation = future(first), input = await f.request(operation, first.intents);
  let rejected: CentralDeliberationError | undefined;

  try {
    await model.deliberate(input, new AbortController().signal);
    assert.fail("a length-only response is not a semantic result");
  }
  catch (error) {
    assert.ok(error instanceof CentralDeliberationError);
    rejected = error;
  }

  assert.ok(rejected);
  assert.equal(rejected.reason, "central_deliberation_incomplete");
  assert.equal(rejected.delivery, "returned");
  assert.equal(rejected.failureClass, "resources");
  assert.equal(rejected.outputDiagnostics?.requestedOutputTokens, CHOSEN);
  assert.equal(rejected.outputDiagnostics?.usageTailComplete, true);
  assert.equal(rejected.outputDiagnostics?.toolStarts, 0);
  assert.equal(blocksAutomaticSemanticRecovery(rejected), true);
  assert.equal(f.wires[1]?.maxOutputTokens, CHOSEN);
  const terminal = model.receipts()[1];
  assert.ok(terminal);
  assert.equal(terminal.boundary.kind, "complete");
  assert.equal(terminal.response, "rejected");
  assert.equal(terminal.settlement, "confirmed");
  const inspected = await f.original.inspect();
  assert.ok(inspected.ok);

  if (!inspected.ok) throw new Error("original funding unavailable");

  const charged = inspected.projection.budget.accounting?.find(row => row.reservationId === rejected.reservationId);
  assert.ok(charged);
  assert.equal(charged.state, "settled");

  if (charged.state !== "settled") throw new Error("original rejected reservation did not settle");

  assert.equal(charged.usage.kind, "reported");

  if (charged.usage.kind !== "reported") throw new Error("original complete usage is unknown");

  assert.equal(charged.usage.outputTokens, CHOSEN);
  assert.equal(charged.usage.totalTokens, CHOSEN + 90);
  assert.equal(await f.receipts().read(operation.operationId), undefined, "a rejected call has no successful semantic delivery");
  const block = semanticRecoveryBlock(operation.operationId, rejected, inspected.projection, input.configuration.configurationRef,
    { state: input.state, operation, now: Date.parse(NOW), recoveryDelayMs: 1000, generationRef: CONFIGURED_GENERATION });

  assert.equal(JSON.parse(block.text).generationRef, CONFIGURED_GENERATION);
  assert.equal(JSON.parse(block.text).outputDiagnostics.requestedOutputTokens, CHOSEN);
  const waiting = { ...input.state, completed: [{ intentId: first.intents[0]!.intentId, operation, outcome: "failed" as const,
    resultRefs: [], publicResult: rejected.reason }], materials: [block] };

  assert.equal(semanticResourceCondition(waiting, inspected.projection, input.configuration.configurationRef, Date.parse(NOW),
    undefined, undefined, { generationRef: CONFIGURED_GENERATION }).blocked, true);
  const increased = await f.write({ type: "coordinate_learning", commandId: "increase:c19", issuedAt: NOW, action: {
    kind: "set_budget_limit", budgetId: BUDGET, expectedSequence: inspected.boardSequence, changeId: "limit:c19",
    limits: { tokens: 500000, calls: 9, steps: 9 }, authorizationRef: "authorization:c19" } });
  assert.ok(increased.ok);
  const funded = await f.original.inspect();
  assert.ok(funded.ok);

  if (!funded.ok) throw new Error("original increased funding unavailable");

  const candidate: Think = { ...operation, operationId: "thought:c19-renamed-and-larger", maxOutputTokens: 16384 };
  const condition = semanticResourceCondition(waiting, funded.projection, input.configuration.configurationRef, Date.parse(NOW) + 86400000,
    undefined, undefined, { generationRef: CONFIGURED_GENERATION, operation: candidate, researchSourceRefs: [] });

  assert.equal(condition.blocked, true);
  assert.equal(condition.material, undefined);
  assert.equal(condition.reason, "central_deliberation_output_capacity_requires_changed_generation_or_research_input");
  await assert.rejects(f.newModel().deliberate(input, new AbortController().signal), /already_reserved/);
  assert.equal(f.wires.length, 2);
  assert.equal(f.reservations.length, 2, "neither an old reservation nor an unsupported candidate purchases another call");
});
