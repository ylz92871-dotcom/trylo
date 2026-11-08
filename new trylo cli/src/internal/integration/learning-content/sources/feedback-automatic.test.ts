import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../../ports/session.js";
import { emptyBoardState } from "../../../learning/control/state.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import type { RewardExposure, RewardFeedback } from "../../../learning/reward/contracts.js";
import { decodeFeedbackSource } from "../../reward/explanation-source.js";
import { readAutomaticContentFeedback } from "./feedback-automatic.js";
import { sessionContentRecordRef } from "./session.js";

const at = "2026-11-04T12:00:00Z", scope = "workspace";

function fixture() {
  const envelope = (sequence: number, kind: string, payload: SessionRecord["payload"]): SessionRecord => ({
    formatVersion: "1", sequence, type: "envelope", sessionId: "session", turnId: "first-task", at,
    payload: { envelope: { protocolVersion: "0.0", sequence, producerSequence: sequence, eventId: `evt-${sequence}`,
      producerId: "loop", timestamp: at, sessionId: "session", turnId: "first-task", attemptId: "attempt", kind, payload } } });
  const records: SessionRecord[] = [
    { formatVersion: "1", sequence: 0, type: "session_start", sessionId: "session", at,
      payload: { fingerprint: { schemaVersion: "1", workspaceId: "workspace", providerId: "fixture", model: "fixture", toolCatalogHash: "catalog" } } },
    { formatVersion: "1", sequence: 1, type: "turn_input", sessionId: "session", turnId: "first-task", at, payload: { text: "Diagnose whether the item is absent." } },
    { formatVersion: "1", sequence: 2, type: "transcript_item", sessionId: "session", turnId: "first-task", at,
      payload: { kind: "tool_call", sequence: 0, toolCallId: "call", name: "learned__search", arguments: { input: { q: "item" } } } },
    envelope(3, "tool_use", { toolCallId: "call", name: "learned__search" }),
    envelope(4, "tool_result", { toolCallId: "call", status: "failed" }),
    envelope(5, "terminal", { reason: "completed" }),
    { formatVersion: "1", sequence: 6, type: "terminal", sessionId: "session", turnId: "first-task", at,
      payload: { reason: "completed", usage: { totalTokens: 12 } } },
    { formatVersion: "1", sequence: 7, type: "turn_input", sessionId: "session", turnId: "next-task", at,
      payload: { text: "The nonzero result was expected; keep the original diagnostic goal." } },
  ];
  const decoded = decodeFeedbackSource({ records, tornTail: false }, "session");

  assert.ok(decoded.ok);
  const binding = decoded.source.bindings[0]!;
  const target = { kind: "tool", id: "learned__search", version: "environment" };
  const exposure: RewardExposure = { schemaVersion: 1, id: binding.exposureId!, source: binding.source,
    context: { scope, taskFamily: "tool_execution", environment: "environment", metric: {
      id: "execution.tool_result", version: "1", unit: "status", minimum: -1, maximum: 1, preference: "higher" } },
    targets: [target], occurredAt: 1, predictions: [{ target, estimate: { mean: 0, variance: 1 } }] };
  const old: RewardFeedback = { schemaVersion: 1, id: "user-before", exposureId: exposure.id,
    source: { ...binding.source, eventId: "old-user-fact" }, origin: "user", evidenceIds: ["old-user-evidence"],
    outcome: { kind: "measured", value: -1, confidence: 1, noiseVariance: 1 },
    attribution: { kind: "unresolved" }, observedAt: 2 };
  const corrected: RewardFeedback = { ...old, id: "user-after", source: { ...old.source, eventId: "late-user-fact" },
    outcome: { kind: "measured", value: 1, confidence: 1, noiseVariance: 1 }, observedAt: 3,
    evidenceIds: [sessionContentRecordRef("session", 7)], supersedes: old.id };
  const content = { role: "tool body" };
  const board = { ...emptyBoardState(), sequence: 10,
    assets: [{ versionId: "tool-version", kind: "tool_package" as const, schemaVersion: 1, content, contentHash: contentHashOf(content),
      source: "inferred" as const, scope, createdAt: at, createdFromProposalId: "proposal" }],
    jobs: [{ jobId: "job", observationId: "observation", domain: "tool" as const, scope, state: "succeeded" as const,
      attempt: 1, maxAttempts: 1, breakerOpen: false, dedupeKey: "job", coordination: {
        issueId: "issue", grantId: "grant", resultRefs: ["tool-version"] } }],
    learningIssues: [{ schemaVersion: 1 as const, issueId: "issue", scope, problemKey: "diagnostic", revision: 1, reports: [],
      decision: { kind: "focused_learning" as const, reason: "investigate", sourceRefs: [], decidedAt: at, revision: 1 }, createdAt: at, updatedAt: at }],
    toolUses: [{ schemaVersion: 1 as const, useId: "actual-use", versionId: "tool-version", scope: "source-tool-scope", sessionId: "session",
      toolCallId: "call", workspaceId: "workspace", contentHash: contentHashOf(content), inputHash: contentHashOf({ q: "item" }),
      execution: "tool_error" as const, quality: "unverified" as const, occurredAt: at }],
    rewardExposures: [exposure], rewardFeedbacks: [old, corrected] };

  return { board, view: { records, tornTail: false }, scope, domain: "tool" as const, issueId: "issue", sessionId: "session", enabled: () => true };
}

test("normal journal and Board receipts automatically recover issue, adopted version, bill and late feedback", async () => {
  const input = fixture(), before = JSON.stringify(input);
  const read = await readAutomaticContentFeedback(input);

  assert.ok(read.ok);
  assert.equal(read.value.adoption.adoptions.length, 1);
  assert.equal(read.value.adoption.adoptions[0]!.basis, "tool_use");
  assert.deepEqual(read.value.adoption.adoptions[0]!.artifact.issueIds, ["issue"]);
  const row = read.value.projection.rows[0]!;

  assert.equal(row.link.issueId, "issue");
  assert.deepEqual(row.link.artifactRefs, [{ ref: "tool-version", version: "tool-version" }]);
  assert.equal(row.association.status, "linked");
  assert.equal(row.report.status === "available" && row.report.unit.status, "failure");
  assert.equal(row.taskResult.status, "unknown", "completed lifecycle is not a task quality verdict");
  assert.equal(row.learningGain.status, "unknown");
  assert.equal(row.cost.status, "observed");
  assert.deepEqual(row.observations.filter(item => item.observation.kind === "user_correction").map(item => item.state), ["superseded", "active"]);
  assert.ok(read.value.batch.records.some(record => record.ref === sessionContentRecordRef("session", 7)
    && record.text === "The nonzero result was expected; keep the original diagnostic goal."));
  assert.ok(read.value.batch.materials.some(material => material.context.includes("later_user_input_unassigned")));
  assert.ok(read.value.batch.records.some(record => record.text.includes('"targetKnown":false')));
  const earlier = await readAutomaticContentFeedback({ ...input, board: { ...input.board, sequence: 9,
    rewardFeedbacks: input.board.rewardFeedbacks.slice(0, 1) } });

  assert.ok(earlier.ok);
  assert.equal(earlier.value.adoption.adoptions[0]!.ref, read.value.adoption.adoptions[0]!.ref,
    "late feedback cannot manufacture a second adoption identity");
  const bookkeeping = await readAutomaticContentFeedback({ ...input, board: { ...input.board, sequence: input.board.sequence + 1 } });

  assert.ok(bookkeeping.ok);
  assert.deepEqual(bookkeeping.value.batch.records.filter(record => record.ref.startsWith("content-adoption-feedback:")).map(record => record.ref),
    read.value.batch.records.filter(record => record.ref.startsWith("content-adoption-feedback:")).map(record => record.ref),
    "an unrelated Board-prefix advance cannot manufacture a new actual-adoption source identity");
  assert.equal(JSON.stringify(input), before);
});

test("disabled or corrupt sources and missing origin lineage cannot manufacture adopted knowledge", async () => {
  const input = fixture();

  assert.deepEqual(await readAutomaticContentFeedback({ ...input, enabled: () => false }), { ok: false, reason: "collect_disabled" });
  const corrupted = { ...input, view: { ...input.view, records: input.view.records.map((record, index) => index === 4 ? { ...record, sequence: 99 } : record) } };
  const read = await readAutomaticContentFeedback(corrupted);

  assert.equal(read.ok, false);
  const unrelated = await readAutomaticContentFeedback({ ...input, board: { ...input.board, jobs: [] } });

  assert.ok(unrelated.ok);
  assert.equal(unrelated.value.projection.rows.length, 0, "actual tool adoption without a recorded originating issue does not invent one");
  assert.equal(unrelated.value.adoption.adoptions.length, 0, "focused retrieval excludes unrelated origin mappings");
});

test("explicit late user feedback from an old session reaches the next session without changing its report cohort", async () => {
  const old = fixture();
  const original = old.board.rewardExposures[0]!;
  const target = { kind: "tool", id: "tool-version", version: "tool-version" };
  const board = { ...old.board, rewardExposures: [{ ...original, targets: [target], predictions: [{ target, estimate: { mean: 0, variance: 1 } }] }] };
  const records: SessionRecord[] = [
    { ...old.view.records[0]!, sessionId: "new-session" },
    { ...old.view.records[7]!, sessionId: "new-session", turnId: "new-task", sequence: 1,
      payload: { text: "Use the corrected original diagnostic interpretation." } },
  ];
  const read = await readAutomaticContentFeedback({ ...old, board, sessionId: "new-session", view: { records, tornTail: false } });

  assert.ok(read.ok);
  assert.equal(read.value.projection.reported?.population, 0);
  assert.ok(read.value.batch.records.some(row => row.text.includes("user-after") && row.text.includes("old-user-fact")),
    "the new view has no old tool binding, but canonical old-session user revision and its superseded head still must be transported");
});
