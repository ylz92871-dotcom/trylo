import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { readSessionContent, sessionContentRecordRef, sessionContentRecordView, sessionTaskAddress } from "./sources/session.js";
import type { SessionContentPage } from "./sources/session-contract.js";

test("queued requirements overflow to an honest source collection and every original body stays reachable through real staged pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-required-users-")), session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const sessionId = "d0443148-1430-42e8-bef9-6098c9f72d21", turnId = "6a30a326-bfee-47ef-b617-d7d87a541aa1", scope = "D:\\CC\\trylo", at = "2026-11-05T02:00:00Z";
  const secrets = ["queued-known-credential"], signal = new AbortController().signal;

  try {
    assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "local-contract", model: "local-contract",
      toolCatalogHash: "catalog", workspaceId: scope } })).ok);
    const texts = ["Original requirement A. " + "a".repeat(18000) + "TAIL_A", "Independent requirement B. " + "b".repeat(18000) + "TAIL_B",
      `Keep source ${scope}\\src\\owner.ts and queued-known-credential private. ` + "c".repeat(18000) + "TAIL_C"];
    const sequences: number[] = [];

    for (const [index, text] of texts.entries()) {
      const written = await session.append({ type: "transcript_item", sessionId, turnId, at, payload: { kind: "user", sequence: index, text } });
      assert.ok(written.ok);
      sequences.push(written.sequence);
    }

    const options = { boardRoot: join(root, "board"), scope, domain: "tool" as const, session, sessionId, turnId, enabled: () => true,
      now: () => Date.parse(at), secrets };
    const runtime = createNormalTaskContentRuntime(options), prepared = await runtime.prepare({}, signal);
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const index = prepared.value.packet.records.find(record => record.ref.startsWith("session-required-user-index:"));
    assert.ok(index);
    assert.equal(index.origin, "execution_result");
    assert.ok(!prepared.value.packet.records.some(record => record.origin === "user_statement"));
    const directory = JSON.parse(index.text) as { readonly availableSources: number; readonly shownSources: number; readonly omittedSources: number;
      readonly catalog: { readonly ref: string; readonly sourceHash: string }; readonly sources: readonly { readonly originalRef: string; readonly sourceRef: string }[] };

    assert.equal(directory.availableSources, 3);
    assert.equal(directory.shownSources + directory.omittedSources, 3);

    for (const sequence of sequences) {
      const ref = sessionContentRecordRef(sessionId, sequence);
      assert.ok(directory.sources.some(source => source.originalRef === ref));
      assert.ok(!prepared.value.packet.aliases?.some(alias => alias.ref === ref && alias.recordRefs.includes(index.ref)), "The index is not an alias for user text.");
    }

    assert.ok(prepared.value.packet.requirements.some(requirement => requirement.requirement.includes("3") && requirement.requirement.includes("unread")));
    assert.ok(!canonicalJson(prepared.value.packet).includes(secrets[0]!));
    const stages = createStagedContentSession({ runtime, enabled: options.enabled, secrets });
    const begin = await stages.begin({ maximumPromptChars: 100000 }, signal);

    assert.equal(begin.status, "apply_known");
    if (begin.status !== "apply_known") assert.fail("collection_begin_failed");

    const catalogPage = await stages.readMaterial({ stageRef: begin.stageRef, evidenceRef: directory.catalog.ref, maximumChars: 8192 }, signal);

    assert.ok(catalogPage.ok);
    assert.ok("next" in catalogPage && catalogPage.next);
    let stageRef = catalogPage.next.stageRef;
    const wholeTurn = await stages.readMaterial({ stageRef, evidenceRef: sessionTaskAddress(turnId), maximumChars: 8192 }, signal);

    assert.ok(wholeTurn.ok);
    assert.equal(wholeTurn.record.text, catalogPage.record.text);
    assert.ok("next" in wholeTurn && wholeTurn.next);
    stageRef = wholeTurn.next.stageRef;
    assert.ok(catalogPage.record.text.includes("TAIL_A") === false, "The directory locates requirements rather than impersonating their bodies.");
    const raw = await session.readRecords();
    assert.ok(raw.ok);

    for (const [index, sequence] of sequences.entries()) {
      const view = sessionContentRecordView(raw.view.records[sequence]!, scope, secrets);
      assert.ok(view);
      const tail = `TAIL_${String.fromCharCode(65 + index)}`;
      const page = await stages.readMaterial({ stageRef, evidenceRef: view.original.ref, start: view.record.text.length - tail.length, maximumChars: 128 }, signal);
      assert.ok(page.ok);
      assert.equal(page.record.text, tail);
      assert.ok("next" in page && page.next);
      stageRef = page.next.stageRef;
      const current = (JSON.parse(page.next.request.materialJson) as { packet: ContentPacket }).packet;
      assert.ok(current.records.some(record => record.ref === page.record.ref && record.text === tail));
    }

    const sourceInput = { session, sessionId, turnId, scope, subsystem: "tool" as const, enabled: options.enabled, secrets, maximumChars: 24000 };
    const cold = await readSessionContent(sourceInput, signal);
    assert.ok(cold.ok);
    assert.ok(cold.value.taskPurpose.includes("Original requirement A."));
    assert.ok(cold.value.taskPurpose.includes("Independent requirement B."));
    assert.ok(cold.value.taskPurpose.includes("<workspace>"));
    assert.ok(cold.value.taskPurpose.length <= 3000);
    const restored = await cold.value.source.readMaterial(directory.catalog.ref, signal, 0, 8192);
    assert.ok(restored.ok);
    assert.equal(restored.value.text, catalogPage.record.text);
    assert.equal(restored.value.sourceHash, directory.catalog.sourceHash);

    for (let i = 3; i < 40; i++) assert.ok((await session.append({ type: "transcript_item", sessionId, turnId, at,
      payload: { kind: "user", sequence: i, text: `Additional original queued requirement ${i}.` } })).ok);

    const many = await createNormalTaskContentRuntime(options).prepare({}, signal);
    assert.ok(many.ok, JSON.stringify(many));
    const manyIndex = many.value.packet.records.find(record => record.ref.startsWith("session-required-user-index:"));
    assert.ok(manyIndex);
    const metadata = JSON.parse(manyIndex.text) as typeof directory;
    assert.equal(metadata.availableSources, 40);
    assert.ok(metadata.omittedSources > 0);
    const manySource = await readSessionContent(sourceInput, signal);
    assert.ok(manySource.ok);
    const first = await manySource.value.source.readMaterial(metadata.catalog.ref, signal, 0, 8192);
    assert.ok(first.ok);
    let full = first.value.text;

    while (full.length < first.value.totalChars) {
      const nextPage: SessionContentPage | { readonly ok: false; readonly reason: string } = await manySource.value.source.readMaterial(metadata.catalog.ref, signal, full.length, 8192);
      assert.ok(nextPage.ok);
      assert.equal(nextPage.value.sourceHash, first.value.sourceHash);
      full += nextPage.value.text;
    }

    assert.equal(contentHashOf(full), metadata.catalog.sourceHash);
    const all = JSON.parse(full) as { readonly sources: readonly unknown[] };
    assert.equal(all.sources.length, 40);
    const after = await session.readRecords();
    assert.ok(after.ok);
    sequences.forEach((sequence, index) => assert.equal(after.view.records[sequence]!.payload.text, texts[index]));
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
