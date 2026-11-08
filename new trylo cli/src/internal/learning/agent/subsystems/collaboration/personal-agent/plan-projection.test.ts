import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../../../control/state.js";
import { reduce } from "../../../../control/reducer.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { createCollaborationControl } from "../control/index.js";
import { publishCollaborationArtifact } from "../artifacts/publish.js";
import type { CollaborationPlan } from "../orchestration/contracts.js";
import { collaborationPlanProjection } from "./plan-projection.js";

const scope = "workspace:plan-projection", NOW = "2026-11-04T00:00:00.000Z";

async function fixture(count: number) {
  let state = emptyBoardState();
  const board: Pick<BoardStore, "load" | "apply"> = { async load() { return { ok: true, state, generation: 0 }; }, async apply(command) {
    const result = reduce(state, command);
    if (result.ok) state = result.state;
    return result;
  } };
  const control = createCollaborationControl({ board, now: () => NOW, ownerId: "plan-read-contract" });
  const published: { issueId: string; versionId: string; proposalId: string; plan: CollaborationPlan }[] = [];

  for (let index = 0; index < count; index++) {
    const reportId = `report:plan-${index}`, report = await control.report({ scope, problemKey: `plan-${index}`,
      report: { reportId, source: { teamRunId: "team:actual", taskId: `task:${index}`, memberId: "worker" }, facts: ["The original task needs a concrete arrangement."], evidenceRefs: [] } });
    assert.ok(report.ok);
    const focus = await control.decide({ issueId: report.issue.issueId, expectedRevision: report.issue.revision, decision: "focused_learning",
      reason: "PA selected a bounded reusable arrangement.", sourceRefs: [reportId] });
    assert.ok(focus.ok);
    const plan: CollaborationPlan = { schema: "collaboration-plan/v1", issueId: focus.issue.issueId, focusRevision: focus.issue.decision.kind === "focused_learning" ? focus.issue.decision.revision : 0,
      familyId: `arrangement-${index}`, title: `Arrangement ${index}`, summary: "A concrete proposed division change.", sourceRefs: [reportId],
      adjustments: [{ memberId: "worker", kind: "division", instruction: "Keep the shared semantic decision with its current owner." }], experienceVersionIds: [], needs: [] };
    const result = await publishCollaborationArtifact({ board, scope, now: () => NOW }, { issueId: plan.issueId, familyId: plan.familyId,
      title: plan.title, hypothesis: plan.summary, sourceRefs: plan.sourceRefs, content: plan, schemaVersion: 3, kind: "plan" });
    assert.ok(result.ok);
    published.push({ issueId: plan.issueId, versionId: result.versionId, proposalId: result.proposalId, plan });
  }

  return { board, state: () => state, published };
}

test("a known issue is selected before the plan limit while complete qualified version IDs stay identical for every view", async () => {
  const h = await fixture(11), chosen = h.published[0]!, before = JSON.stringify(h.state());
  const full = collaborationPlanProjection(h.state(), { scope }), focused = collaborationPlanProjection(h.state(), { scope, issueId: chosen.issueId });

  assert.equal(full.items.length, 8);
  assert.equal(full.summary.availableProposalCount, 11);
  assert.equal(full.summary.omittedProposalCount, 3);
  assert.ok(!full.items.some(plan => plan.versionId === chosen.versionId));
  assert.deepEqual(focused.items.map(plan => plan.versionId), [chosen.versionId]);
  assert.equal(focused.summary.matchingProposalCount, 1);
  assert.equal(focused.summary.omittedProposalCount, 0);
  assert.equal(focused.summary.unrelatedProposalCount, 10);
  assert.deepEqual(full.eligibleVersionIds, focused.eligibleVersionIds);
  assert.deepEqual(collaborationPlanProjection(h.state(), { scope, limit: 1 }).eligibleVersionIds, full.eligibleVersionIds);
  assert.equal(collaborationPlanProjection(h.state(), { scope, limit: 99 }).items.length, 8);
  assert.equal(JSON.stringify(h.state()), before, "the bounded view must not rewrite authoritative plans");
  assert.match(focused.summary.note, /do not imply pending work, adoption or effectiveness/);
});

test("withdrawn assets or proposals and wrong-source or foreign plans are absent from both previews and freshness IDs", async () => {
  const h = await fixture(3), [asset, proposal, retained] = h.published;
  assert.ok(asset && proposal && retained);

  for (const [entityId, entityType] of [[asset.versionId, "asset"], [proposal.proposalId, "proposal"]] as const) {
    assert.ok((await h.board.apply({ type: "tombstone", commandId: `withdraw:${entityId}`, issuedAt: NOW, entityId, entityType, reason: "Withdraw this trial proposal." })).ok);
  }

  const source = h.state().assets.find(item => item.versionId === retained.versionId)!;
  const badPlan = { ...retained.plan, sourceRefs: ["source:unrelated"] }, foreignPlan = { ...retained.plan };
  const state = { ...h.state(), assets: [...h.state().assets,
    { ...source, versionId: "plan:wrong-source", content: badPlan, contentHash: contentHashOf(badPlan) },
    { ...source, versionId: "plan:foreign", scope: "workspace:foreign", content: foreignPlan, contentHash: contentHashOf(foreignPlan) }] };
  const view = collaborationPlanProjection(state, { scope });

  assert.deepEqual(view.items.map(plan => plan.versionId), [retained.versionId]);
  assert.deepEqual(view.eligibleVersionIds, [retained.versionId]);
  assert.equal(view.summary.availableProposalCount, 1);
  assert.deepEqual(collaborationPlanProjection(state, { scope, issueId: asset.issueId }).items, []);
});
