import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { testScratchPath } from "../../testing/scratch.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { contentContextForIssue } from "./issue-context.js";
import { readContentDomainFeedbackBasis } from "./sources/domain-feedback.js";

test("normal domain feedback retains original lineage while private path/credential prose uses the same safe view inline and paged", async () => {
  const parent = testScratchPath("content-domain-source-view");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-")), at = "2026-11-04T15:00:00Z";
  const scope = "D:\\CC\\trylo", signal = new AbortController().signal, key = "known-domain-private-value";
  const session = createNdjsonSessionStore({ path: join(root, "journal.ndjson") });

  try {
    assert.ok((await session.start({ sessionId: "domain-source-view", createdAt: at, fingerprint: { schemaVersion: "1",
      providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: "workspace:domain-source-view" } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId: "domain-source-view", turnId: "turn:1", at,
      payload: { kind: "user", sequence: 0, text: "Compare the actual use with the original quality requirement." } })).ok);
    const boardRoot = join(root, "board");
    const reported = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "domain-source-report", issuedAt: at,
      action: { kind: "report", scope, issueId: "issue:domain-source-view", problemKey: "actual-use", report: { reportId: "report:domain-source-view",
        source: { subsystem: "tool", taskId: "turn:1", versionId: "tool:original" }, facts: ["Actual use needs comparison."], evidenceRefs: [] } } }));
    assert.ok(reported.ok, JSON.stringify(reported));
    assert.ok((await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: "domain-source-focus", issuedAt: at,
      action: { kind: "decide", issueId: "issue:domain-source-view", expectedRevision: 1, decision: "focused_learning",
        reason: "Inspect actual use within the original conditions.", sourceRefs: [] } }))).ok);
    const frame = { sourceRef: "domain-frame:actual-use", sourceRefs: ["receipt:actual-use"], records: [{ role: "actual_use",
      receipt: "actual use returned", workspaceScope: scope, file: `${scope}\\src\\result.ts`, privateNote: key,
      taskResult: "unknown", learningGain: "unknown" }] };
    const options = { boardRoot, scope, domain: "tool" as const, session, sessionId: "domain-source-view", turnId: "turn:1",
      enabled: () => true, now: () => Date.parse(at), secrets: [key], domainFeedback: () => frame };
    const runtime = createNormalTaskContentRuntime(options), prepared = await runtime.prepare({ issueId: "issue:domain-source-view" }, signal);

    assert.ok(prepared.ok);
    const packet = prepared.value.packet;
    const alias = packet.aliases?.find(row => row.ref === frame.sourceRef);
    assert.ok(alias);
    const record = packet.records.find(row => row.ref === alias.recordRefs[0]);
    assert.ok(record);
    assert.notEqual(record.ref, frame.sourceRef);
    assert.ok(record.text.includes("<workspace>"));
    assert.ok(!record.text.includes(key));
    assert.equal(readContentDomainFeedbackBasis(packet, "issue:domain-source-view")[0]?.fingerprint, contentHashOf(frame));
    const page = await runtime.readMaterial({ packet, evidenceRef: frame.sourceRef, maximumChars: 8192 }, signal);
    assert.ok(page.ok);
    assert.equal(page.value.originalRef, record.ref);
    assert.equal(page.value.sourceHash, contentHashOf(record.text));
    assert.equal(page.value.text, record.text);
    assert.equal(page.value.originalSource?.ref, frame.sourceRef);
    const staged = createStagedContentSession({ runtime, enabled: options.enabled, secrets: options.secrets });
    const begin = await staged.begin({ issueId: "issue:domain-source-view", maximumPromptChars: 100000 }, signal);
    assert.equal(begin.status, "apply_known");
    const context = await contentContextForIssue({ ...options, issueId: "issue:domain-source-view", maximumChars: 30000 });
    assert.ok(context.ok);
    assert.ok(!context.value.text.includes(key));
    assert.ok(context.value.text.includes("<workspace>"));
    const larger = await contentContextForIssue({ ...options, issueId: "issue:domain-source-view", maximumChars: 160000 });
    assert.ok(larger.ok, "an explicit domain allowance above the former default must reach the original source reader");
    assert.deepEqual(larger.value.sourceRefs, context.value.sourceRefs);
    assert.deepEqual(JSON.parse(larger.value.text).currentReports, JSON.parse(context.value.text).currentReports);
    assert.ok(!larger.value.text.includes(key));
    const lineageFrame = { sourceRef: "domain-frame:large-lineage", sourceRefs: Array.from({ length: 160 },
      (_, index) => `receipt:${index}:${"a".repeat(80)}`), records: [{ role: "actual_use_history", originalOutput: "x".repeat(70000),
      taskResult: "unknown", learningGain: "unknown" }] };
    const lineageInput = { ...options, domainFeedback: () => lineageFrame, issueId: "issue:domain-source-view" };
    const lineage = await contentContextForIssue({ ...lineageInput, maximumChars: 160000 });
    assert.ok(lineage.ok, "an explicit source envelope must carry a complete feedback basis larger than the old 12k sub-envelope");
    const lineageView = JSON.parse(lineage.value.text);
    assert.equal(lineageView.domainFeedbackCoverage.frames[0]?.transport, "manifest");
    assert.deepEqual(readContentDomainFeedbackBasis(lineageView.currentDomainFeedback, "issue:domain-source-view")[0]?.sourceRefs,
      lineageFrame.sourceRefs, "all original lineage remains bound; no reference is truncated to fit");
    assert.ok(lineage.value.text.length <= 160000);
    const smallerLineage = await contentContextForIssue({ ...lineageInput, maximumChars: 30000 });
    assert.deepEqual(smallerLineage, { ok: false, reason: "content_domain_feedback_capacity" },
      "an insufficient explicit envelope remains a real refusal");
    const invalid = await contentContextForIssue({ ...options, issueId: "issue:domain-source-view", maximumChars: 1000000001 });
    assert.deepEqual(invalid, { ok: false, reason: "content_context_capacity" });
    assert.equal(frame.records[0]?.privateNote, key, "the original owner frame is never mutated");
  } finally {
    await session.release();
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  }
});
