import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import type { LearningIssue } from "../../learning/control/coordination-contract.js";
import { reduce } from "../../learning/control/reducer.js";
import { buildContentPacket } from "../../learning/central/content/material.js";
import type { ContentMaterialBatch } from "../../learning/central/content/material-contract.js";
import { compileContentProcess } from "../../learning/central/content/process.js";
import { contentAdmissionForIssue, contentAdmissionFromBoard } from "./admission.js";
import { contentRecordsForIssue } from "./issue-view.js";
import { buildContentRecord } from "./records.js";
import { contentStageDraft } from "./staged-records.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { boardUserFeedbackMaterialBatch } from "./sources/feedback-board.js";
import { selectContentFeedbackMaterial } from "./sources/feedback-paging.js";
import { buildContentDomainFeedbackAbsenceRecord, buildContentDomainFeedbackBasisRecord, type ContentDomainFeedback } from "./sources/domain-feedback-basis.js";

const SCOPE = "project:content-admission", NOW = "2026-11-04T12:00:00Z";

function issue(): LearningIssue {
  return { schemaVersion: 1, issueId: "issue:one", scope: SCOPE, problemKey: "source-question", revision: 2,
    reports: [{ reportId: "report:one", source: { subsystem: "tool", taskId: "task:one", versionId: "tool:one" },
      facts: ["Inspect the original requirement."], evidenceRefs: ["source:one", "exposure:one"] }],
    decision: { kind: "focused_learning", reason: "Apply known answers before investigating the residual.", sourceRefs: ["source:one"],
      decidedAt: NOW, revision: 2 }, createdAt: NOW, updatedAt: NOW };
}

function board(): BoardState { return { ...emptyBoardState(), sequence: 10, learningIssues: [issue()] }; }

const empty = (): ContentMaterialBatch => ({ records: [], requirements: [], answers: [], materials: [] });

function saved(before: BoardState, kind: "continue" | "revise" | "end" | "undetermined", options: {
  readonly residual?: boolean; readonly preparation?: boolean; readonly batch?: ContentMaterialBatch;
} = {}): BoardState {
  const batch = options.batch ?? empty(), packet = buildContentPacket({ scope: SCOPE, domain: "tool", boardSequence: before.sequence,
    focus: before.learningIssues![0]!, ...batch, records: [{ ref: "source:one", runId: "run:one", sequence: 0, scope: SCOPE,
      origin: "user_statement", text: "Preserve the original requirement." }, ...batch.records] });
  if (!packet.ok) assert.fail(packet.reason);

  const output = compileContentProcess(packet.value, JSON.stringify({ schemaVersion: 1, knowledge: [], applications: [],
    relations: options.residual ? [{ id: "residual", question: "Which condition remains unsupported?", whenRelevant: "The original requirement.",
      expectedChange: "Different answers change the supported scope.", citations: [{ evidenceRef: "source:one", quote: "original requirement" }] }] : [],
    preparations: options.preparation ? [{ description: "Inspect the original comparison source.", sourceRefs: ["source:one"] }] : [] }),
    JSON.stringify({ schemaVersion: 1, assessments: options.residual ? [{ relationId: "residual", disposition: "residual", applicationIds: [],
      reason: "The original condition remains unsupported." }] : [], comparisons: [], selectedRelationId: options.residual ? "residual" : null,
      recommendation: { kind, reason: "A bounded domain-model assessment, not external qualification.", citations: [] } }));
  if (!output.ok) assert.fail(output.reason);

  const fact = buildContentRecord(packet.value, output.value);

  return { ...before, sequence: before.sequence + 1, rewardV2Facts: [...(before.rewardV2Facts ?? []), { ...fact, sequence: before.sequence + 1 }] };
}

test("only published content admits the exact focus, while ordinary funding does not invalidate it", () => {
  const original = board(), packet = buildContentPacket({ scope: SCOPE, domain: "tool", boardSequence: original.sequence,
    focus: issue(), ...empty() });
  if (!packet.ok) assert.fail(packet.reason);

  const stage = contentStageDraft(SCOPE, { schemaVersion: 1, sessionId: "session:one", turnId: "turn:one", kind: "prepared", requestId: "request:one",
    packet: packet.value, maximumPromptChars: 20000, requestHash: "a".repeat(64) });
  const applied = contentStageDraft(SCOPE, { schemaVersion: 1, sessionId: "session:one", turnId: "turn:one", kind: "applied", preparationRef: stage.id,
    applicationJson: JSON.stringify({ schemaVersion: 1, knowledge: [], applications: [], relations: [], preparations: [] }), requestHash: "b".repeat(64) });
  const prepared = { ...original, sequence: 12, rewardV2Facts: [{ ...stage, sequence: 11 }, { ...applied, sequence: 12 }] };

  assert.equal(contentAdmissionFromBoard(prepared, SCOPE, issue().issueId).status, "needs_content");
  const complete = saved(original, "continue"), admission = contentAdmissionFromBoard(complete, SCOPE, issue().issueId);

  assert.equal(admission.status, "ready");
  assert.equal(admission.assessmentBasis, "domain_model_assessment_not_external_result_qualification");
  const funded = reduce(complete, { type: "coordinate_learning", commandId: "fund:one", issuedAt: NOW, action: { kind: "fund",
    issueId: issue().issueId, expectedRevision: 2, grantId: "grant:one", domain: "tool", allowance: { schemaVersion: 2,
      unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 5000 } } });
  if (!funded.ok) assert.fail(funded.reason);

  assert.notEqual(funded.state.learningIssues![0]!.revision, complete.learningIssues![0]!.revision);
  assert.equal(contentAdmissionFromBoard(funded.state, SCOPE, issue().issueId).processId, admission.processId);
  assert.equal(contentAdmissionFromBoard(funded.state, SCOPE, issue().issueId).status, "ready");
  const changedDecision = { ...issue(), decision: { ...issue().decision, reason: "A different focused question." } };

  assert.equal(contentAdmissionFromBoard({ ...complete, learningIssues: [changedDecision] }, SCOPE, issue().issueId).status, "needs_content");
  const changedReport = { ...issue(), reports: [{ ...issue().reports[0]!, facts: ["Different original requirement."] }] };

  assert.equal(contentRecordsForIssue({ ...complete, learningIssues: [changedReport] }, SCOPE, issue().issueId).length, 0);
});

test("model recommendations remain suggestions and no-new-topic retains earlier residuals and preparations", () => {
  const earlier = saved(board(), "continue", { residual: true }), latest = saved(earlier, "revise", { preparation: true });
  const admission = contentAdmissionFromBoard(latest, SCOPE, issue().issueId);

  assert.equal(admission.status, "ready");
  assert.equal(admission.remainingCount, 0);
  assert.equal(admission.preparationCount, 1);
  assert.equal(admission.priorRemainingCount, 1);
  assert.equal(contentAdmissionFromBoard(saved(board(), "end"), SCOPE, issue().issueId).status, "end_suggested");
  assert.equal(contentAdmissionFromBoard(saved(board(), "undetermined"), SCOPE, issue().issueId).status, "review_required");
  assert.equal(latest.learningIssues![0]!.decision.kind, "focused_learning");
  const withReport = { ...latest, learningIssues: [{ ...issue(), revision: 3, reports: [...issue().reports,
    { ...issue().reports[0]!, reportId: "report:late", facts: ["New actual use changed the question's context."] }] }] };

  assert.equal(contentAdmissionFromBoard(withReport, SCOPE, issue().issueId).reason, "content_new_issue_reports_require_review");
});

function feedbackBoard(before: BoardState): BoardState {
  const source = { sessionId: "session:old", turnId: "turn:old", attemptId: "attempt:old", eventId: "event:use" };
  return { ...before, rewardExposures: [{ schemaVersion: 1, id: "exposure:one", source, targets: [], predictions: [], occurredAt: 1,
    context: { scope: SCOPE, taskFamily: "tool-use", environment: "local", metric: { id: "report", version: "v1", unit: "report",
      minimum: -1, maximum: 1, preference: "higher" } } }],
    rewardFeedbacks: [{ schemaVersion: 1, id: "feedback:one", exposureId: "exposure:one", source: { ...source, eventId: "event:correction" },
      origin: "user", evidenceIds: ["user:original"], outcome: { kind: "unknown", reason: "unverified" }, attribution: { kind: "unresolved" }, observedAt: 2 }] };
}

test("new exactly targeted user feedback requires content review; source-owner transport identities establish entry", () => {
  const initial = saved(board(), "continue"), feedback = feedbackBoard(initial);
  assert.equal(contentAdmissionFromBoard(feedback, SCOPE, issue().issueId).reason, "content_new_targeted_user_feedback_requires_review");
  const full = boardUserFeedbackMaterialBatch({ board: feedback, scope: SCOPE, subsystem: "tool", artifacts: [], issueId: issue().issueId });
  const transport = selectContentFeedbackMaterial({ batches: [full], scope: SCOPE, issueId: issue().issueId, maximumChars: 12000 });
  assert.equal(contentAdmissionFromBoard(saved(feedback, "continue", { batch: transport.batch }), SCOPE, issue().issueId).status, "ready");
});

test("pure domain-source fingerprints detect real native revisions without treating Board sequence as feedback", () => {
  const frame: ContentDomainFeedback = { sourceRef: "method-source:one", sourceRefs: ["method-review:one"],
    records: [{ role: "recorded_method_assessment", revision: 1 }] };
  const basis = buildContentDomainFeedbackBasisRecord(frame, issue().issueId, SCOPE);
  const complete = saved(board(), "continue", { batch: { ...empty(), records: [basis] } });

  assert.equal(contentAdmissionFromBoard(complete, SCOPE, issue().issueId, undefined, frame).status, "ready");
  assert.equal(contentAdmissionFromBoard({ ...complete, sequence: complete.sequence + 10 }, SCOPE, issue().issueId, undefined, frame).status, "ready");
  const changed = { ...frame, records: [{ role: "recorded_method_assessment", revision: 2 }] };

  assert.equal(contentAdmissionFromBoard(complete, SCOPE, issue().issueId, undefined, changed).reason, "content_domain_feedback_source_changed");
  assert.equal(contentAdmissionFromBoard(saved(board(), "continue"), SCOPE, issue().issueId, undefined, frame).status, "needs_content");
  assert.equal(contentAdmissionFromBoard(complete, SCOPE, issue().issueId, undefined, { status: "absent" }).reason,
    "content_domain_feedback_source_withdrawn");
  assert.equal(contentAdmissionFromBoard(complete, SCOPE, issue().issueId).status, "ready", "legacy callers still have their original four-argument semantics");
  assert.equal(contentAdmissionFromBoard(saved(board(), "continue"), SCOPE, issue().issueId, undefined, { status: "absent" }).status, "ready");
});

test("an actual source absence already reviewed in the saved packet does not repeatedly reopen content", () => {
  const frame: ContentDomainFeedback = { sourceRef: "method-source:previous", sourceRefs: ["method-review:previous"], records: [{ revision: 1 }] };
  const acknowledged = saved(board(), "continue", { batch: { ...empty(), records: [
    buildContentDomainFeedbackBasisRecord(frame, issue().issueId, SCOPE), buildContentDomainFeedbackAbsenceRecord(issue().issueId, SCOPE)] } });
  assert.equal(contentAdmissionFromBoard(acknowledged, SCOPE, issue().issueId, undefined, { status: "absent" }).status, "ready");
});

test("public admission reads actual saved Board records and never writes or admits disabled work", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-content-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const act = (action: Parameters<typeof reduce>[1]) => withBoardWriter(root, store => store.apply(action));
  const reported = await act({ type: "coordinate_learning", commandId: "report", issuedAt: NOW, action: { kind: "report",
    scope: SCOPE, problemKey: issue().problemKey, issueId: issue().issueId, report: issue().reports[0]! } });
  if (!reported.ok) assert.fail(reported.reason);

  const focused = await act({ type: "coordinate_learning", commandId: "focus", issuedAt: NOW, action: { kind: "decide", issueId: issue().issueId,
    expectedRevision: 1, decision: "focused_learning", reason: "Apply known answers before investigating the residual.", sourceRefs: ["source:one"] } });
  if (!focused.ok) assert.fail(focused.reason);

  const frame: ContentDomainFeedback = { sourceRef: "domain:actual-source", sourceRefs: ["native:observation"], records: [{ role: "original_source", revision: 1 }] };
  const completed = saved(focused.state, "continue", { batch: { ...empty(),
    records: [buildContentDomainFeedbackBasisRecord(frame, issue().issueId, SCOPE)] } }), fact = completed.rewardV2Facts!.at(-1)!;
  const written = await act({ type: "record_reward_v2_fact", commandId: "content:save", issuedAt: NOW, expectedSequence: focused.state.sequence,
    fact: { id: fact.id, scope: fact.scope, algorithmVersion: fact.algorithmVersion, kind: fact.kind, payloadJson: fact.payloadJson } });
  if (!written.ok) assert.fail(written.reason);

  const before = await createBoardReader(root).load();
  if (!before.ok) assert.fail(before.reason);

  const result = await contentAdmissionForIssue({ boardRoot: root, scope: SCOPE, issueId: issue().issueId, enabled: () => true });

  assert.equal(result.status, "ready");
  assert.equal((await contentAdmissionForIssue({ boardRoot: root, scope: SCOPE, issueId: issue().issueId, enabled: () => true,
    domainFeedback: async () => undefined })).reason, "content_domain_feedback_source_withdrawn");
  assert.equal((await contentAdmissionForIssue({ boardRoot: root, scope: SCOPE, issueId: issue().issueId, enabled: () => true,
    domainFeedback: async () => frame })).status, "ready");
  const after = await createBoardReader(root).load();
  if (!after.ok) assert.fail(after.reason);

  assert.equal(after.state.sequence, before.state.sequence);
  assert.equal((await contentAdmissionForIssue({ boardRoot: root, scope: SCOPE, issueId: issue().issueId, enabled: () => false })).reason, "collect_disabled");
});
