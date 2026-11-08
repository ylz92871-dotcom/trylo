import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContentPacket } from "../../learning/central/content/material.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isRedactedTopicData } from "../learning-topics/confidentiality.js";
import { isContentDataSafe } from "./content-confidentiality.js";
import { buildContentDomainFeedbackAbsenceRecord } from "./sources/domain-feedback-basis.js";
import { projectContentRecallCatalog } from "./sources/board-catalog.js";
import { sessionIssueSourceCatalogMaterial } from "./sources/session-issue-address.js";
import { extendContentStagePacket } from "./staged-material.js";
import { decodeSessionContent } from "./sources/session-decode.js";
import { pageContentMaterial } from "./sources/artifact-read.js";

const scope = "D:\\CC\\trylo", secrets = ["known-credential-value"], trusted = { scope };

function packet(text = "Preserve the original calibration requirement.", ownedScope = scope) {
  const ref = "session-record:one";
  const value = buildContentPacket({ scope: ownedScope, domain: "tool", boardSequence: 0,
    records: [{ ref, runId: "session:one", sequence: 0, scope: ownedScope, origin: "user_statement", text }], requirements: [], answers: [],
    materials: [{ id: ref, kind: "requirement", subsystem: "tool", recordRefs: [ref], requirementIds: [], answerIds: [],
      links: { issueIds: [], topicIds: [], artifactRefs: [] }, context: canonicalJson({ source: "canonical_session_journal",
        sessionId: "session:one", turnId: "turn:one", workspaceId: `workspace:${ownedScope}`, journalSequence: 0,
        sourceRecordType: "transcript_item", originalTranscriptSequence: 0, role: "original_user_requirement" }) }] });
  if (!value.ok) assert.fail(value.reason);
  return value.value;
}

test("canonical Windows scope and source-owned workspace identity survive without changing the immutable packet", () => {
  const value = packet(), before = canonicalJson(value);
  assert.equal(isRedactedTopicData(value, secrets), false, "The original whole-value path policy is the actual blocking boundary.");
  assert.equal(isContentDataSafe(value, trusted, secrets), true);
  assert.equal(canonicalJson(value), before);
  assert.equal(isContentDataSafe({ schemaVersion: 1, sessionId: "session:one", turnId: "turn:one", kind: "prepared", requestId: "request:one",
    packet: value, maximumPromptChars: 20000, requestHash: "a".repeat(64) }, trusted, secrets), true);
});

test("free prose and arbitrary JSON cannot promote a scope key into trusted metadata", () => {
  assert.equal(isContentDataSafe({ scope }, trusted, secrets), false);
  assert.equal(isContentDataSafe(packet(canonicalJson({ scope })), trusted, secrets), false);
  assert.equal(isContentDataSafe(packet(`Inspect ${scope} for the current task.`), trusted, secrets), false);
  const value = packet(), original = value.materials[0]!;
  assert.equal(isContentDataSafe({ ...value, materials: [{ ...original, context: canonicalJson({ scope, workspaceId: scope }) }] }, trusted, secrets), false);
  assert.equal(isContentDataSafe({ ...value, records: [{ ...value.records[0]!, scope: "D:\\other-workspace" }] }, trusted, secrets), false);
});

test("known credentials and the original secret-shape rules still apply to every string including trusted identity", () => {
  assert.equal(isContentDataSafe(packet("known-credential-value"), trusted, secrets), false);
  assert.equal(isContentDataSafe(packet("password=unknown-credential"), trusted, secrets), false);
  assert.equal(isContentDataSafe(packet(), trusted, [scope]), false);
  assert.equal(isContentDataSafe(packet(), trusted, ["session:one"]), false);
  const suspicious = "D:\\CC\\token=unknown-credential";

  assert.equal(isContentDataSafe(packet("Original requirement.", suspicious), { scope: suspicious }, []), false);
  assert.equal(isContentDataSafe({ ...packet(), unexpected: { scope } }, trusted, secrets), false);
});

test("only registered source-owner metadata with exact immutable identity can carry the current scope", () => {
  const text = canonicalJson({ role: "host_retrieval_projection_not_task_result_or_learning_gain", ...projectContentRecallCatalog({ scope,
    boardSequence: 0, availableCandidates: 0, consideredCandidates: 0, selectedCandidates: [], omittedCandidates: 0,
    selection: "lexical_then_scope_recency", relevanceIsNotIdentityOrAdequacy: true, candidates: [] }, "Preserve the original requirement.") });
  const ref = `content-recall:${contentHashOf(text)}`;
  const record = { ref, runId: ref, sequence: 0, scope, origin: "execution_result" as const, text };
  const batch = { records: [record], requirements: [], answers: [], materials: [] };

  assert.equal(isContentDataSafe(batch, trusted, secrets), true);
  assert.equal(isContentDataSafe({ ...batch, records: [{ ...record, ref: "content-recall:wrong", runId: "content-recall:wrong" }] }, trusted, secrets), false);
  assert.equal(isContentDataSafe({ ...batch, records: [{ ...record, origin: "user_statement" }] }, trusted, secrets), false);
  assert.equal(isContentDataSafe({ ...batch, records: [{ ...record, ref: "session-content:raw", runId: "session", sequence: 1 }] }, trusted, secrets), false);
  const absence = buildContentDomainFeedbackAbsenceRecord("issue:one", scope);

  assert.equal(isContentDataSafe({ ...batch, records: [absence] }, trusted, secrets), true);
  assert.equal(isContentDataSafe({ ...batch, records: [{ ...absence, text: absence.text + " " }] }, trusted, secrets), false);
  const shared = { statement: "Original public model result." };

  assert.equal(isContentDataSafe([shared, shared], trusted, secrets), true);
  const cyclic: { child?: unknown } = {};
  cyclic.child = cyclic;
  assert.equal(isContentDataSafe(cyclic, trusted, secrets), false);
});

test("the real canonical issue-source catalog preserves current scope metadata and rejects other path prose", () => {
  const catalog = sessionIssueSourceCatalogMaterial({ schemaVersion: 1, issueId: "issue:catalog", scope, problemKey: "original-source", revision: 1,
    reports: [{ reportId: "report:catalog", source: { subsystem: "tool", taskId: "turn:catalog", versionId: "tool:catalog" },
      facts: ["Original task support."], evidenceRefs: [] }], decision: { kind: "unreviewed" }, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" });

  assert.equal(isRedactedTopicData(catalog, secrets), false);
  assert.equal(isContentDataSafe(catalog, trusted, secrets), true);
  const original = catalog.records[0]!;
  const text = original.text.replace("Addresses preserve", "Inspect D:\\other-private-workspace. Addresses preserve");
  const ref = `session-issue-source-manifest:${contentHashOf(text)}`;

  assert.equal(isContentDataSafe({ ...catalog, records: [{ ...original, ref, runId: ref, text }] }, trusted, secrets), false);
});

test("real source pages and journal chunks preserve exact workspace metadata while their text keeps the prose policy", () => {
  const text = "The actual source page preserves its original condition.";
  const extended = extendContentStagePacket(packet(), { ref: "source:page", originalRef: "source:page", origin: "execution_result",
    originalScope: scope, start: 0, end: text.length, totalChars: text.length, text, sourceHash: contentHashOf(text),
    coordinate: { runId: "source:run", sequence: 1 }, owner: "board" }, 0);

  assert.ok(extended.ok);
  assert.equal(isContentDataSafe(extended.value, trusted, secrets), true);
  const decoded = decodeSessionContent({ tornTail: false, records: [
    { formatVersion: "1", sequence: 0, sessionId: "chunk-session", at: "2026-11-04T00:00:00Z", type: "session_start",
      payload: { fingerprint: { schemaVersion: "1", providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: `workspace:${scope}` } } },
    { formatVersion: "1", sequence: 1, sessionId: "chunk-session", turnId: "chunk-turn", at: "2026-11-04T00:00:00Z", type: "transcript_item",
      payload: { kind: "user", sequence: 0, text: "Original source. " + "x".repeat(40000) } },
  ] }, { sessionId: "chunk-session", turnId: "chunk-turn", scope, subsystem: "tool", maximumChars: 24000 });

  assert.ok(decoded.ok);
  assert.equal(isContentDataSafe(decoded.batch, trusted, secrets), true);
  const raw = decoded.batch.records[0]!;

  assert.equal(isContentDataSafe({ ...decoded.batch, records: [{ ...raw, text: `Inspect ${scope} in raw prose.` }] }, trusted, secrets), false);
});

test("a changed archive page binds its safe-view coordinates and original raw source without reusing the raw ref", () => {
  const rawText = `Read ${scope}\\src\\source.ts before changing the original condition.`;
  const read = pageContentMaterial({ ref: "source:archive", requestedRef: "source:archive", text: rawText, originalScope: scope,
    sourceRefs: ["source:archive"], admissibility: "source_record", origin: "execution_result", coordinate: { runId: "archive:run", sequence: 7 } }, 0, 8192);

  assert.ok(read.ok);
  const source = read.value;
  assert.ok(source.originalSource);
  assert.notEqual(source.ref, "source:archive");
  assert.equal(source.originalSource.sourceHash, contentHashOf(rawText));
  const page = { ref: source.requestedRef, originalRef: source.ref, origin: source.origin, originalScope: source.originalScope,
    start: source.start, end: source.end, totalChars: source.totalChars, text: source.text, sourceHash: source.contentHash,
    coordinate: source.coordinate, owner: "board" as const, originalSource: source.originalSource };
  const admitted = extendContentStagePacket(packet(), page, 0);
  assert.ok(admitted.ok);
  assert.equal(isContentDataSafe(admitted.value, trusted, secrets), true);
  const forged = extendContentStagePacket(packet(), { ...page, originalSource: { ...page.originalSource, sourceHash: "0".repeat(64) } }, 0);
  assert.ok(forged.ok);
  assert.equal(isContentDataSafe(forged.value, trusted, secrets), false);
});
