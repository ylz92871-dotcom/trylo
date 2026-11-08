import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { testScratchPath } from "../../../testing/scratch.js";
import { createCentralRuntimeSource } from "../../../integration/central-learning/runtime-source.js";
import type { LearningIssue } from "../../control/coordination-contract.js";
import { contentHashOf } from "../../control/hash.js";
import { emptyBoardState, type BoardState } from "../../control/state.js";
import type { RewardV2Fact } from "../../reward/v2-facts.js";
import type { CentralCompletedOperation, CentralRuntimeSourcePort } from "./contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef, readCentralRuntimeRecords,
  type CentralOpportunityConsideration, type CentralRuntimeRecordInput } from "./records.js";

const scope = "workspace:opportunity-consideration";
const at = "2026-11-05T00:00:00.000Z";
const record = (sequence: number, input: CentralRuntimeRecordInput): RewardV2Fact => ({
  ...buildCentralRuntimeRecord(input), sequence,
});

function issue(index: number): LearningIssue {
  const issueId = `issue:opportunity:${index}`;
  return { schemaVersion: 1, issueId, scope, problemKey: `problem:opportunity:${index}`, revision: 1,
    createdAt: at, updatedAt: at, decision: { kind: "unreviewed" },
    reports: [{ reportId: `report:opportunity:${index}`,
      source: { subsystem: "tool", taskId: `task:opportunity:${index}`, versionId: `version:opportunity:${index}` },
      facts: [`Original source statement ${index}`], hypotheses: [], evidenceRefs: [`evidence:opportunity:${index}`] }] };
}

test("successful actual opportunity consideration survives cold compaction without acknowledging an unread notice", () => {
  const empty = emptyCentralRuntimeState(scope);
  const legacy = record(1, { previousRef: initialCentralRuntimeRef(scope), state: empty,
    reason: "legacy_snapshot_without_opportunity_metadata", sourceRefs: [] });
  const bodyRef = `central-runtime-issue:${contentHashOf({ originalIssue: "skill:opportunity" })}`;
  const noticeRef = bodyRef.replace("central-runtime-issue:", "central-runtime-issue-notice:");
  const resultRef = `central-deliberation-result:${contentHashOf({ explanation: "Wait for actual use" })}`;
  const unknown: CentralCompletedOperation = { intentId: "central:agenda", operation: { kind: "think",
    operationId: "central-interpret:original-worker-return", purpose: "Interpret the actual original worker return",
    expectedChange: "Return the complete current agenda", sourceRefs: ["source:worker-return"] },
    outcome: "unknown", resultRefs: [], publicResult: "The original response is not confirmed" };
  const issued = record(2, { previousRef: legacy.id, state: { ...empty, completed: [unknown] },
    reason: "central_deliberation_issued", sourceRefs: unknown.operation.sourceRefs });
  const returned: CentralCompletedOperation = { ...unknown, outcome: "returned", resultRefs: [resultRef],
    publicResult: "The complete agenda retains the actual-use wait" };
  const agenda: CentralRuntimeRecordInput = { previousRef: issued.id, state: { ...empty, completed: [returned] },
    reason: "central_deliberation_returned", sourceRefs: [resultRef] };
  const consideration: CentralOpportunityConsideration = { operationId: unknown.operation.operationId,
    deliveryRef: `central-deliberation-delivery:${contentHashOf({ originalRequest: "interpret" })}`,
    resultRef, sourceRefs: [bodyRef] };

  const legacyReturned = record(3, agenda);
  const oldRead = readCentralRuntimeRecords([legacy, issued, legacyReturned], scope, 3);

  assert.equal(oldRead.state.completed[0]?.outcome, "returned", "a successful old snapshot needs no new optional field");
  assert.ok(!oldRead.history.consideredSourceRefs?.includes(bodyRef), "an absent original opportunity list cannot be reconstructed from an old snapshot");

  const successful = record(3, { ...agenda, opportunityConsideration: consideration });
  const compacted = record(4, { previousRef: successful.id, state: empty,
    reason: "compact_already_archived_completed_work", sourceRefs: [] });
  const cold = readCentralRuntimeRecords([legacy, issued, successful, compacted], scope, 4);

  assert.deepEqual(cold.state.completed, []);
  assert.deepEqual(cold.state.materials, []);
  assert.ok(cold.history.consideredSourceRefs?.includes(bodyRef));
  assert.deepEqual(cold.history.consideredDeliveries, [{ ...consideration, factRef: successful.id, sequence: 3 }],
    "cold replay retains the original successful agenda's receipt binding without a new persisted schema");
  assert.deepEqual(oldRead.history.consideredDeliveries, [], "an old agenda without an original receipt locator gains no invented frontier");
  assert.ok(!cold.history.consideredSourceRefs?.includes(noticeRef));
  assert.deepEqual(cold.history.consumedSourceRefs, [], "considering an opportunity never manufactures a body or notice read acknowledgement");

  const rejectsBinding = (candidate: CentralRuntimeRecordInput) => assert.throws(() => {
    readCentralRuntimeRecords([legacy, issued, record(3, candidate)], scope, 3);
  }, /central_runtime_opportunity_consideration_binding/);

  rejectsBinding({ ...agenda, state: { ...empty, completed: [unknown] }, opportunityConsideration: consideration });
  rejectsBinding({ ...agenda, opportunityConsideration: { ...consideration, resultRef: "result:another-response" } });
  rejectsBinding({ ...agenda, opportunityConsideration: { ...consideration, operationId: "operation:another-thought" } });
  const carried = record(4, { ...agenda, previousRef: successful.id, opportunityConsideration: consideration });

  assert.throws(() => readCentralRuntimeRecords([legacy, issued, successful, carried], scope, 4),
    /central_runtime_opportunity_consideration_binding/, "carrying a previously returned thought is not another successful complete agenda");
});

test("considered opportunity addresses leave room for the next original issue while reads and new revisions remain available", async () => {
  const originals = Array.from({ length: 33 }, (_, index) => issue(index));
  let state: BoardState = { ...emptyBoardState(), sequence: 33, learningIssues: originals };
  const source = createCentralRuntimeSource({ boardRoot: mkdtempSync(testScratchPath("central-opportunity-consideration-board-")), scope, ports: [], enabled: () => true,
    board: { async load() { return { ok: true, state, generation: 1 }; } } });
  const signal = new AbortController().signal;
  type Query = NonNullable<Parameters<CentralRuntimeSourcePort["snapshot"]>[2]>;
  const initial = await source.snapshot(scope, signal, { subjects: [], sourceRefs: [] });

  assert.equal(initial.opportunities.length, 32);
  assert.equal(initial.hasMore, true);
  const consideredSourceRefs = initial.opportunities.map(row => row.sourceRef);
  const query: Query = { subjects: [], sourceRefs: [], consideredSourceRefs };
  const next = await source.snapshot(scope, signal, query);

  assert.deepEqual(next.opportunities.map(row => row.subject.plane === "agent" ? row.subject.issueId : null),
    [originals[32]!.issueId], "the first 32 considered but unread notices must not hide the 33rd new issue");
  assert.equal(next.hasMore, false, "the source directory must not count old considered addresses as unread discovery backlog");
  assert.deepEqual(query.sourceRefs, [], "discovery fairness must not advance the read cursor");
  assert.ok(initial.sourceRefs.every(ref => !next.sourceRefs.includes(ref)), "old notice identities remain unacknowledged rather than being delivered again");

  const originalBodyRef = consideredSourceRefs[0]!;
  const originalBody = await source.read(scope, [originalBodyRef], 12000, signal);

  assert.equal(originalBody[0]?.ref, originalBodyRef);
  assert.deepEqual(JSON.parse(originalBody[0]!.text).reports, originals[0]!.reports,
    "consideration never revokes exact reading of the original report");

  const first = originals[0]!;
  const revised: LearningIssue = { ...first, revision: 2, updatedAt: "2026-11-05T00:01:00.000Z",
    reports: [...first.reports, { reportId: "report:opportunity:0:correction",
      source: { subsystem: "tool", taskId: "task:opportunity:0:correction", versionId: "version:opportunity:0:correction" },
      facts: ["A new original report changes the receiver premise"], hypotheses: [], evidenceRefs: ["evidence:actual-correction"] }] };

  state = { ...state, sequence: 34, learningIssues: [revised, ...originals.slice(1)] };
  const changed = await source.snapshot(scope, signal, query);
  const revisedOpportunity = changed.opportunities.find(row => row.subject.plane === "agent" && row.subject.issueId === revised.issueId);

  assert.ok(revisedOpportunity);
  assert.notEqual(revisedOpportunity.sourceRef, originalBodyRef, "a new report digest is a fresh opportunity even for the same original issue");
  assert.deepEqual(JSON.parse((await source.read(scope, [revisedOpportunity.sourceRef], 12000, signal))[0]!.text).reports, revised.reports);

  const subject = { plane: "agent", domain: "tool", issueId: revised.issueId } as const;
  const relatedQuery: Query = { subjects: [subject], sourceRefs: [],
    consideredSourceRefs: [...consideredSourceRefs, revisedOpportunity.sourceRef] };

  for (const decision of ["ordinary_execution", "resolved"] as const) {
    const governed: LearningIssue = { ...revised, decision: { kind: decision, reason: `PA chose ${decision}`,
      sourceRefs: [revised.reports[0]!.reportId], decidedAt: at, revision: 3 } };

    state = { ...state, sequence: state.sequence + 1, learningIssues: [governed, ...originals.slice(1)] };
    const constrained = await source.snapshot(scope, signal, relatedQuery);
    const authoritative = constrained.reconsider?.find(row => row.reason === "PA_current_ordinary_or_resolved_constraint_requires_review");

    assert.ok(authoritative, `consideration cannot hide the PA ${decision} constraint`);
    assert.deepEqual(authoritative.subject, subject);
    assert.ok(authoritative.sourceRefs.some(ref => ref.startsWith("central-runtime-constraint:")));
    assert.ok(constrained.materials.some(row => row.text.includes(`PA chose ${decision}`)));
  }
});
