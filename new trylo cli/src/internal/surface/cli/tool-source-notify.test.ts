import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { registerHooks } from "node:module";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import type { CliContext } from "./context.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import type { ToolEvolutionArtifact } from "../../learning/agent/subsystems/tool/domain/evolution/artifact.js";
import { createToolEvolutionArchive } from "../../learning/agent/subsystems/tool/runtime/evolution-archive.js";
import { enqueueToolLearningPlan } from "../../learning/agent/subsystems/tool/runtime/pipeline-queue.js";
import { nominateToolLearningSource } from "../../learning/agent/subsystems/tool/runtime/learning-funding.js";
import { savePipelineAsset } from "../../learning/agent/subsystems/tool/runtime/pipeline-assets.js";
import { toolLearningFundingIdentity } from "../../learning/agent/subsystems/tool/domain/evolution/funding-identity.js";
import { toolLearningDecisionVersionId } from "../../learning/agent/subsystems/tool/domain/evolution/decision-identity.js";
import { resultVersionId, type ToolLearningPlan } from "../../learning/agent/subsystems/tool/domain/evolution/pipeline.js";
import { proposeToolContractRevision, reviewToolContractRevision } from "../../learning/agent/subsystems/tool/runtime/contract-revisions.js";
import { createToolCentralLearning } from "../../learning/agent/subsystems/tool/runtime/central-learning.js";
import { readToolCentralContinuation } from "../../learning/agent/subsystems/tool/runtime/central-research-continuation.js";
import { projectToolCentralFeedbackChanges } from "../../learning/agent/subsystems/tool/runtime/central-feedback-changes.js";
import { toolCentralFeedbackFromBoard } from "../../learning/agent/subsystems/tool/runtime/central-history.js";
import { retainFrozenStage } from "../../integration/central-learning/stage-evidence.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";

test("original tools commits hint their existing owner without stealing managed work or consuming unread native units", async t => {
  let legacyDispatches = 0;
  let interceptedLegacyWorker = false;
  const probe = "__tryloToolNotifyLegacyDispatchProbe";
  Reflect.set(globalThis, probe, () => { legacyDispatches++; });
  const hooks = registerHooks({ load(url, context, nextLoad) {
    // TEST ONLY process boundary: even a regression cannot spawn a provider.
    if (url.endsWith("/adapters/evolution/background-worker.js")) {
      interceptedLegacyWorker = true;
      return { format: "module", shortCircuit: true,
        source: `export async function dispatchToolLearningWorker() { globalThis.${probe}();return {ok:true,pid:1234}; }` };
    }

    const loaded = nextLoad(url, context);

    if (!url.endsWith("/commands-tool-contract.js") || process.env.TOOL_NOTIFY_RED_MANAGED !== "1") return loaded;

    const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);

    assert.ok(source.includes("if (root !== undefined) {"));

    return { ...loaded, source: source.replace("if (root !== undefined) {", "if (false) {") };
  } });

  t.after(() => {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, probe);
  });
  const { handleTools } = await import("./commands-tools.js");
  const parent = testScratchPath("tool-source-notify");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "case-")), homeRoot = path.join(root, "home"), workspaceRoot = path.join(root, "workspace");
  const boardRoot = path.join(homeRoot, "learning", "board"), paths = runtimeScopePaths(homeRoot, workspaceRoot);
  let output = "", warnings = "", committedBeforeWake = false;
  const ctx: CliContext = { homeDir: root, cwd: workspaceRoot, env: { TRYLO_HOME: homeRoot }, nodeVersion: "v24.0.0", stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => true, readDir: () => [], writeFile: () => false, readStdin: async () => "",
    readLine: async () => undefined, readSecret: async () => undefined, stdout: text => { output += text; }, stderr: text => { warnings += text; },
    now: () => Date.parse("2026-11-05T04:00:00.000Z"), newId: prefix => `test:${prefix}` };
  const acquired = tryAcquireRuntimeOwner(paths, { ownerPid: 1234, createToken: () => "test-owner-lock", processStatus: () => "alive" });

  assert.ok(acquired.ok);
  const owner = acquired.value, requests: unknown[] = [];
  const locator = { schemaVersion: 1 as const, scopeKey: paths.scopeKey, ownerId: "test-runtime", pid: 1234, port: 1, token: "test-local-rpc" };
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${locator.token}`);
    let text = "";
    request.on("data", chunk => { text += String(chunk); });
    request.on("end", async () => {
      requests.push(JSON.parse(text));
      const loaded = await createBoardReader(boardRoot).load();
      committedBeforeWake = loaded.ok && loaded.state.jobs.some(job => job.domain === "tool" && job.state === "queued");
      response.end(JSON.stringify({ ok: true, snapshot: { schemaVersion: 1, scopeKey: paths.scopeKey, ownerId: locator.ownerId,
        revision: 1, wakeSequence: 1, consumedSequence: 0, state: "running" } }));
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    owner.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(path.resolve(root)), parent);
    rmSync(root, { recursive: true, force: true });
  });
  assert.ok(owner.writeIntent({ schemaVersion: 1, homeRoot, workspaceRoot, enabled: true, configuration: {},
    wakeSequence: 0, consumedSequence: 0, wakeReason: "test:original", sourceRefs: [] }).ok);
  assert.ok(owner.writeLocator({ ...locator, port: address.port }).ok);
  assert.equal(await handleTools(ctx, ["queue", "TEST ONLY original source notification"]), 0);
  assert.equal(interceptedLegacyWorker, true, "No legacy-worker process may escape the test-only boundary");
  const result: unknown = JSON.parse(output.trim());
  assert.ok(typeof result === "object" && result !== null && "jobId" in result && typeof result.jobId === "string");
  assert.deepEqual(requests, [{ operation: "wake", wake: { reason: "tool_native_plan_queued", sourceRefs: [result.jobId, `plan:${result.jobId}`] } }]);
  assert.equal(committedBeforeWake, true);
  assert.equal(warnings, "");
  // The same real CLI must leave a managed waiting job with its original owner
  // when a Permission-backed contract approval supplies the missing fact.
  const scope = workspaceIdentity(workspaceRoot), at = new Date(ctx.now()).toISOString();
  const request: ToolEvolutionArtifact["request"] = { schemaVersion: 1, requestId: "test:notify-parent", scope,
    capability: "TEST ONLY contract notification", operation: "create", evidence: [
      { sampleId: "s1", role: "source", input: 2, expected: { kind: "value", value: 4 } },
      { sampleId: "s2", role: "source", input: 3, expected: { kind: "value", value: 6 } },
      { sampleId: "v", role: "variation", input: 4, expected: { kind: "value", value: 8 } },
      { sampleId: "n", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } } ] };
  const candidate: ToolEvolutionArtifact["candidate"] = { identity: "notify_test", description: "TEST ONLY parent", inputSchema: { type: "number" },
    source: "module.exports = value => value * 2", mastery: { whenToUse: ["TEST ONLY"], preconditions: [], pitfalls: [] } };
  const origin = await createToolEvolutionArchive(boardRoot).save({ schemaVersion: 1, generatedAt: at, request, candidate,
    verification: { verdict: "pass", candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence),
      checks: request.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed", detail: "TEST ONLY shape fixture" })) } });
  assert.ok(origin.ok);
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: request.capability, createdAt: at,
    targetVersionId: origin.versionId, trigger: { runId: "test:contract-task", proposalKey: "test:contract", action: "user_requested", evidenceRefs: [] } };
  const queued = await enqueueToolLearningPlan(boardRoot, plan);
  assert.ok(queued.ok);
  assert.ok((await nominateToolLearningSource({ boardRoot, scope, centralScope: workspaceRoot, now: ctx.now }, plan, new AbortController().signal)).ok);
  let serial = 0;
  const load = async () => {
    const read = await createBoardReader(boardRoot).load();
    assert.ok(read.ok);
    return read.state;
  };
  const act = async (action: CoordinationAction) => {
    const applied = await withBoardWriter(boardRoot, board => board.apply({ type: "coordinate_learning", commandId: `test:notify:${++serial}`, issuedAt: at, action }));
    assert.ok(applied.ok, JSON.stringify(applied));
  };
  const identity = toolLearningFundingIdentity(plan);

  await act({ kind: "decide", issueId: identity.issueId, expectedRevision: 1, decision: "focused_learning", reason: "TEST managed owner", sourceRefs: [] });
  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1, budgetId: "test:notify-root", scope: workspaceRoot,
    unit: "total_model_tokens", limits: { tokens: 10000, calls: 4, steps: 4 }, authorizationRef: "test:notify-original" } });
  await act({ kind: "fund", issueId: identity.issueId, expectedRevision: 2, grantId: identity.grantId, domain: "tool", budgetId: "test:notify-root",
    expectedSequence: (await load()).sequence, authorizationRef: "test:notify-original", planRef: "test:notify-plan",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 8000, maxCalls: 1, maxSteps: 1, maxPromptChars: 12000 } });
  const preparedOwner = createToolCentralLearning({ boardRoot, scope, centralScope: workspaceRoot, now: ctx.now,
    authorized: () => true, mode: "after_turn", modelRef: "test:notify-model", run: async () => { assert.fail("No worker or provider may run"); } });
  const prepared = await preparedOwner.prepare({ issueId: identity.issueId,
    authorizedAllowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 8000, maxCalls: 1, maxSteps: 1, maxPromptChars: 12000 } }, new AbortController().signal);

  assert.equal(prepared.status, "ready", JSON.stringify(prepared));
  if (prepared.status !== "ready") return;

  const funded = { issueId: identity.issueId, grantId: identity.grantId, expectedIssueRevision: (await load()).learningIssues![0]!.revision,
    stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };
  const assignment: CentralPursuitCandidate = { opportunity: { opportunityId: prepared.offer.offerId, scope: workspaceRoot,
    targetRef: "test:proposal-delivery", instanceRef: prepared.stageRef, sourceRef: funded.sourceBindingRef, stage: "initial",
    conditionRef: "test:condition", baselineRef: "test:idle", windowRef: "test:window", offer: prepared.offer }, source: prepared.source,
    readiness: { kind: "ready", sourceRef: funded.sourceBindingRef, now: ctx.now(), nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "test:proposal-delivery" }, fee: { kind: "hard-budget-only", sourceRef: "test:notify-root" },
    purpose: "focused_learning", objective: { instanceId: "test:objective", criterion: "proposal_delivered", definitionRef: "test:proposal-delivery",
      familyRef: "test:tool-source", familySourceRef: funded.policyRef } };
  const frozen = await retainFrozenStage({ boardRoot, candidate: assignment, input: funded });
  assert.equal(frozen.status, "retained");

  if (frozen.status !== "retained") return;

  const started = await withBoardWriter(boardRoot, board => board.apply({ type: "start_job", commandId: "test:contract-start", issuedAt: at, jobId: queued.jobId }));
  assert.ok(started.ok);
  const first = request.evidence[0]!;
  const proposed = await proposeToolContractRevision(boardRoot, { type: "tool_contract_revision_proposal", schemaVersion: 1, parentVersionId: origin.versionId,
    parentContractHash: contentHashOf(request.evidence), scope, reason: "changed_requirement", corrections: [{ sampleId: first.sampleId,
      oldSampleHash: contentHashOf(first), oldExpectedHash: contentHashOf(first.expected), expected: { kind: "value", value: 5 }, evidenceRefs: ["user:notify-correction"] }] }, at);
  assert.ok(proposed.ok);
  const review = await reviewToolContractRevision(boardRoot, proposed.proposalId, scope);
  assert.ok(review.ok);
  const decision = { action: "revise_contract" as const, proposal: review.proposal, rationale: "TEST correction", existingInsufficiency: "TEST changed requirement",
    expectedBenefit: "TEST contract alignment", constructionCost: "TEST no construction", alternatives: [] };
  const decisionVersionId = toolLearningDecisionVersionId({ jobId: queued.jobId, attempt: 1, decision });
  const savedDecision = await withBoardWriter(boardRoot, board => savePipelineAsset(board, { versionId: decisionVersionId, kind: "workflow", scope,
    source: "inferred", issuedAt: at, content: { type: "tool_learning_decision", schemaVersion: 1, jobId: queued.jobId, attempt: 1,
      step: 1, decision, contextHash: contentHashOf({ requirement: "TEST user correction" }), grantId: identity.grantId } }));
  assert.ok(savedDecision.ok);
  const saved = await withBoardWriter(boardRoot, board => savePipelineAsset(board, { versionId: resultVersionId(queued.jobId, 1), kind: "workflow", scope,
    source: "inferred", issuedAt: at, content: { type: "tool_learning_result", schemaVersion: 1, jobId: queued.jobId, attempt: 1,
      outcome: "waiting_evidence", code: "contract_revision_approval_required", contractProposalId: proposed.proposalId,
      search: { status: "complete", candidates: [], failures: [] }, occurredAt: at, decision,
      decisionVersionId } }));
  assert.ok(saved.ok);
  const waiting = await withBoardWriter(boardRoot, board => board.apply({ type: "complete_job", commandId: "test:contract-wait", issuedAt: at,
    jobId: queued.jobId, next: "waiting_evidence" }));
  assert.ok(waiting.ok);
  const continuation = { board: await load(), scope: workspaceRoot, issueId: identity.issueId, grantId: identity.grantId,
    programRef: "test:canonical-route-program", lastStage: frozen.value };

  assert.equal(readToolCentralContinuation(continuation, { workspaceId: scope, mode: "after_turn", executionAuthorized: false }).kind, "waiting");
  output = "";
  assert.equal(await handleTools(ctx, ["contract-approve", proposed.proposalId, "--approve", review.reviewId]), 0);
  const approval: unknown = JSON.parse(output.trim());

  assert.ok(typeof approval === "object" && approval !== null && "learningResume" in approval);
  assert.deepEqual(approval.learningResume, { kind: "deferred_to_central", jobIds: [queued.jobId] });
  assert.equal(legacyDispatches, 0);
  const after = await load();
  assert.equal(after.jobs.find(job => job.jobId === queued.jobId)!.state, "waiting_evidence");
  assert.equal(after.jobs.find(job => job.jobId === queued.jobId)!.attempt, 1);
  assert.equal(after.centralLearningGrants![0]!.reservations.length, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], { operation: "wake", wake: { reason: "tool_native_contract_approved",
    sourceRefs: [proposed.proposalId, review.revisionId] } });
  const next = readToolCentralContinuation({ ...continuation, board: after }, { workspaceId: scope, mode: "after_turn", executionAuthorized: false });

  assert.equal(next.kind, "continuable", JSON.stringify(next));
  if (next.kind !== "continuable") return;

  assert.equal(next.cursorRef, resultVersionId(queued.jobId, 1));
  const consumedFrame = { ...frozen.value, candidate: { ...frozen.value.candidate, source: { ...frozen.value.candidate.source,
    domainStage: { ...frozen.value.candidate.source.domainStage, readiness: { kind: "ready" as const, evidenceRefs: [next.cursorRef] } } } } };
  const { digest: _digest, ...consumedPayload } = consumedFrame;

  assert.equal(readToolCentralContinuation({ ...continuation, board: after, lastStage: { ...consumedPayload, digest: contentHashOf(consumedPayload) } },
    { workspaceId: scope, mode: "after_turn", executionAuthorized: false }).kind, "waiting");
  const centralJob = after.centralLearningGrants![0]!.jobId;

  await act({ kind: "claim", jobId: centralJob, expectedAttempt: 0, claimId: "test:dependency-claim", ownerId: "test:contract-await",
    expiresAt: new Date(ctx.now() + 60000).toISOString() });
  await act({ kind: "finish", jobId: centralJob, claimId: "test:dependency-claim", result: { kind: "waiting_dependency", dependencies: [
    { dependencyId: "test:contract-dependency", owner: "tool", correlationRef: proposed.proposalId, state: { kind: "waiting", reason: "TEST request only" } }] } });
  const unfulfilled = await load();

  assert.ok(projectToolCentralFeedbackChanges(unfulfilled, { scope: workspaceRoot, workspaceId: scope }).every(row => row.factRef !== "test:contract-dependency"));
  await act({ kind: "dependency", dependencyId: "test:contract-dependency", expectedRevision: 1,
    state: { kind: "ready", resultRef: review.revisionId, resultVersion: review.revisionId, evidenceRefs: [review.revisionId] } });
  const completed = await load(), changes = projectToolCentralFeedbackChanges(completed, { scope: workspaceRoot, workspaceId: scope })
    .filter(row => row.issueId === identity.issueId);

  assert.ok(changes.some(row => row.kind === "dependency"));
  assert.ok(changes.some(row => row.kind === "correction"));
  assert.ok(changes.every(row => row.kind !== "delivery"), "Study/proposal/approval/request rows are not delivery");
  const body = toolCentralFeedbackFromBoard(completed, { scope, centralScope: workspaceRoot, issueId: identity.issueId, nativeChanges: changes });
  assert.ok(body);

  for (const change of changes) {
    assert.ok([change.factRef, change.unitRef, change.revisionRef].every(ref => body.sourceRefs.includes(ref)), JSON.stringify(change));
    assert.ok(body.records.some(row => row.unitRef === change.unitRef && row.revisionRef === change.revisionRef), JSON.stringify(change));
  }

  const withdrawalReview = await reviewToolContractRevision(boardRoot, proposed.proposalId, scope);
  assert.ok(withdrawalReview.ok);
  output = "";
  assert.equal(await handleTools(ctx, ["contract-withdraw", proposed.proposalId, "--approve", withdrawalReview.withdrawReviewId]), 0);
  const withdrawn = await load(), withdrawalChanges = projectToolCentralFeedbackChanges(withdrawn, { scope: workspaceRoot, workspaceId: scope });
  const lifecycle = withdrawalChanges.find(row => row.issueId === identity.issueId && row.factRef === proposed.proposalId && row.kind === "correction");

  assert.ok(lifecycle, "A withdrawn correction must retain its exact native lifecycle navigation");
  const withdrawnBody = toolCentralFeedbackFromBoard(withdrawn, { scope, centralScope: workspaceRoot, issueId: identity.issueId, nativeChanges: withdrawalChanges });
  assert.ok(withdrawnBody);
  assert.ok([lifecycle.factRef, lifecycle.unitRef, lifecycle.revisionRef].every(ref => withdrawnBody.sourceRefs.includes(ref)));
  const rawLifecycle = withdrawnBody.records.find(row => row.unitRef === lifecycle.unitRef && row.revisionRef === lifecycle.revisionRef);

  assert.ok(rawLifecycle && typeof rawLifecycle.payloadJson === "string");
  assert.equal(JSON.parse(rawLifecycle.payloadJson).lifecycle, "rejected");
});
