import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { workflowImprovementsFromBoard } from "./improvement-board.js";
import { resultRecord, runtimeFixture, withImprovementBoard } from "../testing/improvement-runtime-fixtures.js";
import { record } from "../domain/trace-parse.js";

test("retired history retains adopted uses and feedback, while tombstones remove their public projection without corrupting the scope", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot);
  try {
    resultRecord(await fx.runtime.opportunity("learn", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    const adopted = resultRecord(await fx.runtime.context("use", { task: fx.fixture.opportunity.task, boundary: "source handoff" }));

    assert.ok(record(adopted.use));
    fx.state.snapshot = { ...fx.state.snapshot, executionId: "session:contract/turn:followup", watermark: 110,
      receipts: [{ ref: "receipt:followup", sequence: 105, executionId: "session:contract/turn:followup", toolCallId: "read", tool: "read_file", outcome: "succeeded" }] };
    resultRecord(await fx.runtime.feedback("final-report", { useId: adopted.use.useId, exposure: "reported_used",
      evidenceRefs: ["receipt:followup"], followedStepIds: ["confirm-owner"], explanation: "Observed a current owner result; effectiveness is unknown." }));
    const board = await createBoardReader(boardRoot).load();
    assert.ok(board.ok);
    const versionId = String(adopted.use.versionId), asset = board.state.assets.find(item => item.versionId === versionId);
    assert.ok(asset);
    const retired = workflowImprovementsFromBoard({ ...board.state,
      proposals: board.state.proposals.map(item => item.proposalId === asset.createdFromProposalId ? { ...item, lifecycle: "retired" } : item),
    }, fx.options.scope);

    assert.ok(retired.ok);
    assert.equal(retired.value.versions[0]?.status, "blocked");
    assert.equal(retired.value.uses.length, 1);
    assert.equal(retired.value.feedback.length, 1);
    const forgotten = workflowImprovementsFromBoard({ ...board.state, tombstones: [...board.state.tombstones,
      { entityType: "asset", entityId: versionId, boardSequence: board.state.sequence + 1, reason: "owner requested deletion" }],
    }, fx.options.scope);

    assert.ok(forgotten.ok);
    assert.equal(forgotten.value.versions.length, 0);
    assert.equal(forgotten.value.uses.length, 0);
    assert.equal(forgotten.value.feedback.length, 0);
    const input = board.state.assets.find(item => record(item.content) && item.content.type === "workflow_improvement_opportunity");
    assert.ok(input);
    const forgottenInput = workflowImprovementsFromBoard({ ...board.state, tombstones: [...board.state.tombstones,
      { entityType: "asset", entityId: input.versionId, boardSequence: board.state.sequence + 1, reason: "forget the recorded source observations" }],
    }, fx.options.scope);

    assert.ok(forgottenInput.ok);
    assert.equal(forgottenInput.value.opportunities.length, 0);
    assert.equal(forgottenInput.value.versions.length, 0, "a result cannot leak the forgotten opportunity through its copied facts");
    assert.equal(forgottenInput.value.uses.length, 0);
    assert.equal(forgottenInput.value.feedback.length, 0);
    const missing = workflowImprovementsFromBoard({ ...board.state, assets: board.state.assets.filter(item => item.versionId !== versionId) }, fx.options.scope);

    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "workflow_improvement_corrupt");
  } finally { await fx.runtime.close(); }
}));
