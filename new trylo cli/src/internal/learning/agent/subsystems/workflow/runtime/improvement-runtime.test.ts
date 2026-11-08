import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { createFileWorkflowImprovementRuntime } from "../adapters/improvement-composition.js";
import { deferred, deferredImprovementModel, resultRecord, runtimeFixture, withImprovementBoard } from "../testing/improvement-runtime-fixtures.js";
import { record } from "../domain/trace-parse.js";
import { createWorkflowImprovementRuntime } from "./improvement-runtime.js";
import { commitWorkflowImprovementRecord } from "../adapters/improvement-board.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import { compileWorkflowImprovement } from "../improvement/compile.js";

test("a compatible complete workflow above 8KB reaches the frozen handoff without an invented dispatch cap", async () => withImprovementBoard(async boardRoot => {
  const source = searchImprovementFixture(), proposal = { ...source.proposal, procedure: { ...source.proposal.procedure,
    steps: source.proposal.procedure.steps.map(step => ({ ...step,
      action: step.action + " Inspect the exact current contract, input and dependency output before selecting the next action.".repeat(18),
      verify: step.verify + " Retain original evidence and distinguish expected behavior from observed results.".repeat(10) })) } };
  const fx = runtimeFixture(boardRoot, { newModel: () => ({ async propose() { return { ok: true, value: proposal }; },
    usage: () => ({ calls: 1, tokens: 100, observedTokens: 100, uncertain: false }) }) });

  try {
    resultRecord(await fx.runtime.opportunity("learn-complete-procedure", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    const view = await fx.ports.store.read();
    assert.ok(view.ok);
    const candidate = view.value.versions[0];
    assert.ok(candidate);
    const complete = compileWorkflowImprovement(candidate.artifact, candidate.artifact.opportunity.task, 32768);
    assert.ok(complete.ok);
    assert.ok(Buffer.byteLength(complete.value) > 8192);
    const explicit = compileWorkflowImprovement(candidate.artifact, candidate.artifact.opportunity.task, 8192);

    assert.equal(explicit.ok, false, "A caller's explicit resource limit is still enforced");
    const frozen = resultRecord(await fx.runtime.context("adopt-complete-procedure", { task: fx.fixture.opportunity.task, boundary: "before next source read" }));

    assert.equal(frozen.status, "frozen");
    assert.equal(typeof frozen.guidance, "string");
    const deliveredSteps = String(frozen.guidance).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));

    assert.deepEqual(deliveredSteps, proposal.procedure.steps, "Every complete action/check/dependency survives delivery");
    const after = await fx.ports.store.read();
    assert.ok(after.ok);
    assert.equal(after.value.uses.length, 1);
    assert.equal(after.value.feedback.length, 0);
  } finally { await fx.runtime.close(); }
}));

test("central scope differs from immutable asset scope throughout learning, publication and adoption", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot, { centralScope: "D:/project/central-workspace" });
  try {
    resultRecord(await fx.runtime.opportunity("learn-split-scope", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    const view = await fx.ports.store.read();
    assert.ok(view.ok);
    assert.equal(view.value.versions[0]?.status, "eligible");
    assert.equal(view.value.recentIssues[0]?.proposalState, "succeeded");
    const adopted = resultRecord(await fx.runtime.context("adopt-split-scope", { task: fx.fixture.opportunity.task, boundary: "next operation" }));

    assert.equal(adopted.status, "frozen");
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.centralLearningGrants?.[0]?.scope, "D:/project/central-workspace");
    assert.equal(loaded.state.learningIssues?.[0]?.scope, "D:/project/central-workspace");
    assert.ok(loaded.state.assets.every(asset => asset.scope === fx.fixture.opportunity.task.scope));
  } finally { await fx.runtime.close(); }
}));

test("writer-bound governance rejects a source withdrawn after context read without exposing cached guidance", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot), privateCheck = "withdrawn exactCheck must never be fielded";

  resultRecord(await fx.runtime.opportunity("initial", fx.fixture.opportunity));
  await fx.runtime.settlePending();
  const source = await commitWorkflowImprovementRecord(boardRoot, { type: "workflow_improvement_opportunity", schemaVersion: 1,
    opportunity: { ...fx.fixture.opportunity, opportunityId: "host:governance", issueKey: "separate-host-governance", problem: privateCheck },
    evidence: fx.fixture.evidence }, new Date(fx.options.now()).toISOString());
  assert.ok(source.ok);
  const runtime = createWorkflowImprovementRuntime({ ...fx.options, ...fx.ports,
    dispatchPolicy: (_task, visibility) => ({ ok: true, value: visibility?.[source.value.versionId] === "available"
      ? { kind: "allowed", guidance: privateCheck } : { kind: "deferred", reason: "source_withdrawn", sourceRefs: [] } }),
    store: { ...fx.ports.store, async adopt(use, issuedAt, signal, policy) {
      const withdrawn = await withBoardWriter(boardRoot, store => store.apply({ type: "tombstone", commandId: "withdraw-during-handoff",
        issuedAt, entityType: "asset", entityId: source.value.versionId, reason: "Withdraw the host governance source before writer admission" }));
      assert.ok(withdrawn.ok);
      return fx.ports.store.adopt(use, issuedAt, signal, policy);
    } } });

  try {
    const result = await runtime.context("racing-handoff", { task: fx.fixture.opportunity.task, boundary: "before next operation" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "workflow_improvement_dispatch_deferred");
    assert.equal(JSON.stringify(result).includes(privateCheck), false);
    const view = await fx.ports.store.read();
    assert.ok(view.ok);
    assert.equal(view.value.uses.length, 0);
  } finally {
    await runtime.close();
    await fx.runtime.close();
  }
}));

test("opportunity returns while its paid worker is pending, and only a committed central result becomes adoptable", async () => withImprovementBoard(async boardRoot => {
  const model = deferredImprovementModel(), fx = runtimeFixture(boardRoot, { newModel: () => model.port });
  try {
    const queued = resultRecord(await fx.runtime.opportunity("nominate", fx.fixture.opportunity));

    assert.equal(queued.status, "queued");
    await model.started.promise;
    const pending = resultRecord(await fx.runtime.context("during-business", {}));

    assert.equal(pending.status, "inventory");
    const before = await fx.ports.store.read();
    assert.ok(before.ok);
    assert.equal(before.value.versions.length, 0);
    assert.equal(before.value.recentIssues[0]?.proposalState, "running");
    model.response.resolve({ ok: true, value: fx.fixture.proposal });
    await fx.runtime.settlePending();
    const adopted = resultRecord(await fx.runtime.context("handoff", { task: fx.fixture.opportunity.task, boundary: "owner discovered; before scoped search" }));

    assert.equal(adopted.status, "frozen");
    assert.match(String(adopted.guidance), /Search independent symbols together/);
    assert.ok(record(adopted.reputation));
    assert.equal(adopted.reputation.standing, "untried");
    const board = await createBoardReader(boardRoot).load();
    assert.ok(board.ok);
    assert.equal(board.state.centralLearningGrants?.[0]?.domain, "workflow");
    assert.equal(centralLearningSpent(board.state.centralLearningGrants![0]!).tokens, 100);
    assert.equal(board.state.activations.length, 0, "a proposed procedure does not create a quality/permission activation");
  } finally { await fx.runtime.close(); }
}));

test("close cancels an abort-ignoring model, retains unknown usage, and late output cannot publish", async () => withImprovementBoard(async boardRoot => {
  const model = deferredImprovementModel(), fx = runtimeFixture(boardRoot, { newModel: () => model.port });

  resultRecord(await fx.runtime.opportunity("cancel-research", fx.fixture.opportunity));
  await model.started.promise;
  await fx.runtime.close();
  let loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.jobs.find(item => item.domain === "workflow")?.state, "cancelled");
  const grant = loaded.state.centralLearningGrants![0]!;

  assert.equal(grant.reservations[0]?.usage?.kind, "unknown");
  assert.equal(centralLearningSpent(grant).tokens, fx.options.allowance);
  model.response.resolve({ ok: true, value: fx.fixture.proposal });
  await model.response.promise;
  await Promise.resolve();
  const view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.versions.length, 0);
  const second = createFileWorkflowImprovementRuntime({ ...fx.options, budgetId: "budget:fresh-run" });

  try {
    const resume = await second.opportunity("resume-unknown", { resumeOpportunityId: view.value.opportunities[0]!.versionId });
    assert.equal(resume.ok, false);
    if (!resume.ok) assert.equal(resume.code, "workflow_explicit_grant_required");
  } finally { await second.close(); }

  loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.centralLearningGrants?.length, 1, "a new run must not automatically replay an unknown request");
}));

test("renaming a problem with the same evidence cannot buy another proposal", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot);
  try {
    resultRecord(await fx.runtime.opportunity("first", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    const renamed = await fx.runtime.opportunity("rename", { ...fx.fixture.opportunity, issueKey: "same-search-with-a-new-name" });
    assert.equal(renamed.ok, false);
    if (!renamed.ok) assert.equal(renamed.code, "workflow_new_evidence_required");
    assert.equal(fx.calls(), 1);
  } finally { await fx.runtime.close(); }
}));

test("model feedback cannot invent quality or cite pre-adoption receipts", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot);
  try {
    resultRecord(await fx.runtime.opportunity("learn", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    const adopted = resultRecord(await fx.runtime.context("use", { task: fx.fixture.opportunity.task, boundary: "next phase" }));

    assert.ok(record(adopted.use));
    const useId = adopted.use.useId;
    const raw = { useId, exposure: "reported_used", evidenceRefs: ["receipt:foreground"], followedStepIds: ["confirm-owner", "scoped-search"], explanation: "Observed the current result." };

    fx.state.snapshot = { ...fx.state.snapshot, executionId: "session:contract/turn:foreground", watermark: 102,
      receipts: [{ ref: "receipt:foreground", sequence: 99, executionId: "session:contract/turn:foreground", toolCallId: "check", tool: "run_shell", outcome: "succeeded", checkStatus: "passed" }] };
    const old = await fx.runtime.feedback("pre-use", raw);
    assert.equal(old.ok, false);
    if (!old.ok) assert.equal(old.code, "workflow_feedback_unbound");

    fx.state.snapshot = { ...fx.state.snapshot, receipts: fx.state.snapshot.receipts.map(item => ({ ...item, sequence: 101 })) };
    const forged = await fx.runtime.feedback("self-admit", { ...raw, quality: "passed", userAssessment: { judgment: "helped", evidenceRef: "invented-user" } });

    assert.equal(forged.ok, false);
    const actual = resultRecord(await fx.runtime.feedback("actual-report", raw));
    assert.ok(record(actual.feedback));
    assert.equal(actual.feedback.quality, "unknown");
    assert.equal(actual.feedback.exposure, "reported_used");
    assert.ok(record(actual.reputation));
    assert.equal(actual.reputation.qualityPasses, 0);
    assert.equal(actual.reputation.unknown, 1);
  } finally { await fx.runtime.close(); }
}));

test("a run's central allowance refunds only known usage and admits at most four actual proposal attempts", async () => withImprovementBoard(async boardRoot => {
  let calls = 0;
  const fx = runtimeFixture(boardRoot, { newModel: () => {
    let sent = 0;
    return { async propose() {
      calls += 1;
      sent += 1;
      return { ok: false as const, code: "learning_abstained", message: "No justified candidate" };
    },
      usage: () => ({ calls: sent, tokens: sent * 100, observedTokens: sent * 100, uncertain: false }) };
  } });

  try {
    for (let index = 0; index < 5; index += 1) {
      const ref = `receipt:new-observation-${index}`;
      fx.state.snapshot = { ...fx.state.snapshot, evidence: [...fx.state.snapshot.evidence,
        { ref, kind: "rework", summary: `A new real repeated-search observation ${index}.`, executionId: `session:contract/turn:${index}` }] };
      const result = await fx.runtime.opportunity(`attempt-${index}`, { ...fx.fixture.opportunity, evidenceRefs: ["receipt:search-1", ref] });
      if (index < 4) {
        assert.equal(result.ok, true);
        await fx.runtime.settlePending();
      }
      else {
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, "learning_call_limit");
      }
    }

    assert.equal(calls, 4);
    const board = await createBoardReader(boardRoot).load();
    assert.ok(board.ok);
    assert.deepEqual(board.state.centralLearningGrants?.map(item => item.allowance.maxTokens), [16000, 15900, 15800, 15700]);
    assert.equal(board.state.centralLearningGrants?.reduce((sum, item) => sum + centralLearningSpent(item).tokens, 0), 400);
  } finally { await fx.runtime.close(); }
}));

test("close during evidence read prevents a later funding request", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot), reading = deferred<void>(), release = deferred<void>();
  const runtime = createWorkflowImprovementRuntime({ ...fx.options, ...fx.ports, store: { ...fx.ports.store,
    async read() {
      reading.resolve();
      await release.promise;
      return fx.ports.store.read();
    } } });
  const opportunity = runtime.opportunity("late-read", fx.fixture.opportunity);

  await reading.promise;
  await runtime.close();
  release.resolve();
  const result = await opportunity;

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "workflow_runtime_closed");

  const board = await createBoardReader(boardRoot).load();
  assert.ok(board.ok);
  assert.equal(board.state.jobs.length, 0);
  assert.equal(fx.calls(), 0);
  await fx.runtime.close();
}));

test("a late funding acknowledgement after close cannot spawn, and an unreserved opportunity can resume in a new run", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot), funded = deferred<void>(), release = deferred<void>();
  const runtime = createWorkflowImprovementRuntime({ ...fx.options, ...fx.ports, funding: { ...fx.ports.funding,
    async fund(input) {
      const result = await fx.ports.funding.fund(input);
      funded.resolve();
      await release.promise;
      return result;
    } } });
  const opportunity = runtime.opportunity("late-fund", fx.fixture.opportunity);

  await funded.promise;
  await runtime.close();
  release.resolve();
  const result = await opportunity;

  assert.equal(result.ok, false);
  assert.equal(fx.calls(), 0);
  let view = await fx.ports.store.read();
  assert.ok(view.ok);
  assert.equal(view.value.recentIssues[0]?.proposalState, "cancelled");
  const next = createFileWorkflowImprovementRuntime({ ...fx.options, budgetId: "budget:new-unsent-run" });

  try {
    resultRecord(await next.opportunity("resume-unsent", { resumeOpportunityId: view.value.opportunities[0]!.versionId }));
    await next.settlePending();
    view = await fx.ports.store.read();
    assert.ok(view.ok);
    assert.equal(view.value.versions[0]?.status, "eligible");
    assert.equal(fx.calls(), 1);
    const board = await createBoardReader(boardRoot).load();
    assert.ok(board.ok);
    assert.equal(board.state.centralLearningGrants?.[0]?.reservations.length, 0);
    assert.equal(board.state.centralLearningGrants?.length, 2);
  } finally {
    await next.close();
    await fx.runtime.close();
  }
}));

test("a correction committed after context selection is rechecked atomically before adoption", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot);

  resultRecord(await fx.runtime.opportunity("initial", fx.fixture.opportunity));
  await fx.runtime.settlePending();
  const runtime = createWorkflowImprovementRuntime({ ...fx.options, ...fx.ports, store: { ...fx.ports.store,
    async adopt(use, issuedAt, signal) {
      const correctionRef = "user:concurrent-correction";
      const saved = await commitWorkflowImprovementRecord(boardRoot, { type: "workflow_improvement_opportunity", schemaVersion: 1,
        opportunity: { ...fx.fixture.opportunity, opportunityId: "opportunity:concurrent-correction", trigger: "user_correction",
          evidenceRefs: [correctionRef], problem: "The user requires a different recovery before reusing this procedure." },
        evidence: [{ ref: correctionRef, kind: "user_correction", summary: "The user explicitly requires a different recovery for this case." }],
      }, issuedAt);
      assert.ok(saved.ok);

      return fx.ports.store.adopt(use, issuedAt, signal);
    } } });

  try {
    const result = await runtime.context("handoff-after-correction", { task: fx.fixture.opportunity.task, boundary: "next action" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "workflow_improvement_handoff_stale");
    const view = await fx.ports.store.read();
    assert.ok(view.ok);
    assert.equal(view.value.uses.length, 0);
  } finally {
    await runtime.close();
    await fx.runtime.close();
  }
}));

test("reused model call IDs in a later actual turn cannot alias frozen uses or feedback", async () => withImprovementBoard(async boardRoot => {
  const fx = runtimeFixture(boardRoot);
  try {
    resultRecord(await fx.runtime.opportunity("learn", fx.fixture.opportunity));
    await fx.runtime.settlePending();
    const ids: string[] = [];

    for (const [index, turn] of ["first", "second"].entries()) {
      const watermark = 200 + index * 20;

      fx.state.snapshot = { ...fx.state.snapshot, executionId: `session:contract/turn:${turn}`, watermark };
      const frozen = resultRecord(await fx.runtime.context("same-context-id", { task: fx.fixture.opportunity.task, boundary: "before scoped discovery" }));

      assert.ok(record(frozen.use));
      ids.push(String(frozen.use.useId));
      const ref = `receipt:${turn}`;

      fx.state.snapshot = { ...fx.state.snapshot, watermark: watermark + 10, receipts: [{ ref, sequence: watermark + 5,
        executionId: `session:contract/turn:${turn}`, toolCallId: "same-read-id", tool: "read_file", outcome: "succeeded" }] };
      resultRecord(await fx.runtime.feedback("same-feedback-id", { useId: frozen.use.useId, exposure: "reported_used", evidenceRefs: [ref],
        followedStepIds: ["confirm-owner"], explanation: "Actual receipt in this execution; effectiveness is unknown." }));
    }

    assert.notEqual(ids[0], ids[1]);
    const view = await fx.ports.store.read();
    assert.ok(view.ok);
    assert.equal(view.value.uses.length, 2);
    assert.equal(new Set(view.value.feedback.map(item => item.feedbackId)).size, 2);
    assert.equal(new Set(view.value.feedback.map(item => item.executionId)).size, 2);
  } finally { await fx.runtime.close(); }
}));
