import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { CentralDeliberationDeliveryConstraints, CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { createCentralAccountingFunding } from "../learning-content/central-accounting-funding.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import type { ProviderPort } from "../../ports/provider.js";
import { centralDeliveredSourceRefs } from "./deliberation-context.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { buildOrganizationRecord } from "../../learning/central/organization/records.js";
import type { TimerScheduler } from "../../subagent/scheduler.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { CentralDeliberationError } from "./deliberation-contract.js";
import { isCentralDeliberationOutputDiagnostics } from "./deliberation-output-diagnostics.js";
import { blocksAutomaticSemanticRecovery, semanticRecoveryBlock, semanticResourceCondition } from "./runtime-recovery.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import type { CentralChangeNext, CentralLearningChange } from "./change-contract.js";
import { CENTRAL_LEARNING_CHANGE_TOOL } from "./change-contract.js";
import { learningChangeBody, learningChangeFeedback, learningChangeIntent, learningChangeKnowledge,
  learningChangeRead, learningChangeResponse, readLearningChangeWire, type LearningChangeTestView } from "./change-test-support.js";

const SCOPE = "project:central-semantic", NOW = "2026-11-05T00:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 150000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 };
const subject = { plane: "agent" as const, domain: "workflow" as const, issueId: "issue:handoff" };

function request(operationId = "operation:one"): CentralDeliberationRequest {
  return { schemaVersion: 1, scope: SCOPE, budgetId: "budget:central", boardSequence: 1, stateRef: "state:one",
    resources: { boardSequence: 1, budgetId: "budget:central", limits: { tokens: 200000, calls: 10, steps: 10 },
      occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 200000, calls: 10, steps: 10 }, status: "available", holdReason: null },
    configuration: { schemaVersion: 1, configurationRef: "config:one", authorizationRef: "authorization:one", allowance },
    state: { schemaVersion: 1, scope: SCOPE, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    opportunities: [{ subject, sourceRef: "source:original", description: "Repeated handoff rework.", constraints: [] }],
    materials: [{ ref: "source:original", kind: "source", sourceRefs: ["source:original"],
      text: "Original request: compare the interface contract before changing the handoff." }],
    organization: [{ ref: "organization:one", kind: "organization", sourceRefs: ["source:original"],
      text: "Prior actual use supported contract inspection only for cross-specialty handoffs; one same-team counterexample failed." }],
    operation: { kind: "think", operationId, purpose: "Find the next useful computation.", expectedChange: "Choose a research direction.", sourceRefs: ["source:original"] } };
}

function decision(view: LearningChangeTestView, kind: "ready" | "waiting" = "ready"): CentralLearningChange {
  const quote = "Original request: compare the interface contract before changing the handoff.";
  const body = learningChangeBody(view, quote), goal = "Reduce recurring handoff rework.";
  const next: CentralChangeNext = kind === "ready"
    ? { kind: "read", refs: [learningChangeRead(view, "source:original")], maximumChars: 4096,
        purpose: "Inspect the actual contract.", expectedChange: "Separate missing contract from workflow order.", sources: [body.handle] }
    : { kind: "wait", for: "use_feedback", reason: "Need actual use before claiming benefit.", sources: [body.handle] };
  const explanation = "Inspect the original interface before dispatching research.";

  if (view.agenda.length > 0) return { checkpoint: view.checkpoint, changes: [{ kind: "revise", target: learningChangeIntent(view, goal),
    why: "The original purpose now needs actual use feedback.", set: { next } }], explanation, sources: [body.handle] };

  const opportunity = view.opportunities[0];
  assert.ok(opportunity);

  return { checkpoint: view.checkpoint, changes: [{ kind: "create", key: "handoff", subject: opportunity.handle, goal,
    why: "The original request and conditional experience suggest a contract gap.",
    conditions: ["Cross-specialty handoff"], knowledge: [], residual: ["Is the interface already explicit?"],
    commitment: { purpose: "Resolve the contract gap.", assumptions: ["Original source is relevant."], reconsiderWhen: ["Same-team counterexample applies."] },
    sources: [body.handle], grounding: { relation: "The original contract determines the handoff premise.",
      whenRelevant: "A later cross-specialty handoff.", parents: [body.handle], citations: [{ source: body.handle, quote }] }, next }],
    explanation, sources: [body.handle, ...view.materials.filter(row => row.delivery === "body" && row.kind === "organization").map(row => row.handle)] };
}

function response(wire: unknown, kind: "ready" | "waiting" = "ready", usage: "reported" | "unknown" = "reported"): Response {
  const change = decision(readLearningChangeWire(wire), kind);
  return usage === "unknown" ? learningChangeResponse(change, "unknown") : learningChangeResponse(change);
}

async function fixture(fetchImpl: typeof fetch, outputMode: "tool" = "tool", scheduler?: TimerScheduler) {
  let state = emptyBoardState();
  const board = { load: async () => ({ ok: true as const, state, generation: 0 }), apply: async (command: BoardCommand) => {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const opened = await board.apply({ type: "coordinate_learning", commandId: "open:central", issuedAt: NOW, action: {
    kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "budget:central", scope: SCOPE,
      unit: "total_model_tokens", limits: { tokens: 200000, calls: 10, steps: 10 }, authorizationRef: "authorization:one" } } });

  assert.ok(opened.ok);
  const funding = createCentralAccountingFunding({ board, scope: SCOPE, budgetId: "budget:central",
    owner: { kind: "central_deliberation", ownerId: "central:one" }, now: () => NOW, enabled: () => true });
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://central-semantic.invalid/v1/chat/completions",
    model: "configured-model", apiKey: "test-local-only", fetchImpl, maxAttemptsBeforeHeaders: 1 });
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: "unused-injected-original-board", scope: SCOPE,
    budgetId: "budget:central", enabled: () => true, board: {
      read: async () => ({ revision: state.sequence, facts: state.rewardV2Facts ?? [] }),

      append: async (expectedSequence: number, fact: RewardV2Draft) => {
        const written = await board.apply({ type: "record_reward_v2_fact", commandId: `rw2:${fact.id}`, issuedAt: fact.id, expectedSequence, fact });
        if (!written.ok) {
          if (written.reason === "reward_v2_stale") return { status: "stale" as const };
          throw new Error(written.reason);
        }
        return { status: "written" as const, revision: written.state.sequence, idempotent: written.idempotent };
      },
    } });
  const newModel = () => createCentralModelDeliberation({ provider, model: "configured-model", funding, receipts, outputMode,
    ...(scheduler === undefined ? {} : { scheduler }) });

  return { funding, model: newModel(), newModel, board, state: () => state };
}

test("central model sees original material and organization, emits next read, settles real tail, and duplicate never resends", async () => {
  const wires: Record<string, unknown>[] = [];
  const f = await fixture(async (_url, init) => {
    wires.push(JSON.parse(String(init?.body)));
    return response(String(init?.body));
  });
  const before = await f.model.inspect!({ scope: SCOPE, budgetId: "budget:central", operationId: "operation:one" }, new AbortController().signal);

  assert.equal(before.status, "not_sent");

  if (before.status === "not_sent") {
    assert.equal(before.admission?.ownerId, "central:one");
    assert.equal(before.admission?.rootRef.budgetId, "budget:central");
  }

  const result = await f.model.deliberate(request(), new AbortController().signal);

  assert.equal(result.intents[0]?.continuation.kind, "ready");
  assert.equal(wires.length, 1);
  const wire = JSON.stringify(wires[0]);
  assert.match(wire, /Original request: compare/);
  assert.match(wire, /same-team counterexample/);
  assert.match(wire, /submit_learning_change/);
  assert.equal(wires[0]!.response_format, undefined);
  assert.equal(readLearningChangeWire(wires[0]).opportunities.length, 1);
  assert.match(wire, /host_original_root_after_this_computation_reservation/);
  assert.match(wire, /thisComputation/);
  const inspected = await f.funding.inspect();
  assert.ok(inspected.ok);

  if (inspected.ok) assert.equal(inspected.projection.occupied.tokens, 160);

  await assert.rejects(f.model.deliberate(request(), new AbortController().signal), /already_reserved/);
  const resumed = await f.newModel().inspect!({ scope: SCOPE, budgetId: "budget:central", operationId: "operation:one" }, new AbortController().signal);

  assert.equal(resumed.status, "returned");

  if (resumed.status === "returned") assert.deepEqual(resumed.output, result);

  assert.equal(wires.length, 1);
});

test("declarative tool is decoded and independent checkpoint carries its actual next material", async () => {
  let calls = 0;
  const wires: string[] = [];
  const f = await fixture(async (_url, init) => {
    wires.push(String(init?.body));
    calls += 1;
    return response(String(init?.body), calls === 1 ? "ready" : "waiting");
  }, "tool");
  const first = await f.model.deliberate(request(), new AbortController().signal);
  const next = request("operation:two");
  const second = await f.model.deliberate({ ...next, state: { ...next.state, intents: first.intents },
    materials: [...next.materials, { ref: "source:contract-page", kind: "source", sourceRefs: ["source:original"], text: "Actual contract page: required reviewer is absent." }] }, new AbortController().signal);

  assert.equal(second.intents[0]?.continuation.kind, "waiting");
  assert.match(wires[1]!, /required reviewer is absent/);
  assert.equal(second.intents[0]?.intentId, first.intents[0]?.intentId);
  assert.equal(f.model.receipts().length, 2);
});

test("missing usage settles unknown conservatively, and rebuilding the adapter cannot retry the original operation", async () => {
  let calls = 0;
  const f = await fixture(async (_url, init) => {
    calls += 1;
    return response(String(init?.body), "ready", "unknown");
  });

  await assert.rejects(f.model.deliberate(request(), new AbortController().signal), /usage_absent/);
  const inspected = await f.funding.inspect();
  assert.ok(inspected.ok);

  if (inspected.ok) assert.ok(inspected.projection.occupied.tokens > 160);

  const resumed = f.newModel();

  assert.equal((await resumed.inspect!({ scope: SCOPE, budgetId: "budget:central", operationId: "operation:one" }, new AbortController().signal)).status, "unknown");
  await assert.rejects(resumed.deliberate(request(), new AbortController().signal), /already_reserved/);
  assert.equal(calls, 1);
});

test("a rejected original tool retains real terminal usage and safe diagnostics on the original operation across cold replay", async () => {
  const argumentFragment = '{"schemaVersion":1,"private_marker":"DO_NOT_STORE';
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "tool:original", type: "function",
      function: { name: CENTRAL_LEARNING_CHANGE_TOOL, arguments: argumentFragment } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "length" }] },
    { choices: [], usage: { prompt_tokens: 90, completion_tokens: 70, total_tokens: 160 } },
  ];
  let calls = 0;
  const f = await fixture(async () => { calls += 1;
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")
    + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }); }, "tool");
  let rejected: CentralDeliberationError | undefined;

  try { await f.model.deliberate(request(), new AbortController().signal); }
  catch (error) {
    assert.ok(error instanceof CentralDeliberationError);
    rejected = error;
  }

  assert.ok(rejected);
  assert.equal(rejected.reason, "central_deliberation_tool_invalid");
  assert.equal(rejected.delivery, "returned");
  const diagnostics = rejected.outputDiagnostics;
  assert.ok(isCentralDeliberationOutputDiagnostics(diagnostics));
  assert.equal(diagnostics.cause, "open_json");
  assert.equal(diagnostics.finishReason, "length");
  assert.equal(diagnostics.requestedOutputTokens, 8192, "the requested output allowance is separate from the root's total reservation");
  assert.equal(diagnostics.argumentChars, argumentFragment.length);
  assert.equal(diagnostics.usageObserved, true);
  assert.equal(diagnostics.streamExhausted, true);
  assert.equal(diagnostics.usageTailComplete, true);
  assert.equal(f.model.receipts()[0]?.boundary.kind, "complete");
  assert.equal(f.model.receipts()[0]?.response, "rejected");
  assert.deepEqual(f.model.receipts()[0]?.outputDiagnostics, diagnostics);
  const inspected = await f.funding.inspect();
  assert.ok(inspected.ok);
  if (!inspected.ok) return;

  assert.equal(inspected.projection.occupied.tokens, 160, "only the provider's complete observed consumption settles, never the maximum quote");
  assert.equal(inspected.projection.occupied.calls, 1);
  assert.equal(calls, 1);
  assert.equal(blocksAutomaticSemanticRecovery(rejected), true);
  const block = semanticRecoveryBlock(request().operation.operationId, rejected, inspected.projection, "config:one");
  const draft = buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(SCOPE),
    state: { ...emptyCentralRuntimeState(SCOPE), completed: [{ intentId: "central:agenda", operation: request().operation,
      outcome: "failed", resultRefs: [], publicResult: rejected.reason }], materials: [block] },
    reason: "central_semantic_recovery_requires_actual_condition", sourceRefs: [block.ref] });
  const written = await f.board.apply({ type: "record_reward_v2_fact", commandId: `rw2:${draft.id}`, issuedAt: NOW,
    expectedSequence: f.state().sequence, fact: draft });
  assert.ok(written.ok);
  const cold = readCentralRuntimeRecords(f.state().rewardV2Facts ?? [], SCOPE, f.state().sequence);
  const body = JSON.parse(cold.state.materials[0]!.text);

  assert.equal(body.operationId, request().operation.operationId);
  assert.equal(body.reservationId, rejected.reservationId);
  assert.deepEqual(body.outputDiagnostics, diagnostics);
  assert.equal(cold.state.intents.length, 0);
  assert.equal(JSON.stringify(body).includes(argumentFragment), false, "diagnostics retain no argument text");
  semanticResourceCondition(cold.state, inspected.projection, "config:one", Date.parse(NOW));
  const invalid = { ...cold.state, materials: [{ ...block, text: JSON.stringify({ ...body,
    outputDiagnostics: { ...diagnostics, arguments: "private payload forbidden" } }) }] };

  assert.throws(() => semanticResourceCondition(invalid, inspected.projection, "config:one", Date.parse(NOW)), /output_diagnostics_corrupt/);
  const followedByNetworkFailure = new CentralDeliberationError("central_deliberation_provider_network", "unknown", rejected.reservationId,
    { class: "network", retryable: false }, undefined, diagnostics);

  assert.equal(blocksAutomaticSemanticRecovery(followedByNetworkFailure), true,
    "later transport trouble cannot turn the rejected original output into an automatic paid retry");
});

test("a local stream deadline settles the original reservation unknown and rebuilding cannot buy the same operation again", async () => {
  const timers: { readonly delay: number; readonly fire: () => void; cancelled: boolean }[] = [];
  const scheduler: TimerScheduler = (delay, fire) => {
    const timer = { delay, fire, cancelled: false };
    timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  };
  let calls = 0, sent: (() => void) | undefined;
  const started = new Promise<void>(resolve => { sent = resolve; });
  const f = await fixture(async (_url, init) => {
    calls += 1;
    sent!();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("local test transport aborted")), { once: true });
    });
  }, "tool", scheduler);
  const pending = f.model.deliberate(request(), new AbortController().signal);
  const rejected = assert.rejects(pending, /central_deliberation_timeout/);

  await started;
  const firstProgress = timers.find(timer => timer.delay === 120000 && !timer.cancelled);
  assert.ok(firstProgress);
  firstProgress.fire();
  await rejected;
  const receipt = f.model.receipts()[0];
  assert.ok(receipt);
  assert.equal(receipt.boundary.kind, "unknown");
  assert.equal(receipt.settlement, "confirmed");
  const inspected = await f.funding.inspect();
  assert.ok(inspected.ok);

  if (inspected.ok) {
    assert.equal(inspected.projection.occupied.calls, 1);
    assert.equal(inspected.projection.occupied.steps, 1);
    assert.equal(inspected.projection.occupied.tokens, receipt.maxTokens);
  }

  const resumed = f.newModel();

  assert.equal((await resumed.inspect!({ scope: SCOPE, budgetId: "budget:central", operationId: "operation:one" }, new AbortController().signal)).status, "unknown");
  await assert.rejects(resumed.deliberate(request(), new AbortController().signal), /already_reserved/);
  assert.equal(calls, 1);
  assert.ok(timers.every(timer => timer.cancelled));
});

test("invented provenance and unauthorized subjects are rejected after charging the actual call", async () => {
  for (const invalid of ["source", "subject"] as const) {
    const f = await fixture(async (_url, init) => {
      const valid = decision(readLearningChangeWire(String(init?.body)));
      const bad = invalid === "source" ? { ...valid, sources: ["source:never-read"] }
        : { ...valid, changes: valid.changes.map(change => {
          assert.ok(change.kind === "create");
          return { ...change, subject: "opportunity:never-existed" };
        }) };
      return learningChangeResponse(bad);
    });

    await assert.rejects(f.model.deliberate(request(), new AbortController().signal), /handle_unbound|source_unbound|subject_unbound/);
    const inspected = await f.funding.inspect();
    assert.ok(inspected.ok);

    if (inspected.ok) assert.equal(inspected.projection.occupied.tokens, 160);
  }
});

test("32k authorization admits one complete schema and the model sees its actual reserved balance", async () => {
  let wire: Record<string, unknown> = {};
  const f = await fixture(async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return response(String(init?.body));
  });
  const input = request();

  await f.model.deliberate({ ...input, configuration: { ...input.configuration, allowance: { ...allowance, maxTokens: 32000, maxCalls: 4, maxSteps: 4 } } }, new AbortController().signal);
  assert.equal((wire.tools as readonly unknown[]).length, 1);
  assert.equal(wire.response_format, undefined);
  const messages = wire.messages as { role: string; content: string }[];
  const resources = JSON.parse(messages.at(-1)!.content);

  assert.ok(resources.thisComputation.maxTokens <= 32000);
  assert.equal(resources.occupied.tokens, resources.thisComputation.maxTokens);
  assert.equal(resources.available.tokens, 200000 - resources.thisComputation.maxTokens);
});

test("independent thought token ceiling admits a full quote without changing operation allowance or the original root", async () => {
  let wire: Record<string, unknown> = {};
  const f = await fixture(async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return response(String(init?.body));
  });
  const input = request(), before = await f.funding.inspect();
  assert.ok(before.ok);
  const configuration = { ...input.configuration, thoughtMaxTokens: 32000,
    allowance: { ...allowance, maxTokens: 256 } };

  await f.model.deliberate({ ...input, configuration }, new AbortController().signal);
  const messages = wire.messages as { role: string; content: string }[];
  const resources = JSON.parse(messages.at(-1)!.content);

  assert.ok(resources.thisComputation.maxTokens > configuration.allowance.maxTokens);
  assert.ok(resources.thisComputation.maxTokens <= configuration.thoughtMaxTokens);
  const after = await f.funding.inspect();
  assert.ok(after.ok);
  assert.deepEqual(after.projection.budget.limits, before.projection.budget.limits);
  assert.equal(after.projection.budget.openedSequence, before.projection.budget.openedSequence);
  assert.equal(after.projection.budget.authorizationRef, before.projection.budget.authorizationRef);
  assert.equal(after.projection.occupied.tokens, 160);
  assert.equal(after.projection.budget.accounting?.length, 1);
  const delivery = await f.newModel().inspect!({ scope: SCOPE, budgetId: "budget:central", operationId: input.operation.operationId }, new AbortController().signal);

  assert.equal(delivery.status, "returned");

  if (delivery.status === "returned") assert.deepEqual(delivery.request.configuration, configuration);
});

test("independent thought ceiling and remaining root both fence the quote before reservation or transport", async () => {
  for (const boundary of ["thought", "root"] as const) {
    let calls = 0;
    const f = await fixture(async (_url, init) => {
      calls++;
      return response(String(init?.body));
    });

    if (boundary === "root") assert.ok((await f.funding.reserve({ reservationId: "original:other-work", maxTokens: 199744 })).ok);

    const input = request(), before = await f.funding.inspect();
    assert.ok(before.ok);
    await assert.rejects(f.model.deliberate({ ...input, configuration: { ...input.configuration,
      thoughtMaxTokens: boundary === "thought" ? 256 : 32000 } }, new AbortController().signal), /central_deliberation_context_capacity/);
    const after = await f.funding.inspect();
    assert.ok(after.ok);
    assert.equal(calls, 0);
    assert.deepEqual(after, before);
  }
});

test("production planning bounds optional source acknowledgements while retaining the current source fact", async () => {
  let providerCalls = 0, reserveAttempts = 0;
  const f = await fixture(async () => {
    providerCalls++;
    throw new Error("provider must not be called");
  });
  const provider: ProviderPort = { fork: () => ({ async *stream() {
    providerCalls++;
    throw new Error("provider must not be called");
  } }),

    async *stream() {
      providerCalls++;
      throw new Error("provider must not be called");
    } };
  const feedback = { kind: "feedback" as const, decisionRef: "decision:actual", unitRef: "source:current-correction", supersedes: null,
    sourceRefs: ["source:original"], result: { kind: "correction" as const,
      statement: "The original receiver contract contradicts the previous handoff premise.", conditions: "This actual receiver exposure only." } };
  const required = createOrganizationFeedbackMaterial(SCOPE, buildOrganizationRecord(SCOPE, feedback).id, feedback);
  const original = request("operation:bounded-source-progress");
  const input: CentralDeliberationRequest = { ...original, organization: [...original.organization, required],
    materials: [...original.materials, ...Array.from({ length: 6 }, (_, index) => ({ ref: `optional:${index}`, kind: "organization" as const,
      text: `Optional archived context ${index}.`, sourceRefs: Array.from({ length: 64 }, (_, ref) => `r:${index}:${ref}`) }))] };
  const before = await f.funding.inspect();
  assert.ok(before.ok);
  const count = (candidate: CentralDeliberationRequest) => centralDeliveredSourceRefs(candidate).length;

  assert.ok(count(input) > 256);
  let checks = 0, lastAccepted: CentralDeliberationRequest | undefined;
  const constraints: CentralDeliberationDeliveryConstraints = { sourceProgressFits(candidate) {
    checks++;
    const accepted = count(candidate) <= 256;
    if (accepted) lastAccepted = candidate;
    return accepted;
  } };
  const model = createCentralModelDeliberation({ provider, model: "configured-model", funding: f.funding, outputMode: "tool" });
  const prepared = await model.prepareDelivery!(input, new AbortController().signal, constraints);

  assert.ok(count(prepared) <= 256, `actual acknowledgement count ${count(prepared)} exceeds the original 256 limit`);
  assert.ok(checks > 0);
  assert.ok([...prepared.materials, ...prepared.organization].some(row => canonicalJson(row) === canonicalJson(required)));
  assert.deepEqual(prepared.operation, input.operation);
  assert.deepEqual(prepared.configuration, input.configuration);
  assert.deepEqual(prepared.state.intents, input.state.intents);
  assert.ok(!canonicalJson(prepared).includes("sourceProgressFits"));
  checks = 0;
  lastAccepted = undefined;
  const stopBeforeTransport = createCentralModelDeliberation({ provider, model: "configured-model", outputMode: "tool", funding: {
    ...f.funding, async reserve() {
      reserveAttempts++;
      assert.ok(lastAccepted);
      assert.ok(count(lastAccepted) <= 256);
      return { ok: false, reason: "fixture_stop_after_source_plan" };
    },
  } });

  await assert.rejects(stopBeforeTransport.deliberate(input, new AbortController().signal, constraints), /fixture_stop_after_source_plan/);
  assert.ok(checks > 0, "deliberate must apply the same non-wire predicate to its own plan");
  assert.equal(reserveAttempts, 1);
  assert.equal(providerCalls, 0);
  assert.deepEqual(await f.funding.inspect(), before);
});

test("organizational learning cites actual supplied feedback identities and rejects substituting a business source", async () => {
  const feedback = { kind: "feedback", decisionRef: "decision:prior", unitRef: "operation:prior", supersedes: null,
    sourceRefs: ["source:original"], result: { kind: "progress", summary: "Contract inspection ruled out one hypothesis.", remaining: [], resultRefs: ["source:original"] } };
  const knowledge = { kind: "knowledge" as const, knowledgeId: "knowledge:prior", supersedes: null,
    statement: "Inspect contract premises before changing handoff order.", conditions: "Cross-specialty handoffs.", conditionKeys: ["domain:workflow"],
    exceptions: "Same-team cases remain uncertain.", exceptionKeys: ["same-team"], implication: "Choose source inspection first.",
    supportFactIds: ["organization-record:feedback"], counterexampleFactIds: [], state: "proposed" as const };
  const input = request();
  const actualInput = { ...input, organization: [{ ...input.organization[0]!, text: JSON.stringify({
    role: "organization_hypotheses_not_business_evidence", entries: [{ factId: "organization-record:knowledge", knowledge,
      evidence: [{ factId: "organization-record:feedback", sequence: 1, value: feedback }] }],
  }) }] };

  for (const { support, supersedes, accepted } of [
    { support: "organization-record:feedback", supersedes: "organization-record:knowledge", accepted: true },
    { support: "source:original", supersedes: "organization-record:knowledge", accepted: false },
    { support: "organization-record:feedback", supersedes: "knowledge:prior", accepted: false },
  ]) {
    let wire = "";
    const f = await fixture(async (_url, init) => {
      wire = String(init?.body);
      const view = readLearningChangeWire(wire);
      const prior = learningChangeKnowledge(view, "organization-record:knowledge");
      const recall = view.materials.flatMap(row => row.capabilities).find(row => row.kind === "recall");
      assert.ok(recall);
      const supportHandle = support === "source:original" ? learningChangeBody(view, material => material.text.startsWith("Original request:")).handle
        : learningChangeFeedback(view, support);

      return learningChangeResponse({ ...decision(view), organizationUse: { recall: recall.handle, changes: [{ knowledge: prior,
        choice: "program", before: "Change handoff order.", after: "Inspect original contract first.", reason: "Conditional prior evidence warrants source review." }] },
        organizationKnowledge: [{ kind: "revise", target: supersedes === "organization-record:knowledge" ? prior : supersedes,
          why: "The delivered feedback narrows the original organizing hypothesis.", set: { statement: knowledge.statement,
            conditions: knowledge.conditions, conditionKeys: knowledge.conditionKeys, exceptions: knowledge.exceptions,
            exceptionKeys: knowledge.exceptionKeys, implication: knowledge.implication, support: [supportHandle], counterexamples: [] } }] });
    });

    if (!accepted) await assert.rejects(f.model.deliberate(actualInput, new AbortController().signal), /handle_unbound|organization_support_unbound/);
    else {
      const revised = (await f.model.deliberate(actualInput, new AbortController().signal)).organizationKnowledge?.[0];
      assert.equal(revised?.knowledgeId, "knowledge:prior");
      assert.equal(revised?.supersedes, "organization-record:knowledge");
      assert.match(wire, /exact delivered knowledge head/);
      assert.match(wire, /organization-record:knowledge/);
    }
  }
});
