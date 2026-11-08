import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardReader, withBoardWriter } from "../../../adapters/learning-store/file-event-store.js";
import { emptyBoardState, type BoardState } from "../../../learning/control/state.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import { buildContentPacket } from "../../../learning/central/content/material.js";
import { compileContentProcess } from "../../../learning/central/content/process.js";
import { buildContentRecord } from "../records.js";
import { mapBoardContentArtifacts } from "./artifact.js";
import { createAutomaticBoardContentSource } from "./board.js";

test("next task with no issue retrieves prior public knowledge from the real Board and reuses one recall snapshot", async () => {
  const boardRoot = await mkdtemp(join(tmpdir(), "trylo-content-board-source-"));
  try {
    const packet = buildContentPacket({ scope: "repo:a", domain: "tool", boardSequence: 0,
      records: [{ ref: "original-request", runId: "old-session", sequence: 1, scope: "repo:a", origin: "user_statement", text: "Find complete source evidence for the repository owner." }],
      requirements: [{ id: "original-request", requirement: "Find complete source evidence for the repository owner.", conditions: ["Original snapshot"],
        answerRequirement: "Complete source evidence", sourceRefs: ["original-request"] }], answers: [], materials: [] });
    assert.ok(packet.ok);
    const output = compileContentProcess(packet.value, JSON.stringify({ schemaVersion: 1, knowledge: [{ id: "known", statement: "Confirm the owner directory before the scoped source search.",
      conditions: "The owner directory still matches the requested snapshot.", citations: [{ evidenceRef: "original-request", quote: "complete source evidence" }] }],
      applications: [], relations: [], preparations: [] }), JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "undetermined", reason: "No new residual was produced in this bounded view.", citations: [] } }));
    assert.ok(output.ok);
    const fact = buildContentRecord(packet.value, output.value);
    const persisted = await withBoardWriter(boardRoot, store => store.apply({ type: "record_reward_v2_fact", commandId: "save:knowledge", issuedAt: "2026-11-04T12:00:00Z", expectedSequence: 0, fact }));
    assert.ok(persisted.ok);
    let recalls = 0;
    const source = createAutomaticBoardContentSource({ board: createBoardReader(boardRoot), scope: "repo:a", domain: "tool",
      taskPurpose: "Find complete source evidence for repository ownership again.", enabled: () => true,
      recall: { async recall(input) {
        recalls++;
        return input.candidates.map(row => row.id).slice(0, 1);
      } } });
    const read = await source.readTaskReferences(new AbortController().signal);
    assert.ok(read.ok);
    assert.equal(read.value.coverage.selectedCandidates[0], fact.id);
    assert.ok(read.value.batch.answers.some(row => row.answer === "Confirm the owner directory before the scoped source search."));
    assert.ok(read.value.batch.records.some(row => row.ref === "original-request" && row.runId === "old-session"));
    const retrieved = await source.retrieve({ scope: "repo:a", domain: "tool", boardSequence: persisted.state.sequence,
      issueIds: [], topicIds: [], artifactRefs: [], sourceRefs: [] }, new AbortController().signal);
    assert.ok(retrieved.ok);
    assert.equal(recalls, 1);
    const page = await source.readMaterial(fact.id, new AbortController().signal, 0, 100);
    assert.ok(page.ok);
    assert.equal(page.value.end, 100);
    assert.ok(page.value.totalChars > 100);
    assert.equal(read.value.mappings[0]?.version, output.value.processId);
  } finally { await rm(boardRoot, { recursive: true, force: true }); }
});

function assetBoard(pointer: "active" | "suspended"): BoardState {
  const content = { hint: "Use the exact original source when interpreting ownership.", appliesWhen: { tools: ["Read"] }, long: "x".repeat(9000) };
  return { ...emptyBoardState(), sequence: 5,
    assets: [{ versionId: "asset:v1", kind: "prompt_patch", schemaVersion: 1, content, contentHash: contentHashOf(content),
      source: "inferred", scope: "method:niche", createdAt: "2026-11-04T10:00:00Z" }],
    jobs: [{ jobId: "job:1", observationId: "obs:1", domain: "prompt", scope: "repo:a", state: "succeeded", attempt: 1,
      maxAttempts: 1, breakerOpen: false, dedupeKey: "job:1", coordination: { issueId: "issue:1", grantId: "grant:1", resultRefs: ["asset:v1"] } }],
    activations: [{ activationId: "act:1", scope: "method:niche", assetKind: "prompt_patch", pointer, versionId: "asset:v1", boardSequence: 5, generation: 1 }],
    fieldings: [{ exposureId: "use:1", versionId: "asset:v1", proposalId: "proposal:1", turnId: "turn:1", beat: 1, requestId: "attempt:1", scope: "other:niche",
      recordedAt: "2026-11-04T11:00:00Z", useSequence: 4 }] };
}

test("asset ownership follows exact central output relation, active status gates task references, and long content remains page-readable", async () => {
  const board = assetBoard("active"), mappings = mapBoardContentArtifacts(board, "repo:a");

  assert.equal(mappings[0]?.originalScope, "method:niche");
  assert.deepEqual(mappings[0]?.issueIds, ["issue:1"]);
  assert.equal(mapBoardContentArtifacts(board, "unrelated:repo").length, 0);
  const source = createAutomaticBoardContentSource({ board: { async load() { return { ok: true, state: board, generation: 0 }; } },
    scope: "repo:a", domain: "prompt", taskPurpose: "Interpret repository source ownership.", enabled: () => true });
  const read = await source.readTaskReferences(new AbortController().signal);
  assert.ok(read.ok);
  assert.equal(read.value.coverage.availableCandidates, 1);
  assert.ok(read.value.batch.records.some(row => row.text.includes("other:niche")));
  const page = await source.readMaterial("asset:v1", new AbortController().signal, 8192, 8192);
  assert.ok(page.ok);
  assert.equal(page.value.originalScope, "method:niche");
  assert.ok(page.value.text.length > 0);
  const inactive = createAutomaticBoardContentSource({ board: { async load() { return { ok: true, state: assetBoard("suspended"), generation: 0 }; } },
    scope: "repo:a", domain: "prompt", taskPurpose: "Interpret repository source ownership.", enabled: () => true });
  const hidden = await inactive.readTaskReferences(new AbortController().signal);
  assert.ok(hidden.ok);
  assert.equal(hidden.value.coverage.availableCandidates, 0);
  const explicit = await inactive.retrieve({ scope: "repo:a", domain: "prompt", boardSequence: 5, issueIds: [], topicIds: [],
    artifactRefs: [{ id: "asset:v1", version: "asset:v1" }], sourceRefs: [] }, new AbortController().signal);
  assert.ok(explicit.ok);
  assert.ok(explicit.value.answers[0]?.conditions[0]?.includes("inactive"));
});
