import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../../ports/session.js";
import { readFeedbackExplanation } from "../../../integration/reward/explanation-reader.js";
import { decodeFeedbackSource } from "../../../integration/reward/explanation-source.js";
import { emptyBoardState } from "../../control/state.js";
import type { RewardExposure, RewardFeedback } from "../../reward/contracts.js";
import type { ContentFeedbackObservation, FeedbackContentLink } from "./feedback-contracts.js";
import { buildContentFeedbackProjection } from "./feedback.js";

const at = "2026-11-04T11:00:00Z";

function records(): SessionRecord[] {
  const envelope = (sequence: number, kind: string, payload: SessionRecord["payload"]): SessionRecord => ({
    formatVersion: "1", sequence, type: "envelope", sessionId: "session", turnId: "turn", at,
    payload: { envelope: { protocolVersion: "0.0", sequence, producerSequence: sequence, eventId: `evt-${sequence}`,
      producerId: "loop", timestamp: at, sessionId: "session", turnId: "turn", attemptId: "attempt", kind, payload } } });
  return [{ formatVersion: "1", sequence: 0, type: "session_start", sessionId: "session", at,
    payload: { fingerprint: { schemaVersion: "1", workspaceId: "workspace", providerId: "fixture", model: "fixture", toolCatalogHash: "tools" } } },
  envelope(1, "tool_use", { toolCallId: "diagnostic", name: "search" }),
  envelope(2, "tool_use", { toolCallId: "pending", name: "read" }),
  envelope(3, "tool_result", { toolCallId: "diagnostic", status: "failed" }),
  envelope(4, "tool_result", { toolCallId: "pending", status: "success" })];
}

async function fixture() {
  const raw = records();
  const sourceView = decodeFeedbackSource({ records: raw, tornTail: false }, "session", 2);

  assert.ok(sourceView.ok);
  const binding = sourceView.source.bindings[0]!;
  const target = { kind: "method", id: "asset", version: "v1" };
  const exposure: RewardExposure = { schemaVersion: 1, id: binding.exposureId!, source: binding.source,
    context: { scope: "workspace", taskFamily: "diagnostic", environment: "env1",
      metric: { id: "status", version: "1", unit: "status", minimum: -1, maximum: 1, preference: "higher" } },
    targets: [target], occurredAt: 1, predictions: [{ target, estimate: { mean: 0, variance: 1 } }] };
  const old: RewardFeedback = { schemaVersion: 1, id: "old", exposureId: exposure.id,
    source: { ...binding.source, eventId: "old-feedback" }, origin: "user", evidenceIds: ["audit-old"],
    outcome: { kind: "measured", value: -1, confidence: 1, noiseVariance: 1 },
    attribution: { kind: "linked", shares: [{ target, share: 1 }] }, observedAt: 2 };
  const revised: RewardFeedback = { ...old, id: "new", source: { ...old.source, eventId: "new-feedback" },
    supersedes: old.id, evidenceIds: ["audit-new"], observedAt: 4,
    outcome: { kind: "measured", value: 1, confidence: 1, noiseVariance: 1 } };
  const read = await readFeedbackExplanation({ enabled: () => true, sessionId: "session", through: 2, delta: 0.05,
    source: { readRecords: async () => ({ ok: true, view: { records: raw, tornTail: false } }) },
    board: { load: async () => ({ ok: true, generation: 0, state: { ...emptyBoardState(), sequence: 8,
      rewardExposures: [exposure], rewardFeedbacks: [old, revised] } }) } });

  assert.ok(read.ok);
  const link: FeedbackContentLink = { issueId: "issue", scope: "workspace", domain: "method", topicId: "topic",
    artifactRefs: [{ ref: "asset", version: "v1" }], requirementRefs: ["req-v1"], unitId: binding.unit.unitId,
    exposureId: exposure.id, source: binding.source };
  const base = { issueId: link.issueId, unitId: link.unitId, source: link.source,
    observationSource: { ...link.source, eventId: "audit-arrival" }, evidenceRefs: ["audit"], observedAt: 10 };
  const observations: readonly ContentFeedbackObservation[] = [
    { ...base, id: "task", kind: "task_result", requirementRef: "req-v1", measurementRef: "diagnostic-check", result: "success" },
    { ...base, id: "cost", kind: "cost", quantity: 7, unit: "tokens", metricRef: "provider-output", measurementRef: "usage-receipt" },
    { ...base, id: "correction-old", kind: "user_correction", text: "original judgement", targetRef: "asset", targetRole: "unspecified" },
    { ...base, id: "correction-new", kind: "user_correction", supersedes: "correction-old", observedAt: 20,
      text: "failure was the expected diagnostic", targetRef: "asset", targetRole: "same_requirement" },
    { ...base, id: "gain-claim", kind: "learning_gain", value: 1, metricRef: "utility", comparison: { baselineRef: "base",
      treatmentRef: "candidate", requirementRef: "req-v1", windowRef: "window", conditionRef: "conditions",
      protocolRef: "comparison-protocol", measurementRefs: ["base-measurement", "candidate-measurement"] } }];

  return { read, link, observations };
}

test("real explanation read reaches issue/artifact materials without equating reports, results or gain", async () => {
  const input = await fixture();
  const before = JSON.stringify(input);
  const result = buildContentFeedbackProjection({ explanation: input.read, links: [input.link], observations: input.observations });
  const row = result.rows[0]!;

  assert.equal(row.association.status, "linked");
  assert.equal(row.report.status, "available");

  if (row.report.status === "available") assert.equal(row.report.unit.status, "failure");

  assert.deepEqual(row.taskResult, { status: "observed", observationIds: ["task"] });
  assert.deepEqual(row.cost, { status: "observed", observationIds: ["cost"] });
  assert.deepEqual(row.learningGain, { status: "unknown", reason: "no_identified_learning_gain", claimObservationIds: ["gain-claim"] });
  assert.equal(result.reported?.population, 2, "link filtering must not shrink the SFN cohort");
  assert.deepEqual([result.sourcePosition?.cohortThrough, result.sourcePosition?.observedThrough], [2, 4]);
  assert.deepEqual(result.boardPosition, { status: "available", revision: 8 });
  assert.equal(row.revision.status, "compared");

  if (row.revision.status === "compared") assert.deepEqual([row.revision.feedbackId, row.revision.supersedes], ["new", "old"]);

  assert.deepEqual(row.observations.filter(item => item.observation.kind === "user_correction").map(item => item.state), ["superseded", "active"]);
  assert.ok(row.questions.some(item => item.kind === "revision_target"));
  const material = result.materialRecords[0]!;

  assert.ok(material.sourceRefs.includes("req-v1"));
  assert.ok(material.sourceRefs.includes("audit"));
  assert.ok(material.text.includes("failure was the expected diagnostic"));
  assert.ok(material.text.includes("feedback_prefix_reconstruction_difference"));
  assert.equal(JSON.stringify(input), before);
});

test("mismatched source, unknown requirements, missing reads and late observations remain explicit", async () => {
  const { read, link, observations } = await fixture();
  const wrong = { ...link, source: { ...link.source, attemptId: "another-attempt" } };
  const mismatch = buildContentFeedbackProjection({ explanation: read, links: [wrong], observations });

  assert.deepEqual(mismatch.rows[0]!.association, { status: "unlinked", reason: "source_mismatch" });
  assert.equal(mismatch.rows[0]!.report.status, "unknown");
  assert.equal(mismatch.unlinkedObservations.length, observations.length);
  const changedRequirement = buildContentFeedbackProjection({ explanation: read, links: [{ ...link, requirementRefs: ["req-v2"] }], observations });

  assert.deepEqual(changedRequirement.rows[0]!.taskResult, { status: "unknown", reason: "requirement_not_bound" });
  const unavailable = buildContentFeedbackProjection({ explanation: { schemaVersion: 1, ok: false, reason: "source_unavailable" }, links: [link], observations });

  assert.equal(unavailable.status, "source_unavailable");
  assert.equal(unavailable.reported, null);
  assert.equal(unavailable.rows[0]!.taskResult.status, "unknown");
  assert.equal(unavailable.unlinkedObservations.length, observations.length);
  assert.ok(unavailable.materialRecords[0]!.text.includes("source_unavailable"));
});

test("ambiguous revisions and malformed externally supplied observations fail closed", async () => {
  const { read, link, observations } = await fixture();
  const input = { explanation: read, links: [link] };

  assert.throws(() => buildContentFeedbackProjection({ ...input, links: [link, link] }), /duplicate_content_feedback_link/);
  assert.throws(() => buildContentFeedbackProjection({ ...input, observations: [observations[3]!] }), /invalid_content_feedback_revision/);
  assert.throws(() => buildContentFeedbackProjection({ ...input, observations: [{ ...observations[1]!, kind: "cost",
    quantity: -1, unit: "tokens", metricRef: "usage", measurementRef: "receipt" }] }), /invalid_content_feedback_observation/);
  const malformed = { ...read, reported: { ...read.reported, population: 0 } };

  assert.throws(() => buildContentFeedbackProjection({ ...input, explanation: malformed }), /invalid_content_feedback_reported_population/);
});
