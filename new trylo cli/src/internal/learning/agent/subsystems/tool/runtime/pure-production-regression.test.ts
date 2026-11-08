import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { issueAgentMethodReceipt } from "../../../../../integration/testing/authority-fixtures.js";
import { contentHashOf } from "../../../../control/hash.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { createToolProductionPlan, toolProductionScope } from "../domain/evolution/production-plan.js";
import { saveToolProductionPlan, TOOL_PRODUCTION_GENERATOR, TOOL_PRODUCTION_VERIFIER } from "./production-assets.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { admitToolProductionVerification } from "./production-evidence.js";
import { activateToolProduction, reviewToolProductionActivation } from "./production-activation.js";
import { openToolProductionUse } from "./production-use.js";
import { recordAndScheduleToolTaskFeedback } from "./feedback-learning.js";
import { recordToolTaskFeedback } from "./tool-task-feedback.js";
import { saveToolFeedbackHandoff } from "./feedback-handoff.js";
import { planForJob, readToolLearningPipeline } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { exactPureProductionLearningParents } from "./pure-production-regression.js";
import { generatedPredecessorFromBoard } from "./generated-predecessor.js";
import { recordOf } from "../domain/evolution/parse.js";

test("actual stronger pure-production feedback blocks pure construction before source spending and still permits reviewed npm acquisition", async t => {
  // TEST ONLY authority/executor fixtures exercise the actual host owners. This
  // does not claim native verification, a real model answer or task quality.
  const fx = await seedToolProduction(t), original = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(original.ok);
  const checks = { ...fx.plan.checks, requestId: "exact-stronger-production", evidence: fx.plan.checks.evidence.map(sample => sample.role === "variation"
    ? { ...sample, sampleId: "PRIVATE_STRONG_PRODUCTION_CASE", input: 10103, expected: { kind: "value" as const, value: 20206 } } : sample) };
  const strong = createToolProductionPlan({ workspaceId: fx.plan.workspaceId, originVersionId: fx.origin.versionId, artifact: original.artifact, checks, license: "MIT" });
  assert.ok(strong.ok);
  assert.ok((await saveToolProductionPlan(fx.root, strong.plan, productionTestTime)).ok);
  const receipt = await issueAgentMethodReceipt(fx.harness, { ...fx.record, packageVersionId: strong.versionId },
    { scope: toolProductionScope(strong.plan), generatorId: TOOL_PRODUCTION_GENERATOR, verifierId: TOOL_PRODUCTION_VERIFIER });
  const selection = { ...fx.selection, versionId: strong.versionId };

  assert.ok((await admitToolProductionVerification({ ...selection, receiptId: receipt.receiptId, issuedAt: productionTestTime })).ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "permission.ndjson") });
  const review = await reviewToolProductionActivation(selection);
  assert.ok(review.ok);
  const grant = await permission.issue({ action: "activate", candidateId: review.reviewId, packageVersionId: strong.versionId,
    scope: toolProductionScope(strong.plan), issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" });
  assert.ok(grant.ok);
  assert.ok((await activateToolProduction({ ...selection, reviewId: review.reviewId, permission, token: { grantId: grant.grant.grantId }, issuedAt: productionTestTime })).ok);
  const signal = new AbortController().signal;
  const mounted = await openToolProductionUse({ ...selection, sessionId: "actual-production-session", now: () => 0, newId: () => "strong-production-use",
    warn: message => assert.fail(message), executor: { execute: async () => ({ kind: "value" as const, value: 4 }) } });
  assert.ok(mounted.ok);
  t.after(mounted.mount.close);
  const firstUse = await mounted.mount.tools.execute({ toolCallId: "production-call", name: mounted.mount.binding.name, arguments: { input: 2 } }, signal);

  assert.equal(firstUse.outcome, "result", JSON.stringify(firstUse));
  const distractor = createToolProductionPlan({ workspaceId: fx.plan.workspaceId, originVersionId: fx.origin.versionId,
    artifact: original.artifact, checks: { ...fx.plan.checks, requestId: "latest-but-not-the-used-interface" }, license: "MIT" });
  assert.ok(distractor.ok);
  assert.ok((await saveToolProductionPlan(fx.root, distractor.plan, productionTestTime)).ok);
  const feedback = async (key: string, situation = key) => {
    const result = await recordAndScheduleToolTaskFeedback(fx.root, { schemaVersion: 1, feedbackId: key, versionId: strong.versionId,
      sessionId: "actual-production-session", taskId: key, useIds: ["strong-production-use"], situation, source: "user",
      evidenceRefs: [`user:${key}`], outcome: "partial", attribution: "implementation", recommendation: "improve",
      summary: "Investigate the implementation while keeping its already frozen production contract." }, productionTestTime);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.learning.kind, "queued", JSON.stringify(result.learning));
    if (result.learning.kind !== "queued") assert.fail("missing exact feedback inquiry");
    return result.learning.jobId;
  };
  const reasoning = { rationale: "TEST ONLY proposed source revision", existingInsufficiency: "The existing implementation needs investigation",
    expectedBenefit: "Unverified", constructionCost: "An original bounded proposal", alternatives: ["Acquire a reviewed replacement or defer"] };
  let sourceCalls = 0, planned = 0, firstRepairJobId: string | undefined;

  for (const action of ["improve", "create", "compose"] as const) {
    const jobId = await feedback(`strong-${action}`);

    if (action === "improve") firstRepairJobId = jobId;

    const services: ToolPipelineServices = { executionAuthorized: true,
      allowance: async () => ({ grantId: `TEST ONLY original ${action} allowance`, maxCalls: 3, callsRemaining: 3, maxTokens: 48000, tokensRemaining: 48000, maxPromptChars: 24000 }),
      context: async () => ({ availableTools: [], requirements: [] }), search: async () => { assert.fail("exact production source needs no discovery"); },
      plan: async context => {
        planned++;
        assert.equal(JSON.stringify(context).includes("PRIVATE_STRONG_PRODUCTION_CASE"), false);
        const prior = context.priorVersions[0];
        assert.ok(prior);
        const base = { ...original.artifact.request, operation: action === "improve" ? "improve" as const : "create" as const,
          ...(action === "improve" ? { prior: { versionId: prior.versionId } } : {}),
          ...(action === "compose" ? { composition: { schemaVersion: 1, steps: [{ stepId: "old", versionId: prior.versionId, input: { from: "input", path: [] } },
            { stepId: "confirm", versionId: prior.versionId, input: { from: "input", path: [] } }], output: { from: "step", stepId: "confirm", path: [] } } } : {}) };
        const { source: _source, ...descriptor } = original.artifact.candidate;

        return { ...reasoning, action, request: base, sampleOrigins: prior.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "contract", ref: `${prior.versionId}:${sample.sampleId}` })),
          ...(action === "compose" ? { descriptor } : {}) };
      },
      evolve: async () => {
        sourceCalls++;
        assert.fail("stronger hidden production regression cannot collapse to training");
      },
      compose: async () => {
        sourceCalls++;
        assert.fail("composition cannot bypass the same hidden regression obligation");
      },
    };
    const worked = await workToolLearningPipeline({ boardRoot: fx.root, scope: "test", signal, mode: "after_turn", now: () => 0, jobIds: [jobId], services });
    assert.ok(worked.ok);
    assert.equal(worked.results[0]?.code, "pure_production_regression_contract_required");
    const loaded = await createBoardReader(fx.root).load();
    assert.ok(loaded.ok);
    const plan = planForJob(loaded.state, jobId);
    assert.ok(plan);
    const exact = exactPureProductionLearningParents(loaded.state, plan);
    assert.ok(exact.ok);
    assert.deepEqual(exact.parents.map(parent => parent.versionId), [strong.versionId], "an unreferenced production alias must not be selected by recency or capability");
    const diagnostic = loaded.state.assets.find(asset => recordOf(asset.content) && asset.content.type === "tool_pure_production_regression_block" && asset.content.jobId === jobId)?.content;

    assert.ok(recordOf(diagnostic));
    assert.ok(JSON.stringify(diagnostic).includes(strong.versionId));
    assert.ok(JSON.stringify(diagnostic).includes(contentHashOf(strong.plan)));
    assert.ok(JSON.stringify(diagnostic).includes(contentHashOf(strong.plan.checks)));
    assert.equal(JSON.stringify(diagnostic).includes("PRIVATE_STRONG_PRODUCTION_CASE"), false);
    const jobs = await readToolLearningPipeline(fx.root);
    assert.ok(jobs.ok);
    assert.equal(jobs.jobs.find(job => job.jobId === jobId)?.result?.outcome, "waiting_evidence");
  }

  assert.equal(planned, 3);
  assert.equal(sourceCalls, 0);
  const acquireJob = await feedback("strong-acquire", "strong-improve");

  assert.equal(acquireJob, firstRepairJobId, "an external alternative enriches the same pending question, within the original daily nomination cap");
  let acquisitionPlans = 0;
  const acquired = await workToolLearningPipeline({ boardRoot: fx.root, scope: "test", signal, mode: "after_turn", now: () => 0, jobIds: [acquireJob], services: {
    executionAuthorized: true,
    allowance: async () => ({ grantId: "TEST ONLY original improve allowance", maxCalls: 3, callsRemaining: 2 - acquisitionPlans, maxTokens: 48000, tokensRemaining: 48000, maxPromptChars: 24000 }),
    context: async () => ({ availableTools: [], requirements: [] }),
    search: async () => ({ status: "complete", candidates: [{ platform: "npm", id: "semver", version: "7.8.5", sourceUrl: "https://www.npmjs.com/package/semver/v/7.8.5", licenseSpdx: "ISC" }], failures: [] }),
    plan: async context => { acquisitionPlans++;
    return context.search.candidates.length === 0 ? { ...reasoning, action: "research", query: "semver" }
      : { ...reasoning, action: "acquire", candidate: { platform: "npm", id: "semver", version: "7.8.5" }, adaptation: "Use a separately approved replacement while preserving the exact production contract." }; },
    evolve: async () => { assert.fail("acquisition approval is not source execution"); },
  } });
  assert.ok(acquired.ok);
  assert.equal(acquired.results[0]?.code, "acquisition_approval_required");
  assert.equal(acquisitionPlans, 2, "the existing grant has one research and one final approval decision left");
  const final = await createBoardReader(fx.root).load();
  assert.ok(final.ok);
  const acquirePlan = planForJob(final.state, acquireJob);
  assert.ok(acquirePlan);
  const exact = exactPureProductionLearningParents(final.state, acquirePlan);
  assert.ok(exact.ok);
  assert.equal(exact.parents.length, 1);
  const replacement = generatedPredecessorFromBoard(final.state, exact.parents[0]!.versionId, strong.plan.workspaceId);
  assert.ok(replacement);
  assert.deepEqual(replacement.checks.evidence, strong.plan.checks.evidence, "the host's exact production source retains the stronger oracle for the approved npm child");
  assert.equal(final.state.assets.filter(asset => asset.kind === "tool_package").length, 4, "no blocked pure candidate was fabricated");
  assert.equal(sourceCalls, 0);

  // Reconstruct a valid historical merge using the old handoff owner. Future
  // scheduling must not merge P1/P2, but existing assignments cannot be ignored.
  const secondReceipt = await issueAgentMethodReceipt(fx.harness, { ...fx.record, packageVersionId: distractor.versionId },
    { scope: toolProductionScope(distractor.plan), generatorId: TOOL_PRODUCTION_GENERATOR, verifierId: TOOL_PRODUCTION_VERIFIER });
  const secondSelection = { ...selection, versionId: distractor.versionId };

  assert.ok((await admitToolProductionVerification({ ...secondSelection, receiptId: secondReceipt.receiptId, issuedAt: productionTestTime })).ok);
  const secondReview = await reviewToolProductionActivation(secondSelection);
  assert.ok(secondReview.ok);
  const secondGrant = await permission.issue({ action: "activate", candidateId: secondReview.reviewId, packageVersionId: distractor.versionId,
    scope: toolProductionScope(distractor.plan), issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" });
  assert.ok(secondGrant.ok);
  assert.ok((await activateToolProduction({ ...secondSelection, reviewId: secondReview.reviewId, permission,
    token: { grantId: secondGrant.grant.grantId }, issuedAt: productionTestTime })).ok);
  const secondMount = await openToolProductionUse({ ...secondSelection, sessionId: "second-production-session", now: () => 0,
    newId: () => "second-production-use", warn: message => assert.fail(message), executor: { execute: async () => ({ kind: "value" as const, value: 4 }) } });

  assert.ok(secondMount.ok);
  t.after(secondMount.mount.close);
  await secondMount.mount.tools.execute({ name: secondMount.mount.binding.name, toolCallId: "second-production-call", arguments: { input: 2 } }, signal);
  const historical = await recordToolTaskFeedback(fx.root, { schemaVersion: 1, feedbackId: "legacy-second-source", versionId: distractor.versionId,
    sessionId: "second-production-session", taskId: "legacy-second-source-task", useIds: ["second-production-use"], situation: "strong-improve", source: "user",
    evidenceRefs: ["user:legacy-exact-use"], outcome: "partial", attribution: "implementation", recommendation: "improve", summary: "An old version of the scheduler assigned this other exact production use to the same inquiry." }, productionTestTime);

  assert.ok(historical.ok);
  assert.ok((await saveToolFeedbackHandoff(fx.root, { feedbackVersionId: historical.feedbackVersionId, jobId: acquireJob,
    plan: acquirePlan, situation: "strong-improve", issuedAt: productionTestTime })).ok);
  const merged = await createBoardReader(fx.root).load();
  assert.ok(merged.ok);
  const exactMerged = exactPureProductionLearningParents(merged.state, acquirePlan);
  assert.ok(exactMerged.ok);
  assert.deepEqual(new Set(exactMerged.parents.map(parent => parent.versionId)), new Set([strong.versionId, distractor.versionId]),
    "a legacy inquiry with two assigned exact production sources is ambiguous; the host must wait rather than select the newest or first");
});
