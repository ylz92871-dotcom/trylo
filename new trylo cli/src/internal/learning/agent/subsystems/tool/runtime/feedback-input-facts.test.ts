import assert from "node:assert/strict";
import test from "node:test";
import { feedbackInquiryFixture } from "../testing/feedback-inquiry-fixture.js";
import { openToolCandidateUse } from "./evolution-use.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { recordToolTaskFeedback } from "./tool-task-feedback.js";
import { toolLearningFeedbackScope } from "./feedback-input-facts.js";
import { toolLearningFeedbackRequirements, toolLearningPriorVersions } from "./learning-context.js";
import { planForJob } from "./pipeline-queue.js";
import { prepareToolImprovement } from "./evolution-trials.js";

test("exact source-workspace feedback reaches automatic context and generation without importing another workspace's oracle", async t => {
  const f = await feedbackInquiryFixture(t);
  // Both workspace mounts precede feedback. The normal mount's guidance
  // reader intentionally refuses a foreign history rather than importing it.
  const foreign = await openToolCandidateUse({ boardRoot: f.root, versionId: f.parentVersionId, sessionId: "foreign-session", workspaceId: "foreign-workspace",
    now: f.now, newId: () => "foreign-use", warn: () => {}, executor: { execute: async () => ({ kind: "value", value: 4 }) } });
  assert.ok(foreign.ok, JSON.stringify(foreign));
  t.after(foreign.mount.close);
  assert.equal((await foreign.mount.tools.execute({ name: foreign.mount.binding.name, toolCallId: "foreign-call", arguments: { input: 2 } }, new AbortController().signal)).outcome, "result");
  const first = await f.report("own-turn", "own-question"), initial = await f.state();
  const plan = planForJob(initial, String(first.jobId));
  assert.ok(plan);
  const feedback = { schemaVersion: 1, versionId: f.parentVersionId, taskId: "external-task", situation: "batch", evidenceRefs: ["user:explicit"],
    source: "user", outcome: "unsolved", attribution: "implementation", recommendation: "improve" };

  assert.ok((await recordToolTaskFeedback(f.root, { ...feedback, feedbackId: "foreign-external", sessionId: "foreign-session", useIds: ["foreign-use"], summary: "FOREIGN_ORACLE_SENTINEL" }, new Date(f.now()).toISOString())).ok);
  assert.ok((await recordToolTaskFeedback(f.root, { ...feedback, feedbackId: "own-external", sessionId: "session", useIds: ["use-1"], summary: "OWN_EXTERNAL_REQUIREMENT" }, new Date(f.now()).toISOString())).ok);
  const state = await f.state(), scoped = toolLearningFeedbackScope(state, plan);
  assert.ok(scoped.ok);
  assert.equal(scoped.historyScope, "bound");
  assert.equal(scoped.workspaceId, "workspace");
  assert.equal(scoped.uses.some(use => use.useId === "foreign-use"), false);
  const requirements = toolLearningFeedbackRequirements(state, plan);
  assert.ok(requirements.ok);
  assert.ok(requirements.requirements.some(row => row.text.includes("OWN_EXTERNAL_REQUIREMENT")));
  assert.equal(JSON.stringify(requirements).includes("FOREIGN_ORACLE_SENTINEL"), false);
  const parents = toolLearningPriorVersions(state, plan);
  assert.ok(parents.ok);
  assert.equal(JSON.stringify(parents).includes("FOREIGN_ORACLE_SENTINEL"), false);
  const source = await readToolEvolutionCandidate(f.root, f.parentVersionId);
  assert.ok(source.ok);
  const prepared = await prepareToolImprovement(f.root, f.parentVersionId, source.artifact.request, plan);
  assert.ok(prepared.ok);
  assert.ok(prepared.feedback?.includes("OWN_EXTERNAL_REQUIREMENT"));
  assert.equal(prepared.feedback?.includes("FOREIGN_ORACLE_SENTINEL"), false);
  const unbound = { ...plan, trigger: { ...plan.trigger, proposalKey: "unbound-history", evidenceRefs: [] } };
  const unknown = toolLearningFeedbackScope(state, unbound);
  assert.ok(unknown.ok);
  assert.equal(unknown.historyScope, "unknown");
  assert.deepEqual(unknown.entries, []);
  const missing = toolLearningFeedbackRequirements(state, unbound);
  assert.ok(missing.ok);
  assert.deepEqual(missing.requirements, []);
  const historical = toolLearningPriorVersions(state, unbound);
  assert.ok(historical.ok);
  assert.match(historical.versions[0]!.feedback, /workspace is unknown/);
});
