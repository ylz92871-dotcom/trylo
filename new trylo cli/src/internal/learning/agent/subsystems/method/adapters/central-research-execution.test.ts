import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import type { GroundedCentralResearch } from "../../../../../integration/central-learning/research-intake-common.js";
import type { CentralLearningExecutionPort, CentralStagePreparation } from "../../../../../integration/central-learning/contracts.js";
import type { CentralPursuitCandidate } from "../../../../control/decision/pursuit-contract.js";
import { retainFrozenStage } from "../../../../../integration/central-learning/stage-evidence.js";
import { emptyUsage, type ProviderPort } from "../../../../../ports/provider.js";
import { acceptCentralMethodResearch } from "./central-research-intake.js";
import { createCentralMethodResearchExecution } from "./central-research-execution.js";
import { readCentralMethodResearchMaterial, readMethodResearch } from "./central-research-records.js";
import { publishCentralMethodResearchCandidate, readCentralMethodResearchCandidates } from "./central-research-candidate.js";
import { createExperienceStore } from "./experience-store.js";
import { createMethodBoardWriter } from "./board-writer.js";
import { createExperienceRuntime } from "../orchestration/experience-runtime.js";
import { scopesOf, snapshotOf, matureReview } from "../domain/experience-state.js";
import { createCentralRuntimeSource } from "../../../../../integration/central-learning/runtime-source.js";
import { createExperienceTools, METHOD_CONTEXT_TOOL } from "./experience-tools.js";
import { methodCentralFeedbackFromBoard } from "./central-history.js";
import { projectOrganizationDomainRows } from "../../../../../integration/central-learning/organization-feedback-domain.js";
import { recordCentralResearchProgram } from "../../../../../integration/central-learning/research-intake-program-report.js";
import { selectCentralResearchEpisode } from "../../../../../integration/central-learning/research-intake-episode.js";
import { readCentralMethodResearchContinuation } from "./central-research-continuation.js";
import { readCentralMethodResearchStageProduction, createCentralMethodResearchProductionReader } from "./central-research-production.js";
import { contentHashOf } from "../../../../control/hash.js";

const scope = "workspace:method-research", at = "2026-11-05T01:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 24000, maxCalls: 3, maxSteps: 3, maxPromptChars: 12000 };
const operation = { kind: "dispatch" as const, operationId: "op:method-research", purpose: "Compare reusable method prerequisites",
  expectedChange: "A conditional method candidate", sourceRefs: ["source:solved-business"], allowance,
  destination: { plane: "agent" as const, domain: "prompt" as const } };
const request: GroundedCentralResearch = { requestRef: "request:method-research", domain: "prompt", operation,
  intent: { intentId: "intent:method-research", subject: { plane: "central", questionRef: "intent:method-research" },
    goal: "Learn when schema inspection must precede file editing", rationale: "Related solved tasks expose a reusable prerequisite",
    conditions: ["structured files"], knowledge: [{ statement: "Some inputs have external schema declarations", conditions: "JSON work",
      sourceRefs: ["source:solved-business"] }], residual: ["What is the safe transfer boundary?"],
    commitment: { purpose: "Compare reusable prerequisites", assumptions: ["Source task is solved"], reconsiderWhen: ["A counterexample arrives"] },
    revisionReason: "New comparative purpose", sourceRefs: ["source:solved-business"], continuation: { kind: "ready", operation } },
  materials: [{ ref: "source:solved-business", kind: "source", text: "Task was solved after reading the declared JSON schema.", sourceRefs: [] }],
  sourceRefs: ["source:solved-business"] };

for (const legacy of [false, true]) test(`a paid invalid method response ${legacy ? "recovers its original native finish" : "leaves a negative checkpoint on the original grant"}`, async t => {
  const root = await mkdtemp(testScratchPath("method-rejected-response-"));

  t.after(async () => {
    assert.ok(root.startsWith(testScratchPath() + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const options = { boardRoot: root, scope, workspaceId: "legacy:method-research", now: () => Date.parse(at), enabled: () => true };
  const signal = new AbortController().signal, accepted = await acceptCentralMethodResearch(options, request, signal);

  assert.ok(accepted.status === "accepted");
  let serial = 0, calls = 0;
  const load = async () => {
    const result = await createBoardReader(root).load();
    assert.ok(result.ok);
    return result.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning", commandId: `negative:${++serial}`, issuedAt: at, action }));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };

  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1,
    budgetId: "budget:method-research", scope, unit: "total_model_tokens", limits: { tokens: 30000, calls: 4, steps: 4 }, authorizationRef: "test:explicit" } });
  const initial = (await load()).learningIssues!.find(row => row.issueId === accepted.issueId)!;

  await act({ kind: "decide", issueId: initial.issueId, expectedRevision: initial.revision, decision: "focused_learning", reason: "Test original method recovery", sourceRefs: request.sourceRefs });
  const child: ProviderPort = { async *stream() {
    calls++;
    yield { type: "stream_start", providerId: "test", model: "test", warnings: [] };
    yield { type: "text_delta", blockId: "text", text: '{"kind":"candidate"}' };
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 60, outputTokens: 40, totalTokens: 100 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const original: CentralLearningExecutionPort = { domain: "prompt", async prepare() { throw new Error("unexpected_delegate"); },
    async dispatch() { throw new Error("unexpected_delegate"); }, async observe() { throw new Error("unexpected_delegate"); } };
  const port = createCentralMethodResearchExecution({ ...options, provider: { ...child, fork: () => child }, model: "test" }, original);
  const one = { ...allowance, maxCalls: 1, maxSteps: 1 };
  const quoted = await port.prepare({ issueId: initial.issueId, authorizedAllowance: allowance, operationAllowance: one }, signal);

  assert.ok(quoted.status === "ready");
  const before = await load(), focused = before.learningIssues!.find(row => row.issueId === initial.issueId)!;

  await act({ kind: "fund", domain: "prompt", issueId: initial.issueId, expectedRevision: focused.revision,
    grantId: quoted.source.grantId, allowance, budgetId: "budget:method-research", authorizationRef: "test:explicit", planRef: "test:plan", expectedSequence: before.sequence });
  const issue = (await load()).learningIssues!.find(row => row.issueId === initial.issueId)!;
  const funded = { issueId: issue.issueId, grantId: quoted.source.grantId, expectedIssueRevision: issue.revision,
    stageRef: quoted.stageRef, policyRef: quoted.policyRef, sourceBindingRef: quoted.source.sourceBindingRef, offer: quoted.offer };

  assert.equal((await retainFrozenStage({ boardRoot: root, candidate: stageCandidate(quoted), input: funded })).status, "retained");

  if (legacy) {
    const claimId = "claim:legacy-rejected", grant = (await load()).centralLearningGrants![0]!;
    const history = readMethodResearch(await load(), scope, request.requestRef)!;
    const reservationId = `method-research-call:${contentHashOf([funded.stageRef, history.headRef, "test"])}`;

    await act({ kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId, ownerId: request.requestRef,
      expiresAt: "2026-11-05T01:10:00.000Z", expectedIssueRevision: issue.revision });
    await act({ kind: "reserve", grantId: grant.grantId, claimId, reservationId, maxTokens: allowance.maxTokens });
    await act({ kind: "settle", grantId: grant.grantId, reservationId,
      usage: { kind: "reported", totalTokens: 100, inputTokens: 60, outputTokens: 40, model: "test" } });
    await act({ kind: "finish", jobId: grant.jobId, claimId, expectedIssueRevision: issue.revision,
      result: { kind: "yielded", reason: "method_research_output_invalid" } });
  }

  assert.ok((await port.dispatch(funded, signal)).ok);
  const board = await load(), history = readMethodResearch(board, scope, request.requestRef)!;

  assert.equal(history.steps.length, 0);
  assert.equal(history.checkpoints.length, 1, "known paid rejection is durable without inventing a finding");
  assert.equal(board.centralLearningGrants![0]!.reservations[0]!.usage?.kind, "reported");
  assert.equal(board.assets.length, 0);
  assert.equal(calls, legacy ? 0 : 1);
  const continuation = readCentralMethodResearchContinuation({ board, scope, issueId: issue.issueId, grantId: funded.grantId,
    lastStageInputHash: contentHashOf(funded), previousCursorRefs: quoted.source.domainStage.readiness.evidenceRefs });

  assert.equal(continuation.kind, "continuable");
  assert.equal((await port.observe(funded, signal)).outcome, "closed_no_result");
  assert.equal((await port.prepare({ issueId: issue.issueId, authorizedAllowance: allowance, operationAllowance: one }, signal)).status, "ready");
  assert.equal(calls, legacy ? 0 : 1, "preparation must not rebill the original rejection");
});

function stageCandidate(prepared: Extract<CentralStagePreparation, { readonly status: "ready" }>): CentralPursuitCandidate {
  return { opportunity: { opportunityId: prepared.offer.offerId, scope, targetRef: "definition:method-research-candidate",
    instanceRef: prepared.stageRef, sourceRef: prepared.source.sourceBindingRef, stage: prepared.source.domainStage.kind,
    conditionRef: "condition:original-method-research", baselineRef: "baseline:test-idle", windowRef: "window:method-research-test", offer: prepared.offer },
    source: prepared.source, readiness: { kind: "ready", sourceRef: prepared.source.sourceBindingRef, now: Date.parse(at), nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "definition:method-research-candidate" },
    fee: { kind: "hard-budget-only", sourceRef: "budget:method-research" }, purpose: "focused_learning",
    objective: { instanceId: "objective:original-method-research", criterion: "proposal_delivered", definitionRef: "definition:method-research-candidate",
      familyRef: "family:method-research-test", familySourceRef: prepared.policyRef } };
}

test("new method research reaches a native funded candidate and source trial without fake observations", async t => {
  const root = await mkdtemp(testScratchPath("central-method-research-"));

  t.after(async () => {
    assert.ok(root.startsWith(testScratchPath() + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const options = { boardRoot: root, scope, workspaceId: "legacy:method-research", now: () => Date.parse(at), enabled: () => true };
  const signal = new AbortController().signal;
  const accepted = await acceptCentralMethodResearch(options, request, signal);
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.status === "accepted");
  const repeated = await acceptCentralMethodResearch({ ...options, now: () => Date.parse(at) + 1000 }, request, signal);

  assert.deepEqual(repeated, accepted);
  let serial = 0;
  const load = async () => {
    const result = await createBoardReader(root).load();
    assert.ok(result.ok);
    return result.state;
  };
  const apply = async (action: CoordinationAction) => {
    const result = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning", commandId: `test:${++serial}`, issuedAt: at, action }));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };

  await apply({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1,
    budgetId: "budget:method-research", scope, unit: "total_model_tokens", limits: { tokens: 30000, calls: 4, steps: 4 }, authorizationRef: "test:explicit" } });
  let initial = (await load()).learningIssues!.find(row => row.issueId === accepted.issueId)!;

  assert.deepEqual(initial.reports[0]!.source, { kind: "research_request", domain: "prompt", requestRef: request.requestRef, intentRef: request.intent.intentId });
  const program = await selectCentralResearchEpisode(options, request, signal);

  assert.equal((await recordCentralResearchProgram(options, program, accepted, signal)).status, "accepted");
  initial = (await load()).learningIssues!.find(row => row.issueId === accepted.issueId)!;
  const programReport = initial.reports.at(-1)!;

  assert.ok(programReport.reportId.startsWith("central-research-program-report:"));
  await apply({ kind: "decide", issueId: initial.issueId, expectedRevision: initial.revision, decision: "focused_learning", reason: "Test authorized purpose", sourceRefs: request.sourceRefs });
  let calls = 0;
  const child: ProviderPort = { async *stream(sent) {
    calls += 1;
    const running = readCentralMethodResearchContinuation({ board: await load(), scope, issueId: accepted.issueId,
      grantId: funded.grantId, lastStageInputHash: contentHashOf(funded), previousCursorRefs: [] });

    assert.ok(running.kind === "waiting");
    assert.equal(running.reason, "method_research_continuation_original_owner_running");
    const body = JSON.parse(sent.messages.find(row => row.role === "user")!.content);

    assert.deepEqual(body.currentPurpose, preparedContext, "dispatch consumes the original frozen ready packet after the runtime enters running");
    assert.ok(sent.messages.some(row => row.content.includes(request.intent.goal) && row.content.includes(request.intent.knowledge[0]!.statement)));

    if (calls === 2) assert.ok(sent.messages.some(row => row.content.includes("Schema inspection is conditional")));

    const finding = { kind: calls === 1 ? "finding" : "candidate", statement: calls === 1 ? "Schema inspection is conditional" : "Inspect declared schemas before editing structured payloads",
      conditions: "A task declares a schema", sourceRefs: request.sourceRefs, residual: ["Transfer to implicit schemas remains unknown"],
      ...(calls === 1 ? {} : { candidate: { hint: "Inspect the declared schema before editing structured payloads.", scope: { description: "Tasks that declare a JSON schema",
        predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } } } }) };

    yield { type: "stream_start", providerId: "scripted", model: "scripted-method", warnings: [] };
    yield { type: "text_delta", blockId: "text", text: JSON.stringify(finding) };
    yield { type: "usage", usage: { ...emptyUsage(), totalTokens: 100, inputTokens: 60, outputTokens: 40 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const original: CentralLearningExecutionPort = { domain: "prompt", async prepare() { throw new Error("original_review_only"); },
    async dispatch() { throw new Error("original_review_only"); }, async observe() { throw new Error("original_review_only"); } };
  const preparedContext = { ref: "context:original-ready-method-research", text: "Original ready purpose: compare the declared schema prerequisite before a bounded source trial. "
    + JSON.stringify({ sourceReportId: programReport.reportId, program: program.materials[0] }) };
  let currentContext: { readonly ref: string; readonly text: string } | undefined = preparedContext;
  let contextReads = 0;
  const port = createCentralMethodResearchExecution({ ...options, provider: { ...child, fork: () => child }, model: "scripted-method",
    contextForIssue: async () => {
      contextReads += 1;
      return currentContext;
    } }, original);
  const cumulative = { ...allowance, maxTokens: 1000000, maxCalls: 100000, maxSteps: 100000 };
  const operationBudget = { ...allowance, maxTokens: 11000, maxCalls: 2, maxSteps: 1 };
  const operationQuote = await port.prepare({ issueId: accepted.issueId, authorizedAllowance: cumulative, operationAllowance: operationBudget }, signal);

  assert.ok(operationQuote.status === "ready");
  assert.ok(operationQuote.offer.reserve.tokens <= operationBudget.maxTokens);
  assert.ok(operationQuote.offer.reserve.calls <= operationBudget.maxCalls);
  assert.ok(operationQuote.offer.reserve.steps <= operationBudget.maxSteps);
  assert.equal(operationQuote.offer.maxPromptChars, Math.min(cumulative.maxPromptChars, operationBudget.maxPromptChars));
  assert.deepEqual(operationQuote.sourceContext, preparedContext);
  const exhausted = await port.prepare({ issueId: accepted.issueId,
    authorizedAllowance: { ...cumulative, maxTokens: 0, maxCalls: 0, maxSteps: 0 }, operationAllowance: operationBudget }, signal);

  assert.equal(exhausted.status, "waiting");
  assert.equal(calls, 0);
  assert.notEqual((await port.prepare({ issueId: accepted.issueId, authorizedAllowance: cumulative }, signal)).status, "ready",
    "a large cumulative allowance is not silently interpreted as one legacy operation");
  assert.equal(calls, 0);
  const oneStep = { ...allowance, maxCalls: 1, maxSteps: 1 };
  const quoted = await port.prepare({ issueId: accepted.issueId, authorizedAllowance: allowance, operationAllowance: oneStep }, signal);
  assert.equal(quoted.status, "ready");
  assert.ok(quoted.status === "ready");
  assert.equal(quoted.source.domainStage.sourceReportId, programReport.reportId, "the actual frozen assignment identifies its program reception, not the first request report");
  const beforeFund = await load(), focused = beforeFund.learningIssues!.find(row => row.issueId === accepted.issueId)!;

  await apply({ kind: "fund", domain: "prompt", issueId: accepted.issueId, expectedRevision: focused.revision,
    grantId: quoted.source.grantId, allowance, budgetId: "budget:method-research", authorizationRef: "test:explicit", planRef: "test:plan", expectedSequence: beforeFund.sequence });
  const issue = (await load()).learningIssues!.find(row => row.issueId === accepted.issueId)!;
  let funded = { issueId: issue.issueId, grantId: quoted.source.grantId, expectedIssueRevision: issue.revision,
    stageRef: quoted.stageRef, policyRef: quoted.policyRef, sourceBindingRef: quoted.source.sourceBindingRef, offer: quoted.offer,
    ...(quoted.sourceContext === undefined ? {} : { sourceContext: quoted.sourceContext }) };
  const frozen = await retainFrozenStage({ boardRoot: root, candidate: stageCandidate(quoted), input: funded });

  assert.equal(frozen.status, "retained");
  currentContext = { ref: "context:running-method-research", text: "Running bookkeeping and later public material must wait for another preparation." };
  const beforeDispatch = (await load()).sequence, readsBeforeDispatch = contextReads;
  const forged = await port.dispatch({ ...funded, sourceContext: { ...preparedContext, text: "Unfrozen replacement purpose" } }, signal);

  assert.equal(forged.ok, false);
  assert.equal(calls, 0);
  assert.equal((await load()).sequence, beforeDispatch);
  const { sourceContext: _sourceContext, ...stripped } = funded;
  const strippedResult = await port.dispatch(stripped, signal);

  assert.equal(strippedResult.ok, false);
  assert.equal(calls, 0);
  assert.equal((await load()).sequence, beforeDispatch);
  const firstFunded = funded;
  const firstResult = await port.dispatch(funded, signal);
  assert.ok(firstResult.ok);
  assert.equal(calls, 1);
  assert.equal(contextReads, readsBeforeDispatch, "frozen dispatch does not ask the now-running context reader for a different packet");
  const continuedBoard = await load(), previousCursorRefs = quoted.source.domainStage.readiness.evidenceRefs;
  const cursorInput = { board: continuedBoard, scope, issueId: issue.issueId, grantId: funded.grantId,
    lastStageInputHash: contentHashOf(funded), previousCursorRefs };
  const continuation = readCentralMethodResearchContinuation(cursorInput);
  assert.ok(continuation.kind === "continuable");
  assert.ok(continuedBoard.rewardV2Facts?.some(row => row.id === continuation.cursorRef));
  const consumed = readCentralMethodResearchContinuation({ ...cursorInput, previousCursorRefs: [...previousCursorRefs, continuation.cursorRef] });

  assert.ok(consumed.kind === "waiting");
  assert.equal(consumed.reason, "method_research_continuation_cursor_already_consumed");
  assert.equal(readCentralMethodResearchContinuation({ ...cursorInput, lastStageInputHash: "0".repeat(64) }).kind, "inspection");
  const lost = readCentralMethodResearchContinuation({ ...cursorInput, board: { ...continuedBoard,
    rewardV2Facts: continuedBoard.rewardV2Facts!.filter(row => row.id !== continuation.cursorRef) } });

  assert.ok(lost.kind === "inspection");
  assert.equal(lost.reason, "method_research_continuation_paid_checkpoint_missing");
  currentContext = preparedContext;
  const secondStage = await port.prepare({ issueId: issue.issueId, authorizedAllowance: allowance, operationAllowance: oneStep }, signal);
  assert.ok(secondStage.status === "ready");
  funded = { issueId: issue.issueId, grantId: secondStage.source.grantId, expectedIssueRevision: issue.revision,
    stageRef: secondStage.stageRef, policyRef: secondStage.policyRef, sourceBindingRef: secondStage.source.sourceBindingRef, offer: secondStage.offer,
    ...(secondStage.sourceContext === undefined ? {} : { sourceContext: secondStage.sourceContext }) };
  assert.equal((await retainFrozenStage({ boardRoot: root, candidate: stageCandidate(secondStage), input: funded })).status, "retained");
  currentContext = { ref: "context:second-running", text: "The second internal segment uses its own prepared packet." };
  const secondReads = contextReads;
  const result = await port.dispatch(funded, signal);
  assert.ok(result.ok);
  assert.equal(calls, 2);
  assert.equal(contextReads, secondReads);
  const board = await load(), grant = board.centralLearningGrants![0]!;

  assert.equal(grant.reservations.length, 2);
  assert.ok(grant.reservations.every(row => row.usage?.kind === "reported"));
  assert.equal(grant.claim, undefined);
  assert.equal(grant.status, "open");
  assert.equal(board.assets.length, 1);
  assert.equal(board.feedbacks.length, 0);
  const observed = await port.observe(funded, signal);
  assert.equal(observed.outcome, "qualified");
  assert.equal(observed.resultRefs.length, 2);
  const firstObserved = await port.observe(firstFunded, signal);
  assert.equal(firstObserved.outcome, "closed_no_result");
  assert.equal(firstObserved.resultRefs.length, 1);
  const delivered = readCentralMethodResearchContinuation({ board, scope, issueId: issue.issueId, grantId: funded.grantId,
    lastStageInputHash: contentHashOf(funded), previousCursorRefs: secondStage.source.domainStage.readiness.evidenceRefs });

  assert.ok(delivered.kind === "waiting");
  assert.equal(delivered.reason, "method_research_continuation_candidate_delivered");
  const wrongStage = await port.observe({ ...funded, stageRef: funded.stageRef + ":not-dispatched" }, signal);

  assert.equal(wrongStage.outcome, "pending");
  assert.deepEqual(wrongStage.resultRefs, []);
  const material = readCentralMethodResearchMaterial(board, scope, observed.resultRefs[0]!);
  assert.ok(material?.text.includes("Inspect declared schemas"));
  const publicSource = createCentralRuntimeSource({ boardRoot: root, scope, ports: [], enabled: () => true });
  const returned = await publicSource.read(scope, [observed.resultRefs[0]!], 12000, signal);

  assert.ok(returned.some(row => row.text.includes("Inspect declared schemas") && row.sourceRefs.includes(request.intent.intentId)));
  currentContext = preparedContext;
  const next = await port.prepare({ issueId: issue.issueId, authorizedAllowance: allowance }, signal);

  assert.equal(next.status, "waiting");
  assert.equal(calls, 2);
  currentContext = { ref: "context:compare-transfer", text: "Compare the candidate's transfer boundary using the same original materials." };
  const future = await port.prepare({ issueId: issue.issueId, authorizedAllowance: allowance }, signal);
  assert.ok(future.status === "ready");
  const laterUnexecuted = await port.observe({ issueId: issue.issueId, grantId: funded.grantId, expectedIssueRevision: issue.revision,
    stageRef: future.stageRef, policyRef: future.policyRef, sourceBindingRef: future.source.sourceBindingRef, offer: future.offer,
    ...(future.sourceContext === undefined ? {} : { sourceContext: future.sourceContext }) }, signal);

  assert.equal(laterUnexecuted.outcome, "pending");
  assert.deepEqual(laterUnexecuted.resultRefs, []);
  assert.equal(calls, 2);
  const candidate = readCentralMethodResearchCandidates(board, scope, request.requestRef)[0];
  assert.ok(candidate);
  const production = readCentralMethodResearchStageProduction(board, { scope, input: funded });
  assert.ok(production);
  assert.deepEqual(readCentralMethodResearchStageProduction(board, { scope, input: funded, workspaceId: options.workspaceId }), production);
  assert.equal(readCentralMethodResearchStageProduction(board, { scope, input: funded, workspaceId: "workspace:foreign-publisher" }), undefined);
  const productionReader = createCentralMethodResearchProductionReader(board, { scope, workspaceId: options.workspaceId });

  assert.deepEqual(productionReader(funded), production);
  assert.equal(productionReader(firstFunded), undefined);
  assert.deepEqual(productionReader(funded), production, "one loaded-Board session reuses request decoding without changing stage attribution");
  assert.deepEqual(production.publishedVersionRefs, [candidate.versionId]);
  assert.deepEqual(production.checkpointRefs, [candidate.checkpointRef]);
  assert.deepEqual(production.reservationRefs, [candidate.reservationId]);
  assert.equal(board.jobs.find(row => row.jobId === grant.jobId)?.state, "queued", "yielded publication is production before job success");
  assert.equal(readCentralMethodResearchStageProduction(board, { scope, input: firstFunded }), undefined, "the earlier finding stage did not produce this later card");
  assert.equal(readCentralMethodResearchStageProduction(board, { scope, input: { ...funded, stageRef: funded.stageRef + ":foreign" } }), undefined);
  assert.equal(readCentralMethodResearchStageProduction({ ...board, assets: board.assets.map(asset => ({ ...asset, scope })) }, { scope, input: funded }), undefined,
    "a lineage label on an asset outside the original publisher's niche is no publication proof");
  assert.deepEqual(readCentralMethodResearchStageProduction({ ...board, centralLearningGrants: board.centralLearningGrants!.map(row => ({ ...row,
    reservations: row.reservations.map(reservation => reservation.reservationId === candidate.reservationId
      ? { ...reservation, usage: { kind: "unknown" as const, reason: "The original paid call's billing is unconfirmed." } } : reservation) })) },
  { scope, input: funded }), production, "unknown billing retains the already published card without changing the original reservation charge");
  const originalFrame = methodCentralFeedbackFromBoard(board, { scope, issueId: issue.issueId });
  assert.ok(originalFrame);
  assert.ok(originalFrame.sourceRefs.includes(request.intent.intentId));
  assert.ok(originalFrame.sourceRefs.includes(candidate.versionId));
  const store = createExperienceStore(root, () => at), view = await store.load();
  const hypothesis = scopesOf(view, candidate.versionId).find(row => row.hypothesis.scopeId === candidate.scopeId)!.hypothesis;

  assert.equal(snapshotOf(view, hypothesis).evidence.observations.length, 0);
  assert.equal(matureReview(view, hypothesis), undefined);
  const runtime = createExperienceRuntime({ store, emit: () => {}, correct: async () => {}, revise: async () => {} });

  assert.ok((await runtime.catalog()).includes("sourceTrialRequired"));
  const task = { taskId: "real:next-task", opportunityId: "schema-edit", situation: "Edit a JSON file under a declared schema", features: { format: "json" } };

  assert.equal((await runtime.context(task)).length, 0);
  const tools = createExperienceTools({ runtime, taskId: task.taskId });
  const trial = await tools.execute({ toolCallId: "tool:trial", name: METHOD_CONTEXT_TOOL,
    arguments: { operation: "context", situation: task.situation, opportunityId: task.opportunityId, features: task.features,
      trial: { versionId: candidate.versionId, scopeId: candidate.scopeId } } }, signal);

  assert.ok(trial.outcome === "result");
  assert.ok(trial.output.includes(candidate.versionId));
  assert.ok(trial.output.includes('"stable":false'));
  const delivery = await runtime.slot(task.taskId);
  assert.ok(delivery);
  const receipt = delivery.receipts.find(row => row.versionId === candidate.versionId);
  assert.ok(receipt?.binding);
  const writer = createMethodBoardWriter(root), exposureId = "exposure:research-trial";
  const nativeAsset = (await load()).assets.find(row => row.versionId === candidate.versionId)!;

  assert.ok((await writer.recordUse({ writeId: exposureId, exposureId, versionId: candidate.versionId,
    proposalId: nativeAsset.createdFromProposalId!, turnId: task.taskId, beat: 1, requestId: "request:next-task", scope: candidate.scopeId,
    observedAt: at, binding: receipt.binding })).ok);
  const adopted = await tools.execute({ toolCallId: "tool:adopt", name: METHOD_CONTEXT_TOOL,
    arguments: { operation: "adopt", versionId: candidate.versionId, scopeId: candidate.scopeId,
      reason: "Apply the disclosed source method in this matching task" } }, signal);

  assert.equal(adopted.outcome, "result");
  const second = await runtime.slot(task.taskId, undefined, undefined, undefined, 10);
  assert.ok(second);
  const secondReceipt = second.receipts.find(row => row.versionId === candidate.versionId);
  assert.ok(secondReceipt?.binding);
  const actualUse = "exposure:research-trial-second";

  assert.ok((await writer.recordUse({ writeId: actualUse, exposureId: actualUse, versionId: candidate.versionId,
    proposalId: nativeAsset.createdFromProposalId!, turnId: task.taskId, beat: 2, requestId: "request:next-task-second", scope: candidate.scopeId,
    observedAt: at, binding: secondReceipt.binding })).ok);
  await runtime.observeBeat?.({ turnId: task.taskId, beat: 2, failures: [], succeededTools: ["read_file"], toolNames: ["read_file"],
    executionSpan: { firstSequence: 11, lastSequence: 12, toolNames: ["read_file"] } });
  assert.ok((await writer.recordFeedback({ writeId: "feedback:research-trial", exposureId: actualUse, versionId: candidate.versionId,
    turnId: task.taskId, helped: true, context: task, observedAt: at })).ok);
  const third = await runtime.slot(task.taskId, undefined, undefined, undefined, 20);
  assert.ok(third);
  const thirdReceipt = third.receipts.find(row => row.versionId === candidate.versionId);
  assert.ok(thirdReceipt?.binding);
  const laterUse = "exposure:research-trial-third";

  assert.ok((await writer.recordUse({ writeId: laterUse, exposureId: laterUse, versionId: candidate.versionId,
    proposalId: nativeAsset.createdFromProposalId!, turnId: task.taskId, beat: 3, requestId: "request:next-task-third", scope: candidate.scopeId,
    observedAt: at, binding: thirdReceipt.binding })).ok);
  await runtime.observeBeat?.({ turnId: task.taskId, beat: 3, failures: [{ tool: "read_file", code: "ENOENT", fingerprint: "request:third" }],
    succeededTools: [], toolNames: ["read_file"], executionSpan: { firstSequence: 21, lastSequence: 22, toolNames: ["read_file"] } });
  assert.ok((await writer.recordFeedback({ writeId: "feedback:research-trial-third", exposureId: laterUse, versionId: candidate.versionId,
    turnId: task.taskId, helped: true, context: task, observedAt: at })).ok);
  const learned = await store.load();

  assert.equal(snapshotOf(learned, hypothesis).evidence.observations.length, 1);
  assert.equal(matureReview(learned, hypothesis), undefined);
  const lateFrame = methodCentralFeedbackFromBoard(await load(), { scope, issueId: issue.issueId });
  assert.ok(lateFrame);
  const assessments = lateFrame.records.filter(row => row.kind === "method_assessment");
  assert.equal(assessments.length, 1);
  assert.equal(assessments[0]!.exposureId, actualUse, "retain the actual assessment writer's exposure despite several matching opportunity tuples");
  const executionRows = lateFrame.records.filter(row => row.kind === "method_execution");
  assert.equal(executionRows.length, 2);
  const feedback = projectOrganizationDomainRows("decision:original-method-research", lateFrame, [candidate.versionId]);
  const outcomes = feedback.filter(row => row.result.kind === "outcome");
  assert.equal(outcomes.length, 1);
  assert.ok(outcomes[0]!.result.kind === "outcome");
  assert.equal(outcomes[0]!.result.exposureRef, actualUse);
  assert.equal(outcomes[0]!.result.state, "observed");
  assert.equal(calls, 2, "trial and feedback do not buy another research call");
  const history = readMethodResearch(await load(), scope, request.requestRef)!;
  const checkpoint = history.steps.at(-1)!;
  const publication = { request: history.request, finding: checkpoint.step.finding,
    reservationId: checkpoint.step.reservationId, checkpointRef: checkpoint.ref };
  const beforeReplay = (await load()).sequence;

  await publishCentralMethodResearchCandidate({ ...options, now: () => Date.parse(at) + 1000 }, publication, signal);
  assert.equal((await load()).sequence, beforeReplay);
  assert.equal(calls, 2);
  const evicted = await withBoardWriter(root, store => store.apply({ type: "set_method_retention", commandId: "test:evict-source", issuedAt: at,
    record: { versionId: candidate.versionId, layer: "working", retention: "evicted", recordedAt: at } }));

  assert.ok(evicted.ok, JSON.stringify(evicted));
  assert.equal(readCentralMethodResearchCandidates(await load(), scope, request.requestRef)[0]?.availability, "withdrawn");
  assert.deepEqual(readCentralMethodResearchStageProduction(await load(), { scope, input: funded }), production,
    "withdrawal removes current trial availability without erasing original stage production");
  const beforeReject = (await load()).sequence;

  await assert.rejects(() => publishCentralMethodResearchCandidate(options, publication, signal), /withdrawn/);
  assert.equal((await load()).sequence, beforeReject);
  assert.equal(calls, 2);
  const closedIssue = (await load()).learningIssues!.find(row => row.issueId === issue.issueId)!;

  await apply({ kind: "decide", issueId: issue.issueId, expectedRevision: closedIssue.revision, decision: "resolved",
    reason: "End the controlled fixture's original learning purpose", sourceRefs: [request.intent.intentId] });
  assert.equal(readCentralMethodResearchContinuation({ board: await load(), scope, issueId: issue.issueId, grantId: funded.grantId,
    lastStageInputHash: contentHashOf(funded), previousCursorRefs: [] }).kind, "terminal");
  assert.equal(calls, 2);
  assert.deepEqual(readCentralMethodResearchStageProduction(await load(), { scope, input: funded }), production,
    "later original owner closure preserves the historical publication proof");
});
