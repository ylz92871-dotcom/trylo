import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState, type BoardState } from "../../../learning/control/state.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import type { RewardExposure, RewardFeedback } from "../../../learning/reward/contracts.js";
import { createCentralPursuitObservationDraft, readCentralPursuitObservations,
  type CentralPursuitObservationDraft } from "../../learning-allocation/pursuit-observations.js";
import { locateContentObservationLineage, locateUserFeedbackObservationLineage } from "./observation-lineage.js";

const scope = "repo:observation-lineage", at = "2026-11-04T16:30:00Z";

function draft(observation: CentralPursuitObservationDraft) {
  const result = createCentralPursuitObservationDraft(observation);
  if (result.status !== "ready") assert.fail(result.reason);
  return result.value;
}

function fixture(secondStage = false) {
  const original: CentralPursuitObservationDraft = { unitId: "unit:one", scope, grantId: "grant", stageRef: "stage:one", conditionRef: "original-conditions",
    objective: { instanceId: "objective:one", criterion: "checker_verified", definitionRef: "original-checker-criterion",
      familyRef: "original-protocol", familySourceRef: "original-protocol-source" }, sourceRef: "asset:version", revisionRef: "revision:one", outcome: "pending" };
  const first = draft(original), head = draft({ ...original, sourceRef: "actual-checker-receipt", revisionRef: "revision:two", outcome: "qualified", supersedes: first.id });
  const facts = [first, head];

  if (secondStage) facts.push(draft({ ...original, unitId: "unit:two", stageRef: "stage:two",
    objective: { ...original.objective, instanceId: "objective:two", criterion: "adopted" }, outcome: "qualified" }));

  const source = { sessionId: "old-session", turnId: "old-task", attemptId: "old-attempt", eventId: "old-use" };
  const target = { kind: "tool", id: "asset:version", version: "asset:version" };
  const exposure: RewardExposure = { schemaVersion: 1, id: "use:asset", source,
    context: { scope, taskFamily: "actual-task", environment: "environment", metric: {
      id: "execution.tool_result", version: "1", unit: "status", minimum: -1, maximum: 1, preference: "higher" } },
    targets: [target], occurredAt: 1, predictions: [{ target, estimate: { mean: 0, variance: 1 } }] };
  const correction: RewardFeedback = { schemaVersion: 1, id: "late:user-correction", exposureId: exposure.id,
    source: { ...source, eventId: "actual-user-source" }, origin: "user", evidenceIds: ["actual-negative-user-evidence"],
    observedAt: 9, outcome: { kind: "measured", value: -1, confidence: 1, noiseVariance: 1 }, attribution: { kind: "unresolved" } };
  const content = { purpose: "the actual immutable tool artifact" };
  const board: BoardState = { ...emptyBoardState(), sequence: facts.length,
    rewardV2Facts: facts.map((fact, index) => ({ ...fact, sequence: index + 1 })),
    centralLearningGrants: [{ schemaVersion: 2, grantId: "grant", issueId: "original-issue", jobId: "job", scope, focusRevision: 1,
      domain: "tool", allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 },
      steps: 1, reservations: [], status: "closed", closedReason: "completed" }],
    jobs: [{ jobId: "job", observationId: "original-observation", domain: "tool", scope, state: "succeeded", attempt: 1, maxAttempts: 1,
      breakerOpen: false, dedupeKey: "job", coordination: { issueId: "original-issue", grantId: "grant", resultRefs: ["asset:version"] } }],
    assets: [{ versionId: "asset:version", kind: "tool_package", schemaVersion: 1, content, contentHash: contentHashOf(content),
      scope, source: "inferred", createdAt: at }], rewardExposures: [exposure], rewardFeedbacks: [correction] };

  return { board, original, first, head };
}

test("original result and automatically parsed user feedback locate the owner's current supersedes head without another observation", () => {
  const { board, head } = fixture(), before = JSON.stringify(board);
  const result = locateContentObservationLineage({ board, scope, issueId: "original-issue", resultRef: "asset:version", stageRef: "stage:one" });

  assert.equal(result.status, "unique");
  if (result.status !== "unique") assert.fail(JSON.stringify(result));

  assert.equal(result.match.unitId, "unit:one");
  assert.equal(result.match.headFactId, head.id);
  assert.equal(result.match.observation.sourceRef, "actual-checker-receipt");
  assert.equal(result.match.dispatchInput.status, "unknown", "a stageRef does not reconstruct the original frozen dispatch input");
  assert.ok(result.match.sourceRefs.includes("asset:version"), "the original result survives after the canonical head's sourceRef is corrected");
  const bookkeeping = locateContentObservationLineage({ board: { ...board, sequence: board.sequence + 1 }, scope,
    issueId: "original-issue", resultRef: "asset:version", stageRef: "stage:one" });

  assert.equal(bookkeeping.status, "unique");
  if (bookkeeping.status === "unique") assert.deepEqual(bookkeeping.match.sourceRefs, result.match.sourceRefs,
    "the owner's current Board-prefix projection is metadata, not a new original observation source");

  const feedback = locateUserFeedbackObservationLineage({ board, scope, feedbackId: "late:user-correction" });

  assert.equal(feedback.status, "unique");
  if (feedback.status !== "unique") assert.fail(JSON.stringify(feedback));

  assert.equal(feedback.match.headFactId, head.id);
  assert.equal(feedback.match.observation.outcome, "qualified",
    "a negative task/user result is only provenance for the criterion owner, not automatic invalidation of its checker objective");
  assert.ok(feedback.match.sourceRefs.includes("actual-negative-user-evidence"));
  const owner = readCentralPursuitObservations(board, scope);
  assert.equal(owner.status, "ready");

  if (owner.status === "ready") assert.equal(owner.observations.length, 1);

  assert.equal(JSON.stringify(board), before);
});

test("two real stages connected to an artifact stay ambiguous; explicit stage and original objective remain separate", () => {
  const { board } = fixture(true);
  const result = locateContentObservationLineage({ board, scope, artifactRef: "asset:version", version: "asset:version" });

  assert.equal(result.status, "ambiguous");
  if (result.status !== "ambiguous") assert.fail(JSON.stringify(result));

  assert.deepEqual(result.matches.map(row => row.stageRef), ["stage:one", "stage:two"]);
  assert.deepEqual(result.matches.map(row => row.objective.criterion), ["checker_verified", "adopted"]);
  const exact = locateUserFeedbackObservationLineage({ board, scope, feedbackId: "late:user-correction", stageRef: "stage:one" });

  assert.equal(exact.status, "unique");
  if (exact.status === "unique") assert.equal(exact.match.stageRef, "stage:one");
});

test("same scope and prose cannot supply a missing identity, and corrupt original-owner history is rejected", () => {
  const { board } = fixture();
  assert.equal(locateContentObservationLineage({ board, scope }).status, "unknown");
  assert.equal(locateContentObservationLineage({ board, scope, resultRef: "an unrelated result in this scope" }).status, "unknown");
  assert.equal(locateUserFeedbackObservationLineage({ board, scope, feedbackId: "not-a-recorded-user-fact" }).status, "unknown");
  const broken = { ...board, rewardV2Facts: [...board.rewardV2Facts!, board.rewardV2Facts![0]!] };
  assert.equal(locateContentObservationLineage({ board: broken, scope, issueId: "original-issue" }).status, "invalid");
});
