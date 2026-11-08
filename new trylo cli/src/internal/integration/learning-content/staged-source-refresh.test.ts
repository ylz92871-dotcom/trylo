import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { contentDomainFeedbackText, type ContentDomainFeedback } from "./sources/domain-feedback.js";

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function successor(value: unknown) {
  assert.ok(object(value) && object(value.next));
  const next = value.next;
  assert.equal(next.status, "apply_known");
  assert.equal(typeof next.stageRef, "string");
  assert.ok(object(next.request));
  const request = next.request;
  assert.equal(request.stage, "apply_known");
  assert.ok(typeof next.stageRef === "string" && typeof request.inputHash === "string" && typeof request.materialJson === "string");
  return { stageRef: next.stageRef, inputHash: request.inputHash, materialJson: request.materialJson };
}

test("cold deferred source loss creates an honest current-snapshot successor, retains the public apply and rejects old inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-cold-source-")), boardRoot = join(root, "board");
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const at = "2026-11-04T18:00:00Z", scope = "repo:cold-source", sessionId = "cold-source-session", turnId = "source-task", issueId = "issue:cold-source";
  const signal = new AbortController().signal;

  try {
    assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "local-contract",
      model: "local-contract", toolCatalogHash: "catalog", workspaceId: "workspace:cold-source" } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId, turnId, at, payload: { kind: "user", sequence: 0,
      text: "Preserve the original calibration requirement while reading its actual support." } })).ok);
    assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "cold:report", issuedAt: at,
      action: { kind: "report", scope, issueId, problemKey: "calibration-support", report: { reportId: "report:cold",
        source: { subsystem: "tool", taskId: turnId, versionId: "original-tool" }, facts: ["Review actual calibration support."], evidenceRefs: [] } } }))).ok);
    assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "cold:focus", issuedAt: at,
      action: { kind: "decide", issueId, expectedRevision: 1, decision: "focused_learning", reason: "Preserve original support scope.", sourceRefs: [] } }))).ok);
    const frame = (label: string): ContentDomainFeedback => {
      const records = [{ role: "actual_source", marker: label, sourceRef: `source:${label}`, originalOutput: "x".repeat(70000) }];
      return { sourceRef: `domain-feedback:${contentHashOf(records)}`, sourceRefs: [`source:${label}`], records };
    };
    const originalFrame = frame("FRAME_A_ORIGINAL"), currentFrame = frame("B_LATE_SOURCE_FACT");
    let current = originalFrame;
    const options = { boardRoot, scope, domain: "tool" as const, session, sessionId, turnId, enabled: () => true,
      now: () => Date.parse(at), domainFeedback: async () => current };
    const first = createStagedContentSession({ runtime: createNormalTaskContentRuntime(options), enabled: options.enabled });
    const begin = await first.begin({ issueId, requestId: "cold-source-operation", maximumPromptChars: 100000 }, signal);

    assert.equal(begin.status, "apply_known");
    if (begin.status !== "apply_known") assert.fail("begin_failed");

    const originalPacket = (JSON.parse(begin.request.materialJson) as { packet: ContentPacket }).packet;

    assert.ok(originalPacket.retrieval.requestedRefs.includes(originalFrame.sourceRef));
    assert.ok(!originalPacket.records.some(record => record.ref === originalFrame.sourceRef), "The original full frame must be deferred, not already persisted inline.");
    const requirement = originalPacket.records.find(record => record.origin === "user_statement")!;
    const statement = "The original calibration requirement must remain in scope.";
    const applicationJson = JSON.stringify({ schemaVersion: 1, knowledge: [{ id: "known:original-scope", statement,
      conditions: "Original calibration support only.", citations: [{ evidenceRef: requirement.ref, quote: "original calibration requirement" }] }],
      applications: [], relations: [], preparations: [] });
    const applied = await first.applyKnown({ stageRef: begin.stageRef, inputHash: begin.request.inputHash, applicationJson }, signal);

    assert.equal(applied.status, "residual_review");
    if (applied.status !== "residual_review") assert.fail("apply_failed");

    current = currentFrame;
    const coldRuntime = createNormalTaskContentRuntime(options), cold = createStagedContentSession({ runtime: coldRuntime, enabled: options.enabled });
    const changed = await cold.readMaterial({ stageRef: applied.stageRef, evidenceRef: originalFrame.sourceRef, start: 0, maximumChars: 1024 }, signal);

    assert.equal(changed.ok, false);
    if (changed.ok) assert.fail("old_source_must_not_succeed");

    assert.equal(changed.reason, "content_material_snapshot_changed");
    const next = successor(changed), newPacket = (JSON.parse(next.materialJson) as { packet: ContentPacket }).packet;

    assert.notEqual(next.stageRef, begin.stageRef);
    assert.notEqual(next.inputHash, begin.request.inputHash);
    assert.ok(newPacket.materials.some(material => material.recordRefs.includes(currentFrame.sourceRef)));
    assert.ok(newPacket.records.some(record => record.text.includes("B_LATE_SOURCE_FACT")));
    assert.ok(!newPacket.records.some(record => record.ref === originalFrame.sourceRef), "New text must never masquerade under the old source ref.");
    assert.ok(newPacket.records.some(record => record.origin === "model_proposal" && record.text.includes(statement)
      && record.text.includes(applied.stageRef)), "The earlier public apply must remain available as data for comparison.");
    const currentPage = await coldRuntime.readMaterial({ packet: newPacket, evidenceRef: currentFrame.sourceRef, start: 0, maximumChars: 1024 }, signal);

    assert.ok(currentPage.ok);
    assert.ok(currentPage.value.text.includes("B_LATE_SOURCE_FACT"));
    assert.equal(currentPage.value.sourceHash, contentHashOf(contentDomainFeedbackText(currentFrame)));
    const reopened = createStagedContentSession({ runtime: createNormalTaskContentRuntime(options), enabled: options.enabled });
    const restored = await reopened.begin({ issueId, requestId: "cold-source-operation", maximumPromptChars: 100000 }, signal);

    assert.equal(restored.status, "apply_known");
    if (restored.status !== "apply_known") assert.fail("cold_restore_failed");

    assert.equal(restored.stageRef, next.stageRef);
    assert.equal(restored.request.inputHash, next.inputHash);
    const old = await reopened.applyKnown({ stageRef: begin.stageRef, inputHash: begin.request.inputHash, applicationJson }, signal);

    assert.deepEqual(old, { status: "rejected", reason: "content_stage_input_changed" });
    const before = await createBoardReader(boardRoot).load();
    assert.ok(before.ok);
    const unavailable = createStagedContentSession({ runtime: { ...createNormalTaskContentRuntime(options),
      // A pager outage with the same real current source declaration must not manufacture a new snapshot.
      readMaterial: async () => ({ ok: false as const, reason: "content_material_missing" }) }, enabled: options.enabled });
    const unchanged = await unavailable.readMaterial({ stageRef: next.stageRef, evidenceRef: currentFrame.sourceRef, maximumChars: 1024 }, signal);

    assert.equal(unchanged.ok, false);
    if (unchanged.ok) assert.fail("missing_source_must_not_succeed");

    assert.equal(unchanged.reason, "content_material_missing");
    assert.ok(!("next" in unchanged));
    const after = await createBoardReader(boardRoot).load();
    assert.ok(after.ok);
    assert.equal(after.state.sequence, before.state.sequence);
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
