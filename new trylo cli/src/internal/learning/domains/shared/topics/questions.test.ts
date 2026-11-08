import test from "node:test";
import assert from "node:assert/strict";
import { readTopicSubmission } from "./submission.js";
import { prepareTopicOpportunity } from "./opportunity.js";
import { createPersistentTopicIntake } from "../../../../integration/learning-topics/intake.js";
import { createBoardReader } from "../../../../adapters/learning-store/file-event-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const windowJson = JSON.stringify({ schemaVersion: 1, domain: "prompt", scope: "question-contract", boardSequence: 0,
  watermarks: [{ runId: "local", throughSequence: 1 }], records: [{ ref: "empty-input", runId: "local", sequence: 1,
    scope: "question-contract", origin: "checker_result", text: "空列表时取首元素失败，空输入的预期返回约定尚未确定。" }] });
const question = { schemaVersion: 2, question: "空输入的返回约定应当是什么？", whenRelevant: "处理可能为空的集合前",
  expectedChange: "先确定空输入合同再选择边界处理", citations: [{ evidenceRef: "empty-input", quote: "空输入的预期返回约定尚未确定" }] };

test("an evidence-grounded unanswered question needs no invented explanation or executable experiment", () => {
  const result = readTopicSubmission(JSON.stringify(question), windowJson);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "topic") throw new Error("question_not_admitted");
  const topic = result.value.topic;
  assert.equal(topic.schemaVersion, 2);
  assert.equal(topic.status, "grounded_question");
  assert.equal(topic.question, question.question);
  assert.equal("alternatives" in topic, false);
  assert.equal("discriminator" in topic, false);
  assert.ok(Object.isFrozen(topic));
  assert.ok(Object.isFrozen(topic.citations[0]));
});

test("a question without a trusted numerical model remains unvalued", () => {
  assert.deepEqual(prepareTopicOpportunity({ proposals: [JSON.stringify(question)], windowJson, modelJson: null,
    utilityUnit: "explicit-goal", quotaUnit: "approved-experiment", maxQuota: 2 }), { status: "unvalued", reason: "topic_model_required" });
});

test("question admission retains exact quotation and cannot promote model-only text into evidence", () => {
  assert.deepEqual(readTopicSubmission(JSON.stringify({ ...question, citations: [{ evidenceRef: "empty-input", quote: "已经证明原因" }] }), windowJson),
    { ok: false, reason: "topic_quote_missing" });
  const modelWindow = JSON.parse(windowJson);
  modelWindow.records[0].origin = "model_proposal";
  assert.deepEqual(readTopicSubmission(JSON.stringify(question), JSON.stringify(modelWindow)), { ok: false, reason: "topic_self_support_only" });
});

test("the question format cannot carry model numbers, authority or undeclared hypotheses", () => {
  for (const field of ["score", "prior", "permission", "domain", "scope", "alternatives", "discriminator"]) {
    assert.deepEqual(readTopicSubmission(JSON.stringify({ ...question, [field]: "invented" }), windowJson), { ok: false, reason: "topic_shape_invalid" });
  }
});

test("a minimal question persists on the same Board and can be revalidated without manufacturing an answer", async t => {
  const boardRoot = await mkdtemp(path.join(os.tmpdir(), "trylo-question-intake-"));
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const intake = createPersistentTopicIntake({ boardRoot, scope: "question-contract", domain: "prompt", algorithmVersion: "question-v2", enabled: () => true });
  const stored = await intake.ingest(JSON.stringify(question), windowJson);
  assert.equal(stored.status, "persisted");
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const fact = loaded.state.rewardV2Facts?.[0];
  assert.ok(fact);
  const body = JSON.parse(fact.payloadJson);

  assert.equal(body.proposal.schemaVersion, 2);
  assert.equal("modelJson" in body, false);
  assert.equal("answer" in body.proposal, false);
  const replayed = readTopicSubmission(JSON.stringify(body.proposal), JSON.stringify(body.evidenceWindow));
  assert.equal(replayed.ok, true);
  assert.equal((await intake.ingest(JSON.stringify(question), windowJson)).status, "persisted");
  const retried = await createBoardReader(boardRoot).load();
  assert.ok(retried.ok);
  if (!retried.ok) return;

  assert.equal(retried.state.sequence, 1);
  assert.equal(retried.state.rewardV2Facts?.length, 1);
});
