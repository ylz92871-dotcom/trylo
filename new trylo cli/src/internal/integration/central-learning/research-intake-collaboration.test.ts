import assert from "node:assert/strict";
import test from "node:test";
import { createFileCollaborationBoard } from "../../learning/agent/subsystems/collaboration/runtime/board-port.js";
import { createCollaborationControl } from "../../learning/agent/subsystems/collaboration/control/index.js";
import { createCollaborationWorker } from "../../learning/agent/subsystems/collaboration/orchestration/worker.js";
import { createCollaborationDecisionModel } from "../../learning/agent/subsystems/collaboration/runtime/decision-model.js";
import { collaborationCentralResearchForIssue } from "../../learning/agent/subsystems/collaboration/control/central-research-context.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { isLearningIssueReport } from "../../learning/control/coordination-parse.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import type { CentralLearningIntentDraft, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { groundCentralResearch, type GroundedCentralResearch } from "./research-intake-common.js";
import { acceptCentralCollaborationResearch, createCentralCollaborationResearchContextReader } from "./research-intake-collaboration.js";
import { createCentralCollaborationExecution } from "./collaboration.js";
import { DOMAIN_TEST_NOW, DOMAIN_TEST_SCOPE, domainProvider, domainTestSignal, successfulDomainResponse, withDomainBoard } from "./testing/domain-funding.test.js";

const cap = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 30000, maxCalls: 2, maxSteps: 2, maxPromptChars: 60000 };
const unexpected = (): never => { throw new Error("Research intake cannot publish experience, invent a team or invoke a business tool"); };

async function originalRequest(boardRoot: string): Promise<GroundedCentralResearch> {
  const material: CentralRuntimeMaterial = { ref: "material:original-handoff", kind: "source",
    text: "Two completed tasks independently repeated artifact discovery because the original handoff omitted the exact version.",
    sourceRefs: Array.from({ length: 40 }, (_, index) => `original-execution:${index}`) };
  const operation = { kind: "dispatch" as const, operationId: "operation:compare-handoffs", purpose: "Compare the actual handoff prerequisites",
    expectedChange: "Distinguish a shared coordination gap from an unavailable artifact", sourceRefs: [material.ref],
    destination: { plane: "agent" as const, domain: "collaboration" as const }, allowance: cap };
  const intent: CentralLearningIntentDraft = { intentId: "intent:handoff-generalization", subject: { plane: "central", questionRef: "intent:handoff-generalization" },
    goal: "Learn when a receiver needs an immutable artifact identity before beginning dependent work",
    rationale: "The individual tasks are completed; the shared handoff mechanism remains worth investigating.",
    conditions: ["Use only actual handoff receipts"], knowledge: [{ statement: "Both tasks eventually found the artifact",
      conditions: "Observed completed tasks only", sourceRefs: [material.ref] }], residual: ["Was version ambiguity or missing access responsible?"],
    commitment: { purpose: "Compare actual prerequisite evidence", assumptions: ["A cited receipt remains visible"], reconsiderWhen: ["Access was the actual cause"] },
    revisionReason: "The original completed experiences expose a shared transferable question", sourceRefs: [material.ref],
    derivation: { relation: "Compare repeated handoff friction", whenRelevant: "At the next dependent handoff", parentRefs: [material.ref],
      citations: [{ evidenceRef: material.ref, quote: "the original handoff omitted the exact version" }] }, continuation: { kind: "ready", operation } };
  const store = createCentralRuntimeStore({ boardRoot, enabled: () => true }), before = await store.read(DOMAIN_TEST_SCOPE);
  const saved = await store.append({ previousRef: before.stateRef, expectedRevision: before.revision,
    state: { ...emptyCentralRuntimeState(DOMAIN_TEST_SCOPE), intents: [intent], materials: [material] },
    reason: "Preserve the grounded original public learning purpose", sourceRefs: [material.ref] });

  assert.equal(saved.status, "written");

  return groundCentralResearch({ boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true }, "collaboration",
    { intentRef: intent.intentId, intent, operation }, domainTestSignal());
}

test("a grounded central question becomes a truthful original collaboration issue and its worker consumes the full purpose under the existing root", async () => withDomainBoard(async fx => {
  const request = await originalRequest(fx.boardRoot);
  const scripted = domainProvider(() => successfulDomainResponse({ kind: "no_change",
    reason: "The original purpose remains open pending a real receiver acknowledgement; no new trial is supported yet.",
    sourceRefs: [request.intent.intentId, request.materials[0]!.ref] }));
  const board = createFileCollaborationBoard(fx.boardRoot);
  const worker = createCollaborationWorker({ board, scope: DOMAIN_TEST_SCOPE, now: () => DOMAIN_TEST_NOW,
    model: createCollaborationDecisionModel({ provider: scripted.provider, model: "scripted-original-worker" }),
    resources: { query: unexpected }, context: async () => ({ existingOwners: [] }),
    experienceInput: unexpected, publishExperience: unexpected });
  const control = createCollaborationControl({ board, worker, now: () => DOMAIN_TEST_NOW, ownerId: "original-collaboration-owner" });
  const options = { boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true, control, now: () => Date.parse(DOMAIN_TEST_NOW) };
  const accepted = await acceptCentralCollaborationResearch(options, request, domainTestSignal());
  assert.equal(accepted.status, "accepted");

  if (accepted.status !== "accepted") throw new Error("Expected original collaboration issue acceptance");

  const state = await fx.load(), issue = state.learningIssues!.find(item => item.issueId === accepted.issueId)!;

  assert.equal(issue.decision.kind, "unreviewed");
  assert.equal(state.centralLearningGrants?.length ?? 0, 0);
  assert.equal(learningIssueOwner(issue), "collaboration");
  assert.ok(issue.reports.length > 1);
  assert.ok(issue.reports.every(isLearningIssueReport));
  assert.ok(issue.reports.every(report => !("teamRunId" in report.source)));
  const seen = new Set(issue.reports.flatMap(report => report.evidenceRefs));

  for (const ref of request.materials[0]!.sourceRefs) assert.ok(seen.has(ref), ref);

  const duplicate = await acceptCentralCollaborationResearch(options, request, domainTestSignal());
  assert.deepEqual(duplicate, accepted);
  assert.equal((await fx.load()).sequence, state.sequence, "duplicate intake cannot append a new input, report, job or purse");
  const contextForIssue = createCentralCollaborationResearchContextReader({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE });
  const frozen = await contextForIssue(issue.issueId);
  assert.ok(frozen);
  const publicInput = JSON.parse(frozen.text).request;

  assert.deepEqual(publicInput.intent, request.intent);
  assert.deepEqual(publicInput.materials, request.materials);
  const focused = await control.decide({ issueId: issue.issueId, expectedRevision: issue.revision,
    decision: "focused_learning", reason: "Investigate the grounded central purpose under the original managed root", sourceRefs: [request.intent.intentId] });

  assert.ok(focused.ok);
  const execution = createCentralCollaborationExecution({ boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true, control });
  const stage = await execution.prepare({ issueId: issue.issueId, authorizedAllowance: cap }, domainTestSignal());
  const funded = await fx.fund(stage), completed = await execution.dispatch(funded, domainTestSignal());

  assert.ok(completed.ok, JSON.stringify(completed));
  assert.equal(completed.status, "completed");
  assert.equal(scripted.requests.length, 1);
  const body = JSON.parse(scripted.requests[0]!.messages.find(item => item.role === "user")!.content);

  assert.deepEqual(JSON.parse(body.material.centralContent.text).request.intent.knowledge, request.intent.knowledge);
  assert.match(body.material.centralContent.text, /Was version ambiguity or missing access responsible/);
  assert.match(body.material.centralContent.text, /the original handoff omitted the exact version/);
  const after = await fx.load();
  assert.equal(after.jobs.length, 1);
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(after.centralLearningGrants![0]!.budgetId, "budget:domain-contract");
  assert.deepEqual(centralLearningSpent(after.centralLearningGrants![0]!), { tokens: 1500, calls: 1, steps: 1 });
  assert.equal(after.assets.length, 0);
  assert.equal(after.activations.length, 0);
  await acceptCentralCollaborationResearch(options, request, domainTestSignal());
  assert.equal((await fx.load()).centralLearningGrants!.length, 1);
  assert.equal(scripted.requests.length, 1);
}));

test("cancelled intake writes nothing, an explicit closed issue stays closed, and corrupt frozen material fails closed", async () => withDomainBoard(async fx => {
  const request = await originalRequest(fx.boardRoot), board = createFileCollaborationBoard(fx.boardRoot);
  const control = createCollaborationControl({ board, now: () => DOMAIN_TEST_NOW, ownerId: "intake-only-owner" });
  const options = { boardRoot: fx.boardRoot, scope: DOMAIN_TEST_SCOPE, enabled: () => true, control, now: () => Date.parse(DOMAIN_TEST_NOW) };
  const before = await fx.load(), aborted = new AbortController();
  aborted.abort();
  assert.equal((await acceptCentralCollaborationResearch(options, request, aborted.signal)).status, "waiting");
  assert.equal((await fx.load()).sequence, before.sequence);
  const accepted = await acceptCentralCollaborationResearch(options, request, domainTestSignal());
  assert.equal(accepted.status, "accepted");

  if (accepted.status !== "accepted") throw new Error("Expected original collaboration issue acceptance");

  const state = await fx.load(), issue = state.learningIssues![0]!;
  const input = collaborationCentralResearchForIssue(state, DOMAIN_TEST_SCOPE, issue);
  assert.equal(input.status, "ready");

  if (input.status !== "ready") throw new Error("Expected original research input");

  const damaged = { ...state, rewardV2Facts: state.rewardV2Facts!.map(fact => fact.id === input.recordRef
    ? { ...fact, payloadJson: fact.payloadJson.replace("version ambiguity", "DAMAGED ambiguity") } : fact) };

  assert.equal(collaborationCentralResearchForIssue(damaged, DOMAIN_TEST_SCOPE, issue).status, "rejected");
  const resolved = await control.decide({ issueId: issue.issueId, expectedRevision: issue.revision,
    decision: "resolved", reason: "The owner withdrew this learning purpose", sourceRefs: [request.intent.intentId] });
  assert.ok(resolved.ok);
  const closed = await fx.load();
  const result = await acceptCentralCollaborationResearch(options, request, domainTestSignal());
  assert.equal(result.status, "waiting");

  if (result.status === "waiting") assert.equal(result.reason, "collaboration_research_issue_closed");

  assert.equal((await fx.load()).sequence, closed.sequence);
  assert.equal((await fx.load()).jobs.length, 0);
}));
