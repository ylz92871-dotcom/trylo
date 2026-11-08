import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import { compileContentProcess } from "../../learning/central/content/process.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { contentAdmissionForIssue } from "./admission.js";
import { boardUserFeedbackMaterialBatch } from "./sources/feedback-board.js";
import { sessionContentRecordRef } from "./sources/session.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { projectContentSourceText } from "./sources/source-text-view.js";

for (const confidential of [false, true]) test(`a deferred late-feedback locator cannot admit a worker; real complete successor pages can${confidential ? " with Windows scope and a known secret" : ""}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-feedback-admission-pages-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") }), boardRoot = join(root, "board");
  const scope = confidential ? "D:\\CC\\trylo" : "repo:feedback-pages", secrets = confidential ? ["known-feedback-source-credential"] : [];
  const sessionId = "feedback-pages-current", turnId = "review", issueId = "issue:feedback-pages";
  const at = "2026-11-05T01:00:00Z", signal = new AbortController().signal;

  try {
    assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "local-contract",
      model: "local-contract", toolCatalogHash: "catalog", workspaceId: scope } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId, turnId, at,
      payload: { kind: "user", sequence: 0, text: "Compare later feedback with the original supported conditions." } })).ok);
    const originalRef = sessionContentRecordRef(sessionId, 1), exposureId = "exposure:large-late-feedback";

    assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "feedback-pages:report", issuedAt: at,
      action: { kind: "report", scope, issueId, problemKey: "original-feedback-boundary", report: { reportId: "report:feedback-pages",
        source: { subsystem: "tool", taskId: turnId, versionId: "original-tool" }, facts: ["Keep the original supported conditions."],
        evidenceRefs: [originalRef, exposureId] } } }))).ok);
    assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "feedback-pages:focus", issuedAt: at,
      action: { kind: "decide", issueId, expectedRevision: 1, decision: "focused_learning", reason: "Compare the recorded support.",
        sourceRefs: [originalRef] } }))).ok);
    const options = { boardRoot, scope, domain: "tool" as const, session, sessionId, turnId, enabled: () => true, now: () => Date.parse(at), secrets };
    const runtime = createNormalTaskContentRuntime(options), admission = () => contentAdmissionForIssue({ boardRoot, scope, issueId, enabled: options.enabled, secrets });
    const publish = async (packet: ContentPacket) => {
      const output = compileContentProcess(packet, JSON.stringify({ schemaVersion: 1, knowledge: [], applications: [], relations: [], preparations: [] }),
        JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
          recommendation: { kind: "continue", reason: "This contract checks source entry only, without judging its interpretation or learning effect.", citations: [] } }));
      assert.ok(output.ok);
      assert.equal((await runtime.publish(packet, output.value)).status, "content_saved");
    };
    const baseline = await runtime.prepare({ issueId }, signal);
    assert.ok(baseline.ok);
    await publish(baseline.value.packet);
    assert.equal((await admission()).status, "ready");
    // RW1 permits a single active user head per exposure. Large legal target identities
    // and their exact attribution make that real head too large for the inline transport.
    const targets = Array.from({ length: 8 }, (_, index) => ({ kind: "capability", id: `target:${index}:${"I".repeat(190)}`,
      version: `version:${index}:${"V".repeat(190)}` }));
    const source = { sessionId: "feedback-pages-old", turnId: "actual-old-use", attemptId: "old-attempt", eventId: "old-use-event" };

    assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "record_reward_exposure", commandId: "feedback-pages:exposure", issuedAt: at,
      exposure: { schemaVersion: 1, id: exposureId, source, targets, occurredAt: 1, context: { scope, taskFamily: "actual-old-use", environment: "local",
        metric: { id: "task-report", version: "v1", unit: "report", minimum: -1, maximum: 1, preference: "higher" } } } }))).ok);
    assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "record_reward_feedback", commandId: "feedback-pages:feedback", issuedAt: at,
      feedback: { schemaVersion: 1, id: "feedback:active-late", exposureId, source: { ...source, eventId: "late-user-event" }, origin: "user",
        evidenceIds: [`original-user-source:late${confidential ? `:${secrets[0]}` : ""}`], outcome: { kind: "unknown", reason: "unverified" },
        attribution: { kind: "linked", shares: targets.map(target => ({ target, share: 1 / targets.length })) }, observedAt: 2 } }))).ok);
    assert.equal((await admission()).status, "needs_content");
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    const full = boardUserFeedbackMaterialBatch({ board: loaded.state, scope, issueId, subsystem: "tool", artifacts: [] }).records[0]!;
    const view = projectContentSourceText(full, secrets);

    assert.ok(full.text.length > 8000 && full.text.length < 24000, "the actual canonical source must exceed the inline head budget");
    const stages = createStagedContentSession({ runtime, enabled: options.enabled });
    const start = await stages.begin({ requestId: "late-feedback-pages", issueId, maximumPromptChars: 100000 }, signal);

    assert.equal(start.status, "apply_known", JSON.stringify(start));
    if (start.status !== "apply_known") assert.fail(JSON.stringify(start));

    const packet = (JSON.parse(start.request.materialJson) as { readonly packet: ContentPacket }).packet;

    assert.ok(packet.records.some(record => record.text.includes('"role":"exact_feedback_source_available_by_readMaterial"')
      && record.text.includes(view.record.ref)), "normal preparation must exercise the real deferred locator branch");
    await publish(packet);
    assert.equal((await admission()).status, "needs_content", "saving a locator did not put the late feedback content into the model input");
    let stageRef = start.stageRef, nextPacket = packet, position = 0;

    while (position < view.record.text.length) {
      const page = await stages.readMaterial({ stageRef, evidenceRef: full.ref, start: position, maximumChars: 8192 }, signal);

      assert.ok(page.ok, JSON.stringify(page));
      assert.ok("next" in page && page.next);

      if (!("next" in page) || !page.next || !("source" in page) || !page.source) assert.fail("real successor source metadata missing");

      assert.equal(page.source.sourceHash, contentHashOf(view.record.text));
      assert.equal(page.source.owner, "feedback");
      assert.deepEqual(page.source.coordinate, { runId: view.record.runId, sequence: view.record.sequence });
      assert.ok(page.source.end > position);

      if (confidential) {
        assert.deepEqual(page.source.originalSource, view.original);
        assert.equal(page.record.text.includes(secrets[0]!), false);
        assert.equal(page.record.text.includes(scope), false);
      }

      stageRef = page.next.stageRef;
      position = page.source.end;
      nextPacket = (JSON.parse(page.next.request.materialJson) as { readonly packet: ContentPacket }).packet;
      await publish(nextPacket);
      assert.equal((await admission()).status, position < view.record.text.length ? "needs_content" : "ready",
        "only real complete page coverage can clear source freshness; an incomplete prefix cannot");
    }
  } finally {
    await session.release();
    const absolute = resolve(root);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith("trylo-feedback-admission-pages-"));
    await rm(absolute, { recursive: true, force: true });
  }
});
