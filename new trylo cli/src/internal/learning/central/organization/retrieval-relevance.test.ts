import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieveOrganizationExperience, retrieveLegacyOrganizationExperience } from "./retrieval.js";
import { isOrganizationRecallPacket, isOrganizationRecallQuery } from "./validation.js";
import { buildOrganizationRecord, readOrganizationRecords } from "./records.js";
import type { OrganizationDecision, OrganizationFeedback, OrganizationKnowledge, OrganizationProjection, OrganizationRecallQuery, OrganizationStored } from "./contracts.js";

function fixture(): OrganizationProjection {
  const decisions: OrganizationStored<OrganizationDecision>[] = [], feedback: OrganizationStored<OrganizationFeedback>[] = [];
  const knowledge: OrganizationStored<OrganizationKnowledge>[] = [];

  for (let index = 0; index < 12; index++) {
    const id = String(index).padStart(2, "0"), decisionRef = `decision:${id}`, factId = `feedback:${id}`;

    decisions.push({ factId: decisionRef, sequence: index * 3 + 1, value: { kind: "decision", decisionRef, purposeRef: `intent:${id}`,
      context: { purpose: index === 11 ? "先区分路径解析错误和工具参数边界，再决定是否修改流程" : "研究字体字号和页面排版",
        conditionKeys: ["plane:agent", "domain:tool"], known: ["仅有源报告"], residual: ["业务后效仍待观察"] },
      program: { programRef: `program:${id}`, depth: "bounded", timing: "now" }, expectation: { change: "检验原假设", uncertainties: [] },
      alternatives: [], issueRefs: [], stageRefs: [], sourceRefs: [`business:old:${id}`], experienceUse: null } });
    feedback.push({ factId, sequence: index * 3 + 2, value: { kind: "feedback", decisionRef, unitRef: `observation:${id}`,
      supersedes: null, sourceRefs: [`business:old:${id}`], result: { kind: "outcome", state: "unknown", summary: "原后效未知",
        exposureRef: null, attribution: "unknown" } } });
    knowledge.push({ factId: `knowledge:${id}`, sequence: index * 3 + 3, value: { kind: "knowledge", knowledgeId: `practice:${id}`, supersedes: null,
      statement: index === 11 ? "工具参数契约未清楚时先研究路径规范，避免直接重写流程" : `版面字体调整方案${id}`,
      conditions: "仅供有界调查组织参考", conditionKeys: ["plane:agent", "domain:tool"],
      exceptions: "若原参数契约已经得到证明，应改查其他原因", exceptionKeys: ["contract-known"], implication: "先查可区分假设的证据",
      supportFactIds: [factId], counterexampleFactIds: [], state: "proposed" } });
  }

  const original = feedback[11]!;
  const corrected: OrganizationStored<OrganizationFeedback> = { ...original, factId: "feedback:11:corrected", sequence: 50,
    value: { ...original.value, supersedes: original.factId, sourceRefs: ["business:corrected"],
      result: { kind: "outcome", state: "unknown", summary: "纠正：无法确认原改进造成减少返工", exposureRef: null, attribution: "unknown" } } };
  const contrary: OrganizationStored<OrganizationFeedback> = { factId: "feedback:11:contrary", sequence: 51,
    value: { kind: "feedback", decisionRef: "decision:11", unitRef: "counterexample:11", supersedes: null,
      sourceRefs: ["business:counterexample"], result: { kind: "correction", statement: "原参数契约已成立时，重复研究工具会浪费投入", conditions: "原契约已验证" } } };
  const target = knowledge[11]!;

  knowledge[11] = { ...target, value: { ...target.value, counterexampleFactIds: [contrary.factId] } };

  return { scope: "repo:retrieval", decisions, feedback: [...feedback.slice(0, 11), corrected, contrary],
    feedbackHistory: [...feedback, corrected, contrary], knowledge };
}

test("new-source paraphrased purpose reaches related experience beyond eight generic matches with corrections intact", () => {
  const view = fixture(), packet = retrieveOrganizationExperience(view, { purpose: "遇到新路径解析问题，先查参数契约，避免重复改写流程",
    conditionKeys: ["plane:agent", "domain:tool"], sourceRefs: ["business:new"], maximumEntries: 8, maximumCharacters: 32768 });
  const target = packet.entries.find(entry => entry.factId === "knowledge:11");

  assert.ok(target, "a relevant later experience must not be hidden behind eight generic plane/domain matches");
  assert.equal(packet.entries[0]?.factId, "knowledge:11");
  assert.equal(target.knowledge.exceptions, "若原参数契约已经得到证明，应改查其他原因");
  assert.deepEqual(target.matchedConditions, ["plane:agent", "domain:tool"]);
  assert.ok(target.evidence.some(row => row.factId === "feedback:11:contrary"));
  assert.ok(target.evidence.some(row => row.factId === "feedback:11:corrected" && row.value.result.kind === "outcome" && row.value.result.state === "unknown"));
  assert.deepEqual(target.evidenceRevisions, [{ citedFactId: "feedback:11", effectiveFactId: "feedback:11:corrected" }]);
  const textOnly = retrieveOrganizationExperience(view, { ...packet.query, conditionKeys: [] });

  assert.equal(textOnly.entries[0]?.factId, "knowledge:11");
  assert.deepEqual(textOnly.entries[0]?.missingConditions, ["plane:agent", "domain:tool"]);
});

test("bounded stateless continuation reaches remaining heads without repeating a page", () => {
  const view = fixture(), query = { purpose: "研究经验", conditionKeys: ["plane:agent", "domain:tool"], sourceRefs: [],
    maximumEntries: 8, maximumCharacters: 32768 };
  const first = retrieveOrganizationExperience(view, query), next = first.navigation?.nextQuery;

  assert.ok(next);
  assert.equal(first.entries.length, 8);
  assert.equal(first.navigation?.remainingEntries, 4);
  assert.equal(isOrganizationRecallPacket(first), true);
  assert.equal(isOrganizationRecallQuery(next), true);
  const second = retrieveOrganizationExperience(view, next);

  assert.equal(second.entries.length, 4);
  assert.equal(second.navigation?.nextQuery, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(row => row.factId)).size, 12);
  assert.equal(next.offset, 8);
  assert.ok(first.materialJson.includes('"offset":8'), "continuation must reach the model, not only a host side field");
  assert.ok(first.materialJson.includes("same original cost unitRef once across decisions"));
  const empty = retrieveOrganizationExperience(view, { ...query, maximumCharacters: 512 });

  assert.equal(empty.entries.length, 0);
  assert.equal(empty.navigation?.nextQuery, null);
  assert.ok(empty.materialJson.length <= 512);
  assert.ok(empty.materialJson.includes("Refine purpose"));
  const deliveredHeads = new Set<string>();
  let boundedQuery: OrganizationRecallQuery = { ...query, maximumCharacters: 3000 };

  for (let page = 0; page < 12; page++) {
    const bounded = retrieveOrganizationExperience(view, boundedQuery);

    assert.ok(bounded.materialJson.length <= 3000);
    const actualHeads = [...bounded.entries.map(entry => entry.factId), ...(bounded.knowledgeBodyRequired ?? []).map(row => row.factId)];

    assert.ok(actualHeads.length > 0, "a page must deliver a full head or its exact-read directory before advancing");

    for (const factId of actualHeads) {
      assert.ok(!deliveredHeads.has(factId));
      deliveredHeads.add(factId);
    }

    if (bounded.navigation?.nextQuery === null) break;

    assert.ok(bounded.navigation?.nextQuery);
    boundedQuery = bounded.navigation.nextQuery;
  }

  assert.equal(deliveredHeads.size, view.knowledge.length, "capacity may not advance past heads whose body and directory both did not fit");
  assert.equal(isOrganizationRecallQuery({ ...query, offset: 4096 }), true);
  assert.equal(isOrganizationRecallQuery({ ...query, offset: 4097 }), false);
  const oversized = fixture(), target = oversized.knowledge[11]!;
  const longTarget = { ...target, value: { ...target.value, statement: `${target.value.statement}${"参数契约".repeat(900)}` } };
  const advanced = retrieveOrganizationExperience({ ...oversized, knowledge: [...oversized.knowledge.slice(0, 11), longTarget] },
    { ...query, purpose: "路径参数契约", maximumEntries: 1, maximumCharacters: 3000 });

  assert.equal(advanced.entries.length, 1);
  assert.equal(advanced.navigation?.nextQuery?.offset, 2, "capacity-skipped candidate also advances the continuation position");
  assert.ok(advanced.materialJson.includes('"omittedForCapacity":1'));
});

test("historical packets without navigation retain their original identity during decision replay", () => {
  const decision = fixture().decisions[0]!.value;
  const initial = buildOrganizationRecord("repo:legacy", decision);
  const first = { ...initial, sequence: 1 }, before = readOrganizationRecords([first], "repo:legacy", 1);
  const query = { purpose: "Original purpose", conditionKeys: [], sourceRefs: [], maximumEntries: 8, maximumCharacters: 32768 };
  const legacy = retrieveLegacyOrganizationExperience(before, query);

  assert.equal(Object.hasOwn(legacy, "navigation"), false);
  assert.equal(isOrganizationRecallPacket(legacy), true);
  const next = buildOrganizationRecord("repo:legacy", { ...decision, decisionRef: "decision:legacy-consumer",
    experienceUse: { packet: legacy, deliveryRef: "provider:original-delivery", changes: [] } });

  assert.equal(readOrganizationRecords([first, { ...next, sequence: 2 }], "repo:legacy", 2).decisions.length, 2);
});
