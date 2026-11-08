import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { ContentPacket } from "../../learning/central/content/material-contract.js";
import type { KnownApplicationDraft, ResidualReviewDraft } from "../../learning/central/content/process-contract.js";
import type { ProviderPort } from "../../ports/provider.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";
import { contentContextForIssue } from "./issue-context.js";
import { readContentRecords } from "./records.js";
import { topicDomainCandidates } from "../learning-topics/domain-candidates.js";

const at = "2026-11-04T14:00:00Z", scope = "D:\\CC\\normal-content";

test("normal journal -> PA stages -> saved knowledge -> next task provider delivery -> late user input reaches the next review", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-normal-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const boardRoot = join(root, "board");

  try {
    assert.ok((await session.start({ sessionId: "normal-session", createdAt: at, fingerprint: {
      schemaVersion: "1", providerId: "local-contract", model: "normal-contract", toolCatalogHash: "catalog", workspaceId: "workspace:normal-content" } })).ok);
    const user = await session.append({ type: "transcript_item", sessionId: "normal-session", turnId: "task:1", at,
      payload: { kind: "user", sequence: 0, text: "The known rule gives 2 + 2 = 4 under A. Determine whether it extends to B." } });
    assert.ok(user.ok);
    const reported = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "normal-report", issuedAt: at,
      action: { kind: "report", scope, issueId: "issue:normal", problemKey: "conditional-rule", report: {
        reportId: "report:normal", source: { subsystem: "tool", taskId: "task:1", versionId: "rule:v1" },
        facts: ["The original requirement includes B."], evidenceRefs: [] } } }));
    assert.ok(reported.ok);
    const focused = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "normal-focus", issuedAt: at,
      action: { kind: "decide", issueId: "issue:normal", expectedRevision: 1, decision: "focused_learning", reason: "Preserve A and investigate B.", sourceRefs: [] } }));
    assert.ok(focused.ok);
    const options = { boardRoot, scope, domain: "tool" as const, session, sessionId: "normal-session", turnId: "task:1",
      enabled: () => true, now: () => Date.parse(at), excludeToolNames: ["central_content"] };
    const runtime = createNormalTaskContentRuntime(options);
    const stages = createStagedContentSession({ runtime, enabled: options.enabled });
    const first = await stages.begin({ issueId: "issue:normal", requestId: "tool-call:content-1", maximumPromptChars: 100000 }, new AbortController().signal);

    assert.equal(first.status, "apply_known");
    if (first.status !== "apply_known") throw new Error("begin_failed");

    const packet = (JSON.parse(first.request.materialJson) as { packet: ContentPacket }).packet;
    const source = packet.focus?.reports[0]?.source;

    assert.ok(source !== undefined && "taskId" in source);
    assert.equal(source.taskId, "task:1");
    const record = packet.records.find(row => row.text.includes("2 + 2 = 4"))!;

    assert.ok(record);
    assert.equal(record.origin, "user_statement");
    const applied: KnownApplicationDraft = { schemaVersion: 1, knowledge: [{ id: "known:A", statement: "The answer is 4 under A.", conditions: "A only",
      citations: [{ evidenceRef: record.ref, quote: "2 + 2 = 4 under A" }] }], applications: [{ id: "apply:A", requirementRefs: [record.ref], answerRefs: [record.ref],
      binding: "The original A condition", result: "4", conditions: "A only", citations: [{ evidenceRef: record.ref, quote: "2 + 2 = 4 under A" }] }],
      relations: [{ id: "question:B", question: "Does the known answer extend to B?", whenRelevant: "The original B requirement", expectedChange: "Use the rule within supported conditions.",
        citations: [{ evidenceRef: record.ref, quote: "whether it extends to B" }] }], preparations: [] };
    const second = await stages.applyKnown({ stageRef: first.stageRef, inputHash: first.request.inputHash, applicationJson: JSON.stringify(applied) }, new AbortController().signal);

    assert.equal(second.status, "residual_review");
    if (second.status !== "residual_review") throw new Error("apply_failed");

    assert.equal((JSON.parse(second.request.materialJson) as { applied: KnownApplicationDraft }).applied.applications[0]?.result, "4");
    assert.deepEqual(await stages.applyKnown({ stageRef: first.stageRef, inputHash: "0".repeat(64), applicationJson: JSON.stringify(applied) }, new AbortController().signal),
      { status: "rejected", reason: "content_stage_input_changed" });
    assert.deepEqual(await stages.applyKnown({ stageRef: first.stageRef, inputHash: first.request.inputHash, applicationJson: JSON.stringify({ ...applied, preparations: [{ description: "A different draw", sourceRefs: [] }] }) }, new AbortController().signal),
      { status: "rejected", reason: "content_stage_conflict" });
    // A new process restores durable preparation/application instead of asking the model to do step one again.
    const restored = createStagedContentSession({ runtime: createNormalTaskContentRuntime(options), enabled: options.enabled });
    const resumed = await restored.begin({ issueId: "issue:normal", requestId: "tool-call:content-1", maximumPromptChars: 100000 }, new AbortController().signal);

    assert.equal(resumed.status, "residual_review");
    if (resumed.status !== "residual_review") throw new Error("restore_failed");

    assert.equal(resumed.stageRef, second.stageRef);
    const review: ResidualReviewDraft = { schemaVersion: 1, assessments: [{ relationId: "question:B", disposition: "residual", applicationIds: ["apply:A"], reason: "A does not cover B." }],
      comparisons: [], selectedRelationId: "question:B", recommendation: { kind: "continue", reason: "The original B requirement remains.", citations: [] } };
    const done = await restored.review({ stageRef: resumed.stageRef, inputHash: resumed.request.inputHash, reviewJson: JSON.stringify(review) }, new AbortController().signal);

    assert.equal(done.status, "published");
    if (done.status !== "published") throw new Error("review_failed");

    if (!("factId" in done.publication)) throw new Error("content_fact_missing");

    const savedFactId = done.publication.factId;

    assert.equal(done.issueId, "issue:normal");
    assert.equal(done.domain, "tool");
    assert.equal(done.remaining.length, 1);
    const workerContext = await contentContextForIssue({ boardRoot, scope, issueId: "issue:normal", maximumChars: 20000, enabled: options.enabled });
    assert.ok(workerContext.ok);
    assert.ok(workerContext.value.text.includes("The answer is 4 under A."));
    assert.ok(workerContext.value.text.includes("question:B"));
    const beforeFund = await createBoardReader(boardRoot).load();
    assert.ok(beforeFund.ok);
    const originalIssue = beforeFund.state.learningIssues?.find(row => row.issueId === "issue:normal");
    assert.ok(originalIssue);
    const funded = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "normal-fund", issuedAt: at,
      action: { kind: "fund", issueId: originalIssue.issueId, expectedRevision: originalIssue.revision, grantId: "normal-test-grant", domain: "tool",
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 10000 } } }));
    assert.ok(funded.ok);
    const afterFundContext = await contentContextForIssue({ boardRoot, scope, issueId: "issue:normal", maximumChars: 20000, enabled: options.enabled });
    assert.ok(afterFundContext.ok);
    assert.equal(afterFundContext.value.contextRef, workerContext.value.contextRef, "funding alone cannot change an immutable source-context binding");
    const inspection = await restored.begin({ issueId: "issue:normal", requestId: "inspect-saved-public-source", maximumPromptChars: 100000 }, new AbortController().signal);

    assert.equal(inspection.status, "apply_known");
    if (inspection.status !== "apply_known") throw new Error("inspection_begin_failed");

    const archivedPage = await restored.readMaterial({ stageRef: inspection.stageRef, evidenceRef: savedFactId,
      maximumChars: 8192 }, new AbortController().signal);

    assert.ok(archivedPage.ok);
    assert.ok("source" in archivedPage);
    assert.equal(archivedPage.source.owner, "board");
    assert.equal(archivedPage.source.originalSource?.ref, savedFactId);
    assert.notEqual(archivedPage.source.originalRef, savedFactId, "a safe source view cannot reuse the raw source identity");
    assert.ok(!archivedPage.record.text.includes(scope));
    assert.ok((await session.append({ type: "transcript_item", sessionId: "normal-session", turnId: "task:2", at,
      payload: { kind: "user", sequence: 0, text: "Use the previously known answer under A, with the original precision." } })).ok);
    const next = createNormalTaskContentRuntime({ ...options, turnId: "task:2" });
    const preparation = await next.prepare({}, new AbortController().signal);
    assert.ok(preparation.ok);
    assert.ok(preparation.value.packet.answers.some(answer => answer.answer === "The answer is 4 under A."));
    const reference = await next.referenceForTask(20000, new AbortController().signal);
    assert.ok(reference.ok);
    assert.ok(reference.value);
    let sent = "";
    const provider: ProviderPort = { async *stream(request) {
      sent = request.messages.map(message => message.content).join("\n");
      yield { type: "stream_start", providerId: "normal-contract", model: "contract", warnings: [] };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };

    for await (const _event of next.withProvider(provider, reference.value).stream({ attemptId: "actual-business-attempt", model: "contract",
      messages: [{ role: "user", content: "Use A." }], tools: [] }, new AbortController().signal)) { /* Drain the actual decorated request. */ }

    assert.ok(sent.includes("The answer is 4 under A."));
    assert.ok(sent.includes("A only"));
    const journal = await session.readRecords();
    assert.ok(journal.ok);
    assert.ok(journal.view.records.some(row => row.type === "execution_extension" && row.payload.owner === "learning-content"));
    assert.ok((await session.append({ type: "transcript_item", sessionId: "normal-session", turnId: "task:3", at,
      payload: { kind: "user", sequence: 0, text: "Correction: I need B; do not silently reuse the A-only answer." } })).ok);
    const late = createNormalTaskContentRuntime({ ...options, turnId: "task:3" });
    const revised = await late.prepare({ issueId: "issue:normal" }, new AbortController().signal);
    assert.ok(revised.ok);
    assert.ok(revised.value.packet.records.some(row => row.origin === "user_statement" && row.text.includes("Correction: I need B")));
    assert.ok(revised.value.packet.records.some(row => row.text.includes("content_context_delivery")));
    const board = await createBoardReader(boardRoot).load();
    assert.ok(board.ok);
    assert.equal(readContentRecords(board.state.rewardV2Facts ?? [], scope, board.state.sequence).length, 1);
    assert.equal(topicDomainCandidates(board.state.rewardV2Facts ?? [], scope, "tool", board.state.sequence).length, 1);
    assert.equal(board.state.learningIssues?.[0]?.decision.kind, "focused_learning");
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled staged processing has no journal, Board or model access", async () => {
  const runtime = createNormalTaskContentRuntime({ boardRoot: "disabled-content-stage", scope, domain: "tool",
    sessionId: "s", turnId: "t", enabled: () => false, now: () => 0,
    session: { async readRecords() { throw new Error("must not read"); }, async append() { throw new Error("must not write"); } } });
  const staged = createStagedContentSession({ runtime, enabled: () => false });

  assert.deepEqual(await staged.begin({ maximumPromptChars: 100000 }, new AbortController().signal), { status: "rejected", reason: "collect_disabled" });
  assert.deepEqual(await staged.applyKnown({ stageRef: "missing", inputHash: "0".repeat(64), applicationJson: "{}" }, new AbortController().signal),
    { status: "rejected", reason: "collect_disabled" });
});
