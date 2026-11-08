import assert from "node:assert/strict";
import test from "node:test";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { enqueueToolLearningPlan, nextToolLearningDispatch, readToolLearningPipeline, registerToolLearningRecipe } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { createToolLearningFunding } from "./learning-funding.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { TOOL_CYCLE_DEADLINE } from "../domain/evolution/cycle-deadline.js";

/** Real Board/grant/claim, controlled source response; no model or native execution. */
for (const stop of [TOOL_CYCLE_DEADLINE, "user_requested_stop"] as const) {
  test(`${stop} preserves its distinct lifecycle and only an explicit time-slice resume spends the same grant`, async t => {
    const fx = await seedToolProduction(t), controller = new AbortController();
    const queued = await enqueueToolLearningPlan(fx.root, { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double",
      createdAt: productionTestTime, trigger: { action: "user_requested", runId: stop, proposalKey: stop, evidenceRefs: [] } });

    assert.ok(queued.ok);
    const registered = await registerToolLearningRecipe(fx.root, { type: "tool_learning_recipe", schemaVersion: 1, automation: "after_turn",
      request: { ...fx.plan.checks, requestId: "TEST ONLY unchanged frozen checks", operation: "create" } }, productionTestTime);

    assert.ok(registered.ok);
    const funding = createToolLearningFunding({ boardRoot: fx.root, scope: "test", now: () => 0 });
    let sourceCalls = 0;
    const services: ToolPipelineServices = { executionAuthorized: true, allowance: plan => funding.allowance(plan), releaseAllowance: () => funding.release(),
      search: async () => ({ status: "complete", candidates: [], failures: [] }),
      evolve: async request => {
        assert.deepEqual(request.evidence, fx.plan.checks.evidence);
        const reservationId = `controlled-source-${++sourceCalls}`;
        assert.ok((await funding.reserve(reservationId, 512)).ok);
        assert.ok((await funding.settle(reservationId, { kind: "reported", inputTokens: 50, outputTokens: 50, totalTokens: 100, model: "TEST ONLY" })).ok);
        if (sourceCalls === 1) {
          controller.abort(stop);
          return { kind: "cancelled", attempts: 1 };
        }
        return { kind: "failed", code: "parent_source_evidence_required", message: "TEST ONLY bounded continuation", attempts: 1 };
      } };
    const input = { boardRoot: fx.root, scope: "test", now: () => 0, services, mode: "after_turn" as const, jobIds: [queued.jobId] };
    const first = await workToolLearningPipeline({ ...input, signal: controller.signal });
    assert.ok(first.ok);
    assert.equal(first.cancelled, stop !== TOOL_CYCLE_DEADLINE);
    const state = await readToolLearningPipeline(fx.root);
    assert.ok(state.ok);
    const job = state.jobs.find(row => row.jobId === queued.jobId)!;

    assert.equal(job.state, stop === TOOL_CYCLE_DEADLINE ? "waiting_evidence" : "cancelled");
    assert.equal(job.result?.code, stop === TOOL_CYCLE_DEADLINE ? TOOL_CYCLE_DEADLINE : "cancelled");
    assert.equal(job.result?.recipeVersionId, registered.versionId);
    const ready = await nextToolLearningDispatch(fx.root, "test", true, [queued.jobId]);
    assert.ok(ready.ok);
    assert.equal(ready.jobId, undefined);
    await workToolLearningPipeline({ ...input, signal: new AbortController().signal });
    const { jobIds: _selectedJobIds, ...broadInput } = input;

    await workToolLearningPipeline({ ...broadInput, mode: "manual", signal: new AbortController().signal });
    assert.equal(sourceCalls, 1, "an unchanged time slice never automatically retries, and broad manual work does not count as exact resume");
    await workToolLearningPipeline({ ...input, mode: "manual", signal: new AbortController().signal });
    assert.equal(sourceCalls, stop === TOOL_CYCLE_DEADLINE ? 2 : 1, "a user stop never becomes a resumable internal boundary");
    const loaded = await createBoardReader(fx.root).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.centralLearningGrants?.length, 1);
    assert.equal(centralLearningSpent(loaded.state.centralLearningGrants![0]!).calls, sourceCalls);
    const current = loaded.state.jobs.find(row => row.jobId === queued.jobId)!;

    assert.equal(current.attempt, sourceCalls);
    assert.equal(current.maxAttempts, 3);
  });
}
