import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../../learning/control/hash.js";
import { emptyBoardState } from "../../learning/control/state.js";
import type { RewardV2Fact } from "../../learning/reward/v2-facts.js";
import type { CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import { buildCentralOrganizationRecallQuery } from "./runtime-organization-query.js";
import { readCentralPurposeMemory } from "./runtime-purpose-memory.js";

const scope = "workspace:purpose-memory", signal = new AbortController().signal;
const intent = (index: number, goalState: "open" | "answered" | "withdrawn" = "open"): CentralLearningIntentDraft => ({
  intentId: `intent:past:${index}`, subject: { plane: "central", questionRef: `intent:past:${index}` },
  goal: index === 11 ? "先查工具参数契约和路径规范，再决定是否改写流程" : `研究版面字体${index}`,
  rationale: "原业务事实支持保留这个研究问题", conditions: ["条件必须由新实际资料核对"], knowledge: [],
  residual: ["尚未识别参数边界"], commitment: { purpose: "区分原假设", assumptions: [], reconsiderWhen: ["新路径解析资料到来"] },
  revisionReason: "暂时停止投入，目的尚未解答", sourceRefs: [`old-business:${index}`],
  continuation: { kind: "ended", goalState, reason: "本次不继续花费；这不是已解答" } });

function archive() {
  const state = { ...emptyCentralRuntimeState(scope), intents: Array.from({ length: 12 }, (_, index) => intent(index, index === 10 ? "withdrawn" : "open")) };
  const first = buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state, reason: "original ended purposes", sourceRefs: [] });
  const second = buildCentralRuntimeRecord({ previousRef: first.id, state: emptyCentralRuntimeState(scope), reason: "compacted original bodies", sourceRefs: [] });
  const facts: RewardV2Fact[] = [{ ...first, sequence: 1 }, { ...second, sequence: 2 }];
  return { facts, scope, boardSequence: 2 };
}

test("a new successful business task with no active subject revisits the original open purpose through the actual source reader", async () => {
  const original = archive();
  const material = { ref: "business:new-path", kind: "source" as const,
    text: "新任务成功读取了路径；需要比较工具参数约束与目录解析，避免重复改写流程。", sourceRefs: ["business:new-task"] };
  const source = createCentralRuntimeSource({ boardRoot: "unused", scope, ports: [], enabled: () => true,
    board: { async load() { return { ok: true as const, state: { ...emptyBoardState(), sequence: 2, rewardV2Facts: original.facts }, generation: 1 }; } },
    peerSources: [{ async snapshot() { return { boardSequence: 2, opportunities: [], materials: [material], sourceRefs: [material.ref] }; },
      async read() { return [material]; }, owns: (_scope, ref) => ref === material.ref }] });
  const snapshot = await source.snapshot(scope, signal, { subjects: [], sourceRefs: [] });
  const remembered = snapshot.materials.find(row => row.ref.startsWith("central-runtime-purpose-navigation:"));

  assert.ok(remembered, "a compacted open purpose must remain discoverable without an identical active central questionRef");
  const body: unknown = JSON.parse(remembered.text);

  assert.ok(typeof body === "object" && body !== null && "entries" in body && Array.isArray(body.entries));
  const first = body.entries[0];

  assert.equal(first.intentId, "intent:past:11");
  assert.equal(first.goalState, "open");
  const read = await source.read(scope, [first.readRef], 16000, signal);

  assert.deepEqual(JSON.parse(read[0]!.text).value, intent(11));
  const deliveredOriginal = snapshot.materials.find(row => row.ref === first.readRef);

  assert.ok(deliveredOriginal, "a related bounded open purpose must be actually readable in this first agenda without inventing another inspection intent");
  assert.deepEqual(deliveredOriginal, read[0]);
  assert.ok(!snapshot.sourceRefs.includes(remembered.ref), "archive navigation is not new original evidence or a self-wake");
  const stable = await source.snapshot(scope, signal, { subjects: [], sourceRefs: snapshot.sourceRefs });

  assert.deepEqual(stable.sourceRefs, snapshot.sourceRefs);
  const query = buildCentralOrganizationRecallQuery({ state: emptyCentralRuntimeState(scope), opportunities: [], materials: [material] });

  assert.match(query.purpose, /参数约束/);
  assert.ok(query.sourceRefs.includes("business:new-task"));
  assert.notEqual(query.purpose, "Organize the remaining authorized learning purposes.");
});

test("bounded original purpose browsing exposes withdrawn status and advances without a new store", () => {
  const original = archive(), seen = new Set<string>();
  let ref: string | null = "central-runtime-purpose-catalog:0", pages = 0;

  while (ref !== null) {
    const material = readCentralPurposeMemory(original, ref);
    assert.ok(material);
    const body = JSON.parse(material.text) as { entries: { intentId: string; goalState: string; resumableFromNewFacts: boolean; readRef: string }[]; nextReadRef: string | null };

    assert.ok(material.text.length <= 12000);

    for (const item of body.entries) {
      assert.ok(!seen.has(item.intentId));
      seen.add(item.intentId);
      if (item.intentId === "intent:past:10") {
        assert.equal(item.goalState, "withdrawn");
        assert.equal(item.resumableFromNewFacts, false);
        assert.equal(canonicalJson(JSON.parse(readCentralPurposeMemory(original, item.readRef)!.text).value), canonicalJson(intent(10, "withdrawn")));
      }
    }

    ref = body.nextReadRef;
    pages++;
    assert.ok(pages < 5);
  }

  assert.equal(seen.size, 12);
});
