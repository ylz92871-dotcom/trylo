import assert from "node:assert/strict";
import test from "node:test";
import { feedbackInquiryFixture } from "../testing/feedback-inquiry-fixture.js";
import { createToolLearningFunding } from "./learning-funding.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { nextToolLearningDispatch, resultForJob } from "./pipeline-queue.js";
import { recordAndScheduleToolTaskFeedback } from "./feedback-learning.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";

test("typed planning failures retain a funded evidence baseline and only real external evidence wakes the same task", async t => {
  const f = await feedbackInquiryFixture(t), first = await f.report("first-turn", "first-feedback"), jobId = String(first.jobId);
  const funding = createToolLearningFunding({ boardRoot: f.root, scope: f.scope, now: f.now });
  let calls = 0;
  const services: ToolPipelineServices = { allowance: plan => funding.allowance(plan), releaseAllowance: () => funding.release(),
    context: async () => ({ availableTools: [], requirements: [] }),
    plan: async context => {
      const id = `controlled-call-${++calls}`;
      assert.ok((await funding.reserve(id, 512)).ok);
      assert.ok((await funding.settle(id, { kind: "reported", inputTokens: 50, outputTokens: 50, totalTokens: 100, model: "TEST ONLY" })).ok);
      if (calls === 1) return { action: "defer", reason: "more_evidence" }; // A typed decoder rejection, not a provider retry.
      assert.ok(context.requirements.some(row => row.text.includes("actual user correction")));
      return { action: "defer", reason: "not_worthwhile", neededEvidence: [], rationale: "TEST ONLY", existingInsufficiency: "TEST ONLY",
        expectedBenefit: "unproven", constructionCost: "TEST ONLY", alternatives: [] };
    }, search: async () => { assert.fail("no public research is needed for this baseline test"); },
    evolve: async () => { assert.fail("a failed planning contract never starts source generation"); } };
  const work = () => workToolLearningPipeline({ boardRoot: f.root, scope: f.scope, now: f.now, services,
    mode: "after_turn", jobIds: [jobId], signal: new AbortController().signal });
  const rejected = await work();
  assert.ok(rejected.ok);
  assert.equal(rejected.results[0]?.code, "invalid_learning_decision");
  const waiting = await f.state(), result = resultForJob(waiting, jobId, 1);
  assert.ok(result);
  assert.equal(result.outcome, "waiting_evidence");
  assert.ok(result.inputFingerprint);
  assert.equal(result.inputFingerprintPolicy, 2);
  const quiet = await nextToolLearningDispatch(f.root, f.scope, false, [jobId]);
  assert.ok(quiet.ok);
  assert.equal(quiet.jobId, undefined,
    "initial grant creation and the result's own bookkeeping are already in its baseline");
  assert.ok((await work()).ok);
  assert.equal(calls, 1);
  const feedback = await recordAndScheduleToolTaskFeedback(f.root, { schemaVersion: 1, feedbackId: "actual-correction", versionId: f.parentVersionId,
    sessionId: "session", taskId: "external-turn", useIds: ["use-1"], situation: "one task", evidenceRefs: ["user:actual-correction"], source: "user",
    outcome: "unsolved", attribution: "implementation", recommendation: "improve", summary: "An actual user correction supplies independently grounded task text." }, new Date(f.now()).toISOString());

  assert.ok(feedback.ok);
  assert.equal(feedback.learning.kind, "queued");
  const ready = await nextToolLearningDispatch(f.root, f.scope, false, [jobId]);
  assert.ok(ready.ok);
  assert.equal(ready.jobId, jobId);
  assert.ok((await work()).ok);
  assert.equal(calls, 2);
  const final = await f.state();
  assert.equal(final.centralLearningGrants?.length, 1);
  assert.equal(centralLearningSpent(final.centralLearningGrants![0]!).calls, 2);
  assert.equal(final.jobs.find(job => job.jobId === final.centralLearningGrants![0]!.jobId)?.attempt, 2,
    "inspection of an already bound allowance does not open a fresh claim in the same worker attempt");
});
