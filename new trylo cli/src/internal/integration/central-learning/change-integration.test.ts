import test from "node:test";
import assert from "node:assert/strict";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { CentralDeliberationRequest, CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { createCentralAccountingFunding } from "../learning-content/central-accounting-funding.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { CENTRAL_LEARNING_CHANGE_TOOL } from "./change-contract.js";
import { isCentralLearningChange } from "./change-parse.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { validateAgendaTransition } from "../../learning/central/runtime/transitions.js";

const scope = "project:normal-learning-change", budgetId = "budget:normal-change";
const source = "source:actual-contract", quote = "Receiver requires its original declared representation.";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 200000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 };

function request(): CentralDeliberationRequest {
  return { schemaVersion: 1, scope, budgetId, stateRef: "state:normal-change", boardSequence: 1,
    configuration: { schemaVersion: 1, configurationRef: "config:normal-change", authorizationRef: "auth:normal-change", allowance },
    resources: { boardSequence: 1, budgetId, limits: { tokens: 200000, calls: 8, steps: 8 }, occupied: { tokens: 0, calls: 0, steps: 0 },
      available: { tokens: 200000, calls: 8, steps: 8 }, status: "available", holdReason: null },
    state: { schemaVersion: 1, scope, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
    opportunities: [], organization: [], materials: [{ ref: source, kind: "source", text: quote, sourceRefs: [source] }],
    operation: { kind: "think", operationId: "thought:normal-change", purpose: "Choose a supported learning change",
      expectedChange: "Choose a conditional purpose and its next action", sourceRefs: [source] } };
}

async function fixture(fetchImpl: typeof fetch) {
  let state = emptyBoardState();
  const board = { load: async () => ({ ok: true as const, state, generation: 0 }), apply: async (command: BoardCommand) => {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };

  assert.ok((await board.apply({ type: "coordinate_learning", commandId: "open:normal-change", issuedAt: "2026-11-05T00:00:00Z",
    action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId, scope, unit: "total_model_tokens",
      limits: { tokens: 200000, calls: 8, steps: 8 }, authorizationRef: "auth:normal-change" } } })).ok);
  const funding = createCentralAccountingFunding({ board, scope, budgetId, owner: { kind: "central_deliberation", ownerId: "central:normal-change" },
    enabled: () => true, now: () => "2026-11-05T00:00:00Z" });
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: "injected-normal-change", scope, budgetId, enabled: () => true,
    board: { read: async () => ({ revision: state.sequence, facts: state.rewardV2Facts ?? [] }),

      append: async (expectedSequence: number, fact: RewardV2Draft) => {
        const written = await board.apply({ type: "record_reward_v2_fact", commandId: `rw2:${fact.id}`, issuedAt: fact.id, expectedSequence, fact });
        if (!written.ok) {
          if (written.reason === "reward_v2_stale") return { status: "stale" as const };
          throw new Error(written.reason);
        }
        return { status: "written" as const, revision: written.state.sequence, idempotent: written.idempotent };
      } } });
  const provider = createOpenAiCompatibleProvider({ endpoint: "https://change-contract.invalid/v1/chat/completions", model: "configured-model",
    apiKey: "test-local-only", fetchImpl, maxAttemptsBeforeHeaders: 1 });

  assert.throws(() => createCentralModelDeliberation({ provider, model: "configured-model", funding, receipts, outputMode: "structured" }), /central_deliberation_options_invalid/);

  return { funding, receipts, model: createCentralModelDeliberation({ provider, model: "configured-model", funding, receipts }) };
}

function response(argumentsValue: unknown): Response {
  const frames = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call:normal-change", type: "function",
    function: { name: CENTRAL_LEARNING_CHANGE_TOOL, arguments: JSON.stringify(argumentsValue) } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] }, { choices: [], usage: { prompt_tokens: 90, completion_tokens: 70, total_tokens: 160 } }];
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

test("normal advertised change tool grounds one new purpose and next read, accounts once and replays its actual wire receipt", async () => {
  let calls = 0;
  const f = await fixture(async (_url, init) => {
    calls += 1;
    const wire = JSON.parse(String(init?.body));

    assert.equal(wire.tools.length, 1);
    assert.equal(wire.tools[0].function.name, CENTRAL_LEARNING_CHANGE_TOOL);
    const schema = wire.tools[0].function.parameters;

    assert.equal(schema.properties.organizationKnowledge, undefined);
    assert.equal(schema.properties.organizationUse, undefined);
    assert.equal(schema.properties.changes.items.anyOf.length, 1);
    assert.deepEqual(schema.required, ["changes", "explanation"]);
    const data = wire.messages.map((row: { content: string }) => { try { return JSON.parse(row.content); } catch { return undefined; } })
      .find((row: { role?: string } | undefined) => row?.role === "central_learning_public_input");
    const body = data.materials.find((row: { delivery: string; text: string }) => row.delivery === "body" && row.text === quote);

    assert.ok(body);
    assert.notEqual(body.handle, source);

    return response({ changes: [{ kind: "create", key: "contract-question", subject: "central", goal: "Learn when representation must change",
      why: "The actual receiver condition distinguishes preservation from conversion.", grounding: { relation: "The contract controls the representation choice.",
        whenRelevant: "A future handoff with a different receiver contract.", parents: [body.handle], citations: [{ source: body.handle, quote }] },
      next: { kind: "read", purpose: "Inspect the original receiver conditions", expectedChange: "Bound when the conditional rule applies",
        sources: [body.handle], refs: [body.reads[0].handle], maximumChars: 2048 } }], explanation: "Investigate the original condition before claiming reuse." });
  });
  const output = await f.model.deliberate(request(), new AbortController().signal);

  assert.equal(output.intents.length, 1);
  assert.equal(output.intents[0]?.continuation.kind, "ready");
  assert.equal(output.intents[0]?.derivation?.citations[0]?.evidenceRef, source);
  const saved = await f.receipts.read(request().operation.operationId);

  assert.ok(saved?.wireEvidence);
  assert.deepEqual(saved.output, output);
  assert.equal(saved.wireEvidence.rawChange !== undefined, true);
  const projection = await f.funding.inspect();
  assert.ok(projection.ok);

  if (projection.ok) assert.equal(projection.projection.occupied.tokens, 160);

  await assert.rejects(f.model.deliberate(request(), new AbortController().signal), /already_reserved/);
  assert.equal(calls, 1);
});

test("normal change tool refuses an unadvertised complete-agenda payload after settling the actual provider usage", async () => {
  const f = await fixture(async () => response({ schemaVersion: 1, intents: [], sourceRefs: [], publicExplanation: "Old contract" }));
  await assert.rejects(f.model.deliberate(request(), new AbortController().signal), /central_learning_change_invalid/);
  const projection = await f.funding.inspect();
  assert.ok(projection.ok);
  if (projection.ok) assert.equal(projection.projection.occupied.tokens, 160);
  assert.equal(await f.receipts.read(request().operation.operationId), undefined);
});

test("a navigation-only call can explicitly inspect the original without inventing a purpose or quotation", async () => {
  const originalRef = "source:unread-receiver-contract";
  const navigation = { role: "central_source_body_not_delivered", originalRef, readRef: originalRef, deliveryPriority: 5,
    description: "The receiver contract is available to read; its body is not delivered." };
  const navigationRef = `central-source-navigation:${contentHashOf(navigation)}`;
  const input = request();
  const navigationOnly = { ...input, materials: [{ ref: navigationRef, kind: "source" as const, sourceRefs: [originalRef],
    text: canonicalJson(navigation) }],
    operation: { ...input.operation, sourceRefs: [navigationRef] } };
  const f = await fixture(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    const data = wire.messages.map((row: { content: string }) => { try { return JSON.parse(row.content); } catch { return undefined; } })
      .find((row: { role?: string } | undefined) => row?.role === "central_learning_public_input");
    const navigation = data.materials.find((row: { delivery: string }) => row.delivery === "navigation");

    assert.ok(navigation);
    assert.equal(wire.tools[0].function.parameters.properties.inspect !== undefined, true);
    const read = navigation.reads.find((row: { address: string }) => row.address === originalRef);

    assert.ok(read);

    return response({ changes: [], explanation: "Inspect the original before forming an evidence-bound purpose.", inspect: {
      purpose: "Read the receiver representation before learning a rule", expectedChange: "Separate preserved units from required conversion",
      refs: [read.handle], maximumChars: 2048, sources: [navigation.handle] } });
  });
  const output = await f.model.deliberate(navigationOnly, new AbortController().signal);

  assert.deepEqual(output.intents, []);
  assert.deepEqual(output.agendaRead?.refs, [originalRef]);
  assert.equal(output.agendaRead?.kind, "read");
  assert.equal(output.agendaRead?.maximumChars, 2048);
  const saved = await f.receipts.read(input.operation.operationId);

  assert.deepEqual(saved?.output, output);
  assert.ok(saved?.wireEvidence);
});

test("an original native opportunity can continue without manufacturing a central derivation", async () => {
  const input = request(), subject = { plane: "agent" as const, domain: "workflow" as const, issueId: "issue:original-nomination" };
  const nominated = { ...input, materials: [], opportunities: [{ subject, sourceRef: "source:original-nomination",
    description: "The original owner nominated this unresolved workflow question.", constraints: ["Keep the original receiver contract condition"] }],
    operation: { ...input.operation, sourceRefs: ["source:original-nomination"] } };
  const f = await fixture(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    const data = wire.messages.map((row: { content: string }) => { try { return JSON.parse(row.content); } catch { return undefined; } })
      .find((row: { role?: string } | undefined) => row?.role === "central_learning_public_input");
    const opportunity = data.opportunities[0];
    const creation = { kind: "create", key: "native-question", subject: opportunity.handle, goal: "Resolve the nominated contract condition",
      why: "The original owner left an unresolved condition.", next: { kind: "think", purpose: "Compare the known condition with the remaining question",
        expectedChange: "Choose whether a specific original is still needed", sources: [opportunity.handle] } };

    assert.equal(isCentralLearningChange({ changes: [{ ...creation, subject: "central" }], explanation: "Central goals still need grounding" }), false);
    assert.deepEqual(wire.tools[0].function.parameters.properties.changes.items.anyOf[0].properties.subject.enum, [opportunity.handle]);

    return response({ changes: [creation], explanation: "Continue the original nomination without claiming unread evidence." });
  });
  const output = await f.model.deliberate(nominated, new AbortController().signal);

  assert.deepEqual(output.intents[0]?.subject, subject);
  assert.equal(output.intents[0]?.derivation, undefined);
  assert.equal(output.intents[0]?.continuation.kind, "ready");
});

test("a complete delivered archived open purpose is revised under its original identity and still passes actual history authorization", async () => {
  const intentId = "central-purpose:original-open", original: CentralLearningIntentDraft = { intentId,
    subject: { plane: "central", questionRef: intentId }, goal: "Resolve the original receiver condition", rationale: "The original condition remained uncertain",
    conditions: ["Original receiver family"], knowledge: [], residual: ["A different representation may change the rule"],
    commitment: { purpose: "Resolve that original condition", assumptions: [], reconsiderWhen: ["A contrary original arrives"] },
    revisionReason: "The earlier investment stopped", sourceRefs: [source],
    continuation: { kind: "ended", goalState: "open", reason: "Previous resources ended before the question was answered" } };
  const initial = emptyCentralRuntimeState(scope);
  const first = { ...buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: { ...initial, intents: [original] },
    reason: "Retain the open purpose", sourceRefs: [source] }), sequence: 1 };
  const compacted = { ...buildCentralRuntimeRecord({ previousRef: first.id, state: initial, reason: "Compact the ended expenditure", sourceRefs: [] }), sequence: 2 };
  const cursor = readCentralRuntimeRecords([first, compacted], scope, 2), input = request();
  const archivedInput = { ...input, boardSequence: 2, resources: { ...input.resources, boardSequence: 2 }, stateRef: cursor.stateRef, state: cursor.state,
    materials: [...input.materials, { ref: `central-runtime-purpose-record:${contentHashOf([intentId, first.id])}`, kind: "work_result" as const,
      text: canonicalJson({ role: "exact_original_ended_learning_purpose_not_new_evidence", factRef: first.id, value: original }),
      sourceRefs: [intentId, first.id] }] };
  const f = await fixture(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    const data = wire.messages.map((row: { content: string }) => { try { return JSON.parse(row.content); } catch { return undefined; } })
      .find((row: { role?: string } | undefined) => row?.role === "central_learning_public_input");
    const archive = data.materials.find((row: { intents?: unknown[] }) => row.intents?.length);
    const body = data.materials.find((row: { delivery: string; text: string }) => row.delivery === "body" && row.text === quote);

    assert.ok(archive);
    assert.ok(body);
    assert.ok(wire.tools[0].function.parameters.properties.changes.items.anyOf.some((row: { properties: { kind: { enum: string[] } } }) => row.properties.kind.enum.includes("revise")));

    return response({ changes: [{ kind: "revise", target: archive.intents[0].handle,
      why: "The newly delivered original makes the same residual worth bounded continuation.",
      set: { next: { kind: "read", purpose: "Compare the new original receiver condition", expectedChange: "Resolve the original uncertainty",
        sources: [body.handle], refs: [body.reads[0].handle], maximumChars: 2048 } } }], explanation: "Continue the original purpose, retaining its identity and question." });
  });
  const output = await f.model.deliberate(archivedInput, new AbortController().signal);

  assert.equal(output.intents[0]?.intentId, intentId);
  assert.equal(output.intents[0]?.goal, original.goal);
  assert.equal(output.intents[0]?.continuation.kind, "ready");
  assert.equal(validateAgendaTransition(archivedInput, output, cursor.history), null);
});
