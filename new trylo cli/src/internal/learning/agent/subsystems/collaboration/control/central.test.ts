import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../../../control/reducer.js";
import { emptyBoardState, normalizeBoardState } from "../../../../control/state.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { BoardStore } from "../../../../control/store-port.js";
import { centralLearningSpent, type CentralLearningAllowance } from "../../../../control/coordination-contract.js";
import { isCentralLearningAllowance } from "../../../../control/coordination-parse.js";
import { createCollaborationControl } from "./central.js";
import type { CollaborationCentralWorker } from "./contracts.js";

const NOW = "2026-11-03T12:00:00.000Z", scope = "workspace:central";
const allowance: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 3, maxSteps: 3, maxPromptChars: 1200 };
const report = (reportId: string, memberId = "worker") => ({ reportId, source: { teamRunId: "team", taskId: "task", memberId },
  facts: ["The upstream reference is missing from the current handoff."], hypotheses: ["A coordination omission is one possible cause."], evidenceRefs: [] });

function memory() {
  let state = emptyBoardState();
  const commands: BoardCommand[] = [];
  const board: Pick<BoardStore, "load" | "apply"> = { load: async () => ({ ok: true, state, generation: 0 }), apply: async command => {
    const result = reduce(state, command);
    if (result.ok && !result.idempotent) {
      state = result.state;
      commands.push(command);
    }
    return result;
  } };

  return { board, state: () => state, reopen() { state = commands.reduce((previous, command) => {
    const result = reduce(previous, command);
    assert.ok(result.ok);
    return result.ok ? result.state : previous;
  }, emptyBoardState()); } };
}

const control = (h: ReturnType<typeof memory>, worker?: CollaborationCentralWorker, now = () => NOW, ownerId = "owner") =>
  createCollaborationControl({ board: h.board, now, ownerId, ...(worker === undefined ? {} : { worker }) });

test("central prompt context is bounded independently from the unchanged total-token grant", () => {
  assert.equal(isCentralLearningAllowance({ ...allowance, maxPromptChars: 40000 }), true);
  assert.equal(isCentralLearningAllowance({ ...allowance, maxPromptChars: 100000 }), true);
  assert.equal(isCentralLearningAllowance({ ...allowance, maxPromptChars: 100001 }), false);
  assert.equal(isCentralLearningAllowance({ ...allowance, maxTokens: 0, maxPromptChars: 40000 }), false);
});

async function funded(service: ReturnType<typeof control>, key = "missing-reference") {
  const reported = await service.report({ scope, problemKey: key, report: report(`${key}:report`) });
  assert.ok(reported.ok);

  if (!reported.ok) throw new Error("missing report");

  const decision = await service.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "The recurring handoff problem merits a reusable improvement.", sourceRefs: [] });
  assert.ok(decision.ok);

  if (!decision.ok) throw new Error("missing decision");

  const result = await service.fund({ issueId: decision.issue.issueId, expectedRevision: decision.issue.revision, grantId: `grant:${key}`, allowance });

  assert.ok(result.ok);
  if (!result.ok) throw new Error("missing grant");
  return result;
}

test("Personal Agent merges reports with revision checks and resolved or ordinary work receives no learning grant", async () => {
  const h = memory();
  let calls = 0;
  const service = control(h, { async run() {
    calls += 1;
    return { kind: "completed", resultRefs: [] };
  } });
  const first = await service.report({ scope, problemKey: "same-problem", report: report("one") });
  assert.ok(first.ok);
  const second = await service.report({ scope, problemKey: "same-problem", report: report("two", "reviewer") });
  assert.ok(second.ok);

  if (!first.ok || !second.ok) throw new Error("missing issue");

  assert.equal(first.issue.issueId, second.issue.issueId);
  assert.equal(second.issue.reports.length, 2);
  const duplicate = await service.report({ scope, problemKey: "same-problem", report: report("one") });
  assert.ok(duplicate.ok);

  if (duplicate.ok) assert.equal(duplicate.issue.revision, second.issue.revision);

  assert.equal((await service.decide({ issueId: first.issue.issueId, expectedRevision: first.issue.revision,
    decision: "focused_learning", reason: "stale", sourceRefs: [] })).ok, false);

  for (const decision of ["resolved", "ordinary_execution"] as const) {
    const current = h.state().learningIssues![0]!;
    const decided = await service.decide({ issueId: current.issueId, expectedRevision: current.revision, decision,
      reason: "Current execution already handles this problem.", sourceRefs: [] });
    assert.ok(decided.ok);
    if (decided.ok) assert.equal((await service.fund({ issueId: current.issueId, expectedRevision: decided.issue.revision, grantId: decision, allowance })).ok, false);
  }

  assert.equal((await service.dispatch({ scope })).ok, true);
  assert.equal(calls, 0);
  assert.equal(h.state().jobs.length, 0);
  assert.equal(h.state().centralLearningGrants?.length ?? 0, 0);
});

test("a real central dispatch waits for a library result and resumes the same job and total-token allowance after replay", async () => {
  const h = memory();
  let calls = 0;
  let grantId = "";
  const worker: CollaborationCentralWorker = { async run(input) {
    calls += 1;
    grantId ||= input.grantId;
    assert.equal(input.grantId, grantId);
    assert.equal(input.remaining.tokens, calls === 1 ? 1000 : 880);
    const reserved = await input.funding.reserve({ reservationId: `model:${calls}`, maxTokens: calls === 1 ? 1000 : 500 });
    assert.ok(reserved.ok);
    assert.equal((await input.funding.settle({ reservationId: `model:${calls}`, usage: { kind: "reported", totalTokens: calls === 1 ? 120 : 80 } })).ok, true);

    return calls === 1 ? { kind: "waiting_dependency", dependencies: [{ dependencyId: "tool-request", owner: "tool", requestId: "library:one",
      correlationRef: input.issue.issueId, state: { kind: "unavailable", reason: "Tool library is not ready yet." } }] }
      : { kind: "completed", resultRefs: ["adjustment:v1"] };
  } };
  const first = control(h, worker);
  const original = await funded(first);
  const waiting = await first.dispatch({ scope });
  assert.ok(waiting.ok);
  if (waiting.ok) assert.equal(waiting.status, "waiting_dependency");

  await first.dispatch({ scope });
  assert.equal(calls, 1, "waiting cannot spin another model call");
  h.reopen();
  const restarted = control(h, worker, () => NOW, "new-owner");

  assert.equal((await restarted.updateDependency({ dependencyId: "tool-request", expectedRevision: 1,
    state: { kind: "ready", resultRef: "tool:resolved", resultVersion: "v3", evidenceRefs: ["library:receipt"] } })).ok, true);
  const done = await restarted.dispatch({ scope });
  assert.ok(done.ok);
  if (done.ok) assert.equal(done.status, "completed");

  const grant = h.state().centralLearningGrants![0]!;
  assert.equal(grant.grantId, original.grant.grantId);
  assert.equal(h.state().centralLearningGrants!.length, 1);
  assert.equal(h.state().jobs[0]!.jobId, original.jobId);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 200, calls: 2, steps: 2 });
  assert.deepEqual(h.state().jobs[0]!.coordination?.resultRefs, ["adjustment:v1"]);
  await restarted.dispatch({ scope });
  assert.equal(calls, 2);
});

test("creation authorization resumes the same funded job for a library build without claiming the capability is ready", async () => {
  const h = memory();
  let segments = 0;
  const service = control(h, { async run(input) {
    segments += 1;

    if (segments === 1) return { kind: "waiting_dependency", dependencies: [{ dependencyId: "expert-build", owner: "expert",
      correlationRef: input.issue.issueId, state: { kind: "waiting", reason: "Creation requires the user's approval." } }] };

    assert.equal(input.dependencies[0]?.state.kind, "authorized");
    assert.equal(input.dependencies[0]?.requestId, "real:authorized-request");
    assert.equal((await input.funding.reserve({ reservationId: "expert-library-build", maxTokens: 400 })).ok, true);
    await input.funding.settle({ reservationId: "expert-library-build", usage: { kind: "reported", totalTokens: 60 } });
    const dependency = input.dependencies[0]!;

    await service.updateDependency({ dependencyId: dependency.dependencyId, expectedRevision: dependency.revision,
      state: { kind: "ready", resultRef: "expert:built", resultVersion: "1", evidenceRefs: ["library:build-result"] } });

    return { kind: "completed", resultRefs: ["assembled:expert-config"] };
  } });
  const original = await funded(service);
  await service.dispatch({ scope });
  const authorized = await service.updateDependency({ dependencyId: "expert-build", expectedRevision: 1, requestId: "real:authorized-request",
    state: { kind: "authorized", authorizationRef: "library:creation-consent" } });
  assert.equal(authorized.ok, true);
  assert.equal(h.state().learningDependencies![0]!.state.kind, "authorized");
  assert.equal((await service.dispatch({ scope })).ok, true);
  assert.equal(segments, 2);
  assert.equal(h.state().centralLearningGrants![0]!.grantId, original.grant.grantId);
  assert.equal(h.state().centralLearningGrants!.length, 1);
  assert.equal(h.state().learningDependencies![0]!.state.kind, "ready");
  assert.equal(centralLearningSpent(h.state().centralLearningGrants![0]!).tokens, 60);
});

test("an exhausted paid allowance still permits dependency-result assembly while refusing another model reservation", async () => {
  const h = memory();
  let segments = 0;
  const service = control(h, { async run(input) {
    segments += 1;

    if (segments === 1) {
      assert.equal((await input.funding.reserve({ reservationId: "only-model-call", maxTokens: 1000 })).ok, true);
      await input.funding.settle({ reservationId: "only-model-call", usage: { kind: "reported", totalTokens: 1000 } });
      return { kind: "waiting_dependency", dependencies: [{ dependencyId: "finish-capability", owner: "expert",
        correlationRef: input.issue.issueId, state: { kind: "waiting", reason: "The authorized build is in progress." } }] };
    }

    assert.equal(input.remaining.tokens, 0);
    assert.equal((await input.funding.reserve({ reservationId: "must-not-buy", maxTokens: 1 })).ok, false);

    return { kind: "completed", resultRefs: ["assembled-existing-result"] };
  } });

  await funded(service);
  await service.dispatch({ scope });
  await service.updateDependency({ dependencyId: "finish-capability", expectedRevision: 1,
    state: { kind: "ready", resultRef: "expert:ready", resultVersion: "1", evidenceRefs: [] } });
  assert.equal((await service.dispatch({ scope })).ok, true);
  assert.equal(segments, 2);
  assert.equal(centralLearningSpent(h.state().centralLearningGrants![0]!).calls, 1);
});

test("resolving a waiting issue closes its job and original grant instead of waking on a late library result", async () => {
  const h = memory();
  let calls = 0;
  const service = control(h, { async run(input) { calls += 1;
  return { kind: "waiting_dependency", dependencies: [{ dependencyId: "expert-request", owner: "expert",
    correlationRef: input.issue.issueId, state: { kind: "waiting", reason: "Awaiting the existing expert request." } }] }; } });

  await funded(service);
  await service.dispatch({ scope });
  const issue = h.state().learningIssues![0]!;
  const waiting = { kind: "waiting" as const, reason: "Awaiting the existing expert request." };

  assert.equal((await service.updateDependency({ dependencyId: "expert-request", expectedRevision: 1, requestId: "actual-library-request", state: waiting })).ok, true);
  assert.equal(h.state().learningDependencies![0]!.requestId, "actual-library-request");
  assert.equal((await service.updateDependency({ dependencyId: "expert-request", expectedRevision: 2, requestId: "different-request", state: waiting })).ok, false);
  assert.equal((await service.decide({ issueId: issue.issueId, expectedRevision: issue.revision, decision: "resolved", reason: "The task already obtained a suitable expert.", sourceRefs: [] })).ok, true);
  assert.equal((await service.updateDependency({ dependencyId: "expert-request", expectedRevision: 1,
    state: { kind: "ready", resultRef: "expert:late", resultVersion: "2", evidenceRefs: [] } })).ok, false);
  await service.dispatch({ scope });
  assert.equal(calls, 1);
  assert.equal(h.state().jobs[0]!.state, "cancelled");
  assert.equal(h.state().centralLearningGrants![0]!.status, "closed");
});

test("late measured cost can settle a resolved issue but its late adjustment cannot be accepted", async () => {
  const h = memory();
  let release = () => {}, entered = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }), atWork = new Promise<void>(resolve => { entered = resolve; });
  const service = control(h, { async run(input) {
    await input.funding.reserve({ reservationId: "late-call", maxTokens: 1000 });
    entered();
    await gate;
    assert.equal((await input.funding.settle({ reservationId: "late-call", usage: { kind: "reported", totalTokens: 1500 } })).ok, true);
    return { kind: "completed", resultRefs: ["must-not-apply"] };
  } });

  await funded(service);
  const running = service.dispatch({ scope });
  await atWork;
  const issue = h.state().learningIssues![0]!;
  await service.decide({ issueId: issue.issueId, expectedRevision: issue.revision,
    decision: "ordinary_execution", reason: "Handle the change in normal task scheduling.", sourceRefs: [] });
  release();
  assert.equal((await running).ok, false);
  const grant = h.state().centralLearningGrants![0]!;
  assert.equal(centralLearningSpent(grant).tokens, 1500);
  assert.equal(grant.closedReason, "model_token_overrun");
  assert.equal(h.state().jobs[0]!.state, "cancelled");
  assert.equal(h.state().jobs[0]!.coordination?.resultRefs, undefined);
});

test("resolved and ordinary decisions cancel an authorized dependency awaiting its original funded build", async () => {
  for (const decision of ["resolved", "ordinary_execution"] as const) {
    const h = memory(), service = control(h, { async run(input) { return { kind: "waiting_dependency", dependencies: [{
      dependencyId: "authorized-expert", owner: "expert", requestId: "actual-request", correlationRef: input.issue.issueId,
      state: { kind: "authorized", authorizationRef: "permission:creation" },
    }] }; } });

    await funded(service);
    await service.dispatch({ scope });
    assert.equal(h.state().jobs[0]!.state, "queued");
    const issue = h.state().learningIssues![0]!;

    assert.equal((await service.decide({ issueId: issue.issueId, expectedRevision: issue.revision, decision,
      reason: "The original task now handles the request.", sourceRefs: [] })).ok, true);
    assert.equal(h.state().learningDependencies![0]!.state.kind, "cancelled");
    assert.equal((await service.updateDependency({ dependencyId: "authorized-expert", expectedRevision: 1,
      state: { kind: "ready", resultRef: "late:expert", resultVersion: "1", evidenceRefs: [] } })).ok, false);
  }
});

test("resolving after a closed overrun grant cancels pending dependencies while preserving failed job and usage", async () => {
  const h = memory();
  let runs = 0;
  const service = control(h, { async run(input) {
    if (++runs === 1) return { kind: "waiting_dependency", dependencies: [{ dependencyId: "authorized-build", owner: "expert",
      requestId: "actual-request", correlationRef: input.issue.issueId, state: { kind: "authorized", authorizationRef: "permission:1" } }] };
    assert.ok((await input.funding.reserve({ reservationId: "build", maxTokens: 100 })).ok);
    assert.ok((await input.funding.settle({ reservationId: "build", usage: { kind: "reported", totalTokens: 1500 } })).ok);
    return { kind: "failed", reason: "model_token_overrun" };
  } });

  await funded(service);
  await service.dispatch({ scope });
  await service.dispatch({ scope });
  assert.equal(h.state().jobs[0]!.state, "failed");
  assert.equal(h.state().centralLearningGrants![0]!.status, "closed");
  const issue = h.state().learningIssues![0]!;

  assert.ok((await service.decide({ issueId: issue.issueId, expectedRevision: issue.revision, decision: "resolved",
    reason: "Normal execution already solved this.", sourceRefs: [] })).ok);
  assert.equal(h.state().learningDependencies![0]!.state.kind, "cancelled");
  assert.equal(h.state().jobs[0]!.state, "failed");
  assert.equal(h.state().centralLearningGrants![0]!.closedReason, "model_token_overrun");
  assert.equal(centralLearningSpent(h.state().centralLearningGrants![0]!).tokens, 1500);
});

test("a committed non-learning decision aborts its in-process worker signal before a late result can apply", async () => {
  for (const decision of ["resolved", "ordinary_execution"] as const) {
    const h = memory();
    let entered = () => {}, release = () => {}, workerSignal: AbortSignal | undefined;
    const atWork = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const service = control(h, { async run(input) {
      workerSignal = input.signal;
      entered();
      await gate;
      return { kind: "completed", resultRefs: ["late"] };
    } });

    await funded(service);
    const dispatch = service.dispatch({ scope });
    await atWork;
    const issue = h.state().learningIssues![0]!;

    try {
      assert.equal((await service.decide({ issueId: issue.issueId, expectedRevision: issue.revision, decision,
        reason: "The PA no longer requests learning.", sourceRefs: [] })).ok, true);
      assert.equal(workerSignal?.aborted, true);
    } finally {
      release();
      await dispatch;
    }

    assert.equal(h.state().jobs[0]!.coordination?.resultRefs, undefined);
  }
});

test("dispatch composes caller cancellation and removes the caller listener after normal completion", async () => {
  const h = memory(), caller = new AbortController();
  let workerSignal: AbortSignal | undefined;
  const service = control(h, { async run(input) {
    workerSignal = input.signal;
    return { kind: "completed", resultRefs: [] };
  } });

  await funded(service);
  assert.equal((await service.dispatch({ scope, signal: caller.signal })).ok, true);
  assert.notEqual(workerSignal, caller.signal);
  caller.abort();
  assert.equal(workerSignal?.aborted, false);
  const next = memory(), interrupted = new AbortController();
  let entered = () => {}, release = () => {};
  const atWork = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const interruptedService = control(next, { async run(input) {
    workerSignal = input.signal;
    entered();
    await gate;
    return { kind: "completed", resultRefs: ["late"] };
  } });

  await funded(interruptedService);
  const dispatch = interruptedService.dispatch({ scope, signal: interrupted.signal });
  await atWork;

  try {
    interrupted.abort();
    assert.equal(workerSignal?.aborted, true);
  } finally {
    release();
    await dispatch;
  }

  assert.equal(next.state().jobs[0]!.state, "cancelled");
  assert.equal(next.state().jobs[0]!.coordination?.resultRefs, undefined);
});

test("an expired central claim preserves unknown cost and fences the old worker without minting another grant", async () => {
  const h = memory();
  let clock = NOW, release = () => {}, entered = () => {}, recoveredCalls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), atWork = new Promise<void>(resolve => { entered = resolve; });
  const old = createCollaborationControl({ board: h.board, now: () => clock, ownerId: "old", claimLeaseMs: 1000,
    worker: { async run(input) { await input.funding.reserve({ reservationId: "unknown", maxTokens: 200 });
    entered();
    await gate;
      return { kind: "completed", resultRefs: ["stale"] }; } } });

  await funded(old);
  const started = old.dispatch({ scope });
  await atWork;
  const next = control(h, { async run(input) {
    recoveredCalls += 1;
    assert.equal(input.remaining.tokens, 800);
    return { kind: "completed", resultRefs: ["recovered"] };
  } }, () => clock, "new");
  const busy = await next.dispatch({ scope });
  assert.ok(busy.ok);
  if (busy.ok) assert.equal(busy.status, "busy");

  clock = "2026-11-03T12:00:02.000Z";
  const recovered = await next.dispatch({ scope });

  assert.ok(!recovered.ok);
  assert.equal(recovered.reason, "collaboration_recovery_sent_step_requires_inspection");
  release();
  assert.equal((await started).ok, false);
  assert.equal(h.state().centralLearningGrants!.length, 1);
  assert.equal(centralLearningSpent(h.state().centralLearningGrants![0]!).tokens, 200);
  assert.equal(recoveredCalls, 0);
  assert.equal(h.state().jobs[0]!.state, "queued");
  assert.equal(h.state().jobs[0]!.coordination?.resultRefs, undefined);
});

test("old snapshots default coordination fields while malformed units, references and generic job bypasses fail closed", async () => {
  const h = memory(), service = control(h);
  await funded(service);
  assert.ok(normalizeBoardState(JSON.parse(JSON.stringify(h.state()))));
  assert.deepEqual(normalizeBoardState(emptyBoardState())?.learningIssues, []);
  assert.equal(normalizeBoardState({ ...h.state(), learningIssues: JSON.parse("null") }), undefined);
  const wrongUnit = JSON.parse(JSON.stringify(h.state()));
  wrongUnit.centralLearningGrants[0].allowance.unit = "output_tokens";
  assert.equal(normalizeBoardState(wrongUnit), undefined);
  const job = h.state().jobs[0]!;
  const bypass = await h.board.apply({ type: "start_job", commandId: "bypass-central-budget", issuedAt: NOW, jobId: job.jobId });

  assert.equal(bypass.ok, false);
  assert.equal(h.state().jobs[0]!.state, "queued");
});
