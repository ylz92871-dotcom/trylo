import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { compileContentProcess } from "../../learning/central/content/process.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { mergeContentBatches } from "../../learning/central/content/material.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { readContentRecords } from "./records.js";
import { contentRecordMaterialBatch } from "./source.js";
import { contentRecallMaterialBatch } from "./sources/content-recall.js";

test("a real large Session product reaches the next normal task as bounded knowledge with exact evidence pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-large-recall-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const at = "2026-11-04T16:00:00Z", signal = new AbortController().signal;

  try {
    assert.ok((await session.start({ sessionId: "large-recall-session", createdAt: at, fingerprint: {
      schemaVersion: "1", providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: "workspace:large-recall" } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId: "large-recall-session", turnId: "first", at,
      payload: { kind: "user", sequence: 0, text: "Calibration requires original control evidence. " + "original-source-detail ".repeat(900) } })).ok);
    const options = { boardRoot: join(root, "board"), scope: "repo:large-recall", domain: "tool" as const,
      session, sessionId: "large-recall-session", turnId: "first", enabled: () => true, now: () => Date.parse(at) };
    const runtime = createNormalTaskContentRuntime(options), prepared = await runtime.prepare({}, signal);
    assert.ok(prepared.ok);
    const original = prepared.value.packet.records.find(row => row.origin === "user_statement" && row.text.includes("original control evidence"));
    assert.ok(original);
    assert.ok(original.text.length > 18000);
    const output = compileContentProcess(prepared.value.packet, JSON.stringify({ schemaVersion: 1,
      knowledge: [{ id: "known:calibration", statement: "Calibration requires original control evidence before selecting the threshold.",
        conditions: "Only the recorded calibration requirement; no wider threshold validity is established.",
        citations: [{ evidenceRef: original.ref, quote: "Calibration requires original control evidence." }] }],
      applications: [], relations: [], preparations: [{ description: "Obtain the missing original comparison measurement.", sourceRefs: [original.ref] },
        ...[1, 2, 3].map(index => ({ description: `Preserve original preparation ${index}: ` + "pending comparison detail ".repeat(120), sourceRefs: [original.ref] }))] }),
    JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "continue", reason: "Keep the original comparison preparation; success has not been demonstrated.", citations: [] } }));

    assert.ok(output.ok);
    assert.equal((await runtime.publish(prepared.value.packet, output.value)).status, "content_saved");
    const loaded = await createBoardReader(options.boardRoot).load();
    assert.ok(loaded.ok);
    const saved = readContentRecords(loaded.state.rewardV2Facts ?? [], options.scope, loaded.state.sequence)[0]!;

    assert.ok(mergeContentBatches([contentRecordMaterialBatch(saved, options.scope), contentRecallMaterialBatch(saved, options.scope)]).ok,
      "Compact projections and complete legacy material must coexist without conflicting immutable answer or material identities.");
    assert.ok((await session.append({ type: "transcript_item", sessionId: "large-recall-session", turnId: "second", at,
      payload: { kind: "user", sequence: 0, text: "Continue the calibration threshold investigation." } })).ok);
    const next = createNormalTaskContentRuntime({ ...options, turnId: "second" });
    const reference = await next.referenceForTask(20000, signal);
    assert.ok(reference.ok);
    assert.ok(reference.value, "A small real learning product must not disappear because its original Session evidence is large.");
    assert.ok(reference.value.text.includes("Calibration requires original control evidence before selecting the threshold."));
    assert.ok(reference.value.text.includes("Only the recorded calibration requirement"));
    assert.ok(reference.value.text.includes("Obtain the missing original comparison measurement."));
    assert.ok(reference.value.text.includes("success has not been demonstrated"));
    assert.ok(reference.value.text.includes(original.ref));
    assert.ok(reference.value.text.includes("bounded_public_product_recall_original_evidence_deferred"));
    assert.ok(reference.value.text.includes("sourceHash"));
    assert.ok(!reference.value.text.includes("original-source-detail ".repeat(200)));
    assert.equal(reference.value.contentFactIds.length, 1);
    const current = await next.prepare({}, signal);
    assert.ok(current.ok);
    const page = await next.readMaterial({ packet: current.value.packet, evidenceRef: original.ref, start: 10000, maximumChars: 512 }, signal);

    assert.ok(page.ok);
    assert.ok(page.value.text.includes("original-source-detail"));
    const processPage = await next.readMaterial({ packet: current.value.packet,
      evidenceRef: `content-process:${contentHashOf(reference.value.contentFactIds[0]!)}`, start: 0, maximumChars: 8192 }, signal);

    assert.ok(processPage.ok);
    assert.ok(processPage.value.totalChars > 9000);
    assert.ok(processPage.value.text.includes("pending comparison detail"));
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
