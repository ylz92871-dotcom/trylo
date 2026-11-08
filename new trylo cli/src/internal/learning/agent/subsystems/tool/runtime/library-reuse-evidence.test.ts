import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { createToolProductionPlan } from "../domain/evolution/production-plan.js";
import { saveToolProductionPlan } from "./production-assets.js";
import { toolLibraryReuseEvidence } from "./library-reuse-evidence.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { workToolLearningPipeline } from "./pipeline-worker.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";

test("offered exact production versions expose frozen contract fit and source equality without exposing held-out data or reviving unoffered history", async t => {
  const fx = await seedToolProduction(t);
  const origin = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(origin.ok);
  const candidate = { ...origin.artifact.candidate, identity: "same-source-alternative" };
  const artifact = { ...origin.artifact, candidate, verification: { ...origin.artifact.verification, candidateHash: contentHashOf(candidate) } };
  const archived = await createToolEvolutionArchive(fx.root).save(artifact);
  assert.ok(archived.ok);
  const plan = createToolProductionPlan({ workspaceId: fx.plan.workspaceId, originVersionId: archived.versionId, artifact, checks: fx.plan.checks, license: "MIT" });
  assert.ok(plan.ok);
  const saved = await saveToolProductionPlan(fx.root, plan.plan, productionTestTime);
  assert.ok(saved.ok);
  const board = await createBoardReader(fx.root).load();
  assert.ok(board.ok);
  const first = fx.plan.checks.evidence[0]!;
  const tools = [{ toolId: "different-title", versionId: fx.selection.versionId, description: "TEST ONLY" },
    { toolId: "alternate-title", versionId: saved.versionId, description: "TEST ONLY" }, { toolId: "builtin", description: "No invented contract" }];
  const found = toolLibraryReuseEvidence(board.state, "test", tools, [{ ref: "user:exact-example", sample: first }]);
  assert.ok(found.ok);
  assert.equal(found.evidence.length, 2);
  assert.deepEqual(found.evidence[0]?.taskExamples.matchingRefs, ["user:exact-example"]);
  assert.deepEqual(found.evidence[0]?.sameImplementationAs, [{ toolId: "alternate-title", versionId: saved.versionId }]);
  assert.equal(found.evidence[0]?.contractScope.generalization, "not_established");
  assert.equal(JSON.stringify(found.evidence).includes('"input"'), false);
  assert.equal(JSON.stringify(found.evidence).includes('"expected"'), false);
  const limited = toolLibraryReuseEvidence(board.state, "test", tools.slice(0, 1), []);
  assert.ok(limited.ok);
  assert.deepEqual(limited.evidence[0]?.sameImplementationAs, [], "unoffered versions must not be promoted into callable alternatives");
  const foreignContract = toolLibraryReuseEvidence(board.state, "other-scope", tools, []);
  assert.ok(foreignContract.ok);
  assert.deepEqual(foreignContract.evidence, [], "host exposure does not authorize reading another learning scope's contract or feedback");
});

test("a host-offered workspace tool keeps unknown fit when its origin contract is in another learning scope", async t => {
  const fx = await seedToolProduction(t);
  const scope = "host-workspace-with-independent-learning-scope";
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: "double",
    createdAt: productionTestTime, trigger: { action: "user_requested", runId: "later-task", proposalKey: "cross-origin-reuse", evidenceRefs: [] } };
  const queued = await enqueueToolLearningPlan(fx.root, plan);
  assert.ok(queued.ok);
  let decisions = 0;
  const offered = { toolId: "host-offered-double", versionId: fx.selection.versionId, description: "TEST ONLY offered by the existing host" };
  const worked = await workToolLearningPipeline({ boardRoot: fx.root, scope, jobIds: [queued.jobId], mode: "manual", now: () => 0,
    signal: new AbortController().signal, services: {
      executionAuthorized: true,
      allowance: async () => ({ grantId: "TEST ONLY controlled allowance", maxCalls: 2, callsRemaining: 2,
        maxTokens: 16000, tokensRemaining: 16000, maxPromptChars: 24000 }),
      context: async () => ({ availableTools: [offered], requirements: [] }),
      search: async () => { assert.fail("host already exposes this tool"); },
      evolve: async () => { assert.fail("unknown contract fit does not authorize synthesis"); },
      plan: async context => {
        decisions++;
        assert.deepEqual(context.availableTools, [offered]);
        assert.deepEqual(context.reuseEvidence, [], "no contract, feedback or compatibility claim may cross the learning scope");
        return { action: "reuse", toolId: offered.toolId, usage: "Use the existing host-offered ABI; task quality remains unverified.",
          rationale: "The host currently offers this tool; this learner has no contract fit evidence", existingInsufficiency: "No missing behavior established",
          expectedBenefit: "Try the available capability", constructionCost: "No generation", alternatives: ["Unknown contract fit is not evidence of incompatibility"] };
      },
    } });

  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "existing_capability_reused");
  assert.equal(decisions, 1, "optional enrichment cannot block an otherwise valid host-offered reuse decision");
});

test("normal planning consumes contract evidence before deciding to reuse an offered version, with no synthesis or extra model calls", async t => {
  const fx = await seedToolProduction(t), sample = fx.plan.checks.evidence[0]!;
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double",
    createdAt: productionTestTime, trigger: { action: "user_requested", runId: "later-task", proposalKey: "reuse-contract", evidenceRefs: ["user:task-example"] } };
  const queued = await enqueueToolLearningPlan(fx.root, plan);
  assert.ok(queued.ok);
  let decisions = 0;
  const worked = await workToolLearningPipeline({ boardRoot: fx.root, scope: "test", jobIds: [queued.jobId], mode: "manual", now: () => 0,
    signal: new AbortController().signal, services: {
      executionAuthorized: true,
      allowance: async () => ({ grantId: "TEST ONLY existing controlled allowance", maxCalls: 2, callsRemaining: 2,
        maxTokens: 16000, tokensRemaining: 16000, maxPromptChars: 24000 }),
      context: async () => ({ availableTools: [{ toolId: "irrelevant-builtin", description: "A name with many matching words" },
        { toolId: "offered-double", versionId: fx.selection.versionId, description: "TEST ONLY offered production version" }],
        requirements: [{ ref: "user:task-example", kind: "user_requirement", text: "For this task, double the input exactly." }],
        groundedSamples: [{ ref: "user:task-example", sample }] }),
      search: async () => { assert.fail("there is already a suitable offered version"); },
      evolve: async () => { assert.fail("contract-aware reuse must not synthesize a sibling"); },
      plan: async context => {
        decisions++;
        assert.equal(context.availableTools[0]?.toolId, "offered-double");
        assert.deepEqual(context.reuseEvidence?.[0]?.taskExamples.matchingRefs, ["user:task-example"]);
        assert.equal(context.reuseEvidence?.[0]?.contractScope.generalization, "not_established");
        return { action: "reuse", toolId: "offered-double", usage: "Use the existing numeric input ABI.", rationale: "The exact task example already belongs to this version's contract",
          existingInsufficiency: "No missing behavior has been established", expectedBenefit: "Avoid a redundant sibling", constructionCost: "No source generation",
          alternatives: ["Creating another implementation would not add a known behavior"] };
      },
    } });

  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "existing_capability_reused");
  assert.equal(decisions, 1);
});
