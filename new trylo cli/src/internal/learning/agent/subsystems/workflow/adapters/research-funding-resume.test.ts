import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent, type CoordinationAction } from "../../../../control/coordination-contract.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import { createWorkflowImprovementFunding } from "./improvement-funding.js";
import { fileWorkflowImprovementPorts, type FileWorkflowImprovementOptions } from "./improvement-composition.js";
import type { WorkflowImprovementFunding } from "../runtime/improvement-contracts.js";

async function fixture(t: TestContext, managed = false) {
  const boardRoot = await mkdtemp(path.join(tmpdir(), "workflow-research-funding-resume-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), path.resolve(tmpdir()));
    assert.ok(path.basename(boardRoot).startsWith("workflow-research-funding-resume-"));
    await rm(boardRoot, { recursive: true, force: true });
  });
  const source = searchImprovementFixture();
  const record = { type: "workflow_improvement_opportunity" as const, schemaVersion: 1 as const,
    opportunity: source.opportunity, evidence: source.evidence };
  const options: FileWorkflowImprovementOptions = { boardRoot, scope: source.opportunity.task.scope,
    centralScope: "D:/workspace/research-funding-resume", budgetId: "original-run", sessionId: "session:funding-resume",
    allowance: 16_000, now: () => 1_793_761_200_000, publicData: () => true, warn: () => {},
    readEvidence: async () => ({ ok: true, value: { evidence: source.evidence, receipts: [], watermark: 0,
      executionId: "session:funding-resume/turn:original" } }),
    newModel: () => ({ propose: async () => ({ ok: true, value: source.proposal }),
      usage: () => ({ calls: 0, tokens: 0, observedTokens: 0, uncertain: false }) }) };
  let command = 0;
  const read = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const act = async (action: CoordinationAction) => {
    const applied = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning",
      commandId: `research-funding-resume:${++command}`, issuedAt: new Date(options.now()).toISOString(), action }));
    assert.ok(applied.ok, JSON.stringify(applied));
    return applied.state;
  };
  let funding = createWorkflowImprovementFunding({ ...options, research: true, researchOwnerId: "worker:original" });
  let funded: WorkflowImprovementFunding;

  if (managed) {
    const prepared = await funding.prepare(record);
    assert.ok(prepared.ok);
    await act({ kind: "open_budget", expectedSequence: (await read()).sequence,
      budget: { schemaVersion: 1, budgetId: "managed-root:research-resume", scope: options.centralScope!,
        unit: "total_model_tokens", limits: { tokens: 32_000, calls: 8, steps: 8 }, authorizationRef: "host:managed-root" } });
    const state = await act({ kind: "fund", domain: "workflow", issueId: prepared.value.issueId,
      expectedRevision: prepared.value.expectedIssueRevision, expectedSequence: (await read()).sequence,
      grantId: prepared.value.grantId, allowance: prepared.value.allowance, budgetId: "managed-root:research-resume",
      authorizationRef: "host:managed-grant", planRef: "plan:managed-grant" });
    const grant = state.centralLearningGrants![0]!;

    funded = { grantId: grant.grantId, jobId: grant.jobId, inputVersionId: prepared.value.inputVersionId, state: "queued", resultRefs: [] };
    funding = createWorkflowImprovementFunding({ ...options, research: true, researchOwnerId: "worker:original",
      binding: { grantId: funded.grantId, inputVersionId: funded.inputVersionId } });
  } else {
    const result = await funding.fund(record);
    assert.ok(result.ok);
    funded = result.value;
  }

  return { source, record, options, funding, funded, read, act, store: fileWorkflowImprovementPorts(options).store };
}

test("independent research resumes the unique original grant across run budget IDs without renewing its lifetime allowance", async t => {
  const fx = await fixture(t);
  assert.ok(fx.funding.research);
  const reserved = await fx.funding.research.reserve(fx.funded, { stepId: "wf-research:0" });
  assert.ok(reserved.ok);
  assert.ok((await fx.funding.settle(reserved.value, { kind: "reported", totalTokens: 500 })).ok);
  assert.ok(fx.store.saveResearch);
  const checkpoint = await fx.store.saveResearch({ type: "workflow_improvement_research", schemaVersion: 1,
    scope: fx.options.scope, grantId: fx.funded.grantId, inputVersionId: fx.funded.inputVersionId,
    step: 0, reservationId: reserved.value.reservationId, contextRef: "workflow-research-context:funding-fixture",
    status: "continue", observation: { kind: "material_read", evidenceRefs: [fx.source.evidence[0]!.ref] } },
  { reservation: reserved.value, signal: new AbortController().signal, now: fx.options.now });
  assert.ok(checkpoint.ok);
  assert.ok((await fx.funding.finish(reserved.value, { kind: "yielded", reason: "original_research_segment_finished" })).ok);
  const before = await fx.read(), originalAllowance = before.centralLearningGrants![0]!.allowance;
  const resumed = createWorkflowImprovementFunding({ ...fx.options, budgetId: "later-run", allowance: 100_000,
    research: true, researchOwnerId: "worker:later-run" });
  assert.ok(resumed.research);
  assert.ok((await resumed.prepareResume(fx.funded.inputVersionId)).ok);
  const retained = await resumed.fund(fx.record);
  assert.ok(retained.ok, JSON.stringify(retained));
  assert.equal(retained.value.state, "existing");
  assert.equal(retained.value.grantId, fx.funded.grantId);
  const replay = await fx.read();
  assert.equal(replay.sequence, before.sequence);
  assert.equal(replay.centralLearningGrants!.length, 1);
  assert.deepEqual(replay.centralLearningGrants![0]!.allowance, originalAllowance);
  const next = await resumed.research.reserve(retained.value, { stepId: "wf-research:1" });
  assert.ok(next.ok, JSON.stringify(next));
  assert.equal(next.value.grantId, fx.funded.grantId);
  assert.equal(next.value.maxTokens, 15_500);
  assert.deepEqual(centralLearningSpent((await fx.read()).centralLearningGrants![0]!), { tokens: 16_000, calls: 2, steps: 2 });
});

test("an independent resume entrypoint cannot consume or replace a centrally managed grant", async t => {
  const fx = await fixture(t, true);
  const independent = createWorkflowImprovementFunding({ ...fx.options, budgetId: "another-independent-run", research: true });

  assert.ok(independent.research);
  const before = await fx.read();
  const retained = await independent.fund(fx.record);
  assert.ok(!retained.ok);
  assert.equal(retained.code, "workflow_managed_grant_requires_central_dispatch");
  const resumed = await independent.prepareResume(fx.funded.inputVersionId);
  assert.ok(!resumed.ok);
  assert.equal(resumed.code, "workflow_managed_grant_requires_central_dispatch");
  const reserved = await independent.research.reserve(fx.funded, { stepId: "wf-research:0" });
  assert.ok(!reserved.ok);
  assert.equal(reserved.code, "workflow_managed_grant_requires_central_dispatch");
  const after = await fx.read();
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.equal(after.centralLearningGrants![0]!.reservations.length, 0);
});

test("independent prepareResume rejects unknown sends and old one-shot requests without confirmed research checkpoints", async t => {
  for (const scenario of ["unknown_research", "old_one_shot"] as const) {
    await t.test(scenario, async subtest => {
      const fx = await fixture(subtest);
      let funding = fx.funding;

      if (scenario === "old_one_shot") funding = createWorkflowImprovementFunding({ ...fx.options, research: false });

      const reserved = scenario === "unknown_research"
        ? await funding.research!.reserve(fx.funded, { stepId: "wf-research:0" }) : await funding.reserve(fx.funded);

      assert.ok(reserved.ok);
      assert.ok((await funding.settle(reserved.value, scenario === "unknown_research"
        ? { kind: "unknown", reason: "response_not_confirmed" } : { kind: "reported", totalTokens: 500 })).ok);
      assert.ok((await funding.finish(reserved.value, { kind: "yielded", reason: "inspection_required" })).ok);
      const continued = createWorkflowImprovementFunding({ ...fx.options, budgetId: "later-run", research: true });
      const before = await fx.read();
      const result = await continued.prepareResume(fx.funded.inputVersionId);
      assert.ok(!result.ok);
      assert.equal(result.code, "workflow_research_sent_step_requires_inspection");
      const after = await fx.read();
      assert.equal(after.sequence, before.sequence);
      assert.equal(after.centralLearningGrants!.length, 1);
      assert.equal(after.centralLearningGrants![0]!.reservations.length, 1);
    });
  }
});

test("a fresh explicit run may replace a never-sent closed grant but cannot refresh a source that already sent a request", async t => {
  for (const scenario of ["never_sent", "already_sent"] as const) {
    await t.test(scenario, async subtest => {
      const fx = await fixture(subtest);

      if (scenario === "already_sent") {
        assert.ok(fx.funding.research);
        const reserved = await fx.funding.research.reserve(fx.funded, { stepId: "wf-research:0" });
        assert.ok(reserved.ok);
        assert.ok((await fx.funding.settle(reserved.value, { kind: "reported", totalTokens: 500 })).ok);
      }

      assert.ok((await fx.funding.stop(fx.funded)).ok);
      const before = await fx.read();
      assert.equal(before.centralLearningGrants![0]!.status, "closed");
      const next = createWorkflowImprovementFunding({ ...fx.options, budgetId: "fresh-explicit-run", allowance: 10_000,
        research: true, researchOwnerId: "worker:fresh-explicit-run" });
      const funded = await next.fund(fx.record);

      if (scenario === "never_sent") {
        assert.ok(funded.ok, JSON.stringify(funded));
        assert.equal(funded.value.state, "queued");
        assert.notEqual(funded.value.grantId, fx.funded.grantId);
        const after = await fx.read();
        assert.equal(after.centralLearningGrants!.length, 2);
        assert.equal(after.centralLearningGrants![0]!.status, "closed");
        assert.equal(after.centralLearningGrants![0]!.reservations.length, 0);
        assert.equal(after.centralLearningGrants![1]!.allowance.maxTokens, 10_000);
      } else {
        assert.ok(!funded.ok);
        assert.equal(funded.code, "workflow_explicit_grant_required");
        const after = await fx.read();
        assert.equal(after.sequence, before.sequence);
        assert.equal(after.centralLearningGrants!.length, 1);
        assert.equal(after.centralLearningGrants![0]!.reservations.length, 1);
      }
    });
  }
});
