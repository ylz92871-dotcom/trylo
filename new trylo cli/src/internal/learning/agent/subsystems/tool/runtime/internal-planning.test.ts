import { testScratchPath } from "../../../../../testing/scratch.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolEvolutionCandidate, ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import type { ToolLearningContext, ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { decodeToolLearningDecision, toolLearningPlanningPrompt } from "../domain/evolution/learning-plan.js";
import { boundToolLearningContext } from "../domain/evolution/learning-context-budget.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { decodeToolLearningRecipe } from "../domain/evolution/pipeline.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { decisionBindingFailure } from "./learning-context.js";
import { enqueueToolLearningPlan, readToolLearningPipeline } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { createBoardToolLearning } from "../../../../../tooling/library/host/learning.js";
import { createToolLibrary } from "../../../../../tooling/library/service.js";
import type { ToolLibraryEntry } from "../../../../../tooling/library/contracts.js";
import type { PermissionPort } from "../../../../../ports/permission.js";
import type { ToolBinding, ToolPort } from "../../../../../ports/tools.js";

const occurredAt = "2026-11-03T00:00:00.000Z";
const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "planning-scope", capability: "double finite numbers",
  trigger: { runId: "task-1", proposalKey: "double-gap", evidenceRefs: ["task:1"], action: "user_requested" }, createdAt: occurredAt };
const request: ToolEvolutionRequest = { schemaVersion: 1, requestId: "independent-plan", scope: plan.scope, capability: plan.capability,
  operation: "create", maxAttempts: 3, evidence: [
    { sampleId: "source-a", role: "source", input: 2, expected: { kind: "value", value: 4 } },
    { sampleId: "source-b", role: "source", input: 3, expected: { kind: "value", value: 6 } },
    { sampleId: "zero", role: "variation", input: 0, expected: { kind: "value", value: 0 } },
    { sampleId: "invalid", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
  ] };
const reasoning = { rationale: "Repeated transformation warrants a reusable bounded function", existingInsufficiency: "No available tool doubles values",
  expectedBenefit: "May reduce repeated arithmetic calls; not an observed saving", constructionCost: "One generation and four checks", alternatives: ["Reuse inventory first"] };
const candidate: ToolEvolutionCandidate = { identity: "double", description: "Double finite numbers", inputSchema: { type: "number" },
  source: "module.exports = input => input * 2;", mastery: { whenToUse: ["Double numbers"], preconditions: [], pitfalls: [] } };

function plannedCreate(): ToolLearningDecision {
  return { ...reasoning, action: "create", request, sampleOrigins: request.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: "requirement:double-gap" })) };
}

async function fixture(t: TestContext) {
  const base = testScratchPath("tool-learning-internal-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let searches = 0, generations = 0, releases = 0, planning = 0;
  const services: ToolPipelineServices = { executionAuthorized: true,
    allowance: async () => ({ grantId: "central:test", maxCalls: 4, maxTokens: 20000, callsRemaining: 4, tokensRemaining: 20000, maxPromptChars: 100000 }),
    plan: async () => {
      planning++;
      return plannedCreate();
    },
    search: async () => {
      searches++;
      return { status: "complete", candidates: [], failures: [] };
    },
    releaseAllowance: async () => { releases++; },
    async evolve(frozen) {
      generations++;
      // This controlled archive verifies orchestration/binding, not execution quality.
      const artifact = { schemaVersion: 1 as const, generatedAt: occurredAt, request: frozen, candidate,
        verification: { verdict: "pass" as const, candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(frozen.evidence),
          checks: frozen.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed" as const, detail: "TEST ONLY" })) } };
      const saved = await createToolEvolutionArchive(root).save(artifact);
      assert.ok(saved.ok, JSON.stringify(saved));

      return { kind: "candidate", ...saved, artifact, attempts: 1 };
    } };
  const queued = await enqueueToolLearningPlan(root, plan);
  assert.ok(queued.ok, JSON.stringify(queued));
  const input = { boardRoot: root, scope: plan.scope, now: () => 1793664000000, services, mode: "after_turn" as const, signal: new AbortController().signal };
  const state = async () => {
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  return { root, input, state, counts: () => ({ searches, generations, releases, planning }) };
}

test("a real requirement starts learning without a handwritten recipe and freezes its oracle before generation", async t => {
  const fx = await fixture(t);
  const result = await workToolLearningPipeline(fx.input);
  assert.ok(result.ok);
  assert.equal(result.results[0]?.code, "candidate_pending_review");
  const inventory = await readToolLearningPipeline(fx.root);
  assert.ok(inventory.ok);
  const job = inventory.jobs[0];
  assert.equal(job?.state, "waiting_approval");
  assert.equal(job?.result?.decision?.action, "create");
  assert.ok(job?.result?.decisionVersionId);
  const recipeAsset = (await fx.state()).assets.find(asset => asset.versionId === job?.result?.recipeVersionId);
  const recipe = decodeToolLearningRecipe(recipeAsset?.content);
  assert.ok(recipe);
  assert.deepEqual(recipe.request.evidence, request.evidence);
  assert.deepEqual(fx.counts(), { searches: 0, generations: 1, releases: 1, planning: 1 });
  assert.equal((await fx.state()).activations.length, 0);
});

test("semantic reuse ends learning with a concrete usage choice and spends no search or generation", async t => {
  const fx = await fixture(t);
  const services: ToolPipelineServices = { ...fx.input.services,
    context: async () => ({ availableTools: [{ toolId: "existing-multiply", description: "Multiply finite numbers" }], requirements: [] }),
    plan: async () => ({ ...reasoning, action: "reuse", toolId: "existing-multiply", usage: "Set multiplier=2; no new tool is needed" }) };
  const worked = await workToolLearningPipeline({ ...fx.input, services });
  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "existing_capability_reused");
  assert.equal((await fx.state()).jobs[0]?.state, "succeeded");
  assert.equal(fx.counts().searches, 0);
  assert.equal(fx.counts().generations, 0);
});

test("an approved library demand returns the planner's reused tool through current library and Permission resolution", async t => {
  const fx = await fixture(t), context = { memberId: "personal-agent", scope: plan.scope };
  const runtimeName = "existing_multiply", toolId = `runtime:${runtimeName}`;
  let requested = 0, denied = false, executed = 0;
  const permission: PermissionPort = { isDenied: name => denied && name === runtimeName,
    request: async action => { requested++;
    assert.equal(action.name, "tool_library_acquire");
    assert.equal(action.arguments.memberId, context.memberId);
      return { ticketId: "library-consent", toolCallId: action.toolCallId }; },
    awaitDecision: async ticketId => {
      assert.equal(ticketId, "library-consent");
      return { resolution: "approved", scope: "once" };
    } };
  const learning = createBoardToolLearning({ boardRoot: fx.root, permission: () => permission, now: fx.input.now });
  const submitted = await learning.request(context, { requestKey: "semantic-double", taskId: "parent-task", capability: "Twice each finite input without building another tool" }, fx.input.signal);

  assert.ok(submitted.ok, JSON.stringify(submitted));
  assert.equal(submitted.value.state, "queued");
  assert.equal(requested, 1);
  const services: ToolPipelineServices = { ...fx.input.services,
    context: async () => ({ availableTools: [{ toolId, description: "Multiply an input by a configured factor" }], requirements: [] }),
    plan: async () => ({ ...reasoning, action: "reuse", toolId, usage: "Use the existing multiplier with factor=2" }) };
  const worked = await workToolLearningPipeline({ ...fx.input, services, jobIds: [submitted.value.requestId] });
  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "existing_capability_reused");
  const direct = await learning.get(context, submitted.value.requestId);
  assert.ok(direct.ok);
  assert.equal(direct.value.state, "succeeded");
  assert.deepEqual(direct.value.toolIds, [toolId]);

  const binding: ToolBinding = { name: runtimeName, description: "Multiply numeric input", sideEffect: "read_only", parallelSafe: true,
    parameters: { type: "object", properties: { input: { type: "number" }, factor: { type: "number" } } }, needsApproval: false,
    timeoutMs: 1000, outputLimits: { maxBytes: 1024, maxLines: 10 } };
  const tools: ToolPort = { snapshot: () => [binding], cancel: async () => {}, execute: async call => {
    executed++;
    assert.equal(call.name, runtimeName);
    const value = Number(call.arguments.input) * Number(call.arguments.factor);
    return { outcome: "result", value: { result: value }, output: String(value), truncated: false };
  } };
  const entry: ToolLibraryEntry = { id: toolId, name: runtimeName, description: binding.description, capabilities: ["Multiply numbers"],
    source: { kind: "builtin", label: "Existing runtime owner" }, runtimeName, availability: { state: "available" } };
  const library = createToolLibrary({ learning, sources: [{ id: "existing-runtime", read: async () => ({ ok: true, value: [entry] }) }],
    access: async () => ({ ok: true, value: { tools, permission, configuredNames: [runtimeName], allowedNames: [runtimeName] } }) });
  const ready = await library.getRequest(context, submitted.value.requestId);
  assert.ok(ready.ok);
  assert.deepEqual(ready.value.toolIds, [toolId]);
  const resolved = await library.resolve(context, ready.value.toolIds);
  assert.ok(resolved.ok);
  const result = await resolved.value.tools.execute({ toolCallId: "reuse-call", name: runtimeName, arguments: { input: 3, factor: 2 } }, fx.input.signal);

  assert.equal(result.outcome, "result");
  if (result.outcome === "result") assert.equal(result.output, "6");
  assert.equal(executed, 1);
  denied = true;
  const revoked = await library.getRequest(context, submitted.value.requestId);
  assert.ok(revoked.ok);
  assert.deepEqual(revoked.value.toolIds, [], "a completed reuse decision cannot override current Permission");
  assert.equal((await resolved.value.tools.execute({ toolCallId: "denied-reuse-call", name: runtimeName, arguments: { input: 3, factor: 2 } }, fx.input.signal)).outcome, "error");
  assert.equal(executed, 1);
  assert.equal(fx.counts().generations, 0);
  assert.equal(fx.counts().searches, 0);
  assert.equal((await fx.state()).jobs.find(job => job.jobId !== submitted.value.requestId)?.attempt, 0, "only this exact library job was processed");
});

test("public discovery happens only after inventory comparison and is limited to one targeted query", async t => {
  const fx = await fixture(t);
  let turns = 0;
  const services: ToolPipelineServices = { ...fx.input.services,
    plan: async context => { turns++;
    assert.equal(context.availableTools.length, 0);
      return turns === 1 ? { ...reasoning, action: "research", query: "bounded number transform library" } : plannedCreate(); } };
  const result = await workToolLearningPipeline({ ...fx.input, services });
  assert.ok(result.ok);
  assert.equal(result.results[0]?.code, "candidate_pending_review");
  assert.equal(turns, 2);
  assert.equal(fx.counts().searches, 1);
});

test("no central allowance causes an explicit wait without any provider call or implicit retry", async t => {
  const fx = await fixture(t);
  const input = { ...fx.input, services: { ...fx.input.services, allowance: async () => undefined } };
  await workToolLearningPipeline(input);
  await workToolLearningPipeline(input);
  const status = await readToolLearningPipeline(fx.root);
  assert.ok(status.ok);
  assert.equal(status.jobs[0]?.result?.code, "learning_allowance_required");
  assert.equal(status.jobs[0]?.attempt, 1);
  assert.equal(fx.counts().planning, 0);
  assert.equal(fx.counts().generations, 0);
});

test("independent grounding cannot be relabeled or weakened and improvement retains the entire old contract", () => {
  const decision = plannedCreate();
  assert.ok("request" in decision);
  const context: ToolLearningContext = { plan, search: { status: "complete", candidates: [], failures: [] },
    allowance: { grantId: "central:test", maxCalls: 2, maxTokens: 1000, callsRemaining: 2, tokensRemaining: 1000, maxPromptChars: 100000 },
    availableTools: [], priorVersions: [], groundedSamples: [{ ref: "actual:1", sample: request.evidence[0]! }], requirements: [] };
  const counterfeit = { ...decision, sampleOrigins: decision.sampleOrigins.map(origin => ({ ...origin, kind: "observed" as const, ref: "actual:1" })),
    request: { ...request, evidence: request.evidence.map(sample => ({ ...sample, expected: { kind: "value" as const, value: 99 } })) } };

  assert.equal(decisionBindingFailure(counterfeit, context), "sample_grounding_mismatch");
  assert.equal(decisionBindingFailure({ ...decision, sampleOrigins: decision.sampleOrigins.map(origin => ({ ...origin, kind: "observed" as const, ref: "actual:batch" })) },
    { ...context, groundedSamples: request.evidence.map(sample => ({ ref: "actual:batch", sample })) }), undefined);
  assert.equal(decisionBindingFailure(decision, context), "independent_sample_required");
  assert.equal(decodeToolLearningDecision({ ...reasoning, action: "reuse", toolId: "x", usage: "x", approved: true }), undefined);
});

test("execution authorization arriving later resumes the frozen internal recipe without replanning", async t => {
  const fx = await fixture(t);
  await workToolLearningPipeline({ ...fx.input, services: { ...fx.input.services, executionAuthorized: false } });
  assert.equal(fx.counts().planning, 1);
  assert.equal(fx.counts().generations, 0);
  const worked = await workToolLearningPipeline(fx.input);
  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "candidate_pending_review");
  assert.equal(fx.counts().planning, 1);
  assert.equal(fx.counts().generations, 1);
});

test("allowance release failure remains visible while preserving the candidate and terminal lifecycle", async t => {
  const fx = await fixture(t);
  const result = await workToolLearningPipeline({ ...fx.input, services: { ...fx.input.services,
    releaseAllowance: async () => { throw new Error("TEST_PRIVATE_RESOURCE_DETAIL"); } } });
  assert.ok(result.ok);
  const status = await readToolLearningPipeline(fx.root);
  assert.ok(status.ok);
  assert.equal(status.jobs[0]?.state, "waiting_approval");
  assert.equal(status.jobs[0]?.result?.code, "allowance_release_failed");
  assert.equal(status.jobs[0]?.result?.previousCode, "candidate_pending_review");
  assert.equal(status.jobs[0]?.result?.cleanupCode, "cleanup_unconfirmed");
  assert.ok(status.jobs[0]?.result?.candidateVersionId);
  assert.equal(JSON.stringify(status).includes("TEST_PRIVATE_RESOURCE_DETAIL"), false);
});

test("prompt packing drops optional retrieval context while preserving the exact target contract", () => {
  const prior = { versionId: "parent:1", capability: plan.capability, source: candidate.source, evidence: request.evidence, feedback: "A real task identified implementation failure" };
  const context: ToolLearningContext = { plan: { ...plan, targetVersionId: prior.versionId },
    search: { status: "complete", candidates: [], failures: [] }, allowance: { grantId: "central:test", maxCalls: 2, maxTokens: 1000,
      callsRemaining: 2, tokensRemaining: 1000, maxPromptChars: 12000 }, requirements: [{ ref: "requirement:double-gap", kind: "user_requirement", text: plan.capability }],
    groundedSamples: [], priorVersions: [prior], availableTools: Array.from({ length: 24 }, (_, index) => ({ toolId: `irrelevant-${index}`, description: "x".repeat(1000) })) };
  const bounded = boundToolLearningContext(context);
  assert.ok(bounded);
  assert.deepEqual(bounded.priorVersions, [prior]);
  assert.ok(bounded.availableTools.length < 24);
  assert.ok(toolLearningPlanningPrompt(bounded).length <= context.allowance.maxPromptChars);
  assert.equal(boundToolLearningContext({ ...context, allowance: { ...context.allowance, maxPromptChars: 7000 } }), undefined,
    "a mandatory contract that exceeds the allowance cannot be weakened or dispatched");
});

test("planning uses the caller's prompt allowance beyond the former private 12k request estimate", () => {
  const context: ToolLearningContext = { plan, search: { status: "complete", candidates: [], failures: [] },
    allowance: { grantId: "explicit-context-allowance", maxCalls: 6, callsRemaining: 6,
      maxTokens: 76862, tokensRemaining: 76862, maxPromptChars: 40000 },
    requirements: [{ ref: "original-task-contract", kind: "user_requirement", text: "An original requirement. ".repeat(700) }],
    groundedSamples: [], priorVersions: [], availableTools: [] };
  const bounded = boundToolLearningContext(context);
  assert.ok(bounded);
  assert.deepEqual(bounded.requirements, context.requirements);
  assert.ok(toolLearningPlanningPrompt(bounded).length <= context.allowance.maxPromptChars);
});

test("planning packs the complete wire envelope, including the actual 219 character system instruction", () => {
  const context: ToolLearningContext = { plan, search: { status: "complete", candidates: [], failures: [] },
    allowance: { grantId: "wire-envelope", maxCalls: 6, callsRemaining: 6,
      maxTokens: 76862, tokensRemaining: 76862, maxPromptChars: 40000 },
    requirements: [], groundedSamples: [], priorVersions: [],
    availableTools: [{ toolId: "optional-catalog-entry", description: "A retrieved optional contract. ".repeat(100) }] };
  const full = boundToolLearningContext(context);
  assert.ok(full);
  const maxPromptChars = toolLearningPlanningPrompt(full).length + 50;
  const packed = boundToolLearningContext({ ...context, allowance: { ...context.allowance, maxPromptChars } });
  assert.ok(packed);
  assert.ok(toolLearningPlanningPrompt(packed).length + 219 <= maxPromptChars,
    "the real funded provider counts system and user messages together");
});

test("a 7k prompt allowance stops before model dispatch when the mandatory contract does not fit", async t => {
  const fx = await fixture(t);
  const saved = await createToolEvolutionArchive(fx.root).save({ schemaVersion: 1, generatedAt: occurredAt, request, candidate,
    verification: { verdict: "pass", candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence),
      checks: request.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed", detail: "TEST ONLY" })) } });
  assert.ok(saved.ok);
  const queued = await enqueueToolLearningPlan(fx.root, { ...plan, targetVersionId: saved.versionId,
    trigger: { ...plan.trigger, proposalKey: "tight-mandatory-parent", evidenceRefs: [saved.versionId] } });
  assert.ok(queued.ok);
  const worked = await workToolLearningPipeline({ ...fx.input, jobIds: [queued.jobId], services: { ...fx.input.services,
    allowance: async () => ({ grantId: "TEST ONLY tight central grant", maxCalls: 2, callsRemaining: 2, maxTokens: 1000, tokensRemaining: 1000, maxPromptChars: 7000 }),
    context: async () => ({ availableTools: [], requirements: [{ ref: "user:independent", kind: "user_requirement" as const, text: "Keep the full task contract within its allowance" }] }) } });

  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "planning_context_exceeds_allowance");
  assert.equal(fx.counts().planning, 0);
});
