import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContentMaterial, ContentPacketInput } from "./material-contract.js";
import { buildContentPacket, readContentPacket } from "./material.js";
import { createSnapshotContentSource, retrieveContentPacket } from "./material-source.js";

function fixture(): ContentPacketInput {
  return {
    scope: "repo:a", domain: "tool", boardSequence: 12,
    focus: { schemaVersion: 1, issueId: "issue:search", scope: "repo:a", problemKey: "search-completeness", revision: 3,
      reports: [{ reportId: "report:1", source: { subsystem: "tool", taskId: "task:1", versionId: "v1" },
        facts: ["Search output was truncated."], hypotheses: ["The owner directory was ignored."], evidenceRefs: ["event:1", "absent:source"] }],
      decision: { kind: "focused_learning", reason: "Investigate complete evidence in the original scope.",
        sourceRefs: ["event:1"], decidedAt: "2026-11-04T10:00:00Z", revision: 2 },
      createdAt: "2026-11-04T09:00:00Z", updatedAt: "2026-11-04T10:00:00Z" },
    records: [{ ref: "event:1", runId: "run:1", sequence: 0, scope: "repo:a", origin: "execution_result", text: "Search output was truncated." }],
    requirements: [{ id: "req:1", requirement: "Locate the owning implementation.", conditions: ["Current snapshot", "Read only"],
      answerRequirement: "Complete source evidence with file references.", sourceRefs: ["event:1"] }],
    answers: [], materials: [],
  };
}

const material = (id: string, issueIds: readonly string[]): ContentMaterial => ({ id, kind: "known_answer", subsystem: "tool",
  context: "Original search procedure, conditional on the same owner and snapshot.", recordRefs: ["support:answer"],
  requirementIds: [], answerIds: ["answer:1"], links: { issueIds, topicIds: [], artifactRefs: [{ id: "tool:search", version: "v2" }] } });

test("content packet preserves PA content, original requirement and incomplete source coverage", () => {
  const input = fixture(), result = buildContentPacket(input);

  assert.ok(result.ok);
  assert.deepEqual(result.value.focus, input.focus);
  assert.deepEqual(result.value.requirements, input.requirements);
  assert.deepEqual(result.value.records, input.records);
  assert.deepEqual(result.value.retrieval, { coverage: "bounded", requestedRefs: ["event:1", "absent:source"], missingRefs: ["absent:source"] });
  assert.ok(Object.isFrozen(result.value.focus?.reports));
  assert.notEqual(result.value.focus, input.focus);
  const repeated = buildContentPacket(input);

  assert.ok(repeated.ok);
  assert.equal(repeated.value.packetId, result.value.packetId);
  assert.deepEqual(buildContentPacket(input, 50), { ok: false, reason: "content_material_capacity" });
  assert.deepEqual(readContentPacket(JSON.parse(JSON.stringify(result.value))), result);
  assert.deepEqual(readContentPacket({ ...result.value, packetId: "tampered" }), { ok: false, reason: "content_material_invalid" });
  assert.deepEqual(readContentPacket({ ...result.value, retrieval: { ...result.value.retrieval, missingRefs: [] } }),
    { ok: false, reason: "content_material_invalid" });
});

test("exact issue relationship retrieves conditional old answer and support, not a similar unlinked record", async () => {
  const input = fixture();
  const answer = { answerId: "answer:1", question: "How can complete evidence be found?", requirement: "Preserve source completeness.",
    answer: "Confirm owner and snapshot, then scope the search.", conditions: ["Owner and snapshot remain valid"],
    supportRefs: ["support:answer"], artifactRefs: [{ id: "tool:search", version: "v2" }] };
  const source = createSnapshotContentSource({ scope: input.scope, boardSequence: 11,
    records: [
      { ref: "support:answer", runId: "run:old", sequence: 4, scope: input.scope, origin: "checker_result", text: "The bounded old procedure passed its original completeness check." },
      { ref: "similar:only", runId: "run:other", sequence: 1, scope: input.scope, origin: "execution_result", text: "Search output was truncated." },
    ], requirements: [], answers: [answer], materials: [material("material:answer", ["issue:search"])] });
  const result = await retrieveContentPacket(input, source, new AbortController().signal);

  assert.ok(result.ok);
  assert.deepEqual(result.value.answers, [answer]);
  assert.deepEqual(result.value.materials[0]?.links.artifactRefs, [{ id: "tool:search", version: "v2" }]);
  assert.deepEqual(result.value.records.map(record => record.ref), ["event:1", "support:answer"]);
  assert.deepEqual(result.value.retrieval.missingRefs, ["absent:source"]);
});

test("source conflict and cross-scope data fail closed without rewriting coordinates", () => {
  const input = fixture(), first = input.records[0]!;

  assert.deepEqual(buildContentPacket({ ...input, records: [first, { ...first, text: "A different report." }] }),
    { ok: false, reason: "content_material_conflict" });
  assert.deepEqual(buildContentPacket({ ...input, records: [first, { ...first, ref: "alias" }] }),
    { ok: false, reason: "content_material_conflict" });
  assert.deepEqual(buildContentPacket({ ...input, records: [{ ...first, scope: "repo:b" }] }),
    { ok: false, reason: "content_material_scope" });
});

test("long original material is retained in the content packet instead of being truncated to WS1 limits", () => {
  const input = fixture(), first = input.records[0]!;
  const originalText = "Original requirement. ".repeat(150);
  const result = buildContentPacket({ ...input, records: [{ ...first, text: originalText }] });
  assert.ok(result.ok);
  assert.equal(result.value.records[0]?.text, originalText);
});

test("source known-at prefix, cancellation and source failure retain separate failure contracts", async () => {
  const input = fixture(), source = createSnapshotContentSource({ ...input, boardSequence: 13 });
  const signal = new AbortController().signal;

  assert.deepEqual(await retrieveContentPacket(input, source, signal), { ok: false, reason: "content_material_unavailable" });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await retrieveContentPacket(input, source, controller.signal), { ok: false, reason: "content_material_cancelled" });
  const failing = { async retrieve() { throw new Error("source unavailable"); } };

  assert.deepEqual(await retrieveContentPacket(input, failing, signal), { ok: false, reason: "content_material_unavailable" });
});
