import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { appendFileSync } from "node:fs";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { enqueueToolLearningPlan, readToolLearningPipeline, registerToolLearningRecipe, expireToolLearningJob } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import type { ToolLearningPlan } from "../../learning/domains/tool/evolution/pipeline.js";
import type { ToolEvolutionCandidate, ToolEvolutionRequest } from "../../learning/domains/tool/evolution/contracts.js";
import { savePipelineAsset } from "./pipeline-assets.js";
import { resultVersionId } from "../../learning/domains/tool/evolution/pipeline.js";
import { monitorToolJob } from "./pipeline-monitor.js";

const emptySearch = { status: "complete" as const, candidates: [], failures: [] };
const request: ToolEvolutionRequest = { schemaVersion: 1, requestId: "test-recipe", scope: "workspace:test", capability: "double", operation: "create", evidence: [
  { sampleId: "s1", role: "source", input: 2, expected: { kind: "value", value: 4 } },
  { sampleId: "s2", role: "source", input: 3, expected: { kind: "value", value: 6 } },
  { sampleId: "v", role: "variation", input: -1, expected: { kind: "value", value: -2 } },
  { sampleId: "e", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
] };
const candidate: ToolEvolutionCandidate = { identity: "double", description: "double finite numbers", inputSchema: { type: "number" },
  source: "module.exports = input => { if (typeof input !== 'number') { const e = new Error(); e.code = 'invalid_input'; throw e; } return input * 2; }",
  mastery: { whenToUse: ["Double finite numbers"], preconditions: [], pitfalls: [] } };
const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: request.scope, capability: request.capability,
  trigger: { runId: "test-run", proposalKey: "double-gap", action: "replace_or_add", evidenceRefs: ["failure:test"] }, createdAt: new Date(0).toISOString() };

async function fixture(t: TestContext) {
  const base = path.resolve("Temp/tool-cycle-tests"); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")); assert.equal(path.dirname(root), base);
  t.after(() => rm(root, { recursive: true, force: true }));
  let searches = 0, generations = 0;
  const services: ToolPipelineServices = { executionAuthorized: true, search: async () => { searches++; return emptySearch; },
    async evolve(frozen) {
      generations++;
      // TEST ONLY: controlled archive input tests scheduling/binding, not process quality.
      const artifact = { schemaVersion: 1 as const, generatedAt: new Date(0).toISOString(), request: frozen, candidate,
        verification: { verdict: "pass" as const, candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(frozen.evidence),
          checks: frozen.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed" as const, detail: "TEST ONLY" })) } };
      const saved = await createToolEvolutionArchive(root).save(artifact); assert.ok(saved.ok);
      return { kind: "candidate", ...saved, artifact, attempts: 1 };
    } };
  const input = { boardRoot: root, scope: request.scope, now: () => 0, services, mode: "manual" as const, signal: new AbortController().signal };
  const queued = await enqueueToolLearningPlan(root, plan); assert.ok(queued.ok);
  const recipe = (automation: "manual" | "after_turn" = "manual", frozen: ToolEvolutionRequest = request) => registerToolLearningRecipe(root,
    { type: "tool_learning_recipe", schemaVersion: 1, automation, request: frozen }, new Date(0).toISOString());
  const state = async () => { const loaded = await createBoardReader(root).load(); assert.ok(loaded.ok); return loaded.state; };
  return { root, input, recipe, state, jobId: queued.jobId, counts: () => ({ searches, generations }) };
}

test("missing recipe searches once, persists waiting_evidence, and does not manufacture expected answers", async t => {
  const fx = await fixture(t);
  assert.ok((await workToolLearningPipeline(fx.input)).ok);
  assert.equal((await fx.state()).jobs[0]?.state, "waiting_evidence");
  await workToolLearningPipeline(fx.input);
  assert.deepEqual(fx.counts(), { searches: 1, generations: 0 });
  const inventory = await readToolLearningPipeline(fx.root); assert.ok(inventory.ok);
  assert.equal(inventory.jobs[0]?.result?.code, "verification_recipe_required");
  assert.equal((await fx.state()).activations.length, 0);
});

test("caller recipe arrival resumes the same job and freezes the exact recipe/candidate result", async t => {
  const fx = await fixture(t);
  await workToolLearningPipeline(fx.input);
  const recipe = await fx.recipe(); assert.ok(recipe.ok);
  const result = await workToolLearningPipeline(fx.input); assert.ok(result.ok);
  assert.equal(result.results[0]?.code, "candidate_pending_review");
  const state = await fx.state(); assert.equal(state.jobs[0]?.state, "waiting_approval"); assert.equal(state.jobs[0]?.attempt, 2);
  const inventory = await readToolLearningPipeline(fx.root); assert.ok(inventory.ok);
  assert.equal(inventory.jobs[0]?.result?.recipeVersionId, recipe.versionId);
  assert.ok(inventory.jobs[0]?.result?.candidateVersionId);
  assert.equal(state.activations.length, 0); assert.equal(state.evidence.length, 0); assert.equal(state.approvals.length, 0);
  await workToolLearningPipeline(fx.input); assert.equal(fx.counts().generations, 1);
});

test("automatic generation needs explicit recipe opt-in, then ordinary execution authorization", async t => {
  const fx = await fixture(t); await fx.recipe();
  await workToolLearningPipeline({ ...fx.input, mode: "after_turn" });
  assert.equal(fx.counts().generations, 0);
  await fx.recipe("after_turn");
  await workToolLearningPipeline({ ...fx.input, mode: "after_turn", services: { ...fx.input.services, executionAuthorized: false } });
  assert.equal(fx.counts().generations, 0);
  const status = await readToolLearningPipeline(fx.root); assert.ok(status.ok);
  assert.equal(status.jobs[0]?.result?.code, "execution_authorization_required");
  await workToolLearningPipeline({ ...fx.input, mode: "after_turn" });
  assert.equal(fx.counts().generations, 1);
  assert.equal((await fx.state()).jobs[0]?.state, "waiting_approval");
});

test("manual work can consume a manual recipe after automatic discovery waited", async t => {
  const fx = await fixture(t); await fx.recipe();
  await workToolLearningPipeline({ ...fx.input, mode: "after_turn" });
  await workToolLearningPipeline(fx.input);
  assert.equal(fx.counts().generations, 1);
});

test("same capability from another scope cannot supply the oracle", async t => {
  const fx = await fixture(t); await fx.recipe("after_turn", { ...request, scope: "other-workspace" });
  await workToolLearningPipeline(fx.input);
  assert.equal(fx.counts().generations, 0);
  assert.equal((await fx.state()).jobs[0]?.state, "waiting_evidence");
});

test("enqueue replay survives restart without duplicate jobs or assets", async t => {
  const fx = await fixture(t), before = await fx.state();
  const replay = await enqueueToolLearningPlan(fx.root, structuredClone(plan)); assert.ok(replay.ok);
  assert.equal((await fx.state()).sequence, before.sequence); assert.equal((await fx.state()).jobs.length, 1);
});

test("a second process cannot run a claimed job or spend generation budget", async t => {
  const fx = await fixture(t); await fx.recipe();
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const first = workToolLearningPipeline({ ...fx.input, services: { ...fx.input.services, search: async () => { started(); await held; return emptySearch; } } });
  await ready;
  const second = await workToolLearningPipeline(fx.input); assert.ok(second.ok);
  assert.equal(second.results[0]?.code, "running_job_requires_inspection");
  assert.equal(fx.counts().generations, 0);
  release(); await first; assert.equal(fx.counts().generations, 1);
});

test("partial discovery remains factual and cannot certify a downloaded or activated tool", async t => {
  const fx = await fixture(t); await fx.recipe();
  const search = { status: "partial" as const, candidates: [{ platform: "npm", id: "example", sourceUrl: "https://www.npmjs.com/package/example", licenseSpdx: "MIT" }],
    failures: [{ platform: "github", stage: "search", code: "http_429" }] };
  await workToolLearningPipeline({ ...fx.input, services: { ...fx.input.services, search: async () => search } });
  const status = await readToolLearningPipeline(fx.root); assert.ok(status.ok);
  assert.deepEqual(status.jobs[0]?.result?.search, search); assert.equal((await fx.state()).activations.length, 0);
});

test("cancellation during discovery prevents generation and records a terminal cancellation", async t => {
  const fx = await fixture(t); await fx.recipe(); const controller = new AbortController();
  await workToolLearningPipeline({ ...fx.input, signal: controller.signal, services: { ...fx.input.services, search: async () => { controller.abort(); return emptySearch; } } });
  assert.equal(fx.counts().generations, 0); assert.equal((await fx.state()).jobs[0]?.state, "cancelled");
});

test("pre-cancelled work creates no running state", async t => {
  const fx = await fixture(t); const controller = new AbortController(); controller.abort();
  await workToolLearningPipeline({ ...fx.input, signal: controller.signal });
  assert.equal((await fx.state()).jobs[0]?.attempt, 0); assert.equal(fx.counts().searches, 0);
});

test("service exceptions fail visibly without persisting credential-bearing messages", async t => {
  const fx = await fixture(t);
  const result = await workToolLearningPipeline({ ...fx.input, services: { ...fx.input.services, search: async () => { throw new Error("SECRET_TEST_MARKER"); } } });
  assert.ok(result.ok); assert.equal(result.results[0]?.code, "pipeline_service_failed");
  assert.equal((await fx.state()).jobs[0]?.state, "failed");
  assert.equal(JSON.stringify(await fx.state()).includes("SECRET_TEST_MARKER"), false);
});

test("invalid search boundaries fail instead of feeding oversized metadata into the provider", async t => {
  const fx = await fixture(t); await fx.recipe();
  await workToolLearningPipeline({ ...fx.input, services: { ...fx.input.services, search: async () => ({ ...emptySearch,
    candidates: [{ platform: "npm", id: "x".repeat(513), sourceUrl: "https://www.npmjs.com", licenseSpdx: "MIT" }] }) } });
  assert.equal(fx.counts().generations, 0); assert.equal((await fx.state()).jobs[0]?.state, "failed");
});

test("recovery completes an archived terminal result without repeating external work", async t => {
  const fx = await fixture(t);
  const stored = await withBoardWriter(fx.root, async store => {
    await store.apply({ type: "start_job", commandId: `${fx.jobId}:start:1`, issuedAt: plan.createdAt, jobId: fx.jobId });
    return savePipelineAsset(store, { versionId: resultVersionId(fx.jobId, 1), kind: "workflow", source: "inferred", scope: plan.scope, issuedAt: plan.createdAt,
      content: { type: "tool_learning_result", schemaVersion: 1, jobId: fx.jobId, attempt: 1, outcome: "waiting_evidence", code: "verification_recipe_required", search: emptySearch, occurredAt: plan.createdAt } });
  }); assert.ok(stored.ok);
  const recovered = await workToolLearningPipeline(fx.input); assert.ok(recovered.ok);
  assert.equal(recovered.results[0]?.code, "recovered_terminal"); assert.deepEqual(fx.counts(), { searches: 0, generations: 0 });
  assert.equal((await fx.state()).jobs[0]?.state, "waiting_evidence");
});

test("pipeline jobs and artifacts survive Board compaction", async t => {
  const fx = await fixture(t); await workToolLearningPipeline(fx.input);
  const compacted = await withBoardWriter(fx.root, async store => { const loaded = await store.load(); assert.ok(loaded.ok); return store.compact(loaded.generation); });
  assert.ok(compacted.ok);
  const status = await readToolLearningPipeline(fx.root); assert.ok(status.ok);
  assert.equal(status.jobs[0]?.plan?.capability, "double"); assert.equal(status.jobs[0]?.result?.code, "verification_recipe_required");
  assert.ok((await readFile(path.join(fx.root, "board-snapshot.json"), "utf8")).length > 0);
});

test("a lost running job requires explicit closeout and cannot silently retry", async t => {
  const fx = await fixture(t);
  await withBoardWriter(fx.root, store => store.apply({ type: "start_job", commandId: `${fx.jobId}:start:1`, issuedAt: plan.createdAt, jobId: fx.jobId }));
  const result = await workToolLearningPipeline(fx.input); assert.ok(result.ok);
  assert.equal(result.results[0]?.code, "running_job_requires_inspection"); assert.equal(fx.counts().searches, 0);
  assert.ok((await expireToolLearningJob(fx.root, fx.jobId, plan.createdAt)).ok);
  assert.ok((await expireToolLearningJob(fx.root, fx.jobId, plan.createdAt)).ok);
  assert.equal((await fx.state()).jobs[0]?.state, "expired");
  assert.equal((await fx.state()).jobs[0]?.breakerOpen, true);
  await workToolLearningPipeline(fx.input); assert.equal(fx.counts().searches, 0);
});

test("interrupted plan persistence reports failure and same-plan retry fills the prefix once", async t => {
  const fx = await fixture(t), another = { ...plan, trigger: { ...plan.trigger, runId: "interrupted-run", proposalKey: "another-gap" } };
  let writes = 0;
  const failed = await enqueueToolLearningPlan(fx.root, another, { logAppender: (file, bytes, encoding) => {
    writes++;
    if (writes === 4) throw new Error("injected missing commit acknowledgement");
    appendFileSync(file, bytes, encoding);
  } }); assert.equal(failed.ok, false);
  assert.equal((await fx.state()).jobs.length, 1);
  const resumed = await enqueueToolLearningPlan(fx.root, another); assert.ok(resumed.ok);
  assert.equal((await fx.state()).jobs.length, 2);
  const inventory = await readToolLearningPipeline(fx.root); assert.ok(inventory.ok);
  assert.equal(inventory.jobs.find(job => job.jobId === resumed.jobId)?.plan?.trigger.runId, "interrupted-run");
});

test("a candidate verified against different expected values cannot become the job result", async t => {
  const fx = await fixture(t); await fx.recipe();
  const result = await workToolLearningPipeline({ ...fx.input, services: { ...fx.input.services,
    evolve: (frozen, signal, feedback, admission) => fx.input.services.evolve({ ...frozen, evidence: frozen.evidence.map(sample => sample.sampleId === "v" ? { ...sample, expected: { kind: "value", value: 99 } } : sample) }, signal, feedback, admission) } });
  assert.ok(result.ok); assert.equal(result.results[0]?.code, "candidate_recipe_binding_mismatch");
  assert.equal((await fx.state()).jobs[0]?.state, "running");
  assert.equal((await fx.state()).activations.length, 0);
});

test("withdrawn verification recipes cannot feed subsequent generation", async t => {
  const fx = await fixture(t), recipe = await fx.recipe(); assert.ok(recipe.ok);
  await withBoardWriter(fx.root, store => store.apply({ type: "reject", commandId: "withdraw-recipe", issuedAt: plan.createdAt,
    proposalId: `proposal:${recipe.versionId}`, reason: "caller withdrew this oracle" }));
  await workToolLearningPipeline(fx.input);
  assert.equal(fx.counts().generations, 0); assert.equal((await fx.state()).jobs[0]?.state, "waiting_evidence");
});

test("ending a running job cancels its worker signal and refuses a later candidate archive", async t => {
  const fx = await fixture(t), admission = { jobId: fx.jobId, attempt: 1 };
  await withBoardWriter(fx.root, store => store.apply({ type: "start_job", commandId: `${fx.jobId}:start:1`, issuedAt: plan.createdAt, jobId: fx.jobId }));
  const monitor = monitorToolJob({ boardRoot: fx.root, ...admission, signal: fx.input.signal }); t.after(monitor.close);
  await monitor.check(); assert.equal(monitor.signal.aborted, false);
  const generated = await fx.input.services.evolve({ ...request, requestId: `${fx.jobId}:1` }, fx.input.signal, "test", admission); assert.equal(generated.kind, "candidate");
  assert.ok((await expireToolLearningJob(fx.root, fx.jobId, plan.createdAt)).ok);
  await monitor.check(); assert.equal(monitor.signal.aborted, true);
  const before = await fx.state();
  if (generated.kind === "candidate") {
    const refused = await createToolEvolutionArchive(fx.root, { jobAdmission: admission }).save({ ...generated.artifact, generatedAt: new Date(1).toISOString() });
    assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.code, "job_not_running");
  }
  assert.equal((await fx.state()).sequence, before.sequence);
});

test("malformed persisted tool job identities cannot dispatch or become a truthful empty inventory", async t => {
  const fx = await fixture(t);
  await withBoardWriter(fx.root, store => store.apply({ type: "enqueue_job", commandId: "malformed-tool-namespace", issuedAt: plan.createdAt,
    job: { jobId: "tool-learning_v1_bad", observationId: "bad", domain: "tool", scope: plan.scope, maxAttempts: 3, dedupeKey: "bad" } }));
  const inventory = await readToolLearningPipeline(fx.root); assert.equal(inventory.ok, false);
  const work = await workToolLearningPipeline(fx.input); assert.equal(work.ok, false);
  assert.deepEqual(fx.counts(), { searches: 0, generations: 0 });
});

test("waiting evidence without its required result cannot silently requeue and spend budget", async t => {
  const fx = await fixture(t); await fx.recipe();
  await withBoardWriter(fx.root, async store => {
    await store.apply({ type: "start_job", commandId: "missing-result:start", issuedAt: plan.createdAt, jobId: fx.jobId });
    return store.apply({ type: "complete_job", commandId: "missing-result:complete", issuedAt: plan.createdAt, jobId: fx.jobId, next: "waiting_evidence" });
  });
  const status = await readToolLearningPipeline(fx.root); assert.equal(status.ok, false);
  if (!status.ok) assert.equal(status.code, "invalid_pipeline_result");
  const work = await workToolLearningPipeline(fx.input); assert.ok(work.ok); assert.equal(work.results[0]?.code, "invalid_pipeline_result");
  assert.deepEqual(fx.counts(), { searches: 0, generations: 0 });
});

test("failed generation preserves bounded checker diagnostics while excluding raw error messages", async t => {
  const fx = await fixture(t); await fx.recipe();
  const verification = { verdict: "fail" as const, candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence),
    checks: request.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role,
      outcome: sample.role === "variation" ? "wrong_result" as const : "passed" as const, detail: "TEST ONLY" })) };
  await workToolLearningPipeline({ ...fx.input, services: { ...fx.input.services, evolve: async () => ({ kind: "failed", code: "candidate_rejected",
    rejectionCode: "sample_checks_failed", message: "TEST_SECRET_MESSAGE", attempts: 1, verification }) } });
  const status = await readToolLearningPipeline(fx.root); assert.ok(status.ok);
  assert.deepEqual(status.jobs[0]?.result?.generation?.verification, verification);
  assert.equal(status.jobs[0]?.result?.generation?.rejectionCode, "sample_checks_failed");
  assert.equal(JSON.stringify(status).includes("TEST_SECRET_MESSAGE"), false);
});

test("automatic frequency admission uses the existing rule under the Board writer; explicit queueing remains distinct", async t => {
  const fx = await fixture(t);
  for (const key of ["second", "third"]) assert.ok((await enqueueToolLearningPlan(fx.root, { ...plan, trigger: { ...plan.trigger, runId: key, proposalKey: key } })).ok);
  const refused = await enqueueToolLearningPlan(fx.root, { ...plan, trigger: { ...plan.trigger, runId: "fourth", proposalKey: "fourth" } });
  assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.code, "automatic_proposal_daily_limit");
  assert.equal((await fx.state()).jobs.length, 3);
  assert.ok((await enqueueToolLearningPlan(fx.root, { ...plan, trigger: { ...plan.trigger, runId: "explicit", proposalKey: "explicit", action: "user_requested" } })).ok);
  assert.equal((await fx.state()).jobs.length, 4);
});

test("cross-workspace automatic replay cannot bypass the existing cooldown", async t => {
  const fx = await fixture(t);
  const refused = await enqueueToolLearningPlan(fx.root, { ...plan, scope: "other-workspace", trigger: { ...plan.trigger, runId: "another-run" } });
  assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.code, "automatic_proposal_cooldown");
});
