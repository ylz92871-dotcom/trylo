import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../learning/control/state.js";
import type { BoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { createCentralPursuitObservationDraft, readCentralPursuitObservations } from "./pursuit-observations.js";
import type { CentralPursuitObservationDraft } from "./pursuit-observations.js";
import { buildCentralPursuitQualificationRevisionDraft } from "./pursuit-revision.js";
import type { CentralPursuitQualificationReview } from "./pursuit-revision.js";

const scope = "workspace:qualification-revision", date = "2026-11-04T15:00:00.000Z";

function write(board: BoardState, fact: RewardV2Draft): BoardState {
  const next = reduce(board, { type: "record_reward_v2_fact", commandId: `revision-contract:${board.sequence}`,
    issuedAt: date, expectedSequence: board.sequence, fact });
  if (!next.ok) assert.fail(JSON.stringify(next));
  return next.state;
}

function fixture(modeled = true) {
  const original: CentralPursuitObservationDraft = { unitId: "unit:original-stage", scope, conditionRef: "condition:original",
    objective: { instanceId: "objective:original", criterion: "checker_verified", definitionRef: "criterion:frozen-v1",
      familyRef: "family:original", familySourceRef: "protocol:original", ...(modeled ? {
        resourceModel: { kind: "shared_or_exact_treatment" as const, sourceRef: "source:original-model" } } : {}) },
    grantId: "grant:original", stageRef: "stage:original-frame", sourceRef: "receipt:pending-original",
    revisionRef: "revision:pending-original", outcome: "pending", ...(modeled ? { treatmentRef: "treatment:original-exact-offer" } : {}) };
  const draft = createCentralPursuitObservationDraft(original);
  if (draft.status !== "ready") assert.fail(draft.reason);

  return { board: write(emptyBoardState(), draft.value), scope, unitId: original.unitId,
    expectedHeadFactId: draft.value.id, original };
}

function review(outcome: "qualified" | "closed_no_result" | "pending" = "qualified"):
  Extract<CentralPursuitQualificationReview, { kind: "original_criterion_review" }> {
  return { kind: "original_criterion_review", definitionRef: "criterion:frozen-v1", frameRef: "stage:original-frame",
    origin: "external_checker", outcome, sourceRef: "checker:immutable-review-v1", evidenceRefs: ["evidence:original-criterion-verdict"] };
}

function request(source: ReturnType<typeof fixture>, verdict: CentralPursuitQualificationReview = review()) {
  return buildCentralPursuitQualificationRevisionDraft({ board: source.board, scope, unitId: source.unitId,
    expectedHeadFactId: source.expectedHeadFactId, review: verdict });
}

test("original-criterion review preserves the frozen unit, model and resource treatment through the original writer", () => {
  const source = fixture(), before = JSON.stringify(source.board), result = request(source);
  if (result.status !== "ready") assert.fail(JSON.stringify(result));

  assert.equal(result.previousHeadFactId, source.expectedHeadFactId);
  assert.equal(result.previous.outcome, "pending");
  const board = write(source.board, result.draft), decoded = readCentralPursuitObservations(board, scope);
  if (decoded.status !== "ready") assert.fail(decoded.reason);

  assert.equal(decoded.observations.length, 1);
  const current = decoded.observations[0]!;

  assert.equal(current.unitId, source.unitId);
  assert.equal(current.grantId, source.original.grantId);
  assert.equal(current.stageRef, source.original.stageRef);
  assert.equal(current.conditionRef, source.original.conditionRef);
  assert.deepEqual(current.objective, source.original.objective);
  assert.equal(current.treatmentRef, source.original.treatmentRef);
  assert.equal(current.outcome, "qualified");
  assert.equal(current.sourceRef, review().sourceRef);
  assert.notEqual(current.revisionRef, source.original.revisionRef);
  assert.equal(current.sequence, board.sequence);
  assert.equal(JSON.stringify(source.board), before);
});

test("a later review of today's expanded criterion or another frame cannot relabel the original stage", () => {
  const source = fixture();

  for (const verdict of [{ ...review(), definitionRef: "criterion:expanded-v2" }, { ...review(), frameRef: "stage:another-frame" }]) {
    assert.deepEqual(request(source, verdict), { status: "invalid", reason: "pursuit_qualification_frozen_frame_mismatch" });
  }

  for (const origin of ["domain_receipt", "external_checker", "user_original_criterion"] as const) {
    assert.equal(request(source, { ...review(), origin }).status, "ready");
  }
});

test("new requirements and unresolved interpretations remain separate from a qualification correction", () => {
  const source = fixture();

  for (const kind of ["new_requirements", "unresolved"] as const) {
    assert.deepEqual(request(source, { kind, sourceRef: "feedback:new-or-unresolved", evidenceRefs: ["evidence:user-report"] }),
      { status: "no_revision", reason: kind });
  }

  assert.deepEqual(request(source, { ...review(), evidenceRefs: ["evidence:one", "evidence:one"] }),
    { status: "invalid", reason: "pursuit_qualification_review_input" });
});

test("a correction must address the effective original head rather than an old observation or missing unit", () => {
  const source = fixture(), correction = request(source);
  if (correction.status !== "ready") assert.fail(JSON.stringify(correction));

  const changed = { ...source, board: write(source.board, correction.draft) };

  assert.deepEqual(request(changed), { status: "stale", reason: "pursuit_qualification_head_changed" });
  const missing = buildCentralPursuitQualificationRevisionDraft({ board: changed.board, scope,
    unitId: "unit:missing", expectedHeadFactId: correction.draft.id, review: review() });

  assert.deepEqual(missing, { status: "invalid", reason: "pursuit_qualification_unit_missing" });
  const repeated = request({ ...changed, expectedHeadFactId: correction.draft.id });

  assert.deepEqual(repeated, { status: "no_revision", reason: "pursuit_qualification_unchanged" });
});

test("old flat pending evidence becomes a qualified effective head of the same trial", () => {
  const source = fixture(false), result = request(source);
  if (result.status !== "ready") assert.fail(JSON.stringify(result));

  assert.equal(result.draft.algorithmVersion, "central-pursuit-outcome-v1");
  const decoded = readCentralPursuitObservations(write(source.board, result.draft), scope);
  if (decoded.status !== "ready") assert.fail(decoded.reason);

  assert.deepEqual(decoded.observations.map(row => [row.unitId, row.objective.instanceId, row.outcome]),
    [[source.unitId, source.original.objective.instanceId, "qualified"]]);
  assert.equal(decoded.observations[0]?.treatmentRef, undefined);
  assert.equal(decoded.observations[0]?.objective.resourceModel, undefined);
});

test("unrelated Board progress is not a new verdict or qualification revision", () => {
  const source = fixture(), unchanged = { ...review("pending"), sourceRef: source.original.sourceRef };
  const before = readCentralPursuitObservations(source.board, scope);
  const board = write(source.board, { id: "other-owner:progress", scope, kind: "projection", algorithmVersion: "other-owner-v1", payloadJson: "{}" });
  const after = readCentralPursuitObservations(board, scope);
  if (before.status !== "ready" || after.status !== "ready") assert.fail("canonical_source_read_required");

  assert.notEqual(before.sourceRef, after.sourceRef);
  assert.deepEqual(request(source, unchanged), { status: "no_revision", reason: "pursuit_qualification_unchanged" });
  assert.deepEqual(request({ ...source, board }, unchanged), { status: "no_revision", reason: "pursuit_qualification_unchanged" });
});
