/** Test-only source-bound accounting adapters. Production code and public barrels must never import this module. */
import assert from "node:assert/strict";
import { createBoardReader, withBoardWriter } from "../../../adapters/learning-store/file-event-store.js";
import type { CentralLearningAgentDomain, CentralLearningAllowance, CoordinationAction, LearningIssueReport } from "../../../learning/control/coordination-contract.js";
import { centralLearningSpent } from "../../../learning/control/coordination-contract.js";
import type { BoardState } from "../../../learning/control/state.js";
import type { BoardStore } from "../../../learning/control/store-port.js";
import { contentHashOf } from "../../../learning/control/hash.js";
import { createLearningAllocationApplication } from "../application.js";
import { createExperienceFunding } from "../../../learning/agent/subsystems/method/adapters/experience-funding.js";
import { methodFundingIdentity } from "../../../learning/agent/subsystems/method/adapters/funding-identity.js";
import { EXPERIENCE_MODEL_LIMITS } from "../../../learning/agent/subsystems/method/adapters/experience-budget.js";
import type { ExperienceReviewRequest } from "../../../learning/agent/subsystems/method/experience-port.js";
import { createToolLearningFunding } from "../../../learning/agent/subsystems/tool/runtime/learning-funding.js";
import { enqueueToolLearningPlan } from "../../../learning/agent/subsystems/tool/runtime/pipeline-queue.js";
import { toolLearningFundingIdentity } from "../../../learning/agent/subsystems/tool/domain/evolution/funding-identity.js";
import type { ToolLearningPlan } from "../../../learning/agent/subsystems/tool/domain/evolution/pipeline.js";
import { TOOL_LEARNING_ALLOWANCE } from "../../../learning/control/tool-allowance.js";
import { createWorkflowImprovementFunding } from "../../../learning/agent/subsystems/workflow/adapters/improvement-funding.js";
import { searchImprovementFixture } from "../../../learning/agent/subsystems/workflow/testing/improvement-fixtures.js";
import type { WorkflowImprovementOpportunityRecord } from "../../../learning/agent/subsystems/workflow/runtime/improvement-contracts.js";
import { createSkillCoordination } from "../../../learning/agent/subsystems/skill/control/index.js";
import { createCollaborationControl } from "../../../learning/agent/subsystems/collaboration/control/central.js";

export type SharedAdapterStage = {
  readonly domain: CentralLearningAgentDomain; readonly issueId: string; readonly grantId: string;
  readonly sourceBindingRef: string; readonly authorizedAllowance: CentralLearningAllowance;
  readonly consume: () => Promise<void>;
};

type Options = { readonly boardRoot: string; readonly scope: string; readonly now: () => string };

type Harness = Options & {
  readonly board: Pick<BoardStore, "load" | "apply">;
  readonly load: () => Promise<BoardState>;
  readonly act: (action: CoordinationAction) => Promise<BoardState>;
  readonly accounted: () => void;
};

export async function createSharedAdapterFixture(options: Options) {
  let sequence = 0, calls = 0;
  const board: Pick<BoardStore, "load" | "apply"> = {
    load: () => createBoardReader(options.boardRoot).load(),
    apply: command => withBoardWriter(options.boardRoot, store => store.apply(command)),
  };
  const load = async () => {
    const result = await board.load();
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await board.apply({ type: "coordinate_learning", commandId: `shared-source:${++sequence}`, issuedAt: options.now(), action });
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const harness: Harness = { ...options, board, load, act, accounted: () => { calls += 1; } };
  const stages = [await methodStage(harness), await toolStage(harness), await workflowStage(harness),
    await skillStage(harness), await collaborationStage(harness)];

  return { ...harness, stages, accountingCalls: () => calls,
    app: createLearningAllocationApplication({ boardRoot: options.boardRoot, now: options.now, enabled: () => true }) };
}

async function reportAndFocus(fx: Harness, issueId: string, report: LearningIssueReport) {
  const reported = await fx.act({ kind: "report", scope: fx.scope, issueId, problemKey: `shared:${issueId}`, report });
  const issue = reported.learningIssues?.find(item => item.issueId === issueId);
  assert.ok(issue);
  await focus(fx, issue.issueId, issue.revision, report.evidenceRefs);
}

async function focus(fx: Harness, issueId: string, expectedRevision: number, sourceRefs: readonly string[]) {
  await fx.act({ kind: "decide", issueId, expectedRevision, decision: "focused_learning",
    reason: "Explicit source-bound accounting contract; no learning effectiveness claim.", sourceRefs });
}

async function fundedStage(fx: Harness, grantId: string) {
  const state = await fx.load(), grant = state.centralLearningGrants?.find(item => item.grantId === grantId);

  assert.ok(grant, JSON.stringify({ reason: "shared_accounting_grant_missing", grantId, boardSequence: state.sequence }));
  const issue = state.learningIssues?.find(item => item.issueId === grant.issueId), job = state.jobs.find(item => item.jobId === grant.jobId);

  assert.ok(issue, JSON.stringify({ reason: "shared_accounting_issue_missing", grantId }));
  assert.ok(job, JSON.stringify({ reason: "shared_accounting_job_missing", grantId }));
  assert.equal(issue.grantId, grantId);
  assert.equal(grant.scope, fx.scope);

  return { grant, issue, job };
}

async function methodStage(fx: Harness): Promise<SharedAdapterStage> {
  const request: ExperienceReviewRequest = { snapshotId: "snapshot:shared-method", versionId: "method:v1", method: "Inspect before retrying",
    confidence: .99, observations: [], counterexamples: [], scope: { id: "hook", scopeId: "range", versionId: "method:v1", proposedSequence: 0,
      predicate: { all: [{ feature: "operation", value: "retry" }], exclude: [] } } };
  const identity = methodFundingIdentity([], "workspace:method-source", fx.scope, { versionId: request.versionId, scopeId: request.scope.scopeId });

  assert.ok(identity.ok);
  await reportAndFocus(fx, identity.issueId, { reportId: `method-report:${identity.identity}`,
    source: { subsystem: "method", taskId: "turn:shared", versionId: request.versionId },
    facts: ["method_opt_in", `scope:${request.scope.scopeId}`], evidenceRefs: [request.snapshotId] });
  const authorizedAllowance: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens",
    maxTokens: EXPERIENCE_MODEL_LIMITS.scopeTokens, maxCalls: EXPERIENCE_MODEL_LIMITS.scopeCalls,
    maxSteps: EXPERIENCE_MODEL_LIMITS.scopeSteps, maxPromptChars: EXPERIENCE_MODEL_LIMITS.promptChars };

  return { domain: "prompt", issueId: identity.issueId, grantId: identity.grantId, sourceBindingRef: request.snapshotId, authorizedAllowance,

    async consume() {
      const { grant, issue, job } = await fundedStage(fx, identity.grantId);
      const claimId = `shared-method-claim:${contentHashOf([grant.grantId, job.attempt + 1])}`;

      await fx.act({ kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, expectedIssueRevision: issue.revision,
        claimId, ownerId: "shared:method", expiresAt: new Date(Date.parse(fx.now()) + EXPERIENCE_MODEL_LIMITS.claimLeaseMs).toISOString() });
      const funding = createExperienceFunding({ boardRoot: fx.boardRoot, workspaceId: "workspace:method-source", centralScope: fx.scope,
        turnId: "turn:shared", now: fx.now, request, enabled: () => true,
        binding: { grantId: grant.grantId, claimId, envelope: grant.allowance } });
      const current = await funding.inspect();
      assert.ok(current.ok && current.active, JSON.stringify(current));
      const reserved = await funding.reserve({ reservationId: "shared:method", maxTokens: 1000 });
      assert.ok(reserved.ok, JSON.stringify(reserved));
      const settled = await funding.settle({ reservationId: "shared:method", usage: { kind: "reported", totalTokens: 250 } });
      assert.ok(settled.ok, JSON.stringify(settled));
      await fx.act({ kind: "finish", jobId: job.jobId, claimId, result: { kind: "yielded", reason: "shared_method_accounting_boundary" } });
      fx.accounted();
    } };
}

async function toolStage(fx: Harness): Promise<SharedAdapterStage> {
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: fx.scope, capability: "source-bound accounting contract",
    trigger: { runId: "task:shared-tool", proposalKey: "shared-opportunity", action: "replace_or_add", evidenceRefs: ["trace:shared-tool"] }, createdAt: fx.now() };
  const queued = await enqueueToolLearningPlan(fx.boardRoot, plan);
  assert.ok(queued.ok);
  const started = await fx.board.apply({ type: "start_job", jobId: queued.jobId, commandId: "shared:tool-start", issuedAt: fx.now() });
  assert.ok(started.ok);
  const identity = toolLearningFundingIdentity(plan);

  await reportAndFocus(fx, identity.issueId, { reportId: `tool-report:${identity.identity}`,
    source: { subsystem: "tool", taskId: plan.trigger.runId, versionId: queued.jobId },
    facts: ["tool_learning_opt_in", `plan:${queued.jobId}`], evidenceRefs: plan.trigger.evidenceRefs });

  return { domain: "tool", issueId: identity.issueId, grantId: identity.grantId, sourceBindingRef: queued.jobId,
    authorizedAllowance: TOOL_LEARNING_ALLOWANCE,

    async consume() {
      const { grant, issue } = await fundedStage(fx, identity.grantId);
      assert.ok(grant.budgetId);
      const funding = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, centralScope: fx.scope, now: () => Date.parse(fx.now()),
        managedBinding: { issueId: issue.issueId, grantId: grant.grantId, budgetId: grant.budgetId, expectedIssueRevision: issue.revision,
          stage: { chargedAtStart: centralLearningSpent(grant), allowance: grant.allowance } } });
      const allowance = await funding.allowance(plan);
      if (allowance === undefined) assert.fail(JSON.stringify(await funding.inspect()));

      assert.equal(allowance.grantId, identity.grantId);
      const reserved = await funding.reserve("shared:tool", 1000);
      assert.ok(reserved.ok, JSON.stringify(reserved));
      const settled = await funding.settle("shared:tool", { kind: "reported", totalTokens: 250 });
      assert.ok(settled.ok, JSON.stringify(settled));
      await funding.release();
      fx.accounted();
    } };
}

async function workflowStage(fx: Harness): Promise<SharedAdapterStage> {
  const fixture = searchImprovementFixture();
  const record: WorkflowImprovementOpportunityRecord = { type: "workflow_improvement_opportunity", schemaVersion: 1,
    opportunity: { ...fixture.opportunity, task: { ...fixture.opportunity.task, scope: fx.scope } }, evidence: fixture.evidence };
  const options = { boardRoot: fx.boardRoot, scope: fx.scope, centralScope: fx.scope, budgetId: "run:shared-workflow",
    allowance: 4096, now: () => Date.parse(fx.now()) };
  const prepared = await createWorkflowImprovementFunding(options).prepare(record);
  assert.ok(prepared.ok);
  const source = prepared.value;

  return { domain: "workflow", issueId: source.issueId, grantId: source.grantId, sourceBindingRef: source.sourceBindingRef,
    authorizedAllowance: source.allowance,

    async consume() {
      const { grant, issue } = await fundedStage(fx, source.grantId);
      const funding = createWorkflowImprovementFunding({ ...options, binding: { grantId: source.grantId,
        inputVersionId: source.inputVersionId, expectedIssueRevision: issue.revision } });
      const reserved = await funding.reserve({ grantId: source.grantId, jobId: grant.jobId, inputVersionId: source.inputVersionId, state: "queued", resultRefs: [] });

      assert.ok(reserved.ok, JSON.stringify(reserved));
      const settled = await funding.settle(reserved.value, { kind: "reported", totalTokens: 250 });
      assert.ok(settled.ok, JSON.stringify(settled));
      const finished = await funding.finish(reserved.value, { kind: "completed", resultRefs: [] });
      assert.ok(finished.ok, JSON.stringify(finished));
      fx.accounted();
    } };
}

async function skillStage(fx: Harness): Promise<SharedAdapterStage> {
  const control = createSkillCoordination({ board: fx.board, scope: fx.scope, ownerId: "shared:skill", now: fx.now, enabled: () => true });
  const sourceRef = "journal:shared-skill";
  const reported = await control.report({ sourceRef, taskId: "task:shared-skill", facts: ["Source-bound accounting fixture"], evidenceRefs: ["trace:shared-skill"] });

  assert.ok(reported.ok);
  await focus(fx, reported.issue.issueId, reported.issue.revision, [sourceRef]);
  // The original public focus API permits an explicit host grant binding; dispatchFunded uses the canonical Board relation.
  const grantId = `skill-grant:${contentHashOf([fx.scope, sourceRef])}`;
  const authorizedAllowance: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 8000, maxCalls: 2, maxSteps: 2, maxPromptChars: 8000 };

  return { domain: "skill", issueId: reported.issue.issueId, grantId, sourceBindingRef: sourceRef, authorizedAllowance,

    async consume() {
      const { issue } = await fundedStage(fx, grantId);
      const result = await control.dispatchFunded({ signal: new AbortController().signal,
        expectedGrantId: grantId, expectedIssueRevision: issue.revision, worker: async ({ funding, grant }) => {
        assert.equal(grant.grantId, grantId);
        const reserved = await funding.reserve({ reservationId: "shared:skill", maxTokens: 1000 });
        assert.ok(reserved.ok, JSON.stringify(reserved));
        const settled = await funding.settle({ reservationId: "shared:skill", usage: { kind: "reported", totalTokens: 250 } });
        assert.ok(settled.ok, JSON.stringify(settled));
        fx.accounted();
        return { kind: "completed", resultRefs: [] };
      } });

      assert.ok(result.ok, JSON.stringify(result));
      if (result.ok) assert.equal(result.status, "completed");
    } };
}

async function collaborationStage(fx: Harness): Promise<SharedAdapterStage> {
  const control = createCollaborationControl({ board: fx.board, now: fx.now, ownerId: "shared:collaboration", enabled: () => true,
    workScheduler: () => ({ cancel() {} }), worker: { async run({ funding }) {
      const reserved = await funding.reserve({ reservationId: "shared:collaboration", maxTokens: 1000 });
      assert.ok(reserved.ok, JSON.stringify(reserved));
      const settled = await funding.settle({ reservationId: "shared:collaboration", usage: { kind: "reported", totalTokens: 250 } });
      assert.ok(settled.ok, JSON.stringify(settled));
      fx.accounted();
      return { kind: "completed", resultRefs: [] };
    } } });
  const reported = await control.report({ scope: fx.scope, problemKey: "shared:collaboration", report: {
    reportId: "report:shared-collaboration", source: { teamRunId: "team:shared", taskId: "task:shared", memberId: "member:shared" },
    facts: ["Source-bound accounting fixture"], evidenceRefs: ["trace:shared-collaboration"] } });
  assert.ok(reported.ok);
  const decided = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Explicit accounting fixture", sourceRefs: ["trace:shared-collaboration"] });
  assert.ok(decided.ok);
  const authorizedAllowance: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 6000, maxCalls: 2, maxSteps: 2, maxPromptChars: 8000 };
  const grantId = `collaboration-grant:${contentHashOf([fx.scope, reported.issue.issueId])}`;

  return { domain: "collaboration", issueId: reported.issue.issueId, grantId,
    sourceBindingRef: "report:shared-collaboration", authorizedAllowance,

    async consume() {
      const { issue } = await fundedStage(fx, grantId);
      const result = await control.dispatch({ scope: fx.scope, issueId: issue.issueId, grantId, expectedIssueRevision: issue.revision });
      assert.ok(result.ok, JSON.stringify(result));
      if (result.ok) assert.equal(result.status, "completed"); } };
}
