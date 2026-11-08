import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import type { KnownApplicationDraft, ResidualReviewDraft } from "../../learning/central/content/process-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { readContentRecords } from "./records.js";
import { sessionContentRecordRef } from "./sources/session.js";

const at = "2026-11-04T15:00:00Z", scope = "repo:stage-material", sessionId = "stage-material-session", turnId = "normal-task";

test("normal omitted source tail becomes a saved successor input, grounds new quotes and recovers without accepting an old hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-stage-material-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") }), boardRoot = join(root, "board");
  const signal = new AbortController().signal;

  try {
    assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "local-contract",
      model: "source-page-contract", toolCatalogHash: "catalog", workspaceId: "workspace:stage-material" } })).ok);
    const requirement = "Inspect the complete original evidence and preserve its exact supported boundary.";

    assert.ok((await session.append({ type: "transcript_item", sessionId, turnId, at,
      payload: { kind: "user", sequence: 0, text: requirement } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId, turnId, at,
      payload: { kind: "tool_call", sequence: 1, toolCallId: "read:large", name: "Read", arguments: { path: "original-evidence.txt" } } })).ok);
    const tail = "UNIQUE_TAIL_SUPPORT: the original relation holds only within condition Z.";
    const originalText = `${"X".repeat(40000)}${tail}`;
    const source = await session.append({ type: "transcript_item", sessionId, turnId, at,
      payload: { kind: "tool_result", sequence: 2, toolCallId: "read:large", name: "Read", output: originalText,
        truncated: false, outcome: "succeeded" } });
    assert.ok(source.ok);
    // A later ordinary public answer fills the bounded turn transport. The old file's tail must be fetched explicitly.
    assert.ok((await session.append({ type: "transcript_item", sessionId, turnId, at,
      payload: { kind: "assistant_text", sequence: 3, blockId: "recent-public-output", text: "R".repeat(40960) } })).ok);
    const options = { boardRoot, scope, domain: "tool" as const, session, sessionId, turnId, enabled: () => true, now: () => Date.parse(at) };
    const stages = createStagedContentSession({ runtime: createNormalTaskContentRuntime(options), enabled: options.enabled });
    const first = await stages.begin({ requestId: "material-contract", maximumPromptChars: 100000 }, signal);

    assert.equal(first.status, "apply_known");
    if (first.status !== "apply_known") assert.fail("normal preparation failed");

    const packet = (JSON.parse(first.request.materialJson) as { readonly packet: ContentPacket }).packet;

    assert.ok(!packet.records.some(record => record.text.includes(tail)), "the fixture must exercise an actually omitted tail");
    const requirementRecord = packet.records.find(record => record.origin === "user_statement" && record.text === requirement);

    assert.ok(requirementRecord);
    const before: KnownApplicationDraft = { schemaVersion: 1, knowledge: [{ id: "original-requirement", statement: "The complete original source is required.",
      conditions: "Original task only", citations: [{ evidenceRef: requirementRecord.ref, quote: "complete original evidence" }] }],
      applications: [], relations: [], preparations: [] };
    const originalApply = await stages.applyKnown({ stageRef: first.stageRef, inputHash: first.request.inputHash,
      applicationJson: JSON.stringify(before) }, signal);

    assert.equal(originalApply.status, "residual_review");
    if (originalApply.status !== "residual_review") assert.fail("original public apply failed");

    const sourceRef = sessionContentRecordRef(sessionId, source.sequence);
    const page = await stages.readMaterial({ stageRef: originalApply.stageRef, evidenceRef: sourceRef, start: 40000, maximumChars: 512 }, signal);

    assert.ok(page.ok);
    assert.ok("next" in page && page.next, "reading deferred material must persist and return its successor preparation");

    if (!("next" in page) || !page.next) assert.fail("successor request missing");

    assert.equal(page.record.text, tail);
    assert.equal(page.record.origin, "execution_result");
    assert.notEqual(page.record.ref, sourceRef, "a page cannot impersonate the complete original file");
    assert.ok("source" in page && page.source);

    if (!("source" in page) || !page.source) assert.fail("original source metadata missing");

    assert.equal(page.source.sourceHash, contentHashOf(originalText));
    assert.deepEqual(page.source.coordinate, { runId: sessionId, sequence: source.sequence });
    assert.equal(page.next.status, "apply_known");
    assert.notEqual(page.next.stageRef, first.stageRef);
    assert.notEqual(page.next.request.inputHash, first.request.inputHash);
    const successor = (JSON.parse(page.next.request.materialJson) as { readonly packet: ContentPacket }).packet;

    assert.ok(successor.records.some(record => record.ref === page.record.ref && record.text === tail));
    assert.ok(successor.records.some(record => record.ref === originalApply.stageRef && record.origin === "model_proposal"
      && record.text.includes("previous_public_application_before_source_expansion")), "earlier public work must remain available for reuse and revision");
    const updated: KnownApplicationDraft = { schemaVersion: 1, knowledge: [{ id: "tail-boundary", statement: "The original relation is supported only within Z.",
      conditions: "This original source snapshot, within Z", citations: [{ evidenceRef: page.record.ref, quote: tail }] }],
      applications: [], relations: [], preparations: [] };

    assert.deepEqual(await stages.applyKnown({ stageRef: first.stageRef, inputHash: first.request.inputHash,
      applicationJson: JSON.stringify(updated) }, signal), { status: "rejected", reason: "content_stage_input_changed" });
    const applied = await stages.applyKnown({ stageRef: page.next.stageRef, inputHash: page.next.request.inputHash,
      applicationJson: JSON.stringify(updated) }, signal);

    assert.equal(applied.status, "residual_review");
    if (applied.status !== "residual_review") assert.fail("the admitted new page did not ground its exact quote");

    // A fresh runtime has no in-memory source-page cache. The saved successor and cited text must still replay.
    const restored = createStagedContentSession({ runtime: createNormalTaskContentRuntime(options), enabled: options.enabled });
    const recovered = await restored.begin({ requestId: "material-contract", maximumPromptChars: 100000 }, signal);

    assert.equal(recovered.status, "residual_review");
    if (recovered.status !== "residual_review") assert.fail("successor/application recovery failed");

    assert.equal(recovered.stageRef, applied.stageRef);
    assert.equal(recovered.request.inputHash, applied.request.inputHash);
    const review: ResidualReviewDraft = { schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "undetermined", reason: "The new source bounds a public knowledge claim; no additional question or learning gain is certified.", citations: [] } };
    const published = await restored.review({ stageRef: recovered.stageRef, inputHash: recovered.request.inputHash, reviewJson: JSON.stringify(review) }, signal);

    assert.equal(published.status, "published");
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    const records = readContentRecords(loaded.state.rewardV2Facts ?? [], scope, loaded.state.sequence);

    assert.equal(records.length, 1);
    assert.equal(records[0]!.packet.records.find(record => record.ref === page.record.ref)?.text, tail);
    assert.equal(records[0]!.output.applied.knowledge[0]?.citations[0]?.evidenceRef, page.record.ref);
  } finally {
    await session.release();
    const absolute = resolve(root);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith("trylo-content-stage-material-"));
    await rm(absolute, { recursive: true, force: true });
  }
});
