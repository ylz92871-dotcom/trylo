import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { CentralLearningIntentDraft, CentralRuntimeMaterial, CentralLearningRuntimeState } from "../../learning/central/runtime/contracts.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef,
  readCentralRuntimePurposeIndex, readCentralRuntimeRecords } from "../../learning/central/runtime/records.js";
import { readCentralPurposeMemory, recallCentralPurposeMemory, recallCentralPurposeMaterials } from "./runtime-purpose-memory.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";

const scope = "repo:purpose-stability";
const original: CentralLearningIntentDraft = { intentId: "intent:path-contract", subject: { plane: "central", questionRef: "intent:path-contract" },
  goal: "研究工具参数与路径规范", rationale: "区分参数边界假设", conditions: ["以真实路径解析材料核对"], knowledge: [],
  residual: ["路径参数契约尚不清楚"], commitment: { purpose: "查清边界", assumptions: [], reconsiderWhen: ["新路径事实到来"] },
  revisionReason: "本次投入停止但问题仍开放", sourceRefs: ["business:original"],
  continuation: { kind: "ended", goalState: "open", reason: "待新事实" } };

function append(facts: readonly RewardV2Fact[], state: CentralLearningRuntimeState): readonly RewardV2Fact[] {
  const fact = buildCentralRuntimeRecord({ previousRef: facts.at(-1)?.id ?? initialCentralRuntimeRef(scope), state,
    reason: `snapshot:${facts.length + 1}`, sourceRefs: [] });
  return [...facts, { ...fact, sequence: facts.length + 1 }];
}

const archive = (facts: readonly RewardV2Fact[]) => ({ facts, scope, boardSequence: facts.length });

function navigationEntry(facts: readonly RewardV2Fact[]) {
  const material = readCentralPurposeMemory(archive(facts), "central-runtime-purpose-catalog:0");
  assert.ok(material);
  const body = JSON.parse(material.text) as { entries: { readRef: string; goalState: string; resumableFromNewFacts: boolean }[] };
  return body.entries[0]!;
}

test("original successful task text is recalled after many navigation notices without a native issue", () => {
  const facts = append([], { ...emptyCentralRuntimeState(scope), intents: [original] });
  const notices: CentralRuntimeMaterial[] = Array.from({ length: 20 }, (_, index) => ({
    ref: `central-runtime-catalog:${index}`, kind: "source", text: "版面字体字号".repeat(1800), sourceRefs: [`notice:${index}`] }));

  notices.push({ ref: "notice:pa", kind: "source", text: canonicalJson({ role: "PA_current_constraint_not_business_evidence",
    summary: "版面字体字号".repeat(1000) }), sourceRefs: ["notice:pa"] });
  notices.push({ ref: "business:new-success", kind: "source", text: "成功任务提供了新的工具参数约束和路径解析证据。", sourceRefs: ["business:new"] });
  const recalled = recallCentralPurposeMemory({ ...archive(facts), materials: notices, subjects: [] });

  assert.ok(recalled, "actual late-position task text must not be crowded out by navigation catalogs");
  assert.match(recalled.text, /intent:path-contract/);
  const longGoal = { ...original, goal: "不相关版面字号".repeat(2000) };
  const longFacts = append([], { ...emptyCentralRuntimeState(scope), intents: [longGoal] });

  assert.ok(recallCentralPurposeMemory({ ...archive(longFacts), materials: [notices.at(-1)!], subjects: [] }),
    "each original residual/condition field remains searchable after a long goal");
});

test("original body addresses survive unrelated snapshots and later withdrawal without changing their material identity", () => {
  const state = { ...emptyCentralRuntimeState(scope), intents: [original] }, first = append([], state);
  const oldRef = navigationEntry(first).readRef, oldBody = readCentralPurposeMemory(archive(first), oldRef);
  assert.ok(oldBody);
  const second = append(first, { ...state, consumedSourceRefs: ["unrelated:notice"] });

  assert.deepEqual(readCentralPurposeMemory(archive(second), oldRef), oldBody);
  assert.equal(navigationEntry(second).readRef, oldRef);
  assert.equal(readCentralRuntimePurposeIndex(second, scope, 2)[0]?.factRef, first[0]?.id);
  assert.equal(readCentralRuntimeRecords(second, scope, 2).history.endedIntents[0]?.factRef, first[0]?.id);
  const withdrawn: CentralLearningIntentDraft = { ...original, revisionReason: "用户撤回原目的",
    continuation: { kind: "ended", goalState: "withdrawn", reason: "用户撤回，不再授权推进" } };
  const third = append(second, { ...state, intents: [withdrawn] });

  assert.deepEqual(readCentralPurposeMemory(archive(third), oldRef), oldBody, "old exact source remains the old body, not dynamic current state");
  const current = navigationEntry(third);

  assert.notEqual(current.readRef, oldRef);
  assert.equal(current.goalState, "withdrawn");
  assert.equal(current.resumableFromNewFacts, false);
  assert.equal(readCentralRuntimeRecords(third, scope, 3).history.endedIntents[0]?.goalState, "withdrawn");
  assert.notEqual(readCentralRuntimeRecords(third, scope, 3).history.endedIntents[0]?.factRef, first[0]?.id);
  const olderIssuedRef = `central-runtime-purpose-record:${contentHashOf([original.intentId, second[1]!.id])}`;

  assert.deepEqual(JSON.parse(readCentralPurposeMemory(archive(third), olderIssuedRef)!.text).value, original,
    "also resolve a locator issued by the old snapshot-based index from its verified original fact");
});

test("knowledge-only terms recall conditional originals through bounded non-evidence previews without reviving withdrawal", () => {
  const learned: CentralLearningIntentDraft = { ...original,
    knowledge: [
      { statement: "quoraclitopshape " + "original statement detail ".repeat(12),
        conditions: "zunariscopefilter " + "original condition detail ".repeat(12), sourceRefs: ["business:lesson"] },
      { statement: "A separate retained observation.", conditions: "Only under its original conditions.", sourceRefs: ["business:lesson"] },
      { statement: "A third retained observation.", conditions: "Read the original before reuse.", sourceRefs: ["business:lesson"] },
    ], continuation: { kind: "ended", goalState: "withdrawn", reason: "User withdrew further investment; the original record remains." } };
  const first = append([], { ...emptyCentralRuntimeState(scope), intents: [learned] });
  const facts = append(first, emptyCentralRuntimeState(scope)), originalBytes = facts.map(row => row.payloadJson);

  for (const term of ["quoraclitopshape", "zunariscopefilter"]) {
    const query = { ...archive(facts), subjects: [], materials: [{ ref: `business:new:${term}`, kind: "source" as const,
      text: term, sourceRefs: [`business:new:${term}`] }] };
    const navigation = recallCentralPurposeMemory(query);

    assert.ok(navigation, "a term found only in learned statement or conditions must recall its original purpose");
    const item = JSON.parse(navigation.text).entries[0];

    assert.equal(item.intentId, learned.intentId);
    assert.equal(item.goalState, "withdrawn");
    assert.equal(item.resumableFromNewFacts, false);
    assert.equal(item.knowledgePreview.role, "navigation_preview_not_original_body");
    assert.equal(item.knowledgePreview.available, 3);
    assert.equal(item.knowledgePreview.shown, 2);
    assert.equal(item.knowledgePreview.omitted, 1);
    const preview = item.knowledgePreview.entries[0];

    assert.match(preview.statement.text, /^quoraclitopshape /);
    assert.match(preview.conditions.text, /^zunariscopefilter /);
    assert.ok(preview.statement.omittedChars > 0);
    assert.ok(preview.conditions.omittedChars > 0);
    assert.ok(preview.statement.text.length <= 128);
    assert.ok(preview.conditions.text.length <= 128);
    assert.ok(navigation.text.length <= 12000);
    assert.ok(isCentralUnreadNavigationMaterial(navigation));
    const complete = readCentralPurposeMemory(archive(facts), item.readRef);
    assert.ok(complete);
    assert.deepEqual(JSON.parse(complete.text).value, learned, "preview truncation must not truncate the original read");
    assert.ok(recallCentralPurposeMaterials(query).every(row => row.ref !== complete.ref),
      "a withdrawn purpose may be discovered, but must not be automatically delivered as an open purpose");
    assert.equal(readCentralRuntimeRecords(facts, scope, facts.length).state.intents.length, 0);
  }

  assert.deepEqual(facts.map(row => row.payloadJson), originalBytes, "recall must leave original persisted bytes unchanged");
});
