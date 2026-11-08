import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { createCollaborationControl } from "../control/index.js";
import type { CollaborationEvaluation } from "../domain/evaluation.js";
import { createCollaborationRuntimeReceiptWriter } from "../runtime/receipts/index.js";
import { createCollaborationExperienceStore } from "./store.js";
import { isCollaborationExperienceContent } from "./parse.js";
import { collaborationTrialHistory } from "./trial-history.js";

const scope = "workspace:trial-history", NOW = "2026-11-04T00:00:00.000Z";
const owner = { kind: "legacy_member", workspace: scope, profileId: "profile:history", memberId: "worker" } as const;
const evaluation: CollaborationEvaluation = { schema: "collaboration-evaluation/v1", mechanism: "Explicit source and units prevent re-interpretation.",
  alternatives: [{ explanation: "The calculation itself is incorrect.", discriminator: "Check the independently computed result after the handoff." }],
  expectedObservations: [{ id: "units", observation: "The receiver consumes the stated units without asking for them again." }],
  reconsiderWhen: ["The receiver still guesses units after a complete handoff."] };

async function fixture() {
  let state = emptyBoardState();
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "owner:history" });
  const reported = await control.report({ scope, problemKey: "handoff", report: { reportId: "report:history",
    source: { teamRunId: "team:history", taskId: "task:history", memberId: "worker" },
    facts: ["The handoff omitted its source and units."], evidenceRefs: ["artifact:handoff"] } });
  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Examine a reusable handoff practice.", sourceRefs: ["report:history"] });
  assert.ok(focused.ok);
  const writer = createCollaborationRuntimeReceiptWriter({ board, scope });
  const experience = createCollaborationExperienceStore({ board, scope, now: () => NOW, recordRuntimeReceipt: writer.record });
  const publish = async (familyId: string, practice: string, evaluated = true) => {
    const result = await experience.publishExperience({ issueId: focused.issue.issueId, owner, familyId, situation: "A dependent handoff",
      responsibilities: ["worker"], practice, sourceRefs: ["report:history"], ...(evaluated ? { evaluation } : {}) });
    assert.ok(result.ok);
    return result.versionId;
  };
  const dispatch = async (receiptId: string, versionIds: readonly string[]) => {
    assert.ok((await experience.recordDispatch({ receiptId, owner, versionIds, recordedAt: NOW,
      boundary: { executionId: `execution:${receiptId}`, taskId: "task:use", round: 1, role: "worker",
        configurationRef: "legacy-member:history:worker", requestId: `request:${receiptId}` } })).ok);
  };

  return { state: () => state, issueId: focused.issue.issueId, experience, publish, dispatch };
}

test("learner sees the frozen hypothesis and attributed actual use after a revision without rewriting history", async () => {
  const h = await fixture(), first = await h.publish("handoff", "Include source and input units.");

  await h.dispatch("dispatch:old", [first]);
  assert.ok((await h.experience.recordUseFeedback({ receiptId: "feedback:old", usageReceiptId: "dispatch:old", owner,
    versionIds: [first], summary: "Units were supplied but the receiver still guessed; the cause remains uncertain.", outcome: "not_helped",
    sourceRefs: ["artifact:handoff"], assessments: [{ versionId: first, diagnosis: "uncertain",
      observations: [{ expectationId: "units", result: "contradicted", sourceRefs: ["artifact:handoff"] }] }], recordedAt: NOW })).ok);
  const revised = await h.publish("handoff", "Include source, units and one consumer-checkable example.");
  const before = JSON.stringify(h.state()), history = collaborationTrialHistory(h.state(), { scope, issueId: h.issueId });

  assert.deepEqual(history.items.map(item => [item.versionId, item.status]), [[revised, "current"], [first, "historical"]]);
  assert.deepEqual(history.items[1]!.evaluation, evaluation);
  const use = history.items[1]!.uses[0]!;

  assert.equal(use.dispatch.receiptId, "dispatch:old");
  assert.equal(use.feedback?.receiptId, "feedback:old");
  assert.equal(use.feedbackState, "pa_claim_recorded");
  assert.deepEqual(use.feedback?.wholeDispatchVersionIds, [first]);
  assert.equal(use.feedback?.assessment?.observations[0]?.result, "contradicted");
  assert.equal(history.attribution, "observational_pa_claims");
  assert.equal(JSON.stringify(h.state()), before);
  Reflect.set(history.items[1]!.evaluation!, "mechanism", "caller:tampered");
  Reflect.set(history.items[1]!.uses[0]!.dispatch.boundary, "taskId", "caller:tampered");
  assert.equal(JSON.stringify(h.state()), before, "history data cannot become a second Board writer through shared object references");
});

test("history bounds versions, actual uses and complete references with explicit omission counts", async () => {
  const h = await fixture();

  for (let index = 0; index < 6; index++) await h.publish(`family:${index}`, `Practice ${index}.`);

  const latest = h.state().assets[h.state().assets.length - 1]!.versionId;

  for (let index = 0; index < 5; index++) await h.dispatch(`dispatch:${index}`, [latest]);

  const refs = Array.from({ length: 6 }, (_, index) => `artifact:result:${index}`);

  assert.ok((await h.experience.recordUseFeedback({ receiptId: "feedback:latest", usageReceiptId: "dispatch:4", owner,
    versionIds: [latest], summary: "The task passed; contribution is uncertain.", outcome: "uncertain", sourceRefs: refs,
    assessments: [{ versionId: latest, diagnosis: "uncertain", observations: [{ expectationId: "units", result: "unknown", sourceRefs: refs }] }],
    recordedAt: NOW })).ok);
  const history = collaborationTrialHistory(h.state(), { scope, issueId: h.issueId });

  assert.equal(history.items.length, 2);
  assert.equal(history.omittedVersions, 4);
  const item = history.items[0]!;
  assert.equal(item.uses.length, 3);
  assert.equal(item.omittedUses, 2);
  assert.deepEqual(item.uses.map(use => use.dispatch.receiptId), ["dispatch:4", "dispatch:3", "dispatch:2"]);
  assert.equal(item.uses[1]!.feedbackState, "not_yet_assessed");
  assert.equal(item.uses[1]!.feedback, undefined);
  assert.deepEqual(item.uses[0]!.feedback?.sourceRefs, refs.slice(0, 4));
  assert.equal(item.uses[0]!.feedback?.omittedSourceRefs, 2);
  assert.equal(item.uses[0]!.feedback?.assessment?.observations[0]?.omittedSourceRefs, 2);
  assert.equal(collaborationTrialHistory(h.state(), { scope, issueId: h.issueId, limit: 100 }).items.length, 4);
});

test("withdrawn, foreign and ungrounded content stays out; legacy hypotheses are not invented", async () => {
  const h = await fixture(), legacy = await h.publish("legacy", "State the input unit.", false);
  const current = await h.publish("handoff", "State source and units.");
  const withdrawn = { ...h.state(), tombstones: [{ entityId: current, entityType: "asset" as const,
    boardSequence: h.state().sequence, reason: "User withdrew this content." }] };
  const view = collaborationTrialHistory(withdrawn, { scope, issueId: h.issueId });

  assert.deepEqual(view.items.map(item => item.versionId), [legacy]);
  assert.equal(view.items[0]!.evaluation, undefined);
  assert.equal(collaborationTrialHistory(h.state(), { scope: "workspace:foreign", issueId: h.issueId }).items.length, 0);
  assert.equal(collaborationTrialHistory(h.state(), { scope, issueId: "issue:other" }).items.length, 0);
  const ungrounded = { ...h.state(), assets: h.state().assets.map(asset => isCollaborationExperienceContent(asset.content)
    ? { ...asset, content: { ...asset.content, sourceRefs: ["not-a-source"] } } : asset) };

  assert.equal(collaborationTrialHistory(ungrounded, { scope, issueId: h.issueId }).items.length, 0);
});
