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
import { readSessionContent, sessionContentRecordRef } from "./sources/session.js";

test("normal coding paths enter staged learning under new public-view identities and cold source pages reproduce the same sanitized bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-source-view-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const scope = "D:\\CC\\trylo", at = "2026-11-04T20:30:00Z", signal = new AbortController().signal;
  const userText = `Inspect ${scope}\\src\\owner.ts. Preserve source evidence.`, secret = "contract-secret-not-for-model";
  const toolText = `Read ${scope}\\src\\owner.ts. Token ${secret}.\n` + "original source detail ".repeat(2000) + "source-tail";

  try {
    assert.ok((await session.start({ sessionId: "source-view-session", createdAt: at, fingerprint: {
      schemaVersion: "1", providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: scope } })).ok);
    const append = (payload: Parameters<typeof session.append>[0]["payload"]) => session.append({ type: "transcript_item",
      sessionId: "source-view-session", turnId: "coding-task", at, payload });
    const user = await append({ kind: "user", sequence: 0, text: userText });
    assert.ok(user.ok);
    assert.ok((await append({ kind: "tool_call", sequence: 1, toolCallId: "source-read", name: "Read", arguments: { path: `${scope}\\src\\owner.ts` } })).ok);
    const tool = await append({ kind: "tool_result", sequence: 2, toolCallId: "source-read", name: "Read", output: toolText, truncated: false, outcome: "succeeded" });
    assert.ok(tool.ok);
    assert.ok((await append({ kind: "assistant_reasoning", sequence: 3, blockId: "hidden", text: "private source reasoning", redacted: false })).ok);
    const options = { boardRoot: join(root, "board"), scope, domain: "tool" as const, session, sessionId: "source-view-session",
      turnId: "coding-task", enabled: () => true, now: () => Date.parse(at), secrets: [secret] };
    const runtime = createNormalTaskContentRuntime(options), prepared = await runtime.prepare({}, signal);

    assert.ok(prepared.ok, JSON.stringify(prepared));
    const userRef = sessionContentRecordRef(options.sessionId, user.sequence), toolRef = sessionContentRecordRef(options.sessionId, tool.sequence);
    const userView = prepared.value.packet.records.find(row => row.origin === "user_statement");
    assert.ok(userView);
    assert.ok(userView.ref.startsWith("content-source-view:"));
    assert.equal(userView.runId, userView.ref);
    assert.equal(userView.sequence, 0);
    assert.notEqual(userView.ref, userRef);
    assert.ok(userView.text.includes("<workspace>"));
    assert.ok(!userView.text.includes(scope));
    assert.ok(prepared.value.packet.aliases?.some(alias => alias.ref === userRef && alias.recordRefs.includes(userView.ref)));
    assert.ok(prepared.value.packet.records.some(row => row.ref.includes(":chunk:") && row.text.includes("original source detail")));
    assert.ok(!JSON.stringify(prepared.value.packet).includes(secret));
    const routed = await runtime.readMaterial({ packet: prepared.value.packet, evidenceRef: toolRef, start: 0, maximumChars: 512 }, signal);

    assert.ok(routed.ok);
    assert.equal(routed.value.owner, "session");
    assert.equal(routed.value.coordinate.runId, routed.value.originalRef);
    assert.equal(routed.value.coordinate.sequence, 0);
    assert.ok(routed.value.originalRef.startsWith("content-source-view:"));
    assert.ok(!routed.value.text.includes(secret));
    const stages = createStagedContentSession({ runtime, enabled: options.enabled, secrets: options.secrets });
    const begun = await stages.begin({ maximumPromptChars: 100000 }, signal);

    assert.equal(begun.status, "apply_known");
    if (begun.status !== "apply_known") throw new Error("source_view_begin_failed");

    const modelPacket = (JSON.parse(begun.request.materialJson) as { packet: ContentPacket }).packet;

    assert.ok(modelPacket.records.some(row => row.ref === userView.ref && row.text === userView.text));
    const applied = await stages.applyKnown({ stageRef: begun.stageRef, inputHash: begun.request.inputHash,
      applicationJson: JSON.stringify({ schemaVersion: 1, knowledge: [{ id: "known:source-view", statement: "Preserve source evidence before narrowing a coding investigation.",
        conditions: "Only the original coding requirement and sanitized source view.", citations: [{ evidenceRef: userView.ref, quote: "Preserve source evidence." }] }],
        applications: [], relations: [], preparations: [] }) }, signal);

    assert.equal(applied.status, "residual_review");
    if (applied.status !== "residual_review") throw new Error("source_view_apply_failed");

    const saved = await stages.review({ stageRef: applied.stageRef, inputHash: applied.request.inputHash,
      reviewJson: JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
        recommendation: { kind: "continue", reason: "The source remains a scoped observation rather than a verified learning gain.", citations: [] } }) }, signal);

    assert.equal(saved.status, "published");
    const sourceInput = { session, sessionId: options.sessionId, turnId: options.turnId, scope, subsystem: "tool" as const,
      enabled: options.enabled, secrets: options.secrets };
    const cold = await readSessionContent(sourceInput, signal);
    assert.ok(cold.ok);
    const full = await cold.value.source.readMaterial(toolRef, signal, 0, 8192);
    assert.ok(full.ok);
    assert.ok(full.value.ref.startsWith("content-source-view:"));
    assert.equal(full.value.coordinate?.runId, full.value.ref);
    assert.equal(full.value.coordinate?.sequence, 0);
    assert.equal(full.value.originalSource?.sourceHash, contentHashOf(toolText));
    assert.equal(full.value.originalSource?.ref, toolRef);
    assert.ok(!full.value.text.includes(secret));
    assert.ok(full.value.text.includes("<workspace>"));
    assert.equal(routed.value.sourceHash, full.value.sourceHash);
    const byView = await cold.value.source.readMaterial(full.value.ref, signal, 0, 8192);
    assert.deepEqual(byView, full);
    const secondCold = await readSessionContent(sourceInput, signal);
    assert.ok(secondCold.ok);
    const tail = await secondCold.value.source.readMaterial(full.value.ref, signal, full.value.totalChars - "source-tail".length, 128);
    assert.ok(tail.ok);
    assert.equal(tail.value.text, "source-tail");
    assert.equal(tail.value.sourceHash, full.value.sourceHash);
    const index = await cold.value.source.listMaterials(signal);
    assert.ok(index.ok);
    assert.equal(index.value.entries.find(row => row.originalRef === toolRef)?.ref, full.value.ref);
    assert.ok(!JSON.stringify(index.value).includes(secret));
    assert.ok(!JSON.stringify(index.value).includes("private source reasoning"));
    const raw = await session.readRecords();
    assert.ok(raw.ok);
    assert.equal(raw.view.records[tool.sequence]?.payload.output, toolText, "The public view never rewrites the original journal.");
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
