import assert from "node:assert/strict";
import test from "node:test";
import type { BoardStore } from "../../../../control/store-port.js";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState, normalizeBoardState } from "../../../../control/state.js";
import { canonicalJson } from "../../../../control/hash.js";
import { createCollaborationControl } from "../control/index.js";
import { createCollaborationRuntimeReceiptWriter } from "../runtime/receipts/index.js";
import { isCollaborationEvaluation, type CollaborationEvaluation } from "../domain/evaluation.js";
import { createCollaborationExperienceStore } from "./store.js";
import { isCollaborationExperienceContent } from "./parse.js";
import type { PublishExperienceInput } from "./contracts.js";
import { experienceFeedbackInputIssues } from "../../../../control/collaboration-feedback-contract.js";
import { isLearningAction } from "../orchestration/index.js";

const NOW = "2026-11-03T18:20:00.000Z", scope = "workspace:evaluation";
const owner = { kind: "personal_agent", experienceKey: "trylo.personal_agent.v1" } as const;
const evaluation: CollaborationEvaluation = {
  schema: "collaboration-evaluation/v1", mechanism: "An explicit pending list lets the receiver continue unfinished work.",
  alternatives: [{ explanation: "The receiver lacked a necessary tool instead.", discriminator: "Check the frozen tool view and actual attempted operation." }],
  expectedObservations: [{ id: "receiver-continues", observation: "The receiver processes the pending item without redoing the committed one." }],
  reconsiderWhen: ["The receiver has a different explicit interface or cannot access the referenced artifact."],
};

async function fixture() {
  let state = emptyBoardState();
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "evaluation:owner" });
  const report = await control.report({ scope, problemKey: "pending-work", report: { reportId: "report:pending",
    source: { teamRunId: "team:evaluation", taskId: "task:original", memberId: "personal_agent" },
    facts: ["The receiver repeated a committed operation after a handoff omitted pending work."], evidenceRefs: ["artifact:handoff"] } });
  assert.ok(report.ok);
  const focus = await control.decide({ issueId: report.issue.issueId, expectedRevision: report.issue.revision,
    decision: "focused_learning", reason: "Investigate a reusable handoff improvement.", sourceRefs: ["report:pending"] });
  assert.ok(focus.ok);
  const writer = createCollaborationRuntimeReceiptWriter({ board, scope });
  const store = createCollaborationExperienceStore({ board, scope, now: () => NOW, recordRuntimeReceipt: writer.record });
  const input: PublishExperienceInput = { issueId: report.issue.issueId, owner, familyId: "pending-work", situation: "When handing over an in-progress artifact",
    responsibilities: ["Preserve committed work and identify pending items"], practice: "Share the artifact reference and a precise pending list. Follow the receiver's actual interface.",
    sourceRefs: ["report:pending"], evaluation };

  return { board, store, control, input, state: () => state };
}

test("a trial retains its falsifiable hypothesis through the original publisher and Board replay without enlarging member guidance", async () => {
  const h = await fixture(), published = await h.store.publishExperience(h.input);
  assert.ok(published.ok);
  const asset = h.state().assets.find(item => item.versionId === published.versionId);

  assert.ok(asset && isCollaborationExperienceContent(asset.content));
  assert.deepEqual(asset.content.evaluation, evaluation,
    "falsifiable evaluation must remain on the immutable published version");
  assert.ok(normalizeBoardState(JSON.parse(canonicalJson(h.state()))), "new optional metadata must survive persisted state validation");
  const prepared = await h.store.prepareExperience({ owner, maxChars: 600 });
  assert.ok(prepared.ok);
  assert.deepEqual(prepared.versionIds, [published.versionId]);
  assert.ok(prepared.text.length <= 600);
  assert.doesNotMatch(prepared.text, /receiver-continues|alternatives|effectiveness/);
  const { evaluation: _evaluation, ...legacy } = h.input;
  const old = await h.store.publishExperience({ ...legacy, familyId: "legacy-without-evaluation" });
  assert.ok(old.ok);
  assert.ok(normalizeBoardState(h.state()), "old and evaluated trial formats coexist without fabricated old hypotheses");
});

test("PA assessments bind frozen expectation IDs, actual dispatched versions and declared evidence; they do not refocus or mutate a trial", async () => {
  const h = await fixture(), published = await h.store.publishExperience(h.input);
  assert.ok(published.ok);
  const versionIds = [published.versionId], boundary = { executionId: "execution:actual", taskId: "task:next", round: 1,
    role: "personal_agent", configurationRef: "personal-agent:v1", requestId: "request:actual" };

  assert.ok((await h.store.recordDispatch({ receiptId: "dispatch:actual", owner, versionIds, boundary, recordedAt: NOW })).ok);
  const feedback = { receiptId: "feedback:actual", usageReceiptId: "dispatch:actual", owner, versionIds,
    summary: "The receiver's explicit interface differs. The general practice is not disproven by this exception.",
    sourceRefs: ["consumer:actual"], outcome: "uncertain" as const, recordedAt: NOW,
    assessments: [{ versionId: published.versionId, diagnosis: "context_mismatch" as const,
      observations: [{ expectationId: "receiver-continues", result: "unknown" as const, sourceRefs: [] }] }] };
  const before = canonicalJson(h.state().assets), jobs = h.state().jobs.length;
  const invalid = { ...feedback, assessments: [{ ...feedback.assessments[0]!, observations: [
    { expectationId: "invented-expectation", result: "observed" as const, sourceRefs: ["consumer:actual"] }] }] };

  assert.equal((await h.store.recordUseFeedback(invalid)).ok, false);
  assert.ok((await h.store.recordUseFeedback(feedback)).ok);
  assert.ok((await h.store.recordUseFeedback(feedback)).ok, "exact command replay remains idempotent");
  assert.equal((await h.store.recordUseFeedback({ ...feedback, receiptId: "feedback:second" })).ok, false);
  assert.equal(canonicalJson(h.state().assets), before);
  assert.equal(h.state().jobs.length, jobs);
  assert.equal(h.state().centralLearningGrants?.length ?? 0, 0);
  assert.ok(normalizeBoardState(h.state()));
});

test("optional assessment transport rejects unsupported observations and cross-version/source claims before persistence", () => {
  const feedback = { receiptId: "feedback:1", usageReceiptId: "dispatch:1", owner, versionIds: ["version:1"],
    summary: "Observed a specific receiver behavior.", sourceRefs: ["consumer:1"], outcome: "helped" };

  assert.deepEqual(experienceFeedbackInputIssues(feedback), [], "the legacy input contract stays valid");
  const assessment = { versionId: "version:1", diagnosis: "supported", observations: [
    { expectationId: "receiver-continues", result: "observed", sourceRefs: ["consumer:1"] }] };

  assert.deepEqual(experienceFeedbackInputIssues({ ...feedback, assessments: [assessment] }), []);

  for (const candidate of [
    { ...assessment, versionId: "version:other" },
    { ...assessment, observations: [{ ...assessment.observations[0]!, sourceRefs: [] }] },
    { ...assessment, observations: [{ ...assessment.observations[0]!, sourceRefs: ["invented:source"] }] },
    { ...assessment, observations: [assessment.observations[0]!, assessment.observations[0]!] },
    { ...assessment, verdict: "verified" },
  ]) assert.ok(experienceFeedbackInputIssues({ ...feedback, assessments: [candidate] }).length > 0);
});

test("evaluation metadata is bounded, versioned and rejects ambiguous expectations rather than granting new authority", () => {
  assert.ok(isCollaborationEvaluation(evaluation));
  for (const invalid of [
    { ...evaluation, schema: "collaboration-evaluation/v9" }, { ...evaluation, mechanism: "x".repeat(401) },
    { ...evaluation, alternatives: [] }, { ...evaluation, reconsiderWhen: [] },
    { ...evaluation, expectedObservations: [evaluation.expectedObservations[0], evaluation.expectedObservations[0]] },
    { ...evaluation, permissions: ["execute"] },
  ]) assert.equal(isCollaborationEvaluation(invalid), false);
});

test("model experience drafts can restrict an actual source configuration and reject invalid version restrictions", () => {
  const draft = { ownerRef: "expert:source@2", expertVersion: 2, familyId: "source-specific", situation: "A configuration-specific handoff",
    responsibilities: ["Keep the exact receiver contract"], practice: "Use the verified interface for this configuration only.", sourceRefs: ["report:pending"] };
  const action = { kind: "propose", familyId: "source-specific", title: "Respect the source configuration", summary: "The actual configuration matters.",
    sourceRefs: ["report:pending"], adjustments: [], needs: [], experiences: [draft] };
  assert.ok(isLearningAction(action));
  for (const expertVersion of [0, -1, 1.5, "2"]) assert.equal(isLearningAction({ ...action, experiences: [{ ...draft, expertVersion }] }), false);
});
