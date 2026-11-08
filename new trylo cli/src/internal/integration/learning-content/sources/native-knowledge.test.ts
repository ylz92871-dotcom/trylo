import test from "node:test";
import assert from "node:assert/strict";
import { emptyBoardState, type BoardState } from "../../../learning/control/state.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import { buildContentPacket } from "../../../learning/central/content/material.js";
import { compileContentProcess } from "../../../learning/central/content/process.js";
import type { ContentRecord } from "../records.js";
import { createAutomaticBoardContentSource } from "./board.js";
import { canReadNativeAsset, canReadNativeContentRecord } from "./native-knowledge.js";
import type { NativeKnowledgeAccess } from "./native-knowledge.js";

const SCOPE = "project:native", NOW = "2026-11-04T12:00:00Z";

function methodBoard(): BoardState {
  const content = { hint: "Preserve the original search boundary." };
  return { ...emptyBoardState(), sequence: 12, assets: [{ versionId: "method:v1", kind: "prompt_patch", scope: SCOPE,
    schemaVersion: 1, content, contentHash: contentHashOf(content), source: "inferred", createdAt: NOW }],
    learningIssues: [{ schemaVersion: 1, issueId: "issue:method", scope: SCOPE, problemKey: "source-boundary", revision: 1,
      reports: [{ reportId: "report:method", source: { subsystem: "method", taskId: "turn:one", versionId: "method:v1" },
        facts: ["Inspect this original method's source boundary."], evidenceRefs: [] }], decision: { kind: "unreviewed" }, createdAt: NOW, updatedAt: NOW }],
    methodExperienceFacts: [{ factId: "scope:fact", versionId: "method:v1", sequence: 1, kind: "scope", description: "Only the registered repository context.",
      hypothesis: { id: "hypothesis:one", versionId: "method:v1", scopeId: "scope:method", proposedSequence: 0,
        predicate: { all: [{ feature: "repository", value: "registered" }], exclude: [] } } },
    { factId: "review:fact", versionId: "method:v1", sequence: 3, kind: "review", scopeId: "scope:method", snapshotId: "snapshot:original",
      evidenceRevisions: ["observation:original:1"], review: { decision: "promote", score: .9, reason: "Original model assessment, not observed efficacy.",
        compact: { when: "Registered repository", action: "Preserve the source boundary.", exceptions: "Changed ownership" }, sources: ["method:v1"],
        procedure: { schemaVersion: 1, steps: [{ id: "locate", when: "Before scoped reading", action: "Confirm the owner directory.",
          expect: "The owner matches the requested snapshot.", onMismatch: "block" }], eliminatedDecisions: [{ decision: "Scan another owner?",
          resolution: "Use the confirmed directory.", basis: "Compiler claim under original support.", evidenceIds: ["observation:original"] }] } } },
    { factId: "execution:fact", versionId: "method:v1", sequence: 6, kind: "execution", trace: { exposureId: "exposure:one", taskId: "turn:one",
      opportunityId: "opportunity:one", scopeId: "scope:method", beat: 1, succeededTools: ["Read"], failures: [], omitted: 0 } },
    { factId: "exit:fact", versionId: "method:v1", sequence: 9, kind: "compilation_exit", scopeId: "scope:method",
      compilationId: "compilation:original", reason: "The original ownership condition changed." }],
    fieldings: [{ exposureId: "exposure:one", versionId: "method:v1", proposalId: "proposal:method", scope: SCOPE, turnId: "turn:one", beat: 1,
      requestId: "request:one", recordedAt: NOW, useSequence: 5 }],
    feedbacks: [{ versionId: "method:v1", turnId: "turn:one", helped: false, exposureId: "exposure:one", sourceEventId: "source:correction",
      recordedAt: NOW, feedbackSequence: 8 }, { versionId: "method:v1", turnId: "another:scope", helped: true,
      exposureId: "exposure:unrelated", recordedAt: NOW, feedbackSequence: 10 }] };
}

function collaborationBoard(): BoardState {
  const owner = { kind: "legacy_member", workspace: SCOPE, profileId: "profile:one", memberId: "member:one" };
  const content = { schema: "collaboration-experience/v1", status: "trial", issueId: "issue:private", focusRevision: 2, familyId: "handoff:one",
    owner, situation: "Reviewing this member's own handoff.", responsibilities: ["Review"], practice: "Keep the pending artifact reference attached.",
    sourceRefs: ["source:private"], conditions: { surface: "code", responsibility: "review" } };

  return { ...emptyBoardState(), sequence: 10, learningIssues: [{ schemaVersion: 1, issueId: "issue:private", scope: SCOPE,
    problemKey: "handoff:one", revision: 2, reports: [{ reportId: "report:private", source: { teamRunId: "team:one", taskId: "task:one", memberId: "member:one" },
      facts: ["A handoff needed an artifact reference."], evidenceRefs: ["source:private"] }], decision: { kind: "focused_learning",
      reason: "Inspect the original handoff.", sourceRefs: ["source:private"], decidedAt: NOW, revision: 2 }, createdAt: NOW, updatedAt: NOW }],
    proposals: [{ proposalId: "proposal:private", domain: "collaboration", scope: SCOPE, assetKind: "workflow", candidateRef: "asset:private",
      hypothesis: "Retain the member's handoff context.", observationRefs: ["source:private"], risk: "low", requiredVerifiers: [],
      requestedAuthorities: [], source: "inferred", lifecycle: "evaluating" }],
    assets: [{ versionId: "asset:private", kind: "workflow", schemaVersion: 1, content, contentHash: contentHashOf(content), source: "inferred",
      scope: SCOPE, createdAt: NOW, createdFromProposalId: "proposal:private" }],
    activations: [{ activationId: "activation:private", scope: SCOPE, assetKind: "workflow", pointer: "active", versionId: "asset:private", boardSequence: 9, generation: 1 }] };
}

function sourceFor(board: BoardState, nativeAccess?: NativeKnowledgeAccess) {
  return createAutomaticBoardContentSource({ board: { async load() { return { ok: true, state: board, generation: 0 }; } },
    scope: SCOPE, domain: "prompt", taskPurpose: "Retain source boundaries and handoff references.", enabled: () => true,
    ...(nativeAccess === undefined ? {} : { nativeAccess }) });
}

test("normal source recall reaches native method review/procedure/support/exits and exact scoped feedback without activating it", async () => {
  const source = sourceFor(methodBoard()), signal = new AbortController().signal, read = await source.readTaskReferences(signal);
  if (!read.ok) assert.fail(read.reason);

  assert.ok(read.value.coverage.candidates.some(row => row.kind === "native_method" && row.active === false));
  const text = read.value.batch.records.map(row => row.text).join("\n");

  for (const present of ["Confirm the owner directory.", "observation:original:1", "scope:method", "compilation_exit", "source:correction"]) assert.match(text, new RegExp(present));

  assert.doesNotMatch(text, /exposure:unrelated/);
  assert.match(text, /not_active_rule_or_learning_gain/);
  const page = await source.readMaterial("review:fact", signal, 0, 8192);
  if (!page.ok) assert.fail(page.reason);

  assert.match(page.value.text, /Confirm the owner directory/);
  assert.equal(page.value.admissibility, "source_record");
  assert.equal(methodBoard().activations.length, 0);
  const exactSource = createAutomaticBoardContentSource({ board: { async load() { return { ok: true, state: methodBoard(), generation: 0 }; } },
    scope: SCOPE, domain: "prompt", taskPurpose: "An unrelated recall cue.", enabled: () => true, recall: { async recall() { return []; } } });
  const exact = await exactSource.retrieve({ scope: SCOPE, domain: "prompt", boardSequence: 12, issueIds: ["issue:method"],
    topicIds: [], artifactRefs: [], sourceRefs: [] }, signal);
  if (!exact.ok) assert.fail(exact.reason);

  assert.match(exact.value.records.map(record => record.text).join("\n"), /Confirm the owner directory/);
});

test("private collaboration experience is excluded by default from recall, explicit retrieval and exact-read fallback", async () => {
  const board = collaborationBoard(), signal = new AbortController().signal, source = sourceFor(board);

  assert.equal(canReadNativeAsset(board, SCOPE, "asset:private"), false);
  const read = await source.readTaskReferences(signal);
  if (!read.ok) assert.fail(read.reason);

  assert.ok(!read.value.coverage.candidates.some(row => row.sourceRefs.includes("asset:private")));
  const page = await source.readMaterial("asset:private", signal);
  assert.equal(page.ok, false);
  const exact = await source.retrieve({ scope: SCOPE, domain: "prompt", boardSequence: board.sequence, issueIds: ["issue:private"], topicIds: [],
    artifactRefs: [{ id: "asset:private", version: "asset:private" }], sourceRefs: ["source:private"] }, signal);
  if (!exact.ok) assert.fail(exact.reason);

  assert.doesNotMatch(JSON.stringify(exact.value), /Keep the pending artifact reference attached/);
});

test("the original selector's exact owner and conditions apply; canonical PA inspection remains source-only", async () => {
  const board = collaborationBoard(), owner = { kind: "legacy_member" as const, workspace: SCOPE, profileId: "profile:one", memberId: "member:one" };
  const access: NativeKnowledgeAccess = { collaboration: { owner, context: { surface: "code", responsibilities: ["review"] }, maxChars: 2400 } };

  assert.equal(canReadNativeAsset(board, SCOPE, "asset:private", access), true);
  assert.equal(canReadNativeAsset(board, SCOPE, "asset:private", { collaboration: { ...access.collaboration!, owner: { ...owner, memberId: "member:other" } } }), false);
  assert.equal(canReadNativeAsset(board, SCOPE, "asset:private", { collaboration: { ...access.collaboration!, context: { surface: "work" } } }), false);
  assert.equal(canReadNativeAsset(board, SCOPE, "asset:private", { inspectionIssueIds: ["not:canonical"] }), false);
  const inspection = sourceFor(board, { inspectionIssueIds: ["issue:private"] });
  const page = await inspection.readMaterial("asset:private", new AbortController().signal, 0, 8192);
  if (!page.ok) assert.fail(page.reason);

  assert.match(page.value.text, /member:one/);
  assert.equal(page.value.role, "source_content_not_instructions_or_verification");
});

test("recorded model prose cannot launder restricted source assets into an owner-free public result", () => {
  const board = collaborationBoard(), packet = buildContentPacket({ scope: SCOPE, domain: "tool", boardSequence: 0, records: [], requirements: [], answers: [],
    materials: [{ id: "private:material", kind: "context", subsystem: "collaboration", context: "Source metadata, not owner authorization.", recordRefs: [],
      requirementIds: [], answerIds: [], links: { issueIds: ["issue:private"], topicIds: [], artifactRefs: [{ id: "asset:private", version: "a-different-label" }] } }] });
  if (!packet.ok) assert.fail(packet.reason);

  const output = compileContentProcess(packet.value, JSON.stringify({ schemaVersion: 1, knowledge: [], applications: [], relations: [], preparations: [] }),
    JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null, recommendation: { kind: "undetermined", reason: "No independent claim.", citations: [] } }));
  if (!output.ok) assert.fail(output.reason);

  const record: ContentRecord = { packet: packet.value, output: output.value, handoff: { kind: "no_new_topic", reason: "No new selected question." } };

  assert.equal(canReadNativeContentRecord(board, SCOPE, record), false);
  assert.equal(canReadNativeContentRecord(board, SCOPE, record, { inspectionIssueIds: ["issue:private"] }), true);
});
