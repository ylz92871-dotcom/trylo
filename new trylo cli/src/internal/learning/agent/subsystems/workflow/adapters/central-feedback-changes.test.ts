import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { commitWorkflowImprovementRecord } from "./improvement-board.js";
import { runtimeFixture, resultRecord, withImprovementBoard } from "../testing/improvement-runtime-fixtures.js";
import { improvementFeedbackFixture } from "../testing/improvement-fixtures.js";
import { projectWorkflowCentralFeedbackChanges } from "./central-feedback-changes.js";
import { record } from "../domain/trace-parse.js";
import { projectWorkflowCentralFeedback } from "./central-feedback.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";

test("native publication alone is silent; actual frozen use and user correction retain the original unit", async () => withImprovementBoard(async boardRoot => {
  const centralScope = "D:/workspace/feedback-changes", fx = runtimeFixture(boardRoot, { centralScope });
  const read = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const project = async () => projectWorkflowCentralFeedbackChanges(await read(), { scope: centralScope, workspaceId: fx.options.scope });

  try {
    resultRecord(await fx.runtime.opportunity("native-source", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    assert.deepEqual(await project(), [], "a paid candidate, checkpoint or proposal is not delivery/adoption/quality");
    const adopted = resultRecord(await fx.runtime.context("native-handoff", { task: fx.fixture.opportunity.task, boundary: "before source search" }));

    assert.equal(adopted.status, "frozen");
    const first = await project();
    assert.equal(first.length, 1);
    assert.equal(first[0]?.kind, "adoption");
    assert.ok(record(adopted.use));
    const useId = String(adopted.use.useId), versionId = String(adopted.use.versionId);

    assert.equal(first[0]?.unitRef, useId);
    assert.ok(first[0]?.sourceRefs.includes(versionId));
    const correction = await commitWorkflowImprovementRecord(boardRoot, { type: "workflow_improvement_feedback", schemaVersion: 1,
      feedback: improvementFeedbackFixture({ feedbackId: "feedback:actual-user-correction", useId, versionId,
        executionId: `${fx.options.sessionId}/actual-user-assessment`, userAssessment: { judgment: "harmed", evidenceRef: "receipt:user-correction" } }) },
    new Date(fx.options.now()).toISOString());
    assert.ok(correction.ok);
    const changes = await project(), late = changes.find(row => row.kind === "correction");
    assert.ok(late);
    assert.equal(late.factRef, correction.value.versionId);
    assert.equal(late.revisionRef, correction.value.versionId);
    assert.equal(late.unitRef, useId);
    assert.equal(changes.some(row => row.kind === "delivery"), false);
    const body = projectWorkflowCentralFeedback(await read(), { scope: centralScope, issueId: late.issueId, nativeChanges: changes });
    assert.ok(body);

    for (const change of changes) {
      const original: JsonObject | undefined = body.records.find(row => row.factRef === change.factRef && row.unitRef === change.unitRef && row.revisionRef === change.revisionRef);
      assert.ok(original, "each advertised original unit has its exact source record body");
      assert.equal(typeof original.payloadJson, "string");
      const payload = JSON.parse(String(original.payloadJson));
      assert.equal(payload.type === "workflow_improvement_use" ? payload.use.useId : payload.feedback.useId, useId);
      if (change.kind === "correction") assert.deepEqual(payload.feedback.userAssessment, { judgment: "harmed", evidenceRef: "receipt:user-correction" });
    }

    const actual = await read(), tampered = { ...actual, assets: actual.assets.map(asset => asset.versionId !== late.factRef
      || !record(asset.content) || !record(asset.content.feedback) ? asset : { ...asset, content: { ...asset.content,
        feedback: { ...asset.content.feedback, userAssessment: { judgment: "neutral", evidenceRef: "receipt:user-correction" } } } }) };
    const corrupt = projectWorkflowCentralFeedback(tampered, { scope: centralScope, issueId: late.issueId, nativeChanges: changes });

    assert.equal(corrupt?.records.some(row => row.factRef === late.factRef && row.unitRef === late.unitRef), false,
      "an immutable source reference cannot advertise a changed raw feedback body");

    for (const type of ["workflow_improvement_opportunity", "workflow_improvement"]) {
      const changedLineage = { ...actual, assets: actual.assets.map(asset => !record(asset.content) || asset.content.type !== type ? asset
        : { ...asset, content: { ...asset.content, schemaVersion: 1, opportunity: { ...fx.fixture.opportunity, problem: "Changed immutable lineage body" } } }) };
      const unresolved = projectWorkflowCentralFeedback(changedLineage, { scope: centralScope, issueId: late.issueId, nativeChanges: changes });
      assert.equal(unresolved?.records.some(row => row.factRef === late.factRef && row.unitRef === late.unitRef) ?? false, false,
        `the advertised unit cannot bypass its original ${type} identity`);
    }

    assert.deepEqual(projectWorkflowCentralFeedbackChanges({ ...await read(), sequence: 999999 }, { scope: centralScope }), changes,
      "unrelated Board prefix changes cannot manufacture a new revision");
    assert.deepEqual(projectWorkflowCentralFeedbackChanges(await read(), { scope: "D:/foreign" }), []);
  } finally { await fx.runtime.close(); }
}));
