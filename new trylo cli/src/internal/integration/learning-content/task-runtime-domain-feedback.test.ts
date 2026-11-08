import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { contentContextForIssue, createContentIssueContextReader } from "./issue-context.js";
import { contentDomainFeedbackText, readContentDomainFeedbackAbsence, readContentDomainFeedbackBasis, type ContentDomainFeedbackReader } from "./sources/domain-feedback.js";

const at = "2026-11-04T15:00:00Z", scope = "repo:domain-feedback-runtime";

test("normal task and worker material consume original domain feedback; late facts change content while funding alone does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-domain-runtime-")), boardRoot = join(root, "board");
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });

  try {
    assert.ok((await session.start({ sessionId: "domain-session", createdAt: at, fingerprint: { schemaVersion: "1", providerId: "contract",
      model: "local-contract", toolCatalogHash: "catalog", workspaceId: "workspace:domain-feedback" } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId: "domain-session", turnId: "task:domain", at,
      payload: { kind: "user", sequence: 0, text: "Preserve the original quality requirement and review actual tool use feedback." } })).ok);
    const report = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "domain-report", issuedAt: at,
      action: { kind: "report", scope, issueId: "issue:domain", problemKey: "original-quality", report: { reportId: "report:domain",
        source: { subsystem: "tool", taskId: "task:domain", versionId: "tool:v1" }, facts: ["Review actual original source feedback."], evidenceRefs: [] } } }));
    assert.ok(report.ok);
    const focus = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "domain-focus", issuedAt: at,
      action: { kind: "decide", issueId: "issue:domain", expectedRevision: 1, decision: "focused_learning", reason: "Keep original quality and compare actual feedback.", sourceRefs: [] } }));
    assert.ok(focus.ok);
    let domainRecords: readonly JsonObject[] = [
      { role: "actual_use", sourceRef: "use:1", reportStatus: "returned", taskResult: "unknown", learningGain: "unknown" },
      { role: "approval", sourceRef: "approval:1", state: "approved_for_original_scope" },
      { role: "checker_report", sourceRef: "checker:1", status: "unverified" },
      { role: "actual_cost", sourceRef: "cost:1", value: 21, unit: "input_tokens" },
    ];
    const currentProjection = () => ({ sourceRef: `domain-feedback:${contentHashOf(domainRecords)}`, sourceRefs: ["use:1", "approval:1", "checker:1", "cost:1"], records: domainRecords });
    let domainAvailable = true;
    const domainFeedback: ContentDomainFeedbackReader = async (_board, issueId) => domainAvailable && issueId === "issue:domain" ? currentProjection() : undefined;
    const options = { boardRoot, scope, domain: "tool" as const, session, sessionId: "domain-session", turnId: "task:domain",
      enabled: () => true, now: () => Date.parse(at), domainFeedback };
    const runtime = createNormalTaskContentRuntime(options), cancellation = new AbortController().signal;
    const prepared = await runtime.prepare({ issueId: "issue:domain" }, cancellation);
    assert.ok(prepared.ok);
    const originalFrameRef = currentProjection().sourceRef;

    assert.ok(prepared.value.packet.records.some(row => row.ref === originalFrameRef && row.text.includes('"unit":"input_tokens"')));
    assert.equal(readContentDomainFeedbackBasis(prepared.value.packet, "issue:domain").length, 1);
    const stages = createStagedContentSession({ runtime, enabled: options.enabled });
    const begin = await stages.begin({ issueId: "issue:domain", maximumPromptChars: 100000 }, cancellation);

    assert.equal(begin.status, "apply_known");
    if (begin.status !== "apply_known") throw new Error("domain_begin_failed");

    const stagedPacket = (JSON.parse(begin.request.materialJson) as { packet: ContentPacket }).packet;

    assert.ok(stagedPacket.records.some(row => row.ref === originalFrameRef && row.text.includes('"role":"approval"')));
    const applied = await stages.applyKnown({ stageRef: begin.stageRef, inputHash: begin.request.inputHash, applicationJson: JSON.stringify({
      schemaVersion: 1, knowledge: [{ id: "known:actual-report", statement: "The original use returned, while task result and learning gain remain unknown.",
        conditions: "Only the actual original use and quality requirement.", citations: [{ evidenceRef: originalFrameRef, quote: '"taskResult":"unknown"' }] }],
      applications: [], relations: [], preparations: [{ description: "Obtain the actual requested quality result before claiming benefit.", sourceRefs: [originalFrameRef] }],
    }) }, cancellation);

    assert.equal(applied.status, "residual_review");
    if (applied.status !== "residual_review") throw new Error("domain_apply_failed");

    assert.ok(applied.request.materialJson.includes('input_tokens'));
    const reviewed = await stages.review({ stageRef: applied.stageRef, inputHash: applied.request.inputHash, reviewJson: JSON.stringify({
      schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "continue", reason: "Retain the original quality preparation; no new fact question was manufactured.", citations: [] },
    }) }, cancellation);
    assert.equal(reviewed.status, "published");
    const contextInput = { boardRoot, scope, issueId: "issue:domain", maximumChars: 30000, enabled: options.enabled, domainFeedback };
    const worker = await contentContextForIssue(contextInput);
    assert.ok(worker.ok);
    assert.ok(worker.value.text.includes('input_tokens'));
    assert.ok(worker.value.text.includes('actual_use'));
    const workerReader = createContentIssueContextReader(contextInput);
    const workerFrame = await workerReader("issue:domain");
    assert.ok(workerFrame);
    assert.equal(workerFrame.ref, worker.value.contextRef);
    assert.ok(workerFrame.text.includes("The original use returned"));
    const beforeFund = await createBoardReader(boardRoot).load();
    assert.ok(beforeFund.ok);
    const issue = beforeFund.state.learningIssues?.find(row => row.issueId === "issue:domain");
    assert.ok(issue);
    const funded = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "domain-fund", issuedAt: at,
      action: { kind: "fund", issueId: issue.issueId, expectedRevision: issue.revision, grantId: "domain-grant", domain: "tool",
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 } } }));
    assert.ok(funded.ok);
    const afterFund = await contentContextForIssue(contextInput);
    assert.ok(afterFund.ok);
    assert.equal(afterFund.value.contextRef, worker.value.contextRef);
    assert.equal(currentProjection().sourceRef, originalFrameRef);
    domainRecords = [...domainRecords, { role: "user_correction", sourceRef: "late:correction", text: "The returned output did not satisfy the requested quality." }];
    const late = await runtime.prepare({ issueId: "issue:domain" }, cancellation);
    assert.ok(late.ok);
    assert.ok(late.value.packet.records.some(row => row.text.includes("did not satisfy the requested quality")));
    assert.notEqual(readContentDomainFeedbackBasis(late.value.packet, "issue:domain").at(-1)?.fingerprint,
      readContentDomainFeedbackBasis(stagedPacket, "issue:domain").at(-1)?.fingerprint);
    const lateWorker = await contentContextForIssue(contextInput);
    assert.ok(lateWorker.ok);
    assert.notEqual(lateWorker.value.contextRef, worker.value.contextRef);
    const currentAdmission = await runtime.currentAdmission?.("issue:domain", cancellation);

    assert.equal(currentAdmission?.status, "needs_content");
    const refreshed = await stages.begin({ issueId: "issue:domain", maximumPromptChars: 100000 }, cancellation);

    assert.equal(refreshed.status, "apply_known", "same-turn late owner feedback must refresh the default saved process");

    if (refreshed.status !== "apply_known") throw new Error("default_domain_feedback_refresh_failed");

    assert.notEqual(refreshed.stageRef, begin.stageRef);
    const refreshedPacket = (JSON.parse(refreshed.request.materialJson) as { packet: ContentPacket }).packet;

    assert.ok(refreshedPacket.answers.some(row => row.answer === "The original use returned, while task result and learning gain remain unknown."));
    assert.ok(refreshedPacket.records.some(row => row.text.includes("did not satisfy the requested quality")));
    const cold = createStagedContentSession({ runtime: createNormalTaskContentRuntime(options), enabled: options.enabled });
    const coldBegin = await cold.begin({ issueId: "issue:domain", maximumPromptChars: 100000 }, cancellation);

    assert.equal(coldBegin.status, "apply_known");
    if (coldBegin.status !== "apply_known") throw new Error("cold_domain_feedback_restore_failed");

    assert.equal(coldBegin.stageRef, refreshed.stageRef);
    assert.equal(coldBegin.request.inputHash, refreshed.request.inputHash);
    const refreshedApplied = await cold.applyKnown({ stageRef: coldBegin.stageRef, inputHash: coldBegin.request.inputHash, applicationJson: JSON.stringify({
      schemaVersion: 1, knowledge: [{ id: "known:late-correction", statement: "The original returned output failed the user's stated quality requirement.",
        conditions: "The recorded correction concerns this original use only.", citations: [{ evidenceRef: currentProjection().sourceRef, quote: "did not satisfy the requested quality" }] }],
      applications: [], relations: [], preparations: [],
    }) }, cancellation);
    assert.equal(refreshedApplied.status, "residual_review");

    if (refreshedApplied.status !== "residual_review") throw new Error("refreshed_apply_failed");

    const refreshedSaved = await cold.review({ stageRef: refreshedApplied.stageRef, inputHash: refreshedApplied.request.inputHash, reviewJson: JSON.stringify({
      schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "continue", reason: "The actual correction is retained without claiming a learning-gain measurement.", citations: [] },
    }) }, cancellation);
    assert.equal(refreshedSaved.status, "published");
    domainRecords = [...domainRecords, { role: "late_checker_details", sourceRef: "checker:large", originalOutput: "x".repeat(70000) }];
    const large = await runtime.prepare({ issueId: "issue:domain" }, cancellation);
    assert.ok(large.ok);
    const currentLargeRef = currentProjection().sourceRef;

    assert.equal(large.value.coverage.domainFeedback?.frames[0]?.transport, "manifest");
    assert.ok(readContentDomainFeedbackBasis(large.value.packet, "issue:domain").some(row => row.sourceRef === currentLargeRef));
    const largeBegin = await stages.begin({ issueId: "issue:domain", requestId: "domain-content:large", maximumPromptChars: 100000 }, cancellation);

    assert.equal(largeBegin.status, "apply_known");
    if (largeBegin.status !== "apply_known") throw new Error("large_begin_failed");

    const page = await stages.readMaterial({ stageRef: largeBegin.stageRef, evidenceRef: currentLargeRef, start: 69000, maximumChars: 1024 }, cancellation);

    assert.ok(page.ok);
    assert.ok("source" in page);
    assert.equal(page.source.owner, "domain_feedback");
    assert.equal(page.source.sourceHash, contentHashOf(contentDomainFeedbackText(currentProjection())));
    assert.ok("next" in page && page.next);
    const expanded = (JSON.parse(page.next.request.materialJson) as { packet: ContentPacket }).packet;

    assert.ok(expanded.records.some(row => row.ref === page.record.ref && row.text === page.record.text));
    domainAvailable = false;
    const withdrawn = await runtime.prepare({ issueId: "issue:domain" }, cancellation);
    assert.ok(withdrawn.ok);
    const absence = readContentDomainFeedbackAbsence(withdrawn.value.packet, "issue:domain");
    assert.equal(absence.length, 1);
    assert.equal(readContentDomainFeedbackBasis(withdrawn.value.packet, "issue:domain").length, 0, "archived freshness markers are not current observations");
    assert.ok(withdrawn.value.packet.records.some(row => row.text.includes("The original use returned")), "real historical public content remains available after source absence");
    const withdrawal = await stages.begin({ issueId: "issue:domain", requestId: "domain-content:withdrawal", maximumPromptChars: 100000 }, cancellation);

    assert.equal(withdrawal.status, "apply_known");
    if (withdrawal.status !== "apply_known") throw new Error("withdrawal_begin_failed");

    const absencePacket = (JSON.parse(withdrawal.request.materialJson) as { packet: ContentPacket }).packet;
    const absenceRecord = absencePacket.records.find(row => row.ref.startsWith("domain-feedback-absence:"))!;
    assert.ok(absenceRecord);
    const withdrawalApplied = await stages.applyKnown({ stageRef: withdrawal.stageRef, inputHash: withdrawal.request.inputHash, applicationJson: JSON.stringify({
      schemaVersion: 1, knowledge: [{ id: "known:source-absence", statement: "The current owner supplies no frame; historical reports remain historical evidence.",
        conditions: "Current configured source observation only.", citations: [{ evidenceRef: absenceRecord.ref, quote: '"role":"source_bound_domain_feedback_absence"' }] }],
      applications: [], relations: [], preparations: [],
    }) }, cancellation);
    assert.equal(withdrawalApplied.status, "residual_review");

    if (withdrawalApplied.status !== "residual_review") throw new Error("withdrawal_apply_failed");

    const withdrawalSaved = await stages.review({ stageRef: withdrawalApplied.stageRef, inputHash: withdrawalApplied.request.inputHash, reviewJson: JSON.stringify({
      schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
      recommendation: { kind: "continue", reason: "Retain historical source facts without treating absence as retraction.", citations: [] },
    }) }, cancellation);
    assert.equal(withdrawalSaved.status, "published");
    const afterWithdrawal = await runtime.currentAdmission?.("issue:domain", cancellation);
    assert.equal(afterWithdrawal?.status, "ready");
    const beforeRefocus = await createBoardReader(boardRoot).load();
    assert.ok(beforeRefocus.ok);
    const currentIssue = beforeRefocus.state.learningIssues?.find(row => row.issueId === "issue:domain");
    assert.ok(currentIssue);
    const refocused = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "domain-refocus", issuedAt: at,
      action: { kind: "decide", issueId: currentIssue.issueId, expectedRevision: currentIssue.revision, decision: "focused_learning",
        reason: "Review the original quality requirement under the newly focused boundary.", sourceRefs: [] } }));
    assert.ok(refocused.ok);
    const newFocus = await stages.begin({ issueId: "issue:domain", maximumPromptChars: 100000 }, cancellation);

    assert.equal(newFocus.status, "apply_known");
    if (newFocus.status !== "apply_known") throw new Error("new_focus_begin_failed");

    assert.notEqual(newFocus.stageRef, refreshed.stageRef);
    const newFocusPacket = (JSON.parse(newFocus.request.materialJson) as { packet: ContentPacket }).packet;

    assert.equal(newFocusPacket.focus?.decision.kind, "focused_learning");
    assert.ok(newFocusPacket.focus?.decision.reason.includes("newly focused boundary"));
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
