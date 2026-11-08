import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { feedbackInquiryFixture } from "../testing/feedback-inquiry-fixture.js";
import { planForJob, waitingToolJobReady } from "./pipeline-queue.js";
import { toolLearningInputFingerprint } from "./pipeline-planning.js";
import { recordToolTaskFeedback } from "./tool-task-feedback.js";
import { scheduleToolTaskFeedback, resumeToolFeedbackLearning } from "./feedback-learning.js";
import { feedbackHandoffFromBoard } from "./feedback-handoff.js";
import { selectToolFeedbackInquiry } from "./feedback-inquiry.js";

test("public feedback across turns and changed ID/text/situation/subsets reuses the exact terminal inquiry and its original central grant", async t => {
  for (const terminal of ["succeeded", "waiting_evidence", "waiting_approval"] as const) {
    const f = await feedbackInquiryFixture(t), first = await f.report("turn-one", "first-feedback");
    assert.equal(first.kind, "queued");
    assert.equal(typeof first.jobId, "string");
    await f.work(terminal);
    const before = await f.state(), jobId = String(first.jobId), plan = planForJob(before, jobId);
    assert.ok(plan);
    const beforeJob = before.jobs.find(job => job.jobId === jobId)!;
    assert.equal(beforeJob.state, terminal);
    const fingerprint = toolLearningInputFingerprint(before, plan), grants = contentHashOf(before.centralLearningGrants), dispatches = f.dispatches();

    for (const [index, useIds] of [[0, ["use-2", "use-1"]], [1, ["use-1"]]] as const) {
      const repeated = await f.report(`new-turn-${index}`, `new-feedback-${index}`, { useIds: [...useIds], situation: `different model label ${index}`,
        summary: `A different model hypothesis ${index}`, evidenceRefs: [`invented-text-reference:${index}`] });
      assert.deepEqual(repeated, { kind: "not_requested", reason: "already_scheduled", jobId });
    }

    const after = await f.state();
    assert.equal(after.jobs.filter(job => job.jobId.startsWith("tool-learning_v1_")).length, 1);
    assert.equal(contentHashOf(after.centralLearningGrants), grants);
    assert.equal(f.dispatches(), dispatches);
    assert.equal(toolLearningInputFingerprint(after, plan), fingerprint, "agent prose and its own handoffs cannot wake waiting work");

    if (terminal === "waiting_evidence") assert.equal(waitingToolJobReady(after, after.jobs.find(job => job.jobId === jobId)!, plan, "after_turn", false), false);

    assert.ok((after.centralLearningGrants ?? []).every(grant => centralLearningSpent(grant).calls > 0));
    const resumed = await resumeToolFeedbackLearning(f.root, f.scope);
    assert.ok(resumed.ok);
    assert.equal((await f.state()).jobs.length, after.jobs.length);
  }
});

test("a running inquiry keeps ownership when another public report revises the same host-use hypothesis", async t => {
  const f = await feedbackInquiryFixture(t), first = await f.report("turn-one", "first-feedback");
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const work = f.work("succeeded", async () => {
    entered();
    await gate;
  });
  t.after(() => { release(); });
  await ready;
  const before = await f.state(), repeated = await f.report("turn-two", "later-model-feedback", { useIds: ["use-1"], summary: "A new guess", situation: "renamed" });

  assert.deepEqual(repeated, { kind: "not_requested", reason: "already_scheduled", jobId: first.jobId });
  assert.equal(contentHashOf((await f.state()).centralLearningGrants), contentHashOf(before.centralLearningGrants));
  release();
  await work;
});

test("simultaneous same-fact reports and a restart before the first handoff commit converge on one canonical inquiry", async t => {
  const f = await feedbackInquiryFixture(t);
  const raw = { schemaVersion: 1, versionId: f.parentVersionId, sessionId: "session", taskId: "turn-a", useIds: ["use-1", "use-2"],
    situation: "first label", evidenceRefs: ["task:actual"], source: "model", outcome: "unsolved", attribution: "implementation", recommendation: "improve", summary: "First hypothesis" };
  const first = await recordToolTaskFeedback(f.root, { ...raw, feedbackId: "report-a" }, new Date(f.now()).toISOString());
  assert.ok(first.ok);
  const second = await recordToolTaskFeedback(f.root, { ...raw, feedbackId: "report-b", taskId: "turn-b", situation: "another label", summary: "Another wording" }, new Date(f.now()).toISOString());
  assert.ok(second.ok);
  const outcomes = await Promise.all([scheduleToolTaskFeedback(f.root, first.feedbackVersionId), scheduleToolTaskFeedback(f.root, second.feedbackVersionId)]);

  // The existing writer may refuse a simultaneous owner. Durable recovery is
  // allowed to finish that local handoff, never to issue a second inquiry.
  assert.ok(outcomes.some(outcome => outcome.kind === "queued"));
  assert.ok((await resumeToolFeedbackLearning(f.root, f.scope)).ok);
  const state = await f.state(), jobs = state.jobs.filter(job => job.jobId.startsWith("tool-learning_v1_"));
  assert.equal(jobs.length, 1);

  for (const feedbackVersionId of [first.feedbackVersionId, second.feedbackVersionId]) {
    const assigned = feedbackHandoffFromBoard(state, feedbackVersionId);
    assert.ok(assigned.ok);
    assert.equal(assigned.jobId, jobs[0]!.jobId);
  }

  // Removing only the handoff from an in-memory read simulates the committed
  // plan/absent-handoff crash window without rewriting any shared Board bytes.
  const later = await recordToolTaskFeedback(f.root, { schemaVersion: 1, feedbackId: "lost-handoff-restart", versionId: f.parentVersionId, sessionId: "session",
    taskId: "turn-later", useIds: ["use-1"], situation: "changed-again", evidenceRefs: ["task:actual"], source: "model", outcome: "unsolved",
    attribution: "implementation", recommendation: "improve", summary: "Same host facts" }, new Date(f.now()).toISOString());
  assert.ok(later.ok);
  const current = await f.state(), hypothetical = { ...current, assets: current.assets.filter(asset => !(typeof asset.content === "object" && asset.content !== null
    && "type" in asset.content && asset.content.type === "tool_feedback_learning_handoff")) };
  const plan = planForJob(state, jobs[0]!.jobId);
  assert.ok(plan);
  const selected = selectToolFeedbackInquiry(hypothetical, { plan, feedbackVersionId: later.feedbackVersionId,
    feedback: { schemaVersion: 1, feedbackId: "lost-handoff-restart", versionId: f.parentVersionId, sessionId: "session", taskId: "turn-later", useIds: ["use-1"],
      situation: "changed-again", evidenceRefs: ["task:actual"], source: "model", outcome: "unsolved", attribution: "implementation", recommendation: "improve", summary: "Same host facts" } });

  assert.ok(selected.ok);
  assert.equal(selected.existingJobId, jobs[0]!.jobId);
  const resumed = await resumeToolFeedbackLearning(f.root, f.scope);
  assert.ok(resumed.ok);
  const final = await f.state(), bound = feedbackHandoffFromBoard(final, later.feedbackVersionId);
  assert.ok(bound.ok);
  assert.equal(bound.jobId, jobs[0]!.jobId);
});

test("a new host use or an independently supplied user/verifier correction preserves the new-evidence path", async t => {
  const f = await feedbackInquiryFixture(t);
  await f.report("first", "first-feedback");
  await f.work("succeeded");
  const before = await f.state(), firstPlan = planForJob(before, before.jobs.find(job => job.jobId.startsWith("tool-learning_v1_"))!.jobId);
  assert.ok(firstPlan);
  const fingerprint = toolLearningInputFingerprint(before, firstPlan), useId = await f.useTool();

  assert.notEqual(toolLearningInputFingerprint(await f.state(), firstPlan), fingerprint);
  const novel = await f.report("second", "new-use", { useIds: [useId] });
  assert.equal(novel.kind, "queued");
  await f.work("succeeded");
  const external = await recordToolTaskFeedback(f.root, { schemaVersion: 1, feedbackId: "external-correction", versionId: f.parentVersionId,
    sessionId: "session", taskId: "third", useIds: ["use-1"], situation: "one task", evidenceRefs: ["user:correct-requirement"], source: "user", outcome: "unsolved",
    attribution: "implementation", recommendation: "improve", summary: "A genuinely independent correction to the task requirement" }, new Date(f.now()).toISOString());
  assert.ok(external.ok);
  const externalInquiry = await scheduleToolTaskFeedback(f.root, external.feedbackVersionId);
  assert.equal(externalInquiry.kind, "queued");
  assert.equal((await f.state()).jobs.filter(job => job.jobId.startsWith("tool-learning_v1_")).length, 3);
});
