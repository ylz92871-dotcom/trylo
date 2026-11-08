import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { withImprovementBoard } from "../../workflow/testing/improvement-runtime-fixtures.js";
import { createMethodBoardWriter } from "./board-writer.js";
import { projectMethodCentralFeedbackChanges } from "./central-feedback-changes.js";
import type { MethodObservation } from "../domain/inference-observations.js";

test("native method fielding and canonical correction preserve the actual exposure writer relation", async () => withImprovementBoard(async boardRoot => {
  const at = "2026-11-05T10:00:00.000Z", scope = "D:/workspace/feedback-changes", writer = createMethodBoardWriter(boardRoot);
  const read = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  assert.ok((await writer.commitCard({ card: { schemaVersion: 1, hint: "Inspect the declared schema before editing.", appliesWhen: {}, labels: [],
    lineage: { createdFrom: { turnId: "task:source", beat: 1, reason: "containment" } } }, nicheId: "niche:json", versionId: "method:json",
    proposalId: "proposal:json", evidenceId: "admission:json", writeId: "card:json", sample: "schema:missing", observedAt: at })).ok);
  const report = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "report:json", issuedAt: at,
    action: { kind: "report", scope, problemKey: "method:json-review", issueId: "issue:json", report: { reportId: "report:json",
      source: { subsystem: "method", taskId: "task:source", versionId: "method:json" }, facts: ["scope:json"], evidenceRefs: ["admission:json"] } } }));
  assert.ok(report.ok);
  assert.deepEqual(projectMethodCentralFeedbackChanges(await read(), { scope }), [], "a source card is not delivery");
  assert.ok((await writer.recordUse({ writeId: "send:json", exposureId: "exposure:original", versionId: "method:json", proposalId: "proposal:json",
    turnId: "task:actual", beat: 1, requestId: "request:actual", scope: "json", observedAt: at })).ok);
  const original: MethodObservation = { observationId: "observation:actual", versionId: "method:json", taskId: "task:actual",
    opportunityId: "opportunity:actual", scopeId: "json", sequence: (await read()).fieldings[0]!.useSequence!, revision: 0,
    adoption: "displayed", outcome: "unhelpful", source: "self_report", features: {} };

  assert.ok((await writer.recordFeedback({ writeId: "feedback:initial", versionId: "method:json", turnId: "task:actual", helped: false,
    exposureId: "exposure:original", observation: original, observedAt: at })).ok);
  assert.ok((await writer.recordFeedback({ writeId: "feedback:correction", versionId: "method:json", turnId: "task:actual", helped: true,
    exposureId: "exposure:original", observation: { ...original, revision: 1, outcome: "helped" }, observedAt: at })).ok);
  const board = await read(), changes = projectMethodCentralFeedbackChanges(board, { scope });

  assert.equal(changes.filter(row => row.kind === "delivery").length, 1);
  assert.equal(changes.filter(row => row.kind === "quality").length, 0);
  const correction = changes.find(row => row.kind === "correction");
  assert.ok(correction);
  assert.equal(correction.unitRef, "exposure:original");
  assert.equal(correction.factRef, "observation:actual");
  assert.equal(correction.revisionRef, "observation:actual:revision:1");
  assert.equal(changes.some(row => row.kind === "adoption"), false, "display or associated tool success cannot certify following");
  assert.deepEqual(projectMethodCentralFeedbackChanges({ ...board, sequence: board.sequence + 100 }, { scope }), changes);
  assert.deepEqual(projectMethodCentralFeedbackChanges(board, { scope: "D:/foreign" }), []);
}));
