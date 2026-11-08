import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { BOARD_LOG_FILE } from "../../../../../adapters/learning-store/board-replay.js";
import { decodeLog } from "../../../../../adapters/learning-store/codec.js";
import { createOpenAiCompatibleProvider } from "../../../../../adapters/provider/openai-compatible.js";
import type { CentralFundedStage, CentralLearningExecutionPort, CentralStagePreparation } from "../../../../../integration/central-learning/contracts.js";
import type { GroundedCentralResearch } from "../../../../../integration/central-learning/research-intake-common.js";
import { retainFrozenStage } from "../../../../../integration/central-learning/stage-evidence.js";
import type { CentralPursuitCandidate } from "../../../../control/decision/pursuit-contract.js";
import { centralLearningSpent, type CoordinationAction } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { TimerScheduler } from "../../../../../subagent/scheduler.js";
import { acceptCentralMethodResearch } from "./central-research-intake.js";
import { createCentralMethodResearchExecution } from "./central-research-execution.js";
import { readCentralMethodResearchContinuation } from "./central-research-continuation.js";
import { readMethodResearch } from "./central-research-records.js";

const scope = "workspace:method-capacity", at = "2026-11-05T01:00:00.000Z";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
  maxTokens: 64000, maxCalls: 4, maxSteps: 4, maxPromptChars: 60000 };
const operationAllowance = { ...allowance, maxTokens: 32000, maxCalls: 1, maxSteps: 1 };
const operation = { kind: "dispatch" as const, operationId: "op:method-capacity", purpose: "Compare schema prerequisites",
  expectedChange: "A conditional method finding", sourceRefs: ["source:schema-case"], allowance: operationAllowance,
  destination: { plane: "agent" as const, domain: "prompt" as const } };
const request: GroundedCentralResearch = { requestRef: "request:method-capacity", domain: "prompt", operation,
  intent: { intentId: "intent:method-capacity", subject: { plane: "central", questionRef: "intent:method-capacity" },
    goal: "Learn when declared schema inspection must precede editing", rationale: "Compare a solved source case",
    conditions: ["structured files"], knowledge: [], residual: ["What is the transfer boundary?"],
    commitment: { purpose: "Compare prerequisites", assumptions: ["The source case was solved"], reconsiderWhen: ["A counterexample arrives"] },
    revisionReason: "A new comparative purpose", sourceRefs: ["source:schema-case"], continuation: { kind: "ready", operation } },
  materials: [{ ref: "source:schema-case", kind: "source", text: "The solved task required reading its declared JSON schema.", sourceRefs: [] }],
  sourceRefs: ["source:schema-case"] };

type Ready = Extract<CentralStagePreparation, { readonly status: "ready" }>;

type WireRequest = { readonly max_tokens: number; readonly messages: readonly { readonly role: string; readonly content: string }[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function manualClock() {
  let now = Date.parse(at);
  const timers: { readonly due: number; readonly fire: () => void; cancelled: boolean }[] = [];
  const scheduler: TimerScheduler = (delayMs, fire) => {
    const timer = { due: now + delayMs, fire, cancelled: false };
    timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  };

  return { now: () => now, scheduler, advance(ms: number) {
    now += ms;
    for (const timer of timers) if (!timer.cancelled && timer.due <= now) {
      timer.cancelled = true;
      timer.fire();
    }
  } };
}

function response(finding: object, first: boolean) {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(finding) }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: first
      ? { prompt_tokens: 4000, completion_tokens: 9000, total_tokens: 13000 }
      : { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function controlledWire() {
  const entered = deferred<void>(), release = deferred<Response>();
  const bodies: WireRequest[] = [], signals: AbortSignal[] = [];
  const firstFinding = { kind: "finding", statement: "Schema inspection is conditional on an explicit declaration.",
    conditions: "A structured task declares its schema", sourceRefs: request.sourceRefs,
    residual: Array.from({ length: 10 }, (_, index) => `Transfer boundary ${index}: ${"evidence is still required; ".repeat(60)}`) };

  assert.ok(JSON.stringify(firstFinding).length > 16000, "exercise a valid research result beyond lightweight review text capacity");
  const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as WireRequest);
    assert.ok(init?.signal);
    signals.push(init.signal);
    if (bodies.length === 1) {
      entered.resolve();
      return release.promise;
    }
    return response({ kind: "finding", statement: "Implicit schemas need a separate source trial.",
      conditions: "No explicit schema declaration", sourceRefs: request.sourceRefs, residual: ["Collect an actual implicit-schema case"] }, false);
  };
  const provider = createOpenAiCompatibleProvider({ endpoint: "http://127.0.0.1:43123/v1/chat/completions",
    model: "method-capacity-model", apiKey: "test-only", fetchImpl, maxAttemptsBeforeHeaders: 1 });

  return { provider, bodies, signals, entered: entered.promise, releaseResponse: () => release.resolve(response(firstFinding, true)) };
}

function candidate(prepared: Ready, now: number): CentralPursuitCandidate {
  return { opportunity: { opportunityId: prepared.offer.offerId, scope, targetRef: "definition:method-capacity",
    instanceRef: prepared.stageRef, sourceRef: prepared.source.sourceBindingRef, stage: prepared.source.domainStage.kind,
    conditionRef: "condition:method-capacity", baselineRef: "baseline:idle", windowRef: "window:method-capacity", offer: prepared.offer },
    source: prepared.source, readiness: { kind: "ready", sourceRef: prepared.source.sourceBindingRef, now, nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "definition:method-capacity" },
    fee: { kind: "hard-budget-only", sourceRef: "budget:method-capacity" }, purpose: "focused_learning",
    objective: { instanceId: "objective:method-capacity", criterion: "proposal_delivered", definitionRef: "definition:method-capacity",
      familyRef: "family:method-capacity", familySourceRef: prepared.policyRef } };
}

async function fixture(wire: ReturnType<typeof controlledWire>, clock: ReturnType<typeof manualClock>) {
  const root = await mkdtemp(testScratchPath("central-method-capacity-"));
  const signal = new AbortController().signal;
  let expireAfterReserve = false;
  const now = () => {
    if (expireAfterReserve) {
      const log = decodeLog(readFileSync(path.join(root, BOARD_LOG_FILE), "utf8"));
      assert.ok(log.ok);
      if (log.records.some(row => row.command.type === "coordinate_learning" && row.command.action.kind === "reserve")) {
        expireAfterReserve = false;
        clock.advance(540001);
      }
    }
    return clock.now();
  };
  const options = { boardRoot: root, scope, workspaceId: "legacy:method-capacity", now, enabled: () => true,
    provider: wire.provider, model: "method-capacity-model", scheduler: clock.scheduler, contextWindow: 24000,
    contextForIssue: async () => ({ ref: "context:method-capacity", text: "Compare the original schema prerequisite. 完整研究材料保留 UTF-8 字节。" }) };
  let serial = 0;
  const load = async () => {
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning", commandId: `capacity-test:${++serial}`,
      issuedAt: new Date(clock.now()).toISOString(), action }));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const accepted = await acceptCentralMethodResearch(options, request, signal);
  assert.ok(accepted.status === "accepted");
  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1,
    budgetId: "budget:method-capacity", scope, unit: "total_model_tokens", limits: { tokens: 64000, calls: 4, steps: 4 }, authorizationRef: "test:explicit" } });
  const issue = (await load()).learningIssues!.find(row => row.issueId === accepted.issueId)!;

  await act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
    reason: "Compare the grounded source", sourceRefs: request.sourceRefs });
  const original: CentralLearningExecutionPort = { domain: "prompt", async prepare() { throw new Error("unexpected_original_prepare"); },
    async dispatch() { throw new Error("unexpected_original_dispatch"); }, async observe() { throw new Error("unexpected_original_observe"); } };
  // Keep scheduler on a variable so the frozen implementation compiles too;
  // the red control must fail on observable capacity/lifecycle behavior.
  const port = createCentralMethodResearchExecution(options, original);
  const prepare = () => port.prepare({ issueId: accepted.issueId, authorizedAllowance: allowance, operationAllowance }, signal);
  const quoted = await prepare();
  assert.ok(quoted.status === "ready");
  const beforeFund = await load(), focused = beforeFund.learningIssues!.find(row => row.issueId === accepted.issueId)!;

  await act({ kind: "fund", domain: "prompt", issueId: focused.issueId, expectedRevision: focused.revision,
    grantId: quoted.source.grantId, allowance, budgetId: "budget:method-capacity", authorizationRef: "test:explicit",
    planRef: "test:original-plan", expectedSequence: beforeFund.sequence });
  const freeze = async (prepared: Ready): Promise<CentralFundedStage> => {
    const current = (await load()).learningIssues!.find(row => row.issueId === accepted.issueId)!;
    const input: CentralFundedStage = { issueId: accepted.issueId, grantId: prepared.source.grantId, expectedIssueRevision: current.revision,
      stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer,
      ...(prepared.sourceContext === undefined ? {} : { sourceContext: prepared.sourceContext }) };
    assert.equal((await retainFrozenStage({ boardRoot: root, candidate: candidate(prepared, clock.now()), input })).status, "retained");
    return input;
  };
  const input = await freeze(quoted);

  return { port, prepare, load, freeze, input, quoted, signal, boardRoot: root,
    armExpiryAfterReserve() { expireAfterReserve = true; }, setContextWindow(tokens: number) { options.contextWindow = tokens; }, async close() {
    assert.ok(root.startsWith(testScratchPath() + path.sep));
    await rm(root, { recursive: true, force: true });
  } };
}

test("funded method research sends its full grant capacity through normal OpenAI wire and continues on the same grant", async t => {
  const wire = controlledWire(), clock = manualClock(), f = await fixture(wire, clock), controller = new AbortController();
  let pending: ReturnType<CentralLearningExecutionPort["dispatch"]> | undefined;

  t.after(async () => {
    controller.abort();
    wire.releaseResponse();
    if (pending !== undefined) await pending;
    await f.close();
  });
  f.setContextWindow(256);
  const insufficient = await f.prepare(), beforeDispatch = await f.load();

  assert.equal(beforeDispatch.centralLearningGrants![0]!.reservations.length, 0);
  assert.equal(wire.bodies.length, 0);
  f.setContextWindow(24000);
  pending = f.port.dispatch(f.input, controller.signal);
  await wire.entered;
  const running = await f.load(), originalGrant = running.centralLearningGrants![0]!;

  assert.equal(running.centralLearningGrants!.length, 1);
  assert.equal(originalGrant.allowance.maxTokens, 64000);
  assert.equal(originalGrant.reservations.length, 1);
  assert.ok(originalGrant.reservations[0]!.maxTokens > 12000);
  const sent = wire.bodies[0]!;

  assert.ok(sent.max_tokens > 8192, "the normal adapter must receive research output capacity beyond the old 1500-token review cap");
  const promptBytes = new TextEncoder().encode(sent.messages.map(row => row.content).join("")).length;

  assert.equal(sent.max_tokens + promptBytes + 256, originalGrant.reservations[0]!.maxTokens,
    "the complete system and user prompt consumes the original reservation before generation capacity is offered");
  assert.equal(sent.max_tokens + promptBytes + 256, 24000, "the configured context window bounds the actual wire capacity");
  assert.equal(insufficient.status, "waiting", "the full prompt must leave at least 256 tokens of output capacity");
  clock.advance(31000);
  assert.equal(wire.signals[0]!.aborted, false);
  clock.advance(100001);
  assert.equal(wire.signals[0]!.aborted, false);
  assert.ok(Date.parse(originalGrant.claim!.expiresAt) > clock.now(), "the original lease remains valid beyond two minutes");
  assert.equal((await f.prepare()).status, "waiting");
  const busy = await f.port.dispatch(f.input, f.signal);
  assert.ok(busy.ok);
  assert.equal(busy.status, "busy");
  assert.equal(wire.bodies.length, 1);
  assert.equal((await f.load()).centralLearningGrants![0]!.reservations.length, 1);
  wire.releaseResponse();
  assert.ok((await pending).ok);
  const firstBoard = await f.load(), firstGrant = firstBoard.centralLearningGrants![0]!;

  assert.equal(firstGrant.reservations.length, 1);
  assert.equal(firstGrant.reservations[0]!.usage?.kind, "reported");
  assert.equal(centralLearningSpent(firstGrant).tokens, 13000);
  const firstHistory = readMethodResearch(firstBoard, scope, request.requestRef)!;
  assert.equal(firstHistory.steps.length, 1);
  assert.ok(JSON.stringify(firstHistory.steps[0]!.step.finding).length > 16000);
  const continuation = readCentralMethodResearchContinuation({ board: firstBoard, scope, issueId: f.input.issueId,
    grantId: f.input.grantId, lastStageInputHash: contentHashOf(f.input), previousCursorRefs: f.quoted.source.domainStage.readiness.evidenceRefs });

  assert.ok(continuation.kind === "continuable");
  const next = await f.prepare();
  assert.ok(next.status === "ready");
  assert.equal(next.source.domainStage.kind, "continuation");
  assert.equal(next.source.grantId, f.input.grantId);
  assert.notEqual(next.stageRef, f.input.stageRef);
  const nextInput = await f.freeze(next);
  assert.ok((await f.port.dispatch(nextInput, f.signal)).ok);
  assert.equal(wire.bodies.length, 2);
  assert.ok(wire.bodies[1]!.messages.some(row => row.content.includes(firstHistory.steps[0]!.step.finding.statement)));
  const finalBoard = await f.load(), finalGrant = finalBoard.centralLearningGrants![0]!;

  assert.equal(finalBoard.centralLearningGrants!.length, 1);
  assert.equal(finalGrant.grantId, f.input.grantId);
  assert.equal(finalGrant.reservations.length, 2);
  assert.ok(finalGrant.reservations.every(row => row.usage?.kind === "reported"));
  assert.equal(centralLearningSpent(finalGrant).tokens, 13120);
  assert.equal(readMethodResearch(finalBoard, scope, request.requestRef)!.steps.length, 2);
});

test("cancelling hanging method research preserves the original unknown reservation and prevents a resend", async t => {
  const wire = controlledWire(), clock = manualClock(), f = await fixture(wire, clock), controller = new AbortController();
  const pending = f.port.dispatch(f.input, controller.signal);

  t.after(async () => {
    controller.abort();
    wire.releaseResponse();
    await pending;
    await f.close();
  });
  await wire.entered;
  clock.advance(130001);
  assert.equal((await f.prepare()).status, "waiting");
  const busy = await f.port.dispatch(f.input, f.signal);
  assert.ok(busy.ok);
  assert.equal(busy.status, "busy");
  const reservation = (await f.load()).centralLearningGrants![0]!.reservations[0]!;

  assert.equal(wire.bodies.length, 1);
  controller.abort();
  const cancelled = await pending;
  assert.ok(cancelled.ok);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(wire.signals[0]!.aborted, true);
  const afterCancel = await f.load(), retained = afterCancel.centralLearningGrants![0]!;

  assert.equal(retained.reservations.length, 1);
  assert.equal(retained.reservations[0]!.reservationId, reservation.reservationId);
  assert.equal(retained.reservations[0]!.state, "settled");
  assert.equal(retained.reservations[0]!.usage?.kind, "unknown");
  assert.equal(centralLearningSpent(retained).tokens, reservation.maxTokens);
  assert.equal(readMethodResearch(afterCancel, scope, request.requestRef)!.steps.length, 0);
  clock.advance(600001);
  assert.equal((await f.prepare()).status, "waiting", "an elapsed lease does not make unknown paid work safe to repeat");
  const retried = await f.port.dispatch(f.input, f.signal);

  assert.ok(!retried.ok || retried.status === "busy", "the original paid stage remains blocked without throwing or sending again");
  const finalGrant = (await f.load()).centralLearningGrants![0]!;

  assert.equal(wire.bodies.length, 1);
  assert.deepEqual(finalGrant.reservations, retained.reservations);
  assert.deepEqual(finalGrant.claim, retained.claim);
  assert.equal((await f.load()).jobs.find(job => job.jobId === finalGrant.jobId)!.attempt,
    afterCancel.jobs.find(job => job.jobId === retained.jobId)!.attempt, "blocked replay does not acquire a new claim");
  assert.equal(centralLearningSpent(finalGrant).tokens, reservation.maxTokens);
});

test("an unsent research reservation has an explicit consumable checkpoint and continues without rebuying the expired stage", async t => {
  const wire = controlledWire(), clock = manualClock(), f = await fixture(wire, clock), controller = new AbortController();
  let pending: ReturnType<CentralLearningExecutionPort["dispatch"]> | undefined;

  t.after(async () => {
    controller.abort();
    wire.releaseResponse();
    if (pending !== undefined) await pending;
    await f.close();
  });
  const before = readMethodResearch(await f.load(), scope, request.requestRef)!;

  f.armExpiryAfterReserve();
  pending = f.port.dispatch(f.input, controller.signal);
  assert.ok((await pending).ok);
  assert.equal(wire.bodies.length, 0, "the persisted reservation does not permit a send after the stage deadline");
  const board = await f.load(), grant = board.centralLearningGrants![0]!, reservation = grant.reservations[0]!;

  assert.equal(grant.reservations.length, 1);
  assert.equal(reservation.state, "settled");
  assert.ok(reservation.usage?.kind === "reported");
  assert.equal(reservation.usage.totalTokens, 0);
  assert.equal(centralLearningSpent(grant).tokens, 0);
  const history = readMethodResearch(board, scope, request.requestRef)!;

  assert.equal(history.steps.length, 0, "a skipped provider call cannot create a model finding");
  assert.notEqual(history.headRef, before.headRef, "the zero-cost unsent transition still has a durable checkpoint");
  const observed = await f.port.observe(f.input, f.signal);

  assert.equal(observed.outcome, "closed_no_result");
  assert.equal(observed.reason, "method_research_confirmed_not_sent");
  assert.deepEqual(observed.resultRefs, [history.headRef]);
  const cursorInput = { board, scope, issueId: f.input.issueId, grantId: f.input.grantId,
    lastStageInputHash: contentHashOf(f.input), previousCursorRefs: f.quoted.source.domainStage.readiness.evidenceRefs };
  const continuation = readCentralMethodResearchContinuation(cursorInput);
  assert.ok(continuation.kind === "continuable");
  assert.equal(continuation.cursorRef, history.headRef);
  const fact = board.rewardV2Facts!.find(row => row.id === continuation.cursorRef);
  assert.ok(fact);
  const checkpoint: unknown = JSON.parse(fact.payloadJson);

  assert.ok(typeof checkpoint === "object" && checkpoint !== null && "type" in checkpoint);
  assert.equal(checkpoint.type, "method_research_unsent");
  assert.equal("finding" in checkpoint, false);
  assert.ok("reservationId" in checkpoint);
  assert.equal(checkpoint.reservationId, reservation.reservationId);
  assert.ok("stageInputHash" in checkpoint);
  assert.equal(checkpoint.stageInputHash, contentHashOf(f.input));
  const cold = await createBoardReader(f.boardRoot).load();
  assert.ok(cold.ok);
  const coldHistory = readMethodResearch(cold.state, scope, request.requestRef)!;

  assert.equal(coldHistory.headRef, history.headRef);
  assert.equal(coldHistory.steps.length, 0);
  assert.deepEqual(readCentralMethodResearchContinuation({ ...cursorInput, board: cold.state }), continuation);
  const consumed = readCentralMethodResearchContinuation({ ...cursorInput, board: cold.state,
    previousCursorRefs: [...cursorInput.previousCursorRefs, continuation.cursorRef] });

  assert.ok(consumed.kind === "waiting");
  assert.equal(consumed.reason, "method_research_continuation_cursor_already_consumed");
  const next = await f.prepare();
  assert.ok(next.status === "ready");
  assert.equal(next.source.grantId, f.input.grantId);
  assert.notEqual(next.stageRef, f.input.stageRef);
  const nextInput = await f.freeze(next);

  pending = f.port.dispatch(nextInput, controller.signal);
  await wire.entered;
  const running = (await f.load()).centralLearningGrants![0]!;

  assert.equal(wire.bodies.length, 1);
  assert.equal(running.reservations.length, 2);
  assert.notEqual(running.reservations[1]!.reservationId, reservation.reservationId);
  assert.deepEqual(running.reservations[0], reservation);
  const busy = await f.port.dispatch(nextInput, f.signal);
  assert.ok(busy.ok);
  assert.equal(busy.status, "busy");
  assert.equal(wire.bodies.length, 1);
  assert.deepEqual((await f.load()).centralLearningGrants![0]!.reservations, running.reservations);
  wire.releaseResponse();
  assert.ok((await pending).ok);
  const finalBoard = await f.load(), finalGrant = finalBoard.centralLearningGrants![0]!;

  assert.equal(finalBoard.centralLearningGrants!.length, 1);
  assert.equal(finalGrant.grantId, f.input.grantId);
  assert.equal(wire.bodies.length, 1);
  assert.equal(finalGrant.reservations.length, 2);
  assert.deepEqual(finalGrant.reservations[0], reservation);
  assert.equal(finalGrant.reservations[1]!.usage?.kind, "reported");
  const finalHistory = readMethodResearch(finalBoard, scope, request.requestRef)!;

  assert.equal(finalHistory.steps.length, 1);
  assert.equal(finalHistory.steps[0]!.step.reservationId, finalGrant.reservations[1]!.reservationId);
});
