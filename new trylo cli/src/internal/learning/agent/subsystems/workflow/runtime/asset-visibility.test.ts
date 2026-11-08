import assert from "node:assert/strict";
import test from "node:test";
import type { LearningAssetVersion, LearningProposal, ProposalLifecycle } from "../../../../control/contracts.js";
import { emptyBoardState, type BoardState } from "../../../../control/state.js";
import { workflowAssetSelfVisibility, workflowAssetVisibility, workflowAssetVisibilityIndex, workflowForgottenAssetIds } from "./asset-visibility.js";

const scope = "repo:visibility", at = "2026-11-04T00:00:00.000Z";

function owned(id: string, content: unknown = {}, options: { readonly parent?: string; readonly lifecycle?: ProposalLifecycle; readonly scope?: string } = {}) {
  const proposal: LearningProposal = { proposalId: `proposal:${id}`, domain: "workflow", scope: options.scope ?? scope,
    assetKind: "workflow", candidateRef: id, hypothesis: "test input", observationRefs: [], risk: "low",
    requiredVerifiers: [], requestedAuthorities: [], source: "inferred", lifecycle: options.lifecycle ?? "draft" };
  const asset: LearningAssetVersion = { versionId: id, kind: "workflow", schemaVersion: 1, content, contentHash: "test-only",
    source: "inferred", scope: proposal.scope, createdAt: at, createdFromProposalId: proposal.proposalId,
    ...(options.parent === undefined ? {} : { parentVersionId: options.parent }) };

  return { proposal, asset };
}

function board(...entries: readonly ReturnType<typeof owned>[]): BoardState {
  return { ...emptyBoardState(), proposals: entries.map(item => item.proposal), assets: entries.map(item => item.asset) };
}

function forget(state: BoardState, id: string, entityType: "asset" | "proposal" = "asset"): BoardState {
  return { ...state, tombstones: [{ entityId: id, entityType, boardSequence: 1, reason: "test privacy withdrawal" }] };
}

test("owning source, identity and lifecycle are checked before exposing a workflow record", () => {
  const entry = owned("source"), state = board(entry);

  assert.equal(workflowAssetSelfVisibility(state, "source"), "available");

  for (const lifecycle of ["rejected", "retired", "suspended", "rolled_back"] as const) {
    assert.equal(workflowAssetSelfVisibility(board(owned("source", {}, { lifecycle })), "source"), "blocked");
  }

  assert.equal(workflowAssetSelfVisibility({ ...state, proposals: [] }, "source"), "unknown");

  for (const mismatch of [{ source: "user_explicit" as const }, { candidateRef: "other" }, { scope: "repo:other" }, { domain: "skill" as const }]) {
    assert.equal(workflowAssetSelfVisibility({ ...state, proposals: [{ ...entry.proposal, ...mismatch }] }, "source"), "unknown");
  }

  assert.equal(workflowAssetSelfVisibility(forget({ ...state, proposals: [] }, "source"), "source"), "forgotten");
  assert.equal(workflowAssetSelfVisibility(forget(state, entry.proposal.proposalId, "proposal"), "source"), "forgotten");
  assert.equal(workflowAssetSelfVisibility(forget(emptyBoardState(), "removed-source"), "removed-source"), "forgotten");
});

test("retired legacy authority blocks inferred inheritance while modern repair lifecycle remains independent", () => {
  const state = board(owned("retired-parent", {}, { lifecycle: "retired" }), owned("repair-child", {}, { parent: "retired-parent" }));

  assert.equal(workflowAssetSelfVisibility(state, "repair-child"), "available");
  assert.equal(workflowAssetVisibility(state, "repair-child"), "blocked");
  assert.equal(workflowForgottenAssetIds(state).size, 0, "retirement is not a privacy tombstone");
  const forgotten = forget(state, "retired-parent");

  assert.ok(workflowForgottenAssetIds(forgotten).has("repair-child"));
  assert.equal(workflowAssetVisibility(forgotten, "repair-child"), "forgotten");
});

test("forgetting an opportunity closes over its result, uses, feedback and feedback-derived research", () => {
  const opportunity = (id: string) => ({ opportunityId: id, evidenceRefs: [] });
  const state = board(
    owned("input", { type: "workflow_improvement_opportunity", opportunity: opportunity("same-id") }),
    owned("result", { type: "workflow_improvement", opportunity: opportunity("same-id"), evidence: [] }),
    owned("child", { type: "workflow_improvement", parentVersionId: "result", opportunity: opportunity("child-id"), evidence: [] }),
    owned("use", { type: "workflow_improvement_use", use: { useId: "use:1", versionId: "result" } }),
    owned("feedback", { type: "workflow_improvement_feedback", feedback: { feedbackId: "feedback:1", useId: "use:1", versionId: "result", evidenceRefs: [] } }),
    owned("next-input", { type: "workflow_improvement_opportunity", opportunity: opportunity("next-id"), evidence: [{ ref: "feedback:1" }] }),
    owned("next-result", { type: "workflow_improvement", opportunity: opportunity("next-id"), evidence: [] }),
    owned("other-input", { type: "workflow_improvement_opportunity", opportunity: opportunity("same-id") }, { scope: "repo:other" }),
    owned("other-result", { type: "workflow_improvement", opportunity: opportunity("same-id"), evidence: [] }, { scope: "repo:other" }),
  );
  const forgotten = workflowForgottenAssetIds(forget(state, "input"));

  for (const id of ["input", "result", "child", "use", "feedback", "next-input", "next-result"]) assert.ok(forgotten.has(id), id);

  assert.equal(forgotten.has("other-input"), false);
  assert.equal(forgotten.has("other-result"), false);
});

test("named evidence and legacy-correction provenance propagate withdrawal without scanning arbitrary text", () => {
  const state = board(owned("legacy"),
    owned("source-ref", { evidence: [{ sourceVersionId: "legacy", ref: "public-fact" }] }),
    owned("legacy-ref", { evidence: [{ ref: "legacy-correction:legacy" }] }),
    owned("conditional-ref", { opportunity: { evidenceRefs: ["legacy-conditional-correction:legacy"] } }),
    owned("plain-text", { summary: "legacy", reasoning: "legacy", evidence: [{ summary: "legacy", ref: "unrelated-receipt" }] }));
  const visibility = workflowAssetVisibilityIndex(forget(state, "legacy"));

  for (const id of ["source-ref", "legacy-ref", "conditional-ref"]) assert.equal(visibility.get(id), "forgotten");

  assert.equal(visibility.get("plain-text"), "available");
});

test("missing source metadata is unknown and cannot be converted into inherited legacy authority", () => {
  const state = board(owned("child", { parentVersionId: "missing-parent" }),
    owned("feedback", { feedback: { useId: "missing-use", versionId: "child" } }));
  assert.equal(workflowAssetSelfVisibility(state, "child"), "available");
  assert.equal(workflowAssetVisibility(state, "child"), "unknown");
  assert.equal(workflowAssetVisibility(state, "feedback"), "unknown");
  assert.equal(workflowForgottenAssetIds(state).size, 0);
});
