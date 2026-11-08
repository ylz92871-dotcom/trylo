import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import type { ProviderPort } from "../../../../../ports/provider.js";
import type { ToolRunnerPort } from "../../../../../ports/tool-runner-port.js";
import type { ToolEvolutionCandidate } from "../domain/evolution/contracts.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolEvolutionVerifier, ToolEvolutionCheck } from "../domain/evolution/verification.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { createToolEvolutionRuntime } from "./evolution-runtime.js";
import { createToolLearningFunding } from "./learning-funding.js";
import { withToolLearningFunding } from "../adapters/evolution/funded-provider.js";
import { enqueueToolLearningPlan, readToolLearningPipeline, nextToolLearningDispatch } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { proposeToolContractRevision, reviewToolContractRevision, approveToolContractRevision } from "./contract-revisions.js";
import { contractRevisionResumeJobs } from "./contract-revision-resume.js";
import { nominateToolLearningSource } from "./learning-funding.js";
import { readCentralToolStageProduction } from "./central-production.js";
import { selectToolFocusedSource, toolCentralStageIdentity } from "./central-source.js";
import type { CentralFundedStage } from "../../../../../integration/central-learning/contracts.js";

const reasoning = { rationale: "The user's affine requirement changes the old expected answers", existingInsufficiency: "Old samples enforce a different requirement",
  expectedBenefit: "Satisfy the corrected contract; no observed cost saving", constructionCost: "One review and one source revision", alternatives: ["Do not weaken unapproved samples"] };
const requirement = { ref: "user:affine-contract", kind: "user_requirement" as const,
  text: "The current requirement is f(x)=2*x+1 for finite numbers, including fractions; reject nonnumeric input with invalid_input" };

/** Executes actual generated source in a hermetic VM; this is not the production OS sandbox. */
const verifier: ToolEvolutionVerifier = { async verify(candidate, request) {
  const checks: ToolEvolutionCheck[] = request.evidence.map(sample => {
    let actual: unknown;
    try { actual = { kind: "value", value: runInNewContext(`${candidate.source}\nmodule.exports(input)`,
      { module: { exports: undefined }, input: sample.input }, { timeout: 100 }) }; }
    catch (error) { actual = { kind: "error", code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "execution_error" }; }
    return { sampleId: sample.sampleId, role: sample.role, outcome: contentHashOf(actual) === contentHashOf(sample.expected) ? "passed" : "wrong_result",
      detail: "Actual VM result; no native-isolation claim" };
  });
  return { verdict: checks.every(check => check.outcome === "passed") ? "pass" : "fail", checks,
    candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence) };
} };

test("a worker proposes an exact oracle correction, waits for its real permission, and resumes source construction on its original grant", async t => {
  const fx = await seedToolProduction(t), parent = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(parent.ok);
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: parent.artifact.request.scope,
    capability: parent.artifact.request.capability, targetVersionId: parent.versionId, createdAt: productionTestTime,
    trigger: { runId: "corrected-affine-task", proposalKey: "affine-requirement", action: "user_requested", evidenceRefs: [requirement.ref] } };
  const queued = await enqueueToolLearningPlan(fx.root, plan);
  assert.ok(queued.ok);
  const now = () => Date.parse(productionTestTime), signal = new AbortController().signal;
  const funding = createToolLearningFunding({ boardRoot: fx.root, scope: plan.scope, now });
  let reservation = 0, planned = 0, generated = 0, initialGrantId: string | undefined;
  // Model answers are controlled. Actual Board reservations and Permission consumption are exercised.
  const provider: ProviderPort = withToolLearningFunding({ stream: async function* () {
    yield { type: "usage", usage: { mode: "snapshot", inputTokens: 100, outputTokens: 20, totalTokens: 120,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } }, { funding, newId: () => `contract-pipeline-reservation-${++reservation}` });
  const charge = async (attemptId: string) => { for await (const event of provider.stream({ attemptId, model: "TEST-controlled",
    messages: [{ role: "user", content: "TEST ONLY controlled model decision" }], tools: [], maxOutputTokens: 4096 }, signal)) void event; };
  const candidate: ToolEvolutionCandidate = { ...parent.artifact.candidate,
    source: "module.exports = input => { if (typeof input !== 'number') throw Object.assign(new Error('numeric required'), {code:'invalid_input'}); return input * 2 + 1; };" };
  const runner: ToolRunnerPort = { submit: async task => {
    generated++;
    await charge(`tool-evolution:${task.taskId}`);
    return { taskId: task.taskId };
  },
    onProgress: () => () => {}, cancel: async () => true, status: async () => "completed",
    wait: async taskId => ({ taskId, status: "completed", observed: "terminal", output: JSON.stringify(candidate) }) };
  const services: ToolPipelineServices = { executionAuthorized: true,
    allowance: selected => funding.allowance(selected), releaseAllowance: () => funding.release(),
    context: async () => ({ availableTools: [], requirements: [requirement] }),
    search: async () => { assert.fail("an exact oracle correction does not require public discovery"); },
    plan: async context => {
      planned++;
      await charge(`tool-planning:${planned}`);
      initialGrantId ??= context.allowance.grantId;
      assert.equal(context.allowance.grantId, initialGrantId);
      const prior = context.priorVersions.find(item => item.versionId === parent.versionId);
      assert.ok(prior);
      const approved = context.contractRevisions?.find(item => item.proposal.parentVersionId === parent.versionId);
      if (approved === undefined) {
        const anchors = context.contractAnchors?.find(item => item.parentVersionId === parent.versionId);
        assert.ok(anchors);

        return { ...reasoning, action: "revise_contract", proposal: { type: "tool_contract_revision_proposal", schemaVersion: 1,
          parentVersionId: prior.versionId, parentContractHash: anchors.parentContractHash, scope: plan.scope, reason: "changed_requirement",
          corrections: prior.evidence.filter(sample => sample.expected.kind === "value").map(sample => {
            const anchor = anchors.samples.find(item => item.sampleId === sample.sampleId);
            assert.ok(anchor);
            assert.equal(sample.expected.kind, "value");
            return { sampleId: sample.sampleId, oldSampleHash: anchor.sampleHash, oldExpectedHash: anchor.expectedHash,
              expected: { kind: "value", value: Number(sample.input) * 2 + 1 }, evidenceRefs: [requirement.ref] };
          }) } } satisfies ToolLearningDecision;
      }

      const evidence = prior.evidence.map(sample => ({ ...sample, expected: approved.proposal.corrections.find(correction => correction.sampleId === sample.sampleId)?.expected ?? sample.expected }));

      return { ...reasoning, action: "improve", request: { ...parent.artifact.request, requestId: "planned-affine", operation: "improve",
        prior: { versionId: prior.versionId }, contractRevisionRefs: [approved.revisionId],
        evidence: [...evidence, { sampleId: "fractional-transfer", role: "variation", input: 0.75, expected: { kind: "value", value: 2.5 } }], maxAttempts: 1 },
      sampleOrigins: [...evidence.map(sample => ({ sampleId: sample.sampleId, kind: "contract" as const,
        ref: approved.proposal.corrections.some(correction => correction.sampleId === sample.sampleId) ? approved.revisionId : `${prior.versionId}:${sample.sampleId}` })),
      { sampleId: "fractional-transfer", kind: "synthesized", ref: requirement.ref }] };
    },
    evolve: (request, selectedSignal, feedback, admission) => createToolEvolutionRuntime({ runner, verifier,
      archive: createToolEvolutionArchive(fx.root, { jobAdmission: admission }), now, initialFeedback: feedback }).evolve(request, selectedSignal) };
  const input = { boardRoot: fx.root, scope: plan.scope, now, services, mode: "after_turn" as const, signal, jobIds: [queued.jobId] };

  assert.ok((await nominateToolLearningSource({ boardRoot: fx.root, scope: plan.scope, now }, plan, signal)).ok);
  const stageIdentity = async () => {
    const loaded = await createBoardReader(fx.root).load();
    assert.ok(loaded.ok);
    const issue = loaded.state.learningIssues!.find(row => row.reports.some(report => "versionId" in report.source && report.source.versionId === queued.jobId))!;
    const source = selectToolFocusedSource(loaded.state, issue, plan.scope, plan.scope);
    assert.ok(source.ok);
    const identity = toolCentralStageIdentity(loaded.state, source, "after_turn", "TEST-controlled");
    assert.ok(identity.ok);
    return { issueId: issue.issueId, grantId: source.grantId, stageRef: identity.stageRef, policyRef: identity.policyRef,
      sourceBindingRef: identity.sourceBindingRef };
  };
  const firstStage = await stageIdentity();
  const first = await workToolLearningPipeline(input);
  assert.ok(first.ok);
  assert.equal(first.results[0]?.code, "contract_revision_approval_required");
  const waiting = await readToolLearningPipeline(fx.root);
  assert.ok(waiting.ok);
  const proposalId = waiting.jobs.find(job => job.jobId === queued.jobId)?.result?.contractProposalId;
  assert.ok(proposalId);
  const unchanged = await workToolLearningPipeline(input);
  assert.ok(unchanged.ok);
  assert.equal(unchanged.results.length, 0);
  assert.equal(planned, 1);

  // Approval for another exact parent must not wake this job even in the same scope/capability.
  const other = await createToolEvolutionArchive(fx.root).save({ ...parent.artifact, request: { ...parent.artifact.request, requestId: "other-parent" } });
  assert.ok(other.ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "pipeline-contract-permission.ndjson") });
  const review = await reviewToolContractRevision(fx.root, proposalId, plan.scope);
  assert.ok(review.ok);
  const otherProposal = await proposeToolContractRevision(fx.root, { ...review.proposal, parentVersionId: other.versionId }, productionTestTime);
  assert.ok(otherProposal.ok);
  const approve = async (selectedId: string) => {
    const selected = await reviewToolContractRevision(fx.root, selectedId, plan.scope);
    assert.ok(selected.ok);
    const grant = await permission.issue({ action: "modify", candidateId: selected.reviewId, packageVersionId: selected.proposal.parentVersionId,
      scope: plan.scope, issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" });
    assert.ok(grant.ok);
    const accepted = await approveToolContractRevision({ boardRoot: fx.root, proposalId: selectedId, scope: plan.scope,
      reviewId: selected.reviewId, permission, token: { grantId: grant.grant.grantId }, issuedAt: productionTestTime });
    assert.ok(accepted.ok);
    return accepted;
  };

  await approve(otherProposal.proposalId);
  const unrelated = await nextToolLearningDispatch(fx.root, plan.scope, true, [queued.jobId]);
  assert.ok(unrelated.ok);
  assert.equal(unrelated.jobId, undefined);
  const accepted = await approve(proposalId);
  const resumes = await contractRevisionResumeJobs(fx.root, proposalId, plan.scope);
  assert.ok(resumes.ok);
  assert.deepEqual(resumes.jobIds, [queued.jobId]);
  const secondStage = await stageIdentity();
  const second = await workToolLearningPipeline(input);
  assert.ok(second.ok);
  assert.equal(second.results[0]?.code, "candidate_pending_review");
  assert.equal(planned, 2);
  assert.equal(generated, 1);
  const final = await createBoardReader(fx.root).load();
  assert.ok(final.ok);
  assert.equal(final.state.centralLearningGrants?.length, 1);
  const grant = final.state.centralLearningGrants?.[0];
  assert.ok(grant);
  assert.equal(grant.grantId, initialGrantId);
  assert.equal(centralLearningSpent(grant).calls, 3);
  const inventory = await readToolLearningPipeline(fx.root);
  assert.ok(inventory.ok);
  const childId = inventory.jobs.find(job => job.jobId === queued.jobId)?.result?.candidateVersionId;
  assert.ok(childId);
  const child = await readToolEvolutionCandidate(fx.root, childId);
  assert.ok(child.ok);
  assert.deepEqual(child.artifact.request.contractRevisionRefs, [accepted.revisionId]);
  assert.equal(child.artifact.verification.verdict, "pass");
  assert.equal(child.artifact.verification.checks.length, 5);
  assert.deepEqual(final.state.activations, [], "oracle approval does not activate a tool");
  const original = await readToolEvolutionCandidate(fx.root, parent.versionId);
  assert.ok(original.ok);
  assert.deepEqual(original.artifact.request.evidence, parent.artifact.request.evidence);
  // This existing original-worker fixture tests the pure owner's identity
  // boundary. Authentication of a CentralFundedStage archive remains shared.
  const proofInput = (stage: typeof firstStage): CentralFundedStage => ({ ...stage,
    expectedIssueRevision: final.state.learningIssues!.find(row => row.issueId === stage.issueId)!.revision,
    offer: { offerId: "TEST-only-pure-publication-proof", owner: { plane: "agent", domain: "tool" }, policyRef: stage.policyRef,
      reserve: { tokens: 1, calls: 1, steps: 1 }, maxPromptChars: 1 } });
  const proved = readCentralToolStageProduction(final.state, { scope: plan.scope, input: proofInput(secondStage) });

  assert.deepEqual(proved.outputs, [childId], "The original published candidate survives the still-open/yielded funding job");
  assert.ok(!proved.outputs.includes(parent.versionId), "Selecting an older target never produces it again");
  const contract = readCentralToolStageProduction(final.state, { scope: plan.scope, input: proofInput(firstStage) });

  assert.deepEqual(contract.outputs, [], "Content-only contract hashes do not identify their first producing job");
  assert.ok(contract.sourceRefs.includes(proposalId));
  assert.deepEqual(readCentralToolStageProduction(final.state, { scope: plan.scope,
    input: { ...proofInput(secondStage), sourceBindingRef: "TEST-wrong-source" } }).outputs, []);
  const historical = { ...final.state, proposals: final.state.proposals.map(row => row.proposalId === child.proposalId
    ? { ...row, lifecycle: "rejected" as const } : row) };

  assert.deepEqual(readCentralToolStageProduction(historical, { scope: plan.scope, input: proofInput(secondStage) }).outputs, [childId],
    "Historical production survives later withdrawal without granting current executability");
});
