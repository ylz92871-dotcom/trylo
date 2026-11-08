import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { emptyBoardState } from "../../learning/control/state.js";
import type { CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import type { RewardV2Draft, RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { CENTRAL_ADVISORY_TYPE, type CentralAdvisoryPublish,
  type CentralAdvisoryWithdraw, type CentralAdvisoryKnowledge } from "./central-advisory-contracts.js";
import { buildCentralAdvisoryRecord, centralAdvisoryId, centralAdvisoryKnowledgeHash,
  lookupCentralAdvisories, readCentralAdvisory, readCentralAdvisoryRecords, resolveCentralAdvisoryPublications } from "./central-advisory-records.js";

const scope = "workspace:central-advisory", budgetId = "budget:central-advisory";
const entry: CentralAdvisoryKnowledge = { statement: "Compare the original receiver condition before reuse.",
  conditions: "The receiver declares its representation.", sourceRefs: ["source:original-public-observation"] };

function purpose(): CentralLearningIntentDraft {
  return { intentId: "intent:receiver-condition", subject: { plane: "central", questionRef: "intent:receiver-condition" },
    goal: "Understand when the receiver condition matters", rationale: "An original public observation is conditional",
    conditions: ["Only the declared receiver"], knowledge: [entry], residual: ["A contrary receiver remains unobserved"],
    commitment: { purpose: "Compare real receiver conditions", assumptions: [], reconsiderWhen: ["A contrary original is read"] },
    revisionReason: "Retain the original conditional understanding", sourceRefs: entry.sourceRefs,
    continuation: { kind: "waiting", wait: { kind: "facts", sourceRefs: entry.sourceRefs, reason: "Await a relevant original" } } };
}

function fixture() {
  const facts: RewardV2Fact[] = [];
  const append = (draft: RewardV2Draft) => {
    const fact = { ...draft, sequence: (facts.at(-1)?.sequence ?? 0) + 1 };
    facts.push(fact);
    return fact;
  };
  const board = () => ({ ...emptyBoardState(), sequence: facts.at(-1)?.sequence ?? 0, rewardV2Facts: facts });
  const apply = (intent: CentralLearningIntentDraft) => {
    const current = readCentralRuntimeRecords(facts, scope, board().sequence);
    return append(buildCentralRuntimeRecord({ previousRef: current.stateRef, state: { ...current.state, intents: [intent] },
      reason: "test:original-purpose-state", sourceRefs: intent.sourceRefs }));
  };
  const publication = (intent: CentralLearningIntentDraft, applied: RewardV2Fact, previousPublicationRef: string | null = null): CentralAdvisoryPublish => ({
    schemaVersion: 1, type: CENTRAL_ADVISORY_TYPE, kind: "publish", scope, budgetId,
    advisoryId: centralAdvisoryId(scope, intent.intentId, centralAdvisoryKnowledgeHash(entry)), intentId: intent.intentId,
    purposeHeadRef: applied.id, purposeConditions: intent.conditions, knowledgeHash: centralAdvisoryKnowledgeHash(entry), ...entry,
    whenRelevant: "A later task compares a declared receiver representation", uncertainty: "No independent later-use outcome is known",
    accessSourceRefs: entry.sourceRefs, decisionRef: `decision:${applied.sequence}`,
    deliveryRef: `central-deliberation-delivery:${contentHashOf([applied.id, "delivery"])}`,
    appliedStateRef: applied.id, appliedSequence: applied.sequence, previousPublicationRef,
  });
  const views = () => resolveCentralAdvisoryPublications({ facts, scope, boardSequence: board().sequence });

  return { facts, append, board, apply, publication, views };
}

test("advisory currentness follows exact original knowledge and purpose conditions, preserving unrelated commitment and ended-open changes", () => {
  const f = fixture(), original = purpose(), applied = f.apply(original), value = f.publication(original, applied);
  const fact = f.append(buildCentralAdvisoryRecord(value));

  assert.equal(fact.id, `central-advisory-publication:${contentHashOf(value)}`);
  assert.deepEqual(readCentralAdvisoryRecords(f.facts, scope, f.board().sequence)[0], { ref: fact.id, version: fact.id, sequence: fact.sequence, value });
  const first = f.views()[0]!;

  assert.equal(first.status, "current");
  assert.equal(first.id, value.advisoryId);
  assert.equal(first.version, fact.id);
  assert.deepEqual(first.purposeConditions, original.conditions);
  assert.deepEqual(first.sourceRefs, entry.sourceRefs);
  assert.deepEqual(first.accessSourceRefs, value.accessSourceRefs);
  assert.equal(first.uncertainty, value.uncertainty);
  assert.deepEqual(lookupCentralAdvisories(f.board(), scope), [first]);
  assert.deepEqual(readCentralAdvisory(f.board(), scope, { ref: first.id, version: fact.id }), first);
  f.apply({ ...original, revisionReason: "Wait using a different investment commitment",
    commitment: { ...original.commitment, purpose: "Retain this question without a new expenditure" },
    continuation: { kind: "ended", goalState: "open", reason: "No further investment is justified now" } });
  assert.equal(f.views()[0]!.status, "current", "unrelated commitment and ending expenditure do not withdraw knowledge");
  f.apply({ ...original, conditions: ["A different original receiver"], revisionReason: "The purpose applicability changed" });
  assert.equal(f.views()[0]!.status, "source_changed", "unchanged knowledge alone cannot hide changed purpose conditions");
  f.apply({ ...original, knowledge: [{ ...entry, conditions: "A narrower receiver condition" }], revisionReason: "Revise the knowledge condition" });
  assert.equal(f.views()[0]!.status, "source_changed");
  assert.deepEqual(lookupCentralAdvisories(f.board(), scope), []);
  assert.equal(readCentralAdvisory(f.board(), scope, { ref: first.id, version: fact.id })?.version, fact.id, "old original versions remain historical");
  f.apply({ ...original, revisionReason: "Withdraw the original purpose", continuation: { kind: "ended", goalState: "withdrawn", reason: "The author withdraws this purpose" } });
  assert.equal(f.views()[0]!.status, "purpose_withdrawn");
});

test("explicit publication withdrawal leaves internal knowledge intact and a late older append cannot override its original applied order", () => {
  const f = fixture(), original = purpose(), applied = f.apply(original), firstValue = f.publication(original, applied);
  const first = f.append(buildCentralAdvisoryRecord(firstValue));
  const pendingApplied = f.apply({ ...original, revisionReason: "Consider a different public reuse context" });
  const pending = { ...f.publication(original, pendingApplied, first.id), whenRelevant: "An earlier pending reuse context" };
  const withdrawalApplied = f.apply({ ...original, revisionReason: "Withdraw only the public handoff" });
  const withdrawal: CentralAdvisoryWithdraw = { schemaVersion: 1, type: CENTRAL_ADVISORY_TYPE, kind: "withdraw", scope, budgetId,
    advisoryId: firstValue.advisoryId, publicationRef: first.id, why: "Do not expose this version to ordinary tasks",
    decisionRef: "decision:withdraw", deliveryRef: `central-deliberation-delivery:${contentHashOf("withdraw-delivery")}`,
    appliedStateRef: withdrawalApplied.id, appliedSequence: withdrawalApplied.sequence, previousPublicationRef: first.id };

  f.append(buildCentralAdvisoryRecord(withdrawal));
  const late = f.append(buildCentralAdvisoryRecord(pending));

  assert.ok(late.sequence > withdrawalApplied.sequence && pending.appliedSequence < withdrawal.appliedSequence);
  assert.equal(f.views().find(view => view.version === first.id)?.status, "publication_withdrawn");
  assert.equal(f.views().find(view => view.version === late.id)?.status, "superseded");
  assert.deepEqual(lookupCentralAdvisories(f.board(), scope), []);
  const internal = readCentralRuntimeRecords(f.facts, scope, f.board().sequence).state.intents[0]!;

  assert.deepEqual(internal.knowledge, original.knowledge);
  const renewedApplied = f.apply({ ...original, revisionReason: "Explicitly publish a new version after withdrawal" });
  const renewed = f.append(buildCentralAdvisoryRecord({ ...f.publication(original, renewedApplied, first.id), uncertainty: "Later use is still unknown" }));

  assert.deepEqual(lookupCentralAdvisories(f.board(), scope).map(view => view.version), [renewed.id]);
  assert.equal(readCentralAdvisory(f.board(), scope, { ref: firstValue.advisoryId, version: first.id })?.status, "publication_withdrawn");
});

test("advisory readers reject noncanonical, forged or malformed records rather than manufacturing a current source", () => {
  const f = fixture(), original = purpose(), applied = f.apply(original), value = f.publication(original, applied);
  const draft = buildCentralAdvisoryRecord(value), fact = f.append(draft);
  const invalid = (payload: unknown): RewardV2Fact => ({ ...fact, payloadJson: canonicalJson(payload),
    id: `central-advisory-publication:${contentHashOf(payload)}` });

  for (const changed of [invalid({ ...value, extra: true }), invalid({ ...value, knowledgeHash: contentHashOf("forged") }),
    { ...fact, id: `central-advisory-publication:${contentHashOf("wrong-id")}` }, { ...fact, payloadJson: ` ${fact.payloadJson}` }]) {
    assert.throws(() => readCentralAdvisoryRecords([applied, changed], scope, changed.sequence), /record_corrupt/);
  }

  assert.throws(() => readCentralAdvisoryRecords([fact, applied], scope, fact.sequence), /prefix_invalid/);
  assert.throws(() => readCentralAdvisoryRecords([applied, fact], scope, applied.sequence), /prefix_invalid/);
  const conflict = { ...buildCentralAdvisoryRecord({ ...value, uncertainty: "A different payload for the same original applied decision" }), sequence: fact.sequence + 1 };

  assert.throws(() => readCentralAdvisoryRecords([...f.facts, conflict], scope, conflict.sequence), /decision_conflict/);
  assert.deepEqual(readCentralAdvisoryRecords(f.facts, "workspace:other", fact.sequence), []);
  assert.equal(readCentralAdvisory(f.board(), scope, {
    ref: centralAdvisoryId(scope, `${value.intentId}:other`, value.knowledgeHash), version: fact.id,
  }), undefined);
  assert.notEqual(centralAdvisoryKnowledgeHash(entry), centralAdvisoryKnowledgeHash({ ...entry, sourceRefs: [...entry.sourceRefs, "source:second"] }));
});

