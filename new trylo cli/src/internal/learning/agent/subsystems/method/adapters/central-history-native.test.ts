import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { canonicalJson } from "../../../../control/hash.js";
import { shortId } from "../../../../domains/shared/hash.js";
import { withImprovementBoard } from "../../workflow/testing/improvement-runtime-fixtures.js";
import { canonicalObservations, type MethodObservation } from "../domain/inference-observations.js";
import { snapshotOf } from "../domain/experience-state.js";
import { createMethodBoardWriter } from "./board-writer.js";
import { methodCentralFeedbackChangesForIssue, projectMethodCentralFeedbackChanges } from "./central-feedback-changes.js";
import { methodCentralFeedbackFromBoard } from "./central-history.js";
import { reviseExperience } from "./experience-revision.js";
import { createExperienceStore } from "./experience-store.js";
import { readOrganizationNativeFeedbackUnit } from "../../../../../integration/central-learning/organization-feedback-sources.js";

test("method advertised child units resolve their actual payload and revision without trusting supplied ownership", async () => withImprovementBoard(async boardRoot => {
  const at = "2026-11-05T11:00:00.000Z", scope = "D:/workspace/method-native-body", writer = createMethodBoardWriter(boardRoot);
  const store = createExperienceStore(boardRoot, () => at);
  const read = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  for (const versionId of ["method:parent", "method:foreign"]) {
    assert.ok((await writer.commitCard({ card: { schemaVersion: 1, hint: `Inspect the schema for ${versionId}.`, appliesWhen: {}, labels: [],
      lineage: { createdFrom: { turnId: "task:source", beat: 1, reason: "containment" } } }, nicheId: "niche:json", versionId,
      proposalId: `proposal:${versionId}`, evidenceId: `admission:${versionId}`, writeId: `card:${versionId}`, sample: "schema:missing", observedAt: at })).ok);
    assert.ok((await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: `report:${versionId}`, issuedAt: at,
      action: { kind: "report", scope, problemKey: `review:${versionId}`, issueId: `issue:${versionId}`, report: { reportId: `report:${versionId}`,
        source: { subsystem: "method", taskId: "task:source", versionId }, facts: ["scope:json"], evidenceRefs: [`admission:${versionId}`] } } }))).ok);
  }

  const hint = "Inspect the schema and validate its declared required fields.";

  await reviseExperience(writer, () => at, "method:parent", hint);
  const childId = shortId("method-revision", ["method:parent", hint]);
  const childProposalId = shortId("method_proposal", [childId]);

  for (const [versionId, proposalId] of [[childId, childProposalId], ["method:foreign", "proposal:method:foreign"]] as const) {
    await store.append(view => ({ kind: "scope", factId: `scope:${versionId}`, versionId, sequence: view.sequence + 1,
      hypothesis: { id: `hypothesis:${versionId}`, versionId, scopeId: "json", predicate: { all: [{ feature: "format", value: "json" }], exclude: [] },
        proposedSequence: view.sequence }, description: "The task has a JSON schema." }));
    assert.ok((await writer.recordUse({ writeId: `send:${versionId}`, exposureId: `exposure:${versionId}`, versionId, proposalId,
      turnId: `task:${versionId}`, beat: 1, requestId: `request:${versionId}`, scope: "json", observedAt: at })).ok);
    const original: MethodObservation = { observationId: `observation:${versionId}`, versionId, taskId: `task:${versionId}`,
      opportunityId: `opportunity:${versionId}`, scopeId: "json", sequence: (await read()).fieldings.find(row => row.versionId === versionId)!.useSequence!,
      revision: 0, adoption: "displayed", outcome: "unhelpful", source: "self_report", features: { format: "json" } };

    assert.ok((await writer.recordFeedback({ writeId: `feedback:initial:${versionId}`, versionId, turnId: `task:${versionId}`, helped: false,
      exposureId: `exposure:${versionId}`, observation: original, observedAt: at })).ok);
    assert.ok((await writer.recordFeedback({ writeId: `feedback:correction:${versionId}`, versionId, turnId: `task:${versionId}`, helped: true,
      exposureId: `exposure:${versionId}`, observation: { ...original, revision: 1, outcome: "helped" }, observedAt: at })).ok);
    await store.append(view => ({ kind: "decision", factId: `decision:${versionId}`, versionId, sequence: view.sequence + 1,
      context: { taskId: `task:${versionId}`, opportunityId: `opportunity:${versionId}`, situation: "Check the schema.", features: { format: "json" } },
      decision: { action: "adopt", versionId, scopeId: "json", reason: "The declared schema applies." } }));
    await store.append(view => ({ kind: "restriction", factId: `restriction:${versionId}`, versionId, sequence: view.sequence + 1,
      scopeId: "json", predicate: { all: [{ feature: "format", value: "json" }], exclude: [{ feature: "draft", value: "unknown" }] },
      reason: "Exclude unknown schema drafts." }));
  }

  // Review and candidate prose have no delivery/quality identity of their own.
  await store.append(view => {
    const scopeFact = view.facts.find(row => row.kind === "scope" && row.versionId === childId);
    assert.ok(scopeFact?.kind === "scope");
    const snapshot = snapshotOf(view, scopeFact.hypothesis);
    return { kind: "review", factId: "review:child", versionId: childId, sequence: view.sequence + 1,
      scopeId: "json", snapshotId: snapshot.snapshotId, evidenceRevisions: snapshot.revisions,
      review: { decision: "defer", score: 0.5, reason: "Await further actual use.", sources: [childId] } };
  });
  const board = await read(), issueId = "issue:method:parent";
  const changes = projectMethodCentralFeedbackChanges(board, { scope }), owned = changes.filter(row => row.issueId === issueId);
  const indexed = methodCentralFeedbackChangesForIssue(board, { scope, issueId });

  assert.strictEqual(projectMethodCentralFeedbackChanges(board, { scope }), changes);
  assert.strictEqual(methodCentralFeedbackChangesForIssue(board, { scope, issueId }), indexed);
  assert.deepEqual(indexed, owned);
  assert.ok(Object.isFrozen(changes) && Object.isFrozen(indexed) && indexed.every(row => Object.isFrozen(row) && Object.isFrozen(row.sourceRefs)));
  assert.deepEqual(methodCentralFeedbackChangesForIssue(board, { scope, issueId: "issue:missing" }), []);
  assert.deepEqual(projectMethodCentralFeedbackChanges(board, { scope: "D:/foreign" }), []);
  assert.notStrictEqual(projectMethodCentralFeedbackChanges({ ...board }, { scope }), changes, "a new loaded Board owns its own index");
  let assetReads = 0;
  const observed = new Proxy(board, { get(target, property, receiver) {
    if (property === "assets") assetReads += 1;
    return Reflect.get(target, property, receiver) as unknown;
  } });
  const first = projectMethodCentralFeedbackChanges(observed, { scope }), readsAfterIndex = assetReads;

  assert.ok(readsAfterIndex > 0);
  assert.strictEqual(projectMethodCentralFeedbackChanges(observed, { scope }), first);
  assert.deepEqual(methodCentralFeedbackChangesForIssue(observed, { scope, issueId }), owned);
  assert.equal(assetReads, readsAfterIndex, "aggregate and per-issue lookup index the same loaded native prefix once");
  const reused = { ...board }, beforeAdvance = projectMethodCentralFeedbackChanges(reused, { scope });

  reused.sequence += 1;
  assert.notStrictEqual(projectMethodCentralFeedbackChanges(reused, { scope }), beforeAdvance, "a changed prefix invalidates an accidentally reused Board object");
  assert.deepEqual(projectMethodCentralFeedbackChanges(reused, { scope }), changes);
  assert.equal(owned.length, 4, "child delivery, decision, restriction and canonical corrected assessment are advertised");
  assert.equal(owned.some(row => row.kind === "quality"), false, "the correction replaces revision zero");
  const legacy = methodCentralFeedbackFromBoard(board, { scope, issueId });
  assert.ok(legacy);
  assert.equal(legacy.records.some(row => row.factRef === `exposure:${childId}`), false, "the child has no behavioral review link");
  const actual = methodCentralFeedbackFromBoard(board, { scope, issueId, nativeChanges: changes });
  assert.ok(actual);
  assert.equal(actual.records.length, owned.length);

  for (const change of owned) {
    const record: JsonObject | undefined = actual.records.find(row => row.factRef === change.factRef && row.unitRef === change.unitRef && row.revisionRef === change.revisionRef);
    assert.ok(record);
    const payload = change.kind === "delivery" ? board.fieldings.find(row => row.exposureId === change.factRef)
      : board.methodExperienceFacts?.find(row => row.factId === change.factRef)
        ?? board.feedbacks.find(row => row.observation?.observationId === change.factRef && row.observation.revision === 1)?.observation;

    assert.ok(payload);
    assert.equal(record.payloadJson, canonicalJson(payload));
    assert.deepEqual(record.sourceRefs, change.sourceRefs);
    const unit = readOrganizationNativeFeedbackUnit(actual, change);
    assert.equal(unit.kind, "found");
    assert.deepEqual(unit.payload, JSON.parse(canonicalJson(payload)));
    assert.deepEqual(unit.sourceRefs, [...new Set([change.factRef, change.unitRef, change.revisionRef, ...change.sourceRefs])].sort());
    assert.equal(unit.sourceRefs.includes(actual.sourceRef), false, "a frame wrapper revision is not original unit content");
  }

  const assessment = actual.records.find(row => row.kind === "method_assessment");
  assert.ok(assessment);
  assert.equal(assessment.exposureId, `exposure:${childId}`);
  assert.equal(assessment.revision, 1);
  const canonical = canonicalObservations(board.feedbacks.flatMap(row => row.observation === undefined ? [] : [row.observation]))
    .find(row => row.observationId === assessment.factRef);
  assert.ok(canonical);
  const writers = [...new Set(board.feedbacks.flatMap(row => row.observation === canonical && row.exposureId !== undefined ? [row.exposureId] : []))];

  assert.equal(writers.length, 1);
  assert.equal(assessment.unitRef, writers[0]);
  assert.equal(assessment.exposureId, writers[0]);
  assert.equal(assessment.revisionRef, `${canonical.observationId}:revision:${canonical.revision}`);
  const directChange = changes.find(row => row.issueId === "issue:method:foreign" && row.kind === "delivery");
  assert.ok(directChange);
  const directLegacy = methodCentralFeedbackFromBoard(board, { scope, issueId: directChange.issueId });
  assert.ok(directLegacy);
  const direct = methodCentralFeedbackFromBoard(board, { scope, issueId: directChange.issueId, nativeChanges: [directChange] });
  assert.ok(direct);
  assert.equal(direct.records.length, directLegacy.records.length, "adding an exact-unit alias keeps legacy semantic row count");
  const directUnit = readOrganizationNativeFeedbackUnit(direct, directChange);
  assert.equal(directUnit.kind, "found");
  assert.deepEqual(directUnit.payload, JSON.parse(canonicalJson(board.fieldings.find(row => row.exposureId === directChange.factRef))));
  assert.equal(directLegacy.records.find(row => row.factRef === directChange.factRef)?.unitRef, undefined,
    "without metadata the original semantic frame remains unchanged");
  assert.equal(actual.records.some(row => row.kind === "method_review" || row.kind === "method_behavior_revision"), false);
  const foreign = changes.filter(row => row.issueId === "issue:method:foreign").map(row => ({ ...row, issueId }));

  assert.equal(foreign.length, 4);
  assert.deepEqual(methodCentralFeedbackFromBoard(board, { scope, issueId, nativeChanges: foreign })?.records, legacy.records,
    "a real foreign unit cannot acquire ownership from a supplied issueId");

  for (const nativeChanges of [owned.map(row => ({ ...row, revisionRef: `${row.revisionRef}:forged` })),
    owned.map(row => ({ ...row, sourceRefs: [...row.sourceRefs, "unrelated:source"] }))]) {
    assert.deepEqual(methodCentralFeedbackFromBoard(board, { scope, issueId, nativeChanges })?.records, legacy.records);
  }

  assert.equal(methodCentralFeedbackFromBoard(board, { scope: "D:/foreign", issueId, nativeChanges: owned }), undefined);
}));
