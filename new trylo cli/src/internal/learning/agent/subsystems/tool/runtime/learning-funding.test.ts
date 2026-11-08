import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../../../../ports/provider.js";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningRemaining, centralLearningSpent, type CoordinationAction } from "../../../../control/coordination-contract.js";
import { TOOL_LEARNING_ALLOWANCE } from "../../../../control/tool-allowance.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { enqueueToolLearningPlan, expireToolLearningJob } from "./pipeline-queue.js";
import { createToolLearningFunding } from "./learning-funding.js";
import { withToolLearningFunding } from "../adapters/evolution/funded-provider.js";
import { contentHashOf } from "../../../../control/hash.js";
import { toolLearningFundingClaimId } from "../domain/evolution/funding-identity.js";

const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "workspace:funding-test", capability: "test shared model allowance",
  trigger: { runId: "task", proposalKey: "opportunity", action: "replace_or_add", evidenceRefs: ["task:actual-trace"] }, createdAt: new Date(0).toISOString() };
const request: ProviderRequest = { attemptId: "model-call", model: "test-model", maxOutputTokens: 8192, messages: [{ role: "user", content: "Plan or construct the requested tool." }], tools: [] };
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const usage = (inputTokens: number, outputTokens: number, mode: "snapshot" | "delta" = "snapshot"): ProviderEvent => ({ type: "usage",
  usage: { mode, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } });

async function drain(provider: ProviderPort, signal = new AbortController().signal, modelRequest = request) { for await (const event of provider.stream(modelRequest, signal)) void event; }

async function fixture(t: TestContext, withWriter?: typeof withBoardWriter) {
  const base = testScratchPath("tool-learning-funding-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queued = await enqueueToolLearningPlan(root, plan);
  assert.ok(queued.ok);
  const started = await withBoardWriter(root, store => store.apply({ type: "start_job", jobId: queued.jobId, commandId: "start", issuedAt: plan.createdAt }));

  assert.ok(started.ok);
  const createFunding = () => createToolLearningFunding({ boardRoot: root, scope: plan.scope, now: () => 0,
    ...(withWriter === undefined ? {} : { withWriter }) });
  const funding = createFunding();
  const allowance = await funding.allowance(plan);
  assert.ok(allowance);
  let reservation = 0;
  const wrap = (provider: ProviderPort, selected = funding) => withToolLearningFunding(provider, { funding: selected, newId: () => `reservation-${++reservation}` });
  const state = async () => {
    const loaded = await createBoardReader(root).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const grant = async () => {
    const grants = (await state()).centralLearningGrants;
    assert.equal(grants?.length, 1);
    assert.ok(grants?.[0]);
    return grants[0];
  };

  return { root, funding, createFunding, wrap, state, grant, jobId: queued.jobId };
}

test("planning and nested generation forks spend one Board cap and charge actual total usage", async t => {
  const fx = await fixture(t);
  let calls = 0;
  const createProvider = (): ProviderPort => ({ fork: () => createProvider(), stream: async function* () {
    calls++;
    yield usage(1000, 100);
    yield usage(100, 20, "delta");
    yield finish;
  } });
  const provider = fx.wrap(createProvider()), planning = provider.fork!(), generation = planning.fork!();

  for (const selected of [planning, generation, planning.fork!(), provider]) await drain(selected);

  for (let index = 4; index < TOOL_LEARNING_ALLOWANCE.maxCalls; index++) await drain(generation.fork!());

  const grant = await fx.grant();

  assert.deepEqual(grant.allowance, TOOL_LEARNING_ALLOWANCE);
  assert.equal(grant.domain, "tool");
  assert.deepEqual(centralLearningSpent(grant), { tokens: TOOL_LEARNING_ALLOWANCE.maxCalls * 1220, calls: TOOL_LEARNING_ALLOWANCE.maxCalls, steps: TOOL_LEARNING_ALLOWANCE.maxCalls });
  assert.equal(grant.reservations.every(row => row.state === "settled" && row.usage?.kind === "reported"), true);
  await assert.rejects(drain(generation.fork!()), /budget_exhausted/);
  assert.equal(calls, TOOL_LEARNING_ALLOWANCE.maxCalls);
});

test("cancellation charges unknown usage and releasing then reopening cannot refill the lifetime grant", async t => {
  const fx = await fixture(t), cancellation = new AbortController();
  let calls = 0;
  const interrupted = fx.wrap({ stream: async function* () {
    calls++;
    cancellation.abort();
    yield { type: "cancel_ack" };
  } });

  await assert.rejects(drain(interrupted, cancellation.signal), /cancelled/);
  const first = await fx.grant();

  assert.equal(first.reservations[0]?.usage?.kind, "unknown");
  const reservation = first.reservations[0]!.maxTokens;

  assert.ok(reservation > 8192 && reservation < 16_000);
  assert.equal(centralLearningSpent(first).tokens, reservation);
  await fx.funding.release();
  const reopened = fx.createFunding(), remainder = await reopened.allowance(plan);
  assert.ok(remainder);
  assert.equal(remainder.grantId, first.grantId);
  assert.equal(remainder.tokensRemaining, TOOL_LEARNING_ALLOWANCE.maxTokens - reservation);
  assert.equal(remainder.callsRemaining, TOOL_LEARNING_ALLOWANCE.maxCalls - 1);
  const resumed = fx.wrap({ stream: async function* () {
    calls++;
    yield usage(400, 100);
    yield finish;
  } }, reopened);

  await drain(resumed);
  const second = await fx.grant();

  assert.equal(second.grantId, first.grantId);
  assert.equal(centralLearningSpent(second).tokens, reservation + 500);
  assert.equal(calls, 2);
  const failure: ProviderEvent = { type: "error", class: "auth", retryable: false, phase: "before_headers", message: "redacted test diagnostic" };
  const failed = fx.wrap({ stream: async function* () { yield failure; } }, reopened);
  const received: ProviderEvent[] = [];

  for await (const event of failed.stream(request, new AbortController().signal)) received.push(event);

  assert.deepEqual(received, [failure], "the artifact worker must retain typed provider diagnostics");
  assert.equal(centralLearningSpent(await fx.grant()).tokens, 2 * reservation + 500, "a failed call without usage still consumes its reservation");
});

test("reopening the same worker attempt uses a new funding epoch and rejects its old worker", async t => {
  const fx = await fixture(t), first = await fx.grant();
  assert.ok(first.claim);
  const old = fx.createFunding();
  assert.ok(await old.allowance(plan));
  assert.ok((await fx.funding.reserve("old-epoch-unknown", 1000)).ok);
  await fx.funding.release();
  const next = fx.createFunding();
  assert.ok(await next.allowance(plan));
  const second = await fx.grant();
  assert.ok(second.claim);
  assert.equal(second.grantId, first.grantId);
  assert.notEqual(second.claim.claimId, first.claim.claimId);
  assert.equal(second.claim.claimId, toolLearningFundingClaimId(plan, fx.jobId, 1, second.claim.step));
  assert.equal(second.reservations[0]?.usage?.kind, "unknown");
  assert.equal((await old.inspect()).ok, false);
  assert.equal((await old.reserve("late-old-call", 500)).ok, false);
  await assert.rejects(old.release(), /learning_claim_conflict/);
  assert.equal((await fx.grant()).claim?.claimId, second.claim.claimId, "late release cannot yield the new worker's claim");
  await drain(fx.wrap({ stream: async function* () {
    yield usage(200, 30);
    yield finish;
  } }, next));
  const spent = centralLearningSpent(await fx.grant());

  await next.release();
  assert.equal((await fx.grant()).claim, undefined);
  const third = fx.createFunding();
  assert.ok(await third.allowance(plan));
  await third.release();
  const final = await fx.grant();
  assert.equal(final.claim, undefined, "a repeated same-attempt finish must execute for its new lease");
  assert.deepEqual(centralLearningSpent(final), spent);
  assert.equal(spent.calls, 2);
  assert.equal(spent.tokens, 1230);
});

test("an active legacy claim can be released even when an older identical finish action is already archived", async t => {
  const fx = await fixture(t);
  const legacyId = toolLearningFundingClaimId(plan, fx.jobId, 1);
  const coordinate = async (action: CoordinationAction) => {
    const result = await withBoardWriter(fx.root, store => store.apply({ type: "coordinate_learning", commandId: `tool-budget:${contentHashOf(action)}`,
      issuedAt: plan.createdAt, action }));
    assert.ok(result.ok);
    return result;
  };
  const initial = await fx.grant();
  assert.ok(initial.claim);
  await coordinate({ kind: "finish", jobId: initial.jobId, claimId: initial.claim.claimId,
    result: { kind: "yielded", reason: "test_initial_lease_setup" } });
  const claim = async () => {
    const grant = await fx.grant(), state = await fx.state(), budgetJob = state.jobs.find(job => job.jobId === grant.jobId);
    assert.ok(budgetJob);
    return coordinate({ kind: "claim", jobId: budgetJob.jobId, expectedAttempt: budgetJob.attempt, claimId: legacyId,
      ownerId: "test-legacy-worker", expiresAt: new Date(600_000).toISOString() });
  };

  await claim();
  const grant = await fx.grant();

  await coordinate({ kind: "finish", jobId: grant.jobId, claimId: legacyId, result: { kind: "yielded", reason: "tool_worker_boundary" } });
  await claim();
  const current = fx.createFunding();
  assert.ok(await current.allowance(plan));
  const before = centralLearningSpent(await fx.grant());

  await current.release();
  const final = await fx.grant();
  assert.equal(final.claim, undefined);
  assert.deepEqual(centralLearningSpent(final), before);
});

test("parallel forks with absent usage cannot exceed the shared token cap", async t => {
  const fx = await fixture(t);
  let calls = 0;
  const createProvider = (): ProviderPort => ({ fork: () => createProvider(), stream: async function* () {
    calls++;
    yield finish;
  } });
  const provider = fx.wrap(createProvider());
  const fullRequest = { ...request, maxOutputTokens: 5488, messages: [{ role: "user" as const, content: "x".repeat(20_000) }] };
  const slotsAtCap = Math.floor(TOOL_LEARNING_ALLOWANCE.maxTokens / 16_000);
  const outcomes = await Promise.allSettled(Array.from({ length: slotsAtCap + 1 }, () => drain(provider.fork!(), undefined, fullRequest)));

  assert.equal(outcomes.filter(row => row.status === "fulfilled").length, calls);
  // The shared writer may refuse simultaneous lock acquisition; admission must
  // never exceed the cap, but it does not promise concurrent callers a lease.
  assert.ok(calls >= 1 && calls <= slotsAtCap);
  const slots = slotsAtCap - calls;

  for (let index = 0; index < slots; index++) await drain(provider.fork!(), undefined, fullRequest);

  await assert.rejects(drain(provider.fork!(), undefined, fullRequest), /budget_exhausted/);
  assert.equal(calls, slotsAtCap);
  const grant = await fx.grant();

  assert.equal(grant.reservations.length, slotsAtCap);
  assert.equal(grant.reservations.every(row => row.usage?.kind === "unknown"), true);
  assert.equal(centralLearningSpent(grant).tokens, TOOL_LEARNING_ALLOWANCE.maxTokens);
  assert.equal(centralLearningRemaining(grant).tokens, 0);
});

test("research and two-phase npm construction retain one original grant even when no call reports usage", async t => {
  const fx = await fixture(t), outputs: number[] = [];
  const provider = fx.wrap({ stream: async function* (incoming) {
    outputs.push(incoming.maxOutputTokens!);
    yield finish;
  } });

  for (const stage of ["search", "inspect", "select"]) await drain(provider, undefined,
    { ...request, attemptId: `tool-planning:${stage}`, maxOutputTokens: 4096 });

  const afterPlanning = await fx.grant();

  assert.equal(afterPlanning.reservations.length, 3);
  assert.ok(afterPlanning.reservations.every(row => row.maxTokens < 12_000));
  assert.deepEqual(outputs, [4096, 4096, 4096]);
  await fx.funding.release();
  const continued = fx.createFunding();
  const remaining = await continued.allowance(plan);
  assert.ok(remaining);
  assert.equal(remaining.grantId, afterPlanning.grantId);
  assert.equal(remaining.callsRemaining, TOOL_LEARNING_ALLOWANCE.maxCalls - 3);
  const construction = fx.wrap({ stream: async function* (incoming) {
    outputs.push(incoming.maxOutputTokens!);
    yield finish;
  } }, continued);

  await drain(construction, undefined, { ...request, attemptId: "tool-contract:freeze", maxOutputTokens: 6144 });
  await drain(construction, undefined, { ...request, attemptId: "tool-adaptation:source", maxOutputTokens: 8192 });
  const final = await fx.grant();

  assert.deepEqual(outputs, [4096, 4096, 4096, 6144, 8192]);
  assert.equal(final.grantId, afterPlanning.grantId);
  assert.equal(final.reservations.length, 5);
  assert.equal(final.reservations.every(row => row.usage?.kind === "unknown"), true);
  assert.ok(centralLearningRemaining(final).tokens > 0);
});

test("provider overrun closes the grant and a closed parent pipeline task stops later model calls", async t => {
  const fx = await fixture(t);
  let calls = 0;
  const provider = fx.wrap({ stream: async function* () {
    calls++;
    yield usage(16_000, 1);
    yield finish;
  } });

  await assert.rejects(drain(provider), /token_overrun/);
  const closed = await fx.grant();
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedReason, "model_token_overrun");
  assert.equal(centralLearningSpent(closed).tokens, 16_001);
  await assert.rejects(drain(provider), /tool_learning_inactive/);
  assert.equal(await fx.createFunding().allowance(plan), undefined);
  assert.equal(calls, 1);

  const parent = await fixture(t);
  let parentCalls = 0;
  const guarded = parent.wrap({ stream: async function* () {
    parentCalls++;
    yield usage(10, 10);
    yield finish;
  } });

  assert.ok((await expireToolLearningJob(parent.root, parent.jobId, plan.createdAt)).ok);
  await assert.rejects(drain(guarded), /tool_learning_inactive/);
  assert.equal(parentCalls, 0);
  assert.equal((await parent.grant()).reservations.length, 0);
});

test("omitted output allocation stays absent and unknown usage spends the whole lifetime grant without refill", async t => {
  const fx = await fixture(t);
  const { maxOutputTokens: allocation, ...unallocated } = request;
  assert.equal(allocation, 8192);
  assert.equal(Object.hasOwn(unallocated, "maxOutputTokens"), false);
  let calls = 0;
  const createProvider = (): ProviderPort => ({ stream: async function* (incoming) {
    calls++;
    assert.equal(Object.hasOwn(incoming, "maxOutputTokens"), false, "funding must not inject a caller output allocation");
    assert.equal(incoming.maxOutputTokens, undefined);
    yield finish;
  } });

  await drain(fx.wrap(createProvider()), undefined, unallocated);
  const first = await fx.grant();
  assert.equal(calls, 1);
  assert.equal(first.reservations.length, 1);
  assert.equal(first.reservations[0]?.maxTokens, TOOL_LEARNING_ALLOWANCE.maxTokens);
  assert.equal(first.reservations[0]?.usage?.kind, "unknown");
  assert.deepEqual(centralLearningSpent(first), { tokens: TOOL_LEARNING_ALLOWANCE.maxTokens, calls: 1, steps: 1 });
  assert.equal(centralLearningRemaining(first).tokens, 0);

  await fx.funding.release();
  const reopened = fx.createFunding(), remainder = await reopened.allowance(plan);
  assert.ok(remainder);
  assert.equal(remainder.grantId, first.grantId);
  assert.equal(remainder.tokensRemaining, 0);
  assert.equal(remainder.callsRemaining, TOOL_LEARNING_ALLOWANCE.maxCalls - 1);
  await assert.rejects(drain(fx.wrap(createProvider(), reopened), undefined, unallocated), /budget_exhausted/);
  assert.equal(calls, 1, "exhausted grant must reject the next request before provider dispatch");
  const final = await fx.grant();
  assert.equal(final.grantId, first.grantId);
  assert.equal(final.reservations.length, 1);
  assert.deepEqual(centralLearningSpent(final), centralLearningSpent(first));
});

test("parallel provider completions settle through one funding writer without rejecting an already dispatched call", async t => {
  const entered = deferred(), release = deferred();
  let settlement = false, held = false, clock = 0, lockRefusals = 0;
  const writer: typeof withBoardWriter = (root, run, options) => withBoardWriter(root, async store => {
    if (settlement && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return run(store);
  }, settlement ? { ...options, admission: { now: () => clock, random: () => 0,
    wait: async () => { lockRefusals++; clock = 5000; } } } : options);
  const fx = await fixture(t, writer), funding = fx.funding;
  let settlements = 0, calls = 0;
  const shared = { ...funding, settle: (...args: Parameters<typeof funding.settle>) => {
    settlement = true;
    if (++settlements === 2) release.resolve();
    return funding.settle(...args);
  } };
  const dispatches = deferred();
  const provider = fx.wrap({ stream: async function* () {
    const index = ++calls;
    if (calls === 2) dispatches.resolve();
    await dispatches.promise;
    if (index === 2) await entered.promise;
    yield finish;
  } }, shared);
  const outcomes = await Promise.allSettled([drain(provider), drain(provider)]);
  const grant = await fx.grant();
  t.diagnostic(JSON.stringify({ calls, lockRefusals, outcomes: outcomes.map(row => row.status === "fulfilled" ? row.status : String(row.reason)),
    reservations: grant.reservations.map(row => ({ state: row.state, usage: row.usage })) }));

  assert.equal(calls, 2);
  assert.deepEqual(outcomes.map(row => row.status), ["fulfilled", "fulfilled"]);
  assert.equal(lockRefusals, 0, "the original Board writer must not contend with this funding instance itself");
  assert.equal(grant.reservations.length, 2);
  assert.equal(grant.reservations.every(row => row.state === "settled" && row.usage?.kind === "unknown"), true);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("an external settlement refusal keeps its reservation and exact phase without poisoning the funding writer", async t => {
  let refuse = false;
  const writer: typeof withBoardWriter = (root, run, options) => refuse
    ? Promise.resolve({ ok: false, reason: "multi_writer", detail: "synthetic external owner still holds the Board lock" })
    : withBoardWriter(root, run, options);
  const fx = await fixture(t, writer);
  const provider = fx.wrap({ stream: async function* () {
    refuse = true;
    yield finish;
  } });

  await assert.rejects(drain(provider), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "tool_learning_settlement_failed");
    assert.deepEqual(error.cause, { phase: "settle", code: "multi_writer" });
    return true;
  });
  const before = await fx.grant();
  assert.equal(before.reservations[0]?.state, "reserved");
  const spent = centralLearningSpent(before);
  refuse = false;
  assert.ok((await fx.funding.settle("reservation-1", { kind: "unknown", reason: "usage_not_reported" })).ok);
  const after = await fx.grant();
  assert.equal(after.reservations[0]?.state, "settled");
  assert.deepEqual(centralLearningSpent(after), spent, "a refusal cannot release or refill an unknown bill");
});

test("an outcome-unknown writer rejection is not replayed and later funding transactions still run", async t => {
  let failAfterWrite = false, completedTransactions = 0;
  const failure = new Error("synthetic outcome unknown after durable write");
  const writer: typeof withBoardWriter = async (root, run, options) => {
    const result = await withBoardWriter(root, run, options);
    completedTransactions++;
    if (failAfterWrite) {
      failAfterWrite = false;
      throw failure;
    }
    return result;
  };
  const fx = await fixture(t, writer);
  const provider = fx.wrap({ stream: async function* () {
    failAfterWrite = true;
    yield finish;
  } });

  await assert.rejects(drain(provider), error => error === failure);
  assert.equal(completedTransactions, 3, "allowance, reservation and settlement each enter the writer once");
  const grant = await fx.grant();
  assert.equal(grant.reservations.length, 1);
  assert.equal(grant.reservations[0]?.state, "settled");
  assert.ok((await fx.funding.reserve("later-reservation", 1000)).ok);
  assert.equal(completedTransactions, 4);
  const after = await fx.grant();
  assert.equal(after.reservations.length, 2);
  assert.equal(after.reservations[0]?.usage?.kind, "unknown");
});

test("cancellation after reservation never dispatches the provider and retains the unknown reservation", async t => {
  const fx = await fixture(t), cancellation = new AbortController();
  let calls = 0;
  const funding = { ...fx.funding, reserve: async (...args: Parameters<typeof fx.funding.reserve>) => {
    const result = await fx.funding.reserve(...args);
    cancellation.abort();
    return result;
  } };
  const provider = fx.wrap({ stream: async function* () {
    calls++;
    yield finish;
  } }, funding);

  await assert.rejects(drain(provider, cancellation.signal), /tool_learning_cancelled/);
  assert.equal(calls, 0);
  const grant = await fx.grant();
  assert.equal(grant.reservations.length, 1);
  assert.equal(grant.reservations[0]?.state, "settled");
  assert.deepEqual(grant.reservations[0]?.usage, { kind: "unknown", reason: "cancelled" });
});

test("an already queued settlement keeps its original grant when the funding owner releases", async t => {
  const fx = await fixture(t);
  assert.ok((await fx.funding.reserve("settling-before-release", 1000)).ok);
  const settlement = fx.funding.settle("settling-before-release", { kind: "unknown", reason: "usage_not_reported" });
  const released = fx.funding.release();

  assert.ok((await settlement).ok);
  await released;
  const grant = await fx.grant();
  assert.equal(grant.claim, undefined);
  assert.equal(grant.reservations[0]?.state, "settled");
  assert.equal(centralLearningSpent(grant).tokens, 1000);
});
