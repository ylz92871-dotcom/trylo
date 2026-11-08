import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralCompletedOperation, CentralDeliberationOutput, CentralDeliberationRequest,
  CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef,
  type CentralOpportunityConsideration } from "../../learning/central/runtime/records.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { readAppliedCentralAdvisoryDecisions } from "./central-advisory-applied-decisions.js";

const scope = "project:advisory-applied", budgetId = "budget:advisory-applied";
const knowledge = { statement: "Compare the actual input conditions before reusing a result.",
  conditions: "Only when the original comparison conditions still hold.", sourceRefs: ["source:one"] };
const intent: CentralLearningIntentDraft = { intentId: "intent:advisory", subject: { plane: "central", questionRef: "intent:advisory" },
  goal: "Retain a conditional comparison.", rationale: "An actual public observation supports investigating this condition.",
  conditions: [knowledge.conditions], knowledge: [knowledge], residual: ["Effect on a future task is unknown."],
  commitment: { purpose: "Make the original condition available as an advisory.", assumptions: [], reconsiderWhen: ["A counterexample arrives."] },
  revisionReason: "Original public comparison recorded.", sourceRefs: ["source:one"],
  continuation: { kind: "ended", goalState: "open", reason: "No further investigation is currently selected." } };
const publish = { kind: "publish" as const, intentId: intent.intentId, knowledgeHash: contentHashOf(knowledge),
  whenRelevant: knowledge.conditions, uncertainty: "Not independently validated; future benefit is unknown." };

async function withFixture(run: (fixture: Awaited<ReturnType<typeof fixtureAt>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "trylo-advisory-applied-"));
  try { await run(await fixtureAt(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function fixtureAt(root: string) {
  const board = createRewardV2BoardPort(root, () => true);
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot: root, scope, budgetId, enabled: () => true });
  let state = emptyCentralRuntimeState(scope), stateRef = initialCentralRuntimeRef(scope);

  async function saveDelivery(operationId: string, handoffs?: CentralDeliberationOutput["knowledgeHandoffs"]) {
    const prefix = await board.read();
    const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId, boardSequence: prefix.revision,
      resources: { boardSequence: prefix.revision, budgetId, limits: { tokens: 100000, calls: 4, steps: 4 },
        occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 4, steps: 4 }, status: "available", holdReason: null },
      configuration: { schemaVersion: 1, configurationRef: "configuration:one", authorizationRef: "authorization:one",
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } },
      stateRef, state, opportunities: [], materials: [{ ref: "source:one", kind: "source", text: "Actual public observation.", sourceRefs: ["source:one"] }],
      organization: [], operation: { kind: "think", operationId, purpose: "Choose a conditional advisory.",
        expectedChange: "Record the original public choice.", sourceRefs: ["source:one"] } };
    const output: CentralDeliberationOutput = { schemaVersion: 1, intents: [intent], publicExplanation: "Keep the condition and uncertainty.",
      sourceRefs: ["source:one"], ...(handoffs === undefined ? {} : { knowledgeHandoffs: handoffs }) };

    return receipts.save({ request, output });
  }

  async function commit(delivery: Awaited<ReturnType<typeof saveDelivery>>, options: {
    readonly reason?: string; readonly outcome?: CentralCompletedOperation["outcome"];
    readonly completed?: Partial<CentralCompletedOperation>; readonly consideration?: Partial<CentralOpportunityConsideration>;
  } = {}) {
    const resultRef = `central-deliberation-result:${contentHashOf(delivery.output)}`;
    const completed: CentralCompletedOperation = { intentId: "central:agenda", operation: delivery.request.operation,
      outcome: options.outcome ?? "returned", resultRefs: [resultRef], publicResult: delivery.output.publicExplanation, ...options.completed };
    const reason = options.reason ?? "central_deliberation_returned";

    state = { ...state, intents: delivery.output.intents, completed: [...state.completed, completed] };
    const fact = buildCentralRuntimeRecord({ previousRef: stateRef, state, reason, sourceRefs: delivery.output.sourceRefs,
      ...(reason !== "central_deliberation_returned" || completed.outcome !== "returned" ? {} : { opportunityConsideration: {
        operationId: delivery.request.operation.operationId, deliveryRef: delivery.deliveryRef, resultRef, sourceRefs: [], ...options.consideration } }) });
    const prefix = await board.read(), saved = await board.append(prefix.revision, fact);

    assert.equal(saved.status, "written");
    stateRef = fact.id;

    return fact.id;
  }

  async function compact() {
    state = { ...state, intents: [], completed: [] };
    const fact = buildCentralRuntimeRecord({ previousRef: stateRef, state, reason: "bounded_working_set_compaction", sourceRefs: [] });
    const prefix = await board.read(), saved = await board.append(prefix.revision, fact);
    assert.equal(saved.status, "written");
    stateRef = fact.id;
  }

  return { board, saveDelivery, commit, compact };
}

test("recovers applied advisory choices after publisher interruption in original commit order and through compaction", async () => withFixture(async fx => {
  const delivery = await fx.saveDelivery("operation:publish", [publish]);
  let prefix = await fx.board.read();

  assert.deepEqual(readAppliedCentralAdvisoryDecisions(prefix.facts, scope, prefix.revision), [], "a receipt alone has not applied an agenda");
  const first = await fx.commit(delivery);
  const withdrawal = await fx.saveDelivery("operation:withdraw", [{ kind: "withdraw", publicationRef: "central-advisory:original", why: "A later observation withdrew support." }]);
  const second = await fx.commit(withdrawal);

  await fx.compact();
  prefix = await fx.board.read();
  const before = canonicalJson(prefix), result = readAppliedCentralAdvisoryDecisions(prefix.facts, scope, prefix.revision);

  assert.deepEqual(result.map(row => row.appliedStateRef), [first, second]);
  assert.ok(result[0]!.appliedSequence < result[1]!.appliedSequence);
  assert.deepEqual(result.map(row => row.decisionRef), ["operation:publish", "operation:withdraw"]);
  assert.deepEqual(result.map(row => [row.deliveryRef, row.request, row.output]),
    [[delivery.deliveryRef, delivery.request, delivery.output], [withdrawal.deliveryRef, withdrawal.request, withdrawal.output]]);
  assert.equal(canonicalJson(prefix), before, "recovery is read-only and creates no pending ledger");
}));

test("ignores late record-only, unknown and legacy outputs rather than manufacturing an applied publication", async () => withFixture(async fx => {
  await fx.commit(await fx.saveDelivery("operation:late", [publish]), { reason: "central_late_semantic_response_recovered_not_overwriting_new_agenda" });
  await fx.commit(await fx.saveDelivery("operation:unknown", [publish]), { reason: "central_deliberation_failed", outcome: "unknown" });
  await fx.commit(await fx.saveDelivery("operation:legacy"));
  await fx.commit(await fx.saveDelivery("operation:omitted-handoffs"));
  const prefix = await fx.board.read();
  assert.deepEqual(readAppliedCentralAdvisoryDecisions(prefix.facts, scope, prefix.revision), []);
}));

test("rejects a completed result or operation that does not match the authenticated returned receipt", async () => {
  await withFixture(async fx => {
    const delivery = await fx.saveDelivery("operation:wrong-result", [publish]);
    const wrong = "central-deliberation-result:wrong";
    await fx.commit(delivery, { completed: { resultRefs: [wrong] }, consideration: { resultRef: wrong } });
    const prefix = await fx.board.read();
    assert.throws(() => readAppliedCentralAdvisoryDecisions(prefix.facts, scope, prefix.revision), /central_advisory_applied_decision_binding_invalid/);
  });
  await withFixture(async fx => {
    const delivery = await fx.saveDelivery("operation:wrong-body", [publish]);
    await fx.commit(delivery, { completed: { operation: { ...delivery.request.operation, expectedChange: "A different operation body." } } });
    const prefix = await fx.board.read();
    assert.throws(() => readAppliedCentralAdvisoryDecisions(prefix.facts, scope, prefix.revision), /central_advisory_applied_decision_binding_invalid/);
  });
  await withFixture(async fx => {
    const delivery = await fx.saveDelivery("operation:wrong-consideration", [publish]);
    await fx.commit(delivery, { consideration: { sourceRefs: ["opportunity:not-in-request"] } });
    const prefix = await fx.board.read();
    assert.throws(() => readAppliedCentralAdvisoryDecisions(prefix.facts, scope, prefix.revision), /central_advisory_applied_decision_binding_invalid/);
  });
});

test("rejects publication before its receipt commit and preserves native receipt corruption failures", async () => withFixture(async fx => {
  const delivery = await fx.saveDelivery("operation:ordering", [publish]);
  const applied = await fx.commit(delivery), prefix = await fx.board.read();
  const reordered = [{ ...prefix.facts.find(row => row.id === applied)!, sequence: 1 },
    ...prefix.facts.filter(row => row.id !== applied).map(row => ({ ...row, sequence: row.sequence + 1 }))];

  assert.throws(() => readAppliedCentralAdvisoryDecisions(reordered, scope, prefix.revision), /central_advisory_applied_receipt_binding_invalid/);
  const changed = prefix.facts.map(row => row.algorithmVersion === "central-deliberation-public-chunk-v1"
    ? { ...row, payloadJson: row.payloadJson.replace("Actual public observation.", "Edited public observation.") } : row);

  assert.throws(() => readAppliedCentralAdvisoryDecisions(changed, scope, prefix.revision), /central_deliberation_receipt/);
}));
