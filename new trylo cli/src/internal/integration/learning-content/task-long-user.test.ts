import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { sessionContentRecordRef } from "./sources/session.js";

test("a real 40k original user requirement enters the normal 24k source budget as incomplete material and remains fully page-readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-long-user-material-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const head = "FIRST REQUIREMENT: retain the original ownership contract.\n";
  const tail = "\nFINAL REQUIREMENT: verify the final source boundary before concluding.";
  const userText = head + "x".repeat(40000 - head.length - tail.length) + tail;
  const at = "2026-11-04T21:30:00Z", signal = new AbortController().signal;

  try {
    assert.ok((await session.start({ sessionId: "long-user-session", createdAt: at, fingerprint: {
      schemaVersion: "1", providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: "repo:long-user" } })).ok);
    const original = await session.append({ type: "transcript_item", sessionId: "long-user-session", turnId: "long-original-task", at,
      payload: { kind: "user", sequence: 0, text: userText } });
    assert.ok(original.ok);
    const options = { boardRoot: join(root, "board"), scope: "repo:long-user", domain: "tool" as const, session,
      sessionId: "long-user-session", turnId: "long-original-task", enabled: () => true, now: () => Date.parse(at) };
    const runtime = createNormalTaskContentRuntime(options), prepared = await runtime.prepare({}, signal);

    assert.ok(prepared.ok, JSON.stringify(prepared));
    const packet = prepared.value.packet, rawRef = sessionContentRecordRef(options.sessionId, original.sequence);
    const firstRef = `${rawRef}:chunk:0`, first = packet.records.find(row => row.ref === firstRef);
    assert.ok(first);
    assert.ok(first.text.startsWith(head));
    assert.equal(packet.requirements.length, 1);
    assert.equal(packet.requirements[0]?.id, firstRef);
    assert.ok(packet.requirements[0]?.answerRequirement.includes("visible chunk is incomplete"));
    assert.ok(packet.requirements[0]?.requirement.includes(rawRef));
    assert.equal(packet.answers.length, 0);
    const chunks = packet.records.filter(row => row.ref.startsWith(`${rawRef}:chunk:`));

    assert.ok(chunks.reduce((sum, row) => sum + row.text.length, 0) < userText.length);
    assert.ok(prepared.value.coverage.session.omitted.some(ref => ref.startsWith(`${rawRef}:chunk:`)));

    for (const chunk of chunks) {
      const material = packet.materials.find(row => row.id === chunk.ref);
      assert.ok(material);
      const context = JSON.parse(material.context) as { originalRef: string; sourceHash: string; totalChars: number;
        start: number; end: number; transport: string; pagingAvailable: boolean };
      assert.equal(context.originalRef, rawRef);
      assert.equal(context.sourceHash, contentHashOf(userText));
      assert.equal(context.totalChars, 40000);
      assert.equal(context.transport, "partial_source_chunk");
      assert.equal(context.pagingAvailable, true);
      assert.equal(chunk.text, userText.slice(context.start, context.end));
    }

    const stages = createStagedContentSession({ runtime, enabled: options.enabled });
    const begun = await stages.begin({ maximumPromptChars: 100000 }, signal);

    assert.equal(begun.status, "apply_known");
    if (begun.status !== "apply_known") throw new Error("long_user_prepare_failed");

    const modelPacket = (JSON.parse(begun.request.materialJson) as { packet: ContentPacket }).packet;

    assert.ok(modelPacket.records.some(row => row.ref === firstRef && row.text.startsWith(head)));
    assert.ok(modelPacket.requirements[0]?.answerRequirement.includes("incomplete"));
    assert.equal(modelPacket.answers.length, 0);
    const read = await stages.readMaterial({ stageRef: begun.stageRef, evidenceRef: rawRef, start: userText.length - tail.length, maximumChars: 512 }, signal);

    assert.ok(read.ok, JSON.stringify(read));
    assert.ok("source" in read);
    assert.equal(read.source.owner, "session");
    assert.equal(read.source.sourceHash, contentHashOf(userText));
    assert.equal(read.record.text, tail);
    assert.ok("next" in read && read.next);
    const expanded = (JSON.parse(read.next.request.materialJson) as { packet: ContentPacket }).packet;

    assert.ok(expanded.records.some(row => row.ref === read.record.ref && row.text === tail));
    assert.ok(expanded.requirements[0]?.answerRequirement.includes("incomplete"));
    assert.equal(expanded.answers.length, 0);
    const raw = await session.readRecords();
    assert.ok(raw.ok);
    assert.equal(raw.view.records[original.sequence]?.payload.text, userText);
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
