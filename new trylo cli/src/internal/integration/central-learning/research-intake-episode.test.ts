import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { methodResearchGrantId } from "../../learning/agent/subsystems/method/adapters/central-research-records.js";
import { acceptCentralMethodResearch } from "../../learning/agent/subsystems/method/adapters/central-research-intake.js";
import { acceptCentralToolResearch } from "../../learning/agent/subsystems/tool/runtime/central-research-intake.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { selectCentralResearchEpisode, centralResearchEpisodeEvidence } from "./research-intake-episode.js";
import { CentralResearchIntakeError, type GroundedCentralResearch } from "./research-intake-common.js";
import { recordCentralResearchProgram } from "./research-intake-program-report.js";
import { createCentralMethodResearchExecution } from "../../learning/agent/subsystems/method/adapters/central-research-execution.js";
import { centralCandidateForStage } from "./candidates.js";
import { retainFrozenStage } from "./stage-evidence.js";
import { recordCentralStageObservation } from "./observations.js";
import type { CentralLearningExecutionPort, CentralFundedStage } from "./contracts.js";
import type { ProviderPort } from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";
import { createCentralRuntimeResearchContinuation } from "../../surface/cli/central-runtime-research-continuation.js";

const at = "2026-11-05T03:00:00.000Z", scope = "workspace:research-episodes", intentId = "intent:research-episodes";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 12000, maxCalls: 2, maxSteps: 2, maxPromptChars: 12000 };

function input(domain: GroundedCentralResearch["domain"] = "prompt", coordinate = 1,
  body = "The schema repair resolved the original task.", origin: "user_statement" | "execution_result" | "checker_result" = "execution_result"): GroundedCentralResearch {
  const material = centralMaterialFromPage({ ref: "session:actual-source", originalRef: "session:actual-source", originalScope: scope,
    origin, owner: "session", coordinate: { runId: "run:business", sequence: coordinate },
    sourceHash: contentHashOf(body), start: 0, end: body.length, totalChars: body.length, text: body });
  const operation = { kind: "dispatch" as const, operationId: "operation:initial", purpose: "Compare existing schema repair prerequisites",
    expectedChange: "A transferable method and its counterexamples", sourceRefs: [material.ref], allowance,
    destination: { plane: "agent" as const, domain } };

  return { requestRef: `central-research-request:${contentHashOf([scope, intentId, domain])}`, domain, operation,
    intent: { intentId, subject: { plane: "central", questionRef: intentId }, goal: "Learn when schema checks transfer across tasks",
      rationale: "Solved work supports comparison", conditions: ["structured payload", "declared schema"],
      knowledge: [{ statement: "The task was solved after a schema repair", conditions: "A declared schema was available", sourceRefs: [material.ref] }],
      residual: ["Which prerequisite transfers?"], commitment: { purpose: "Compare the prerequisite", assumptions: ["The task is already solved"],
        reconsiderWhen: ["A new trial or correction appears"] }, revisionReason: "Initial source-grounded purpose",
      sourceRefs: [material.ref], continuation: { kind: "ready", operation } }, materials: [material], sourceRefs: [intentId, material.ref] };
}

function revised(request: GroundedCentralResearch, purpose: string): GroundedCentralResearch {
  const operation = { ...request.operation, purpose };
  return { ...request, operation, intent: { ...request.intent, continuation: { kind: "ready", operation } } };
}

function shuffled(request: GroundedCentralResearch): GroundedCentralResearch {
  const operation = { ...request.operation, operationId: "operation:another-id", allowance: { ...allowance, maxTokens: 5000, maxCalls: 1, maxSteps: 1 }, sourceRefs: [] };
  return { ...request, operation, intent: { ...request.intent, conditions: [...request.intent.conditions].reverse(),
    revisionReason: "Bookkeeping wording changed", knowledge: request.intent.knowledge.map(row => ({ ...row, sourceRefs: ["knowledge:new-ref"] })),
    continuation: { kind: "ready", operation } }, materials: [...request.materials,
      { ref: "knowledge:new-ref", kind: "knowledge", text: "Same interpretation under a new derived reference.", sourceRefs: [] }] };
}

function metadata(request: GroundedCentralResearch) {
  const material = request.materials.find(row => row.ref.startsWith("central-research-episode-metadata:"));
  assert.ok(material);
  return JSON.parse(material.text) as { programRef: string; selection: string; baseRequestRef: string;
    previous: null | { issueId: string; grantId: string | null } };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(testScratchPath("central-research-episode-"));

  t.after(async () => {
    assert.ok(root.startsWith(testScratchPath() + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const options = { boardRoot: root, scope, enabled: () => true }, signal = new AbortController().signal;
  const native = { ...options, workspaceId: "legacy:episodes", now: () => Date.parse(at) };
  const assignments = new Map<string, { readonly input: CentralFundedStage; readonly candidate: ReturnType<typeof centralCandidateForStage> }>();
  let serial = 0;
  const load = async () => {
    const read = await createBoardReader(root).load();
    assert.ok(read.ok);
    return read.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning", commandId: `episode-test:${++serial}`, issuedAt: at, action }));
    assert.ok(result.ok, result.ok ? undefined : `${result.reason}:${result.detail}`);
    return result.state;
  };
  const select = async (request: GroundedCentralResearch,
    extra: Pick<Parameters<typeof selectCentralResearchEpisode>[0], "readContinuation" | "readOwnerFeedback"> = {}) => {
    const before = await load(), output = await selectCentralResearchEpisode({ ...options, ...extra }, request, signal), after = await load();
    assert.equal(after.sequence, before.sequence, "episode selection cannot write a second lifecycle");
    assert.deepEqual(after.centralLearningGrants, before.centralLearningGrants);
    assert.deepEqual(after.centralLearningBudgets, before.centralLearningBudgets);
    return output;
  };
  const accept = async (request: GroundedCentralResearch) => {
    const result = request.domain === "prompt" ? await acceptCentralMethodResearch(native, request, signal)
      : await acceptCentralToolResearch(native, request, signal);
    assert.ok(result.status === "accepted", JSON.stringify(result));
    const recorded = await recordCentralResearchProgram({ ...options, now: native.now }, request, result, signal);
    assert.ok(recorded.status === "accepted", JSON.stringify(recorded));
    return recorded.issueId;
  };
  const fund = async (request: GroundedCentralResearch, issueId: string) => {
    let board = await load();
    if (board.centralLearningBudgets?.length === 0 || board.centralLearningBudgets === undefined) {
      await act({ kind: "open_budget", expectedSequence: board.sequence, budget: { schemaVersion: 1, budgetId: "root:episodes", scope,
        unit: "total_model_tokens", limits: { tokens: 50000, calls: 10, steps: 10 }, authorizationRef: "test:explicit-root" } });
    }

    board = await load();
    let issue = board.learningIssues!.find(row => row.issueId === issueId)!;

    await act({ kind: "decide", issueId, expectedRevision: issue.revision, decision: "focused_learning", reason: "Test authorized episode", sourceRefs: [request.requestRef] });
    board = await load();
    issue = board.learningIssues!.find(row => row.issueId === issueId)!;
    const grantId = request.domain === "prompt" ? methodResearchGrantId(request.requestRef) : `test-tool-grant:${contentHashOf(request.requestRef)}`;

    await act({ kind: "fund", issueId, expectedRevision: issue.revision, grantId, domain: request.domain, allowance,
      budgetId: "root:episodes", authorizationRef: "test:explicit-root", planRef: "test:episode-plan", expectedSequence: board.sequence });

    return grantId;
  };
  const close = async (grantId: string, unknown = false) => {
    let board = await load();
    const grant = board.centralLearningGrants!.find(row => row.grantId === grantId)!;
    const job = board.jobs.find(row => row.jobId === grant.jobId)!, claimId = `claim:${grantId}`;

    await act({ kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId, ownerId: "test:episode-owner", expiresAt: "2026-11-05T03:01:00.000Z" });

    if (unknown) {
      await act({ kind: "reserve", grantId, claimId, reservationId: `call:${grantId}`, maxTokens: 1000 });
      await act({ kind: "settle", grantId, reservationId: `call:${grantId}`, usage: { kind: "unknown", reason: "response_not_observed" } });
    }

    board = await load();
    assert.ok(board.centralLearningGrants!.some(row => row.grantId === grantId));
    await act({ kind: "finish", jobId: job.jobId, claimId, result: { kind: "completed", resultRefs: [] } });
  };
  const methodPort = (provider: ProviderPort) => {
    const original: CentralLearningExecutionPort = { domain: "prompt", async prepare() { throw new Error("Not the native research source"); },
      async dispatch() { throw new Error("No dispatch requested"); }, async observe() { throw new Error("No result claimed"); } };
    return createCentralMethodResearchExecution({ ...native, provider, model: "test:episode-model" }, original);
  };
  const assign = async (issueId: string, grantId: string, operationAllowance = allowance) => {
    const provider: ProviderPort = { async *stream() { throw new Error("Assignment is not a provider invocation"); } };
    const stage = await methodPort(provider).prepare({ issueId, authorizedAllowance: allowance, operationAllowance }, signal);

    assert.ok(stage.status === "ready", JSON.stringify(stage));
    const issue = (await load()).learningIssues!.find(row => row.issueId === issueId)!;
    const input: CentralFundedStage = { issueId, grantId, expectedIssueRevision: issue.revision,
      stageRef: stage.stageRef, policyRef: stage.policyRef, sourceBindingRef: stage.source.sourceBindingRef, offer: stage.offer,
      ...(stage.sourceContext === undefined ? {} : { sourceContext: stage.sourceContext }) };
    const candidate = centralCandidateForStage({ scope, issueId, domain: "prompt", stage, nowMs: Date.parse(at), budgetId: "root:episodes" });
    const retained = await retainFrozenStage({ boardRoot: root, candidate, input });
    assert.equal(retained.status, "retained");
    const assigned = await recordCentralStageObservation({ boardRoot: root, enabled: () => true, candidate, input, mode: "initial",
      observed: { outcome: "pending", resultRefs: [], sourceRefs: [input.sourceBindingRef], reason: "assigned_not_proof_of_execution" } });

    assert.ok(assigned.status === "written" || assigned.status === "previous");
    assignments.set(grantId, { input, candidate });

    return input;
  };
  const labelClosed = async (grantId: string) => {
    const assigned = assignments.get(grantId);
    assert.ok(assigned);
    assert.equal((await load()).centralLearningGrants!.find(row => row.grantId === grantId)!.status, "closed");
    const result = await recordCentralStageObservation({ boardRoot: root, enabled: () => true, ...assigned,
      observed: { outcome: "closed_no_result", resultRefs: [], sourceRefs: [assigned.input.sourceBindingRef],
        reason: "explicit_original_source_closure_without_delivered_candidate" } });
    assert.ok(result.status === "written" || result.status === "previous");
  };

  return { options, native, signal, load, act, select, accept, fund, close, assign, labelClosed, methodPort };
}

test("native episodes deduplicate the public program and actual source units while preserving original unknown charges", async t => {
  const h = await fixture(t), original = input(), initial = await h.select(original);

  assert.equal(initial.requestRef, original.requestRef);
  assert.equal(metadata(initial).selection, "initial");
  const issueId = await h.accept(initial), repeated = await h.select(shuffled(original));
  assert.equal(repeated.requestRef, initial.requestRef);
  assert.equal(metadata(repeated).programRef, metadata(initial).programRef);
  assert.deepEqual(repeated.materials[0], initial.materials[0], "repeated prepare preserves the first admitted metadata");
  const grantId = await h.fund(initial, issueId);
  await h.assign(issueId, grantId);
  await h.close(grantId, true);
  const money = centralBudgetProjection(await h.load(), "root:episodes");
  const held = (error: unknown) => error instanceof CentralResearchIntakeError && error.reason === "already_assigned_outcome_unresolved"
    && error.sourceRefs.includes(grantId);

  await assert.rejects(() => h.select(shuffled(original)), held);
  const modelOnly = centralMaterialFromPage({ ref: "model:another-proposal", originalRef: "model:another-proposal", originalScope: scope,
    origin: "model_proposal", owner: "board", coordinate: { runId: "model:another-proposal", sequence: 99 },
    sourceHash: contentHashOf("New model wording"), start: 0, end: 17, totalChars: 17, text: "New model wording" });

  await assert.rejects(() => h.select({ ...original, materials: [...original.materials, modelOnly] }), held);
  const untrusted = { ref: "user:json-body", kind: "source" as const, text: original.materials[0]!.text, sourceRefs: [] };

  await assert.rejects(() => h.select({ ...original, materials: [...original.materials, untrusted] }), held,
    "a user's JSON body cannot impersonate the host page owner");
  assert.notEqual((await h.select(input("prompt", 1, "Correction: the declaration was stale despite the first repair."))).requestRef, original.requestRef,
    "an actually read source revision changes its original body hash even without new knowledge wording");

  for (const origin of ["user_statement", "checker_result"] as const) {
    assert.notEqual((await h.select(input("prompt", 1, "The checker or user corrected the original result.", origin))).requestRef, original.requestRef);
  }

  const rawLater = await h.select(input("prompt", 2));

  assert.notEqual(rawLater.requestRef, initial.requestRef, "same source text at a different real coordinate is a new read unit");
  assert.equal(metadata(rawLater).selection, "derived_continuation");
  assert.deepEqual(metadata(rawLater).previous, { issueId, grantId, requestRef: initial.requestRef, programRef: metadata(initial).programRef });
  assert.deepEqual(rawLater.sourceRefs.slice(0, 4), [original.requestRef, metadata(rawLater).programRef, issueId, grantId]);
  const laterIssue = await h.accept(rawLater), laterGrant = await h.fund(rawLater, laterIssue);
  await h.assign(laterIssue, laterGrant);
  await h.close(laterGrant);
  await h.labelClosed(laterGrant);
  await assert.rejects(() => h.select(shuffled(input("prompt", 2))), error => error instanceof CentralResearchIntakeError
    && error.reason === "program_already_processed" && error.sourceRefs.includes(laterGrant));
  const complementary = await h.select(revised(original, "Compare the already-read prerequisite with its boundary counterexample"));

  assert.notEqual(complementary.requestRef, initial.requestRef);
  assert.notEqual(complementary.requestRef, rawLater.requestRef);
  assert.equal(metadata(complementary).selection, "derived_continuation");
  assert.ok(centralResearchEpisodeEvidence(complementary).some(row => row.ref === original.requestRef));
  assert.deepEqual(centralBudgetProjection(await h.load(), "root:episodes")?.occupied, money?.occupied,
    "a new phase does not refund or duplicate the old unknown reservation");
});

test("receiving B during assigned A stabilizes metadata but cannot pretend B executed after A closes", async t => {
  const h = await fixture(t), original = input(), first = await h.select(original), issueId = await h.accept(first);
  const grantId = await h.fund(first, issueId);
  await h.assign(issueId, grantId);
  const changed = revised(original, "Compare two already-read alternatives as a complementary computation"), open = await h.select(changed);

  assert.equal(open.requestRef, first.requestRef);
  assert.equal(metadata(open).selection, "reuse_open");
  await h.accept(open);
  const stillOpen = await h.select(shuffled(changed));
  assert.deepEqual(stillOpen.materials[0], open.materials[0]);
  await h.close(grantId);
  const repeated = await h.select(shuffled(changed));
  assert.notEqual(repeated.requestRef, first.requestRef,
    "B was only received; A's actual frozen assignment cannot consume B's opportunity");
  assert.equal(metadata(repeated).selection, "derived_continuation");
  await assert.rejects(() => h.select(shuffled(original)), error => error instanceof CentralResearchIntakeError
    && error.reason === "already_assigned_outcome_unresolved" && error.sourceRefs.includes(grantId));
});

test("unresolved multiple native sources and forged source-page metadata are rejected without writes", async t => {
  const h = await fixture(t), original = input(), first = await h.select(original), firstIssue = await h.accept(first);
  const grantId = await h.fund(first, firstIssue);
  await h.assign(firstIssue, grantId);
  await h.close(grantId);
  const a = await h.select(revised(original, "Read one complementary comparison"));
  const b = await h.select(revised(original, "Derive a different counterexample boundary"));

  await h.accept(a);
  await h.accept(b);
  const before = (await h.load()).sequence;

  await assert.rejects(() => h.select(revised(original, "A third direction")), error => error instanceof CentralResearchIntakeError
    && error.reason === "central_research_episode_multiple_open_sources");
  assert.equal((await h.load()).sequence, before);
  const forged = { ...original.materials[0]!, text: original.materials[0]!.text.replace('"sequence":1', '"sequence":999') };

  await assert.rejects(() => h.select({ ...original, materials: [forged] }), error => error instanceof CentralResearchIntakeError
    && error.reason === "central_research_source_page_invalid");
  const outside = centralMaterialFromPage({ ref: "session:outside", originalRef: "session:outside", originalScope: "workspace:elsewhere",
    origin: "user_statement", owner: "session", coordinate: { runId: "run:elsewhere", sequence: 1 }, sourceHash: contentHashOf("outside"),
    start: 0, end: 7, totalChars: 7, text: "outside" });

  await assert.rejects(() => h.select({ ...original, materials: [outside] }), error => error instanceof CentralResearchIntakeError
    && error.reason === "central_research_source_page_invalid");
});

test("a terminal native tool source can have a successor while its old root grant stays occupied; missing legacy program remains explicit", async t => {
  const h = await fixture(t), original = input("tool"), initial = await h.select(original), issueId = await h.accept(initial);
  const grantId = await h.fund(initial, issueId), board = await h.load();
  const source = board.learningIssues!.find(row => row.issueId === issueId)!.reports.find(row => "subsystem" in row.source)!;

  assert.ok("versionId" in source.source);
  const jobId = source.source.versionId;
  const started = await withBoardWriter(h.options.boardRoot, store => store.apply({ type: "start_job", commandId: "tool:start", issuedAt: at, jobId }));
  assert.ok(started.ok);
  const finished = await withBoardWriter(h.options.boardRoot, store => store.apply({ type: "complete_job", commandId: "tool:done", issuedAt: at, jobId, next: "succeeded" }));
  assert.ok(finished.ok);
  const next = await h.select(revised(original, "Compare the tool's already-read error contract"));
  assert.notEqual(next.requestRef, initial.requestRef);
  assert.equal((await h.load()).centralLearningGrants!.find(row => row.grantId === grantId)!.status, "open");
  const legacy = await fixture(t), legacyInput = input("tool");
  await legacy.accept(legacyInput);
  const selected = await legacy.select(revised(legacyInput, "A different program cannot invent its predecessor's missing program"));

  assert.equal(selected.requestRef, legacyInput.requestRef);
  assert.equal(metadata(selected).selection, "legacy_program_unrecorded");
  const interrupted = await fixture(t), interruptedInput = input("tool"), first = await interrupted.select(interruptedInput);
  const native = await acceptCentralToolResearch(interrupted.native, first, interrupted.signal);
  assert.ok(native.status === "accepted");
  const resumed = await interrupted.select(interruptedInput);

  assert.deepEqual(resumed.materials[0], first.materials[0], "a crash after native source commit cannot change the first metadata before reception is logged");
});

test("an original assigned stage with missing frozen evidence holds inspection instead of opening a blind successor", async t => {
  const h = await fixture(t), first = await h.select(input()), issueId = await h.accept(first), grantId = await h.fund(first, issueId);
  const assigned = await h.assign(issueId, grantId);
  await h.close(grantId);
  const directory = path.join(h.options.boardRoot, "central-decisions", "stage-evidence");
  const file = path.join(directory, `${contentHashOf([grantId, assigned.stageRef])}.json`);

  assert.equal(path.dirname(file), directory);
  await rename(file, file + ".evidence-backup");
  const before = await h.load();

  await assert.rejects(() => h.select(revised(input(), "Compare another complementary use")), error => error instanceof CentralResearchIntakeError
    && error.reason === "central_research_episode_assignment_inspection_required");
  assert.deepEqual(await h.load(), before);
});

test("a confirmed native internal finding can continue the same program and grant, but an already assigned next cursor cannot be bought again", async t => {
  const h = await fixture(t), original = input(), initial = await h.select(original), issueId = await h.accept(initial), grantId = await h.fund(initial, issueId);
  const stage = await h.assign(issueId, grantId, { ...allowance, maxCalls: 1, maxSteps: 1 });
  let calls = 0;
  const child: ProviderPort = { async *stream() {
    calls += 1;
    yield { type: "stream_start", providerId: "scripted", model: "test:episode-model", warnings: [] };
    yield { type: "text_delta", blockId: "finding", text: JSON.stringify({ kind: "finding", statement: "A declared schema is a conditional prerequisite.",
      conditions: "The task supplies a declared schema", sourceRefs: [original.materials[0]!.ref], residual: ["Compare the prerequisite with its exception next"] }) };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 60, outputTokens: 40, totalTokens: 100 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const port = h.methodPort({ ...child, fork: () => child });
  const worked = await port.dispatch(stage, h.signal);
  assert.ok(worked.ok);
  assert.equal(calls, 1);
  const readContinuation = createCentralRuntimeResearchContinuation(h.native.workspaceId);
  const continued = await h.select(shuffled(original), { readContinuation });
  assert.equal(continued.requestRef, initial.requestRef);
  assert.equal((await h.load()).centralLearningGrants!.length, 1);
  assert.equal(calls, 1);
  await h.assign(issueId, grantId, { ...allowance, maxCalls: 1, maxSteps: 1 });
  await assert.rejects(() => h.select(shuffled(original), { readContinuation }), error => error instanceof CentralResearchIntakeError
    && error.reason === "method_research_continuation_stage_input_mismatch" && error.sourceRefs.includes(grantId)
    && error.sourceRefs.some(ref => ref.startsWith("method-research-record:")));
  assert.equal(calls, 1);
  assert.equal((await h.load()).centralLearningGrants![0]!.reservations.length, 1);
});
