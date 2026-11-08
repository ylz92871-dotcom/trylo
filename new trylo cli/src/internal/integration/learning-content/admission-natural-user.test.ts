import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { compileContentProcess } from "../../learning/central/content/process.js";
import type { ProviderPort } from "../../ports/provider.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import type { NormalTaskContentRuntime } from "./task-runtime-contract.js";
import { contentAdmissionForIssue } from "./admission.js";
import { sessionContentRecordRef, sessionContentRecordView } from "./sources/session.js";

test("actual delivered content makes later raw user input require one saved content review without assigning a correction target", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-natural-admission-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const sessionId = "natural-source-session", scope = "D:\\CC\\trylo", issueId = "issue:natural-source", secrets = ["known-source-credential"];
  const at = "2026-11-04T17:00:00Z", signal = new AbortController().signal, boardRoot = join(root, "board");

  try {
    assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "local-contract",
      model: "local-contract", toolCatalogHash: "catalog", workspaceId: scope } })).ok);
    const appendUser = (turnId: string, text: string) => session.append({ type: "transcript_item", sessionId, turnId, at,
      payload: { kind: "user", sequence: 0, text } });

    assert.ok((await appendUser("original", "Keep the calibration condition tied to the original control source.")).ok);
    const originalRef = sessionContentRecordRef(sessionId, 1);

    assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "natural:report", issuedAt: at,
      action: { kind: "report", scope, issueId, problemKey: "calibration-condition", report: { reportId: "report:natural",
        source: { subsystem: "tool", taskId: "original", versionId: "original-tool" }, facts: ["Preserve the original calibration condition."],
        evidenceRefs: [originalRef] } } }))).ok);
    assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "natural:focus", issuedAt: at,
      action: { kind: "decide", issueId, expectedRevision: 1, decision: "focused_learning", reason: "Review original calibration support.",
        sourceRefs: [originalRef] } }))).ok);
    const options = { boardRoot, scope, domain: "tool" as const, session, sessionId, turnId: "original", enabled: () => true, now: () => Date.parse(at), secrets };
    const admissionInput = { boardRoot, scope, issueId, enabled: options.enabled, sessionSource: { session, sessionId, secrets } };
    const saveReview = async (runtime: NormalTaskContentRuntime, known: boolean) => {
      const prepared = await runtime.prepare({ issueId }, signal);
      assert.ok(prepared.ok, JSON.stringify(prepared));
      const output = compileContentProcess(prepared.value.packet, JSON.stringify({ schemaVersion: 1,
        knowledge: known ? [{ id: "known:control", statement: "Use the original control source when applying the calibration condition.",
          conditions: "Original calibration scope only.", citations: [{ evidenceRef: originalRef, quote: "original control source" }] }] : [],
        applications: [], relations: [], preparations: [] }), JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
        recommendation: { kind: known ? "continue" : "revise", reason: "Retain the original scope and review the newly visible user source.", citations: [] } }));

      assert.ok(output.ok);
      assert.equal((await runtime.publish(prepared.value.packet, output.value)).status, "content_saved");

      return prepared.value.packet;
    };

    await saveReview(createNormalTaskContentRuntime(options), true);
    assert.equal((await contentAdmissionForIssue(admissionInput)).status, "ready");
    const currentText = "Apply the recorded calibration condition in D:\\CC\\trylo\\src\\calibration.ts with known-source-credential.";

    assert.ok((await appendUser("actual-use", currentText)).ok);
    const using = createNormalTaskContentRuntime({ ...options, turnId: "actual-use" });
    const reference = await using.referenceForTask(20000, signal);
    assert.ok(reference.ok);
    assert.ok(reference.value);
    const provider: ProviderPort = { async *stream() {
      yield { type: "stream_start", providerId: "local-contract", model: "local-contract", warnings: [] };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };

    for await (const _event of using.withProvider(provider, reference.value).stream({ attemptId: "actual-use:request", model: "local-contract",
      messages: [{ role: "user", content: currentText }], tools: [] }, signal)) { /* Real delivery receipt owner. */ }

    assert.equal((await contentAdmissionForIssue(admissionInput)).status, "needs_content",
      "The actual delivery turn's original input remains a source candidate even though it precedes the delivery receipt.");
    await saveReview(using, false);
    assert.equal((await contentAdmissionForIssue(admissionInput)).status, "ready");
    const lateText = "The current calibration at D:\\CC\\trylo\\src\\calibration.ts only applies while the control source remains the same; known-source-credential.";
    const late = await appendUser("later-user", lateText);
    assert.ok(late.ok);
    const read = await session.readRecords();
    assert.ok(read.ok);
    const lateView = sessionContentRecordView(read.view.records[late.sequence]!, scope, secrets);
    assert.ok(lateView);
    const lateRef = lateView.record.ref;
    assert.notEqual(lateRef, sessionContentRecordRef(sessionId, late.sequence));
    const changed = await contentAdmissionForIssue(admissionInput);

    assert.equal(changed.status, "needs_content", "A raw user source after an actual issue-linked delivery must reach the worker's content gate.");
    assert.ok(changed.sourceRefs.includes(lateRef));
    const reviewed = await saveReview(createNormalTaskContentRuntime({ ...options, turnId: "later-user" }), false);

    assert.ok(reviewed.records.some(record => record.ref === lateRef && record.origin === "user_statement" && record.text === lateView.record.text));
    assert.ok(lateView.record.text.includes("<workspace>"));
    assert.ok(!lateView.record.text.includes(secrets[0]!));
    const after = await session.readRecords();
    assert.ok(after.ok);
    assert.equal(after.view.records[late.sequence]!.payload.text, lateText);
    assert.equal((await contentAdmissionForIssue(admissionInput)).status, "ready");
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
