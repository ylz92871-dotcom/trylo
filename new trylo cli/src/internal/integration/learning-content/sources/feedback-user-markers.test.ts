import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord } from "../../../ports/session.js";
import { emptyBoardState } from "../../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../../learning/control/hash.js";
import { buildContentPacket } from "../../../learning/central/content/material.js";
import { compileContentProcess } from "../../../learning/central/content/process.js";
import { buildContentRecord } from "../records.js";
import { decodeSessionContent, sessionContentRecordView } from "./session-decode.js";
import { readAutomaticContentFeedback } from "./feedback-automatic.js";
import { readSessionContent } from "./session.js";
import { createTaskSourcePageReader } from "../task-source-pages.js";
import { extendContentStagePacket } from "../staged-material.js";
import { hasCandidateEnteredPacket, laterIssueUserInputCandidates, parseIssueUserInputBasis } from "./feedback-user-markers.js";

const scope = "repo:user-input-proof", at = "2026-11-04T17:00:00Z", issueId = "issue:user-input-proof";

function fixture() {
  const text = `${"Q".repeat(40000)}END_OF_REAL_USER_INPUT`;
  const records: SessionRecord[] = [
    { formatVersion: "1", sequence: 0, type: "session_start", sessionId: "session", at, payload: { fingerprint: {
      schemaVersion: "1", workspaceId: "workspace", providerId: "local", model: "local", toolCatalogHash: "catalog" } } },
    { formatVersion: "1", sequence: 1, type: "turn_input", sessionId: "session", turnId: "unrelated-old-turn", at, payload: { text: "An unrelated earlier user input." } },
    { formatVersion: "1", sequence: 2, type: "transcript_item", sessionId: "session", turnId: "adopted-turn", at, payload: { kind: "user", sequence: 0, text } },
    { formatVersion: "1", sequence: 3, type: "envelope", sessionId: "session", turnId: "adopted-turn", at, payload: { envelope: {
      protocolVersion: "0.0", sequence: 0, producerSequence: 0, eventId: "actual-request-event", producerId: "loop", timestamp: at,
      sessionId: "session", turnId: "adopted-turn", attemptId: "actual-attempt", kind: "usage", payload: { totalTokens: 1 } } } },
    { formatVersion: "1", sequence: 4, type: "turn_input", sessionId: "session", turnId: "later-turn", at, payload: { text: "A later request with no assumed correction sign." } },
  ];
  const content = { instruction: "An actual method source." };
  const focus = { schemaVersion: 1 as const, issueId, scope, problemKey: "source-proof", revision: 1,
    reports: [{ reportId: "original-report", source: { subsystem: "method" as const, taskId: "adopted-turn", versionId: "method-version" },
      facts: ["Preserve the original source conditions."], evidenceRefs: [] }],
    decision: { kind: "unreviewed" as const }, createdAt: at, updatedAt: at };
  const board = { ...emptyBoardState(), assets: [{ versionId: "method-version", kind: "prompt_patch" as const, schemaVersion: 1, content,
    contentHash: contentHashOf(content), source: "inferred" as const, scope, createdAt: at }], learningIssues: [focus],
    jobs: [{ jobId: "original-job", observationId: "obs", domain: "prompt" as const, scope, state: "succeeded" as const, attempt: 1,
      maxAttempts: 1, breakerOpen: false, dedupeKey: "original-job", coordination: { issueId, grantId: "grant", resultRefs: ["method-version"] } }],
    fieldings: [{ exposureId: "real-provider-fielding", versionId: "method-version", proposalId: "proposal", turnId: "adopted-turn", beat: 1,
      requestId: "actual-attempt", scope: "method:niche", recordedAt: at }] };

  return { board, scope, issueId, sessionId: "session", records, focus, text };
}

test("actual adoption associates same-turn-before-delivery and later user originals without a negative label or Board-time churn", () => {
  const input = fixture(), result = laterIssueUserInputCandidates(input);
  assert.equal(result.status, "ready");

  if (result.status !== "ready") assert.fail(JSON.stringify(result));

  assert.deepEqual(result.candidates.map(row => row.coordinate.sequence), [2, 4]);
  assert.ok(result.candidates.every(row => row.association === "unassigned_user_input_for_issue_review"));
  const first = result.candidates[0]!, marker = result.batch.records[0]!;

  assert.equal(first.originalSource, undefined);
  assert.equal(marker.text, canonicalJson({ schemaVersion: 1, type: "actual_user_input_source_basis", scope: first.scope,
    sourceRef: first.ref, sourceHash: first.sourceHash, sessionId: first.sessionId, turnId: first.turnId ?? null,
    coordinate: first.coordinate, totalChars: first.text.length, reviewedBy: first.reviewedBy }));
  assert.equal(parseIssueUserInputBasis(marker)?.sourceRef, first.ref, "clean v1 marker bytes and address remain compatible");
  const funded = laterIssueUserInputCandidates({ ...input, board: { ...input.board, sequence: input.board.sequence + 1 } });

  assert.equal(funded.status, "ready");
  if (funded.status === "ready") assert.equal(funded.sourceRef, result.sourceRef);
});

test("basis-only or one partial user chunk cannot wash an unseen source into reviewed; complete canonical entry survives later compaction", () => {
  const input = fixture(), initial = laterIssueUserInputCandidates(input);
  assert.equal(initial.status, "ready");

  if (initial.status !== "ready") assert.fail(JSON.stringify(initial));

  const candidate = initial.candidates.find(row => row.coordinate.sequence === 2)!;
  const markerOnly = buildContentPacket({ ...initial.batch, scope, domain: "prompt", boardSequence: 0, focus: input.focus });
  assert.ok(markerOnly.ok, markerOnly.ok ? "" : markerOnly.reason);
  assert.equal(hasCandidateEnteredPacket(markerOnly.value, candidate), false);
  const decoded = decodeSessionContent({ records: input.records, tornTail: false }, { sessionId: input.sessionId, turnId: "adopted-turn",
    scope, subsystem: "method", maximumChars: 65536 });
  assert.ok(decoded.ok);
  const full = buildContentPacket({ ...decoded.batch, scope, domain: "prompt", boardSequence: 0, focus: input.focus });
  assert.ok(full.ok);
  assert.equal(hasCandidateEnteredPacket(full.value, candidate), true);
  const first = full.value.records.find(row => row.ref === `${candidate.ref}:chunk:0`)!;
  assert.ok(first);
  const partial = buildContentPacket({ scope, domain: "prompt", boardSequence: 0, focus: input.focus,
    records: [first], materials: full.value.materials.filter(row => row.recordRefs.includes(first.ref)),
    requirements: full.value.requirements, answers: [] });
  assert.ok(partial.ok);
  assert.equal(hasCandidateEnteredPacket(partial.value, candidate), false, "knowing the full-source hash is not reading its omitted tail");
  const output = compileContentProcess(full.value, JSON.stringify({ schemaVersion: 1, knowledge: [], applications: [], relations: [], preparations: [] }),
    JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "undetermined", reason: "The source was introduced, without certifying its interpretation or a learning effect.", citations: [] } }));
  assert.ok(output.ok);
  const fact = { ...buildContentRecord(full.value, output.value), sequence: 1 };
  const replayed = laterIssueUserInputCandidates({ ...input, board: { ...input.board, sequence: 1, rewardV2Facts: [fact] } });

  assert.equal(replayed.status, "ready");
  if (replayed.status !== "ready") assert.fail(JSON.stringify(replayed));

  const reviewed = replayed.candidates.find(row => row.ref === candidate.ref)!;

  assert.deepEqual(reviewed.reviewedBy, [{ factId: fact.id, processId: output.value.processId }]);
  assert.equal(hasCandidateEnteredPacket(markerOnly.value, reviewed), true, "the canonical completed fact proves prior full source entry after raw text is compacted away");
  assert.equal(replayed.sourceRef, initial.sourceRef, "review/funding positions are not new raw user inputs");
});

test("file-path and secret user candidates use the canonical public source view through transport and durable entry proof", async () => {
  const base = fixture(), scope = "D:\\CC\\trylo", secret = "fixture-secret-value-never-exported";
  const original = { ...base.records[2]!, payload: { ...base.records[2]!.payload,
    text: `Inspect D:\\CC\\trylo\\src\\entry.ts and preserve its conditions. Token ${secret}.` } };
  const records = base.records.map(row => row.sequence === 2 ? original : row);
  const input = { ...base, scope, records, secrets: [secret], focus: { ...base.focus, scope },
    board: { ...base.board, assets: base.board.assets.map(asset => ({ ...asset, scope })),
      jobs: base.board.jobs.map(job => ({ ...job, scope })), learningIssues: [{ ...base.focus, scope }] } };
  const view = sessionContentRecordView(original, scope, [secret])!;
  assert.equal(view.changed, true);
  const current = laterIssueUserInputCandidates(input);
  assert.equal(current.status, "ready");

  if (current.status !== "ready") assert.fail(JSON.stringify(current));

  const candidate = current.candidates.find(row => row.turnId === "adopted-turn")!;

  assert.equal(candidate.ref, view.record.ref);
  assert.deepEqual(candidate.coordinate, { runId: view.record.runId, sequence: view.record.sequence });
  assert.equal(candidate.sourceHash, contentHashOf(view.record.text));
  assert.equal(candidate.text, view.record.text);
  assert.deepEqual(candidate.originalSource, view.original);
  const marker = current.batch.records.find(row => parseIssueUserInputBasis(row)?.sourceRef === candidate.ref)!;
  assert.ok(marker);
  assert.deepEqual(parseIssueUserInputBasis(marker)?.originalSource, view.original);
  const forgedText = canonicalJson({ ...parseIssueUserInputBasis(marker), originalSource: { ...view.original, sequence: view.original.sequence + 1 } });
  const forgedRef = `content-user-source-basis:${contentHashOf(forgedText)}`;

  assert.equal(parseIssueUserInputBasis({ ...marker, ref: forgedRef, runId: forgedRef, text: forgedText }), undefined,
    "a recomputed outer marker hash cannot authenticate a false raw-source locator");
  assert.ok(candidate.text.includes("<workspace>\\src\\entry.ts"));
  assert.equal(candidate.text.includes(secret), false);
  const feedback = await readAutomaticContentFeedback({ ...input, domain: "prompt", view: { records, tornTail: false }, enabled: () => true });

  assert.ok(feedback.ok, feedback.ok ? "" : feedback.reason);
  const archived = feedback.value.readMaterial(candidate.ref, 0, 8192);
  assert.ok(archived.ok);
  assert.equal(archived.text, candidate.text);
  assert.deepEqual(archived.originalCoordinate, candidate.coordinate);
  const decoded = decodeSessionContent({ records, tornTail: false }, { sessionId: input.sessionId, turnId: "adopted-turn", scope,
    secrets: [secret], subsystem: "method" });
  assert.ok(decoded.ok);
  const packet = buildContentPacket({ ...decoded.batch, scope, domain: "prompt", boardSequence: 0, focus: input.focus });
  assert.ok(packet.ok);
  assert.equal(hasCandidateEnteredPacket(packet.value, candidate), true);
  const signal = new AbortController().signal;
  const session = await readSessionContent({ session: { async readRecords() { return { ok: true, view: { records, tornTail: false } }; } },
    sessionId: input.sessionId, turnId: "adopted-turn", scope, secrets: [secret], subsystem: "method", enabled: () => true }, signal);
  assert.ok(session.ok);
  const reader = createTaskSourcePageReader({ session: session.value.source,
    board: { async readMaterial() { return { ok: false, reason: "content_material_missing" }; } },
    feedback: { readMaterial() { return { ok: false, reason: "content_feedback_material_missing" }; } } });
  const page = await reader.read(candidate.ref, signal, 0, 8192);
  assert.ok(page.ok);
  assert.deepEqual(page.value.originalSource, candidate.originalSource);
  const empty = buildContentPacket({ scope, domain: "prompt", boardSequence: 0, focus: input.focus,
    records: [], requirements: [], answers: [], materials: [] });
  assert.ok(empty.ok);
  const paged = extendContentStagePacket(empty.value, page.value, 0);
  assert.ok(paged.ok);
  assert.equal(hasCandidateEnteredPacket(paged.value, candidate), true,
    "the exact projected page hash includes its preserved original-source metadata");
  const output = compileContentProcess(packet.value, JSON.stringify({ schemaVersion: 1, knowledge: [], applications: [], relations: [], preparations: [] }),
    JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "undetermined", reason: "Public source entered; no interpretation was certified.", citations: [] } }));
  assert.ok(output.ok);
  const fact = { ...buildContentRecord(packet.value, output.value), sequence: 1 };
  const replay = laterIssueUserInputCandidates({ ...input, board: { ...input.board, sequence: 1, rewardV2Facts: [fact] } });
  assert.equal(replay.status, "ready");

  if (replay.status !== "ready") assert.fail(JSON.stringify(replay));

  assert.deepEqual(replay.candidates.find(row => row.ref === candidate.ref)!.reviewedBy, [{ factId: fact.id, processId: output.value.processId }]);
});
