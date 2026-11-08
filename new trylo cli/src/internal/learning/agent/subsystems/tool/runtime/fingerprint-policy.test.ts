import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeToolLearningResult } from "../domain/evolution/pipeline.js";
import { recordOf } from "../domain/evolution/parse.js";
import { feedbackInquiryFixture } from "../testing/feedback-inquiry-fixture.js";
import { planForJob, resultForJob, waitingToolJobReady } from "./pipeline-queue.js";

test("new fingerprint policy wakes for real host facts while legacy hash differences require explicit manual work", async t => {
  const f = await feedbackInquiryFixture(t), first = await f.report("first", "first-feedback");
  await f.work("waiting_evidence");
  const before = await f.state(), jobId = String(first.jobId), plan = planForJob(before, jobId);
  assert.ok(plan);
  const result = resultForJob(before, jobId, 1);
  assert.ok(result);
  assert.equal(result.inputFingerprintPolicy, 2);
  assert.equal(waitingToolJobReady(before, before.jobs.find(job => job.jobId === jobId)!, plan, "after_turn", false), false);
  await f.useTool();
  const actual = await f.state(), job = actual.jobs.find(row => row.jobId === jobId)!;

  assert.equal(waitingToolJobReady(actual, job, plan, "after_turn", false), true, "new policy observes the genuinely new immutable use");
  const legacy = { ...actual, assets: actual.assets.map(asset => {
    if (!recordOf(asset.content) || asset.content.type !== "tool_learning_result" || asset.content.jobId !== jobId) return asset;
    const { inputFingerprintPolicy: _policy, ...content } = asset.content;
    return { ...asset, content, contentHash: contentHashOf(content) };
  }) };
  const read = resultForJob(legacy, jobId, 1);
  assert.ok(read);
  assert.equal(Object.hasOwn(read, "inputFingerprintPolicy"), false);
  assert.equal(waitingToolJobReady(legacy, job, plan, "after_turn", false), false, "a changed formula does not silently pay for legacy work");
  assert.equal(waitingToolJobReady(legacy, job, plan, "manual", false), true, "explicit manual work uses the same quota and frozen task");
  assert.equal(decodeToolLearningResult({ ...read, inputFingerprintPolicy: 3 }), undefined);
  assert.equal(decodeToolLearningResult({ ...read, inputFingerprint: undefined, inputFingerprintPolicy: 2 }), undefined);
  assert.deepEqual((await f.state()).centralLearningGrants, before.centralLearningGrants, "the read-only legacy check issued no replacement grant");
});
