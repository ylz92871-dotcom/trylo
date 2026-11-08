import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralCompletedOperation, CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { createRewardV2BoardPort, type RewardV2BoardPort } from "../reward/v2-board-port.js";
import { createCentralDeliberationReceiptsAtRoot, type CentralDeliberationDelivery } from "./deliberation-receipts.js";
import { lookupCentralAdvisories, readCentralAdvisoryRecords, resolveCentralAdvisoryPublications } from "./central-advisory-records.js";
import { createRuntimeCentralAdvisoryPublisher } from "./runtime-central-advisory-publication.js";
import { CentralAdvisorySourceError } from "./central-advisory-source-ancestry.js";
import { readCentralPurposeMemory } from "./runtime-purpose-memory.js";
import { createRuntimeCentralAdvisoryContext } from "./runtime-central-advisory-context.js";
import { packCentralDeliberationContext } from "./deliberation-context.js";

const scope = "project:advisory-publication", budgetId = "budget:advisory-publication";
const knowledge = { statement: "Compare the original declared receiver before reuse.",
  conditions: "Only when the receiver declares the same representation.", sourceRefs: ["source:original"] };
const purpose: CentralLearningIntentDraft = { intentId: "intent:advisory", subject: { plane: "central", questionRef: "question:advisory" },
  goal: "Understand the receiver condition", rationale: "An original public observation is conditional.",
  conditions: [knowledge.conditions], knowledge: [knowledge], residual: ["No subsequent benefit is known."],
  commitment: { purpose: "Retain the original conditional understanding", assumptions: [], reconsiderWhen: ["A counterexample arrives."] },
  revisionReason: "Retain the original observation", sourceRefs: knowledge.sourceRefs,
  continuation: { kind: "ended", goalState: "open", reason: "No further investment is selected." } };
const publish = { kind: "publish" as const, intentId: purpose.intentId, knowledgeHash: contentHashOf(knowledge),
  whenRelevant: knowledge.conditions, uncertainty: "Not independently validated; future benefit is unknown." };

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "trylo-advisory-publication-"));
  try { await run(await fixture(root)); } finally { await rm(root, { recursive: true, force: true }); }
}

async function fixture(root: string) {
  const board = createRewardV2BoardPort(root, () => true);
  let state = emptyCentralRuntimeState(scope), stateRef = initialCentralRuntimeRef(scope), operation = 0;

  async function deliver(actions: NonNullable<CentralDeliberationOutput["knowledgeHandoffs"]>, options: {
    readonly budgetId?: string; readonly intents?: readonly CentralLearningIntentDraft[]; readonly materials?: readonly CentralRuntimeMaterial[];
  } = {}) {
    const deliveryBudgetId = options.budgetId ?? budgetId;
    const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: root, scope, budgetId: deliveryBudgetId, enabled: () => true });
    const prefix = await board.read();
    operation += 1;
    const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId: deliveryBudgetId, boardSequence: prefix.revision,
      configuration: { schemaVersion: 1, configurationRef: "configuration:advisory", authorizationRef: "authorization:advisory",
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
      resources: { boardSequence: prefix.revision, budgetId: deliveryBudgetId, limits: { tokens: 100000, calls: 4, steps: 4 },
        occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
      stateRef, state, opportunities: [], organization: [], materials: [{ ref: "source:original", kind: "source",
        text: "Original receiver observation.", sourceRefs: ["source:original"] }, ...(options.materials ?? [])],
      operation: { kind: "think", operationId: `operation:advisory:${operation}`, purpose: "Select a public conditional advisory",
        expectedChange: "Preserve explicit conditions and uncertainty", sourceRefs: ["source:original"] } };

    return receipts.save({ request, output: { schemaVersion: 1, intents: options.intents ?? [purpose], sourceRefs: ["source:original"],
      publicExplanation: "Retain the conditional observation without claiming benefit.", knowledgeHandoffs: actions } });
  }

  async function commit(delivery: CentralDeliberationDelivery, applied = true) {
    const resultRef = `central-deliberation-result:${contentHashOf(delivery.output)}`;
    const completed: CentralCompletedOperation = { intentId: "central:agenda", operation: delivery.request.operation,
      outcome: "returned", resultRefs: [resultRef], publicResult: delivery.output.publicExplanation };

    state = { ...state, intents: delivery.output.intents, completed: [...state.completed, completed] };
    const draft = buildCentralRuntimeRecord({ previousRef: stateRef, state,
      reason: applied ? "central_deliberation_returned" : "central_late_semantic_response_recovered_not_overwriting_new_agenda",
      sourceRefs: delivery.output.sourceRefs, ...(applied ? { opportunityConsideration: { operationId: delivery.request.operation.operationId,
        deliveryRef: delivery.deliveryRef, resultRef, sourceRefs: [] } } : {}) });
    const prefix = await board.read();
    assert.equal((await board.append(prefix.revision, draft)).status, "written");
    stateRef = draft.id;
    return draft.id;
  }

  async function revise(next: CentralLearningIntentDraft) {
    state = { ...state, intents: [next] };
    const draft = buildCentralRuntimeRecord({ previousRef: stateRef, state, reason: "Original purpose revision", sourceRefs: next.sourceRefs });
    const prefix = await board.read();
    assert.equal((await board.append(prefix.revision, draft)).status, "written");
    stateRef = draft.id;
  }

  async function loaded() {
    const result = await createBoardReader(root).load();
    assert.ok(result.ok);
    return result.state;
  }

  async function compact() {
    state = { ...state, intents: [] };
    const draft = buildCentralRuntimeRecord({ previousRef: stateRef, state, reason: "bounded_working_set_compaction", sourceRefs: [] });
    const prefix = await board.read();
    assert.equal((await board.append(prefix.revision, draft)).status, "written");
    stateRef = draft.id;
  }

  return { root, board, deliver, commit, revise, loaded, compact };
}

test("publishes only applied original selections, preserves exact ancestry and conditions, and recovers a durable lost acknowledgement once", async () => withFixture(async fx => {
  const signal = new AbortController().signal, delivery = await fx.deliver([publish]);
  let accessCalls = 0, batches = 0;
  const access = async (state: Awaited<ReturnType<typeof fx.loaded>>, snapshot: Parameters<Parameters<typeof createRuntimeCentralAdvisoryPublisher>[0]["access"]>[1], received: AbortSignal) => {
    accessCalls += 1;
    assert.equal(received, signal);
    assert.ok(state.sequence > delivery.request.boardSequence);
    assert.deepEqual(snapshot.purposeConditions, purpose.conditions);
    assert.equal(snapshot.statement, knowledge.statement);
    assert.equal(snapshot.conditions, knowledge.conditions);
    assert.equal(snapshot.uncertainty, publish.uncertainty);
    assert.ok(snapshot.accessSourceRefs.includes("source:original"));
    assert.ok(snapshot.accessSourceRefs.includes(delivery.deliveryRef));
    return { ok: true };
  };
  const wrapped: RewardV2BoardPort = { ...fx.board, append: async () => { throw new Error("single append is not this operation"); },

    appendBatch: async (revision, drafts, received) => {
      batches += 1;
      assert.equal(received, signal);
      assert.equal(drafts.length, 2);
      await fx.board.appendBatch!(revision, drafts, received);
      throw new Error("lost durable acknowledgement");
    } };
  const publisher = createRuntimeCentralAdvisoryPublisher({ boardRoot: fx.root, scope, enabled: () => true, board: wrapped, access });

  await assert.rejects(publisher.recordDecision({ scope, appliedStateRef: "central-runtime-state:" + "0".repeat(64) }, signal), /applied_decision_required/);
  const appliedStateRef = await fx.commit(delivery);
  const saved = await publisher.recordDecision({ scope, appliedStateRef }, signal);

  assert.equal(saved.status, "recorded");
  assert.equal(saved.results[0]!.status, "published");
  assert.equal(batches, 2);
  assert.equal(accessCalls, 1);
  const before = canonicalJson(await fx.board.read());

  assert.equal((await publisher.recordDecision({ scope, appliedStateRef }, signal)).status, "existing");
  const cold = createRuntimeCentralAdvisoryPublisher({ boardRoot: fx.root, scope, enabled: () => true,
    access: async () => { throw new Error("a committed footer must not repeat access or delivery"); } });

  assert.equal((await cold.recoverApplied({ scope }, signal))[0]!.status, "existing");
  assert.equal(canonicalJson(await fx.board.read()), before);
  assert.equal(batches, 2);
  const publicationRef = saved.results[0]!.publicationRef!;
  const pendingOlder = await fx.commit(await fx.deliver([publish]));
  const withdrawal = await fx.deliver([{ kind: "withdraw", publicationRef, why: "The author explicitly withdraws public reuse." }],
    { budgetId: "budget:advisory-later" });
  const withdrawApplied = await fx.commit(withdrawal);

  assert.equal((await cold.recordDecision({ scope, appliedStateRef: withdrawApplied }, signal)).results[0]!.status, "withdrawn");
  assert.equal((await cold.recordDecision({ scope, appliedStateRef: pendingOlder }, signal)).results[0]!.status, "superseded",
    "recovering an earlier applied publish cannot replace a newer applied withdrawal");
  const board = await fx.loaded();
  assert.deepEqual(lookupCentralAdvisories(board, scope), []);
  const withdrawRecord = readCentralAdvisoryRecords(board.rewardV2Facts ?? [], scope, board.sequence).find(row => row.value.kind === "withdraw");

  assert.equal(withdrawRecord?.value.budgetId, withdrawal.request.budgetId, "the later budget is bound to its own receipt, not the earlier wallet");
  assert.deepEqual(board.rewardV2Facts?.filter(row => row.id === publicationRef).length, 1);
  assert.equal(resolveCentralAdvisoryPublications({ facts: board.rewardV2Facts ?? [], scope, boardSequence: board.sequence })[0]!.status, "publication_withdrawn");
  assert.deepEqual(readCentralRuntimeRecords(board.rewardV2Facts ?? [], scope, board.sequence).state.intents[0]!.knowledge, [knowledge],
    "publication withdrawal leaves the original internal knowledge unchanged");
}));

test("records definite source rejection once, refuses late record-only authority, and suspends an unproved partial batch", async () => {
  await withFixture(async fx => {
    const signal = new AbortController().signal, delivery = await fx.deliver([publish]), appliedStateRef = await fx.commit(delivery);

    await fx.revise({ ...purpose, conditions: ["A different original condition"], revisionReason: "The condition changed." });
    let accessCalls = 0;
    const publisher = createRuntimeCentralAdvisoryPublisher({ boardRoot: fx.root, scope, enabled: () => true,

      access: async () => {
        accessCalls += 1;
        return { ok: true };
      } });
    const rejected = await publisher.recordDecision({ scope, appliedStateRef }, signal);

    assert.equal(rejected.results[0]!.status, "rejected");
    assert.equal(rejected.results[0]!.reason, "central_advisory_source_changed");
    const context = createRuntimeCentralAdvisoryContext({ boardRoot: fx.root, scope, enabled: () => true,
      access: async () => ({ ok: true }) });
    const query = { subjects: [purpose.subject],
      purposes: [{ subject: purpose.subject, purpose: purpose.goal, sourceRefs: [purpose.intentId] }], sourceRefs: [] };
    const observed = await context.source.snapshot(scope, signal, query);

    assert.equal(observed.materials.length, 1);
    assert.equal(observed.reconsider?.length, 1);
    assert.ok(observed.materials[0]!.text.includes("central_advisory_source_changed"));
    const consumed = await context.source.snapshot(scope, signal, { ...query, sourceRefs: observed.sourceRefs });

    assert.deepEqual(consumed.sourceRefs, []);
    assert.deepEqual(consumed.reconsider, []);
    const input = delivery.request;

    assert.throws(() => packCentralDeliberationContext({ ...input, materials: observed.materials,
      operation: { ...input.operation, sourceRefs: observed.sourceRefs } }, candidate => candidate.materials.length === 0),
    /central_deliberation_context_capacity/, "a selected native refusal must arrive whole before another model call");
    assert.equal(accessCalls, 0);
    assert.deepEqual(readCentralAdvisoryRecords((await fx.board.read()).facts, scope, (await fx.board.read()).revision), []);
    await fx.revise({ ...purpose, revisionReason: "The condition is once again the original one." });
    assert.equal((await publisher.recordDecision({ scope, appliedStateRef }, signal)).status, "existing");
    assert.equal(accessCalls, 0);
    const late = await fx.commit(await fx.deliver([publish]), false);

    await assert.rejects(publisher.recordDecision({ scope, appliedStateRef: late }, signal), /applied_decision_required/);
  });
  await withFixture(async fx => {
    const signal = new AbortController().signal, appliedStateRef = await fx.commit(await fx.deliver([publish]));
    let writes = 0;
    const wrapped: RewardV2BoardPort = { ...fx.board, appendBatch: async (revision, drafts) => {
      if (!drafts[0]?.id.startsWith("central-advisory-publication:")) return fx.board.appendBatch!(revision, drafts, signal);
      writes += 1;
      await fx.board.append(revision, drafts[0]!, signal);
      throw new Error("unknown partial batch");
    } };
    const publisher = createRuntimeCentralAdvisoryPublisher({ boardRoot: fx.root, scope, enabled: () => true, board: wrapped,
      access: async () => ({ ok: true }) });

    await assert.rejects(publisher.recordDecision({ scope, appliedStateRef }, signal), /write_requires_inspection/);
    const before = canonicalJson(await fx.board.read());

    await assert.rejects(publisher.recoverApplied({ scope }, signal), /write_requires_inspection/);
    assert.equal(writes, 1);
    assert.equal(canonicalJson(await fx.board.read()), before);
    const prefix = await fx.board.read();
    assert.equal(readCentralAdvisoryRecords(prefix.facts, scope, prefix.revision).length, 1);
    assert.ok(!prefix.facts.some(row => row.id.startsWith("central-advisory-result:")), "partial public facts never manufacture a completion footer");
  });
  await withFixture(async fx => {
    const signal = new AbortController().signal;
    let typed = true, calls = 0;
    const publisher = createRuntimeCentralAdvisoryPublisher({ boardRoot: fx.root, scope, enabled: () => true, access: async () => {
      calls += 1;
      if (typed) throw new CentralAdvisorySourceError("central_advisory_source_scope");
      throw new Error("unknown owner I/O");
    } });
    const first = await fx.commit(await fx.deliver([publish]));
    const rejected = await publisher.recordDecision({ scope, appliedStateRef: first }, signal);

    assert.equal(rejected.results[0]!.reason, "central_advisory_source_scope");
    assert.equal((await publisher.recordDecision({ scope, appliedStateRef: first }, signal)).status, "existing");
    assert.equal(calls, 1);
    typed = false;
    const second = await fx.commit(await fx.deliver([publish])), before = canonicalJson(await fx.board.read());

    await assert.rejects(publisher.recordDecision({ scope, appliedStateRef: second }, signal), /unknown owner I\/O/);
    assert.equal(canonicalJson(await fx.board.read()), before, "unknown I/O is not a durable candidate rejection");
  });
});

test("cold recovery reuses the exact first publication and completes its original prepared footer without rerunning current access", async () => withFixture(async fx => {
  const signal = new AbortController().signal, appliedStateRef = await fx.commit(await fx.deliver([publish]));
  const interrupted: RewardV2BoardPort = { ...fx.board, appendBatch: async (revision, drafts, received) => {
    if (!drafts[0]?.id.startsWith("central-advisory-publication:")) return fx.board.appendBatch!(revision, drafts, received);
    await fx.board.append(revision, drafts[0]!, received);
    throw new Error("process stopped after the first publication");
  } };
  const first = createRuntimeCentralAdvisoryPublisher({ boardRoot: fx.root, scope, enabled: () => true, board: interrupted, access: async () => ({ ok: true }) });

  await assert.rejects(first.recordDecision({ scope, appliedStateRef }, signal), /write_requires_inspection/);
  const prefix = await fx.board.read(), original = readCentralAdvisoryRecords(prefix.facts, scope, prefix.revision)[0]!;

  assert.ok(prefix.facts.some(row => row.id.startsWith("central-advisory-plan:")));
  assert.equal(original.value.kind, "publish");
  await fx.revise({ ...purpose, conditions: ["A newer original applicability condition"], revisionReason: "The original source changed after preparation." });
  let writes = 0;
  const coldBoard: RewardV2BoardPort = { ...fx.board, appendBatch: async (revision, drafts, received) => {
    writes += 1;
    assert.equal(received, signal);
    assert.equal(drafts.length, 1);
    assert.ok(drafts[0]!.id.startsWith("central-advisory-result:"));
    return fx.board.appendBatch!(revision, drafts, received);
  } };
  const cold = createRuntimeCentralAdvisoryPublisher({ boardRoot: fx.root, scope, enabled: () => true, board: coldBoard,
    access: async () => { throw new Error("a durable preparation must not rerun today's access gate"); } });
  const recovered = await cold.recoverApplied({ scope }, signal);

  assert.equal(recovered[0]!.results[0]!.publicationRef, original.ref);
  assert.equal(writes, 1);
  const final = await fx.loaded(), publications = readCentralAdvisoryRecords(final.rewardV2Facts ?? [], scope, final.sequence);

  assert.deepEqual(publications, [original]);
  assert.equal(lookupCentralAdvisories(final, scope).length, 0, "the old prepared fact does not override current source conditions");
  assert.equal((await cold.recoverApplied({ scope }, signal))[0]!.status, "existing");
  assert.equal(writes, 1);
}));

test("publishes an exact fully delivered archived purpose without restoring it to the working agenda", async () => withFixture(async fx => {
  const signal = new AbortController().signal, originalHead = await fx.commit(await fx.deliver([publish]));

  await fx.compact();
  const prefix = await fx.board.read();
  const original = readCentralPurposeMemory({ facts: prefix.facts, scope, boardSequence: prefix.revision },
    `central-runtime-purpose-record:${contentHashOf([purpose.intentId, originalHead])}`);

  assert.ok(original);
  const delivery = await fx.deliver([publish], { intents: [], materials: [original] }), appliedStateRef = await fx.commit(delivery);
  let calls = 0;
  const publisher = createRuntimeCentralAdvisoryPublisher({ boardRoot: fx.root, scope, enabled: () => true,

    access: async () => {
      calls += 1;
      return { ok: true };
    } });

  assert.equal((await publisher.recordDecision({ scope, appliedStateRef }, signal)).results[0]!.status, "published");
  assert.equal(calls, 1);
  const board = await fx.loaded();
  assert.deepEqual(readCentralRuntimeRecords(board.rewardV2Facts ?? [], scope, board.sequence).state.intents, []);
  assert.equal(lookupCentralAdvisories(board, scope)[0]!.purposeHeadRef, originalHead);
}));
