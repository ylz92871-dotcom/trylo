import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { seedToolProduction } from "../testing/production-fixtures.js";
import { toolLearningFeedbackVersions, toolLearningParentFromBoard } from "./learning-parent.js";
import { candidateFromBoard } from "./evolution-reader.js";
import type { BoardState } from "../../../../control/state.js";

test("suspended and rolled-back sources remain read-only learning parents and keep their production feedback", async t => {
  const fx = await seedToolProduction(t), loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);

  for (const lifecycle of ["suspended", "rolled_back"] as const) {
    const state: BoardState = { ...loaded.state, proposals: loaded.state.proposals.map(proposal =>
      proposal.proposalId === fx.origin.proposalId || proposal.proposalId === `production-proposal:${fx.selection.versionId}`
        ? { ...proposal, lifecycle } : proposal) };
    const parent = toolLearningParentFromBoard(state, fx.origin.versionId);
    assert.ok(parent.ok);
    assert.equal(parent.parent.kind, "generated");
    const productionParent = toolLearningParentFromBoard(state, fx.selection.versionId);
    assert.ok(productionParent.ok);
    assert.equal(productionParent.parent.versionId, fx.origin.versionId);
    assert.ok(toolLearningFeedbackVersions(state, fx.origin.versionId).includes(fx.selection.versionId));
    const execution = candidateFromBoard(state, fx.origin.versionId);
    assert.ok(!execution.ok);
    assert.equal(execution.code, "candidate_unavailable");
  }
});

test("explicit rejection, retirement, tombstones and altered proposal identity still exclude history", async t => {
  const fx = await seedToolProduction(t), loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);

  for (const lifecycle of ["rejected", "retired"] as const) {
    const state: BoardState = { ...loaded.state, proposals: loaded.state.proposals.map(proposal => proposal.proposalId === fx.origin.proposalId ? { ...proposal, lifecycle } : proposal) };
    assert.equal(toolLearningParentFromBoard(state, fx.origin.versionId).ok, false);
  }

  assert.equal(toolLearningParentFromBoard({ ...loaded.state, tombstones: [{ entityId: fx.origin.versionId, entityType: "asset",
    boardSequence: loaded.state.sequence, reason: "TEST ONLY withdrawn" }] }, fx.origin.versionId).ok, false);
  assert.equal(toolLearningParentFromBoard({ ...loaded.state, proposals: loaded.state.proposals.map(proposal => proposal.proposalId === fx.origin.proposalId
    ? { ...proposal, candidateRef: "another-version" } : proposal) }, fx.origin.versionId).ok, false);
});
