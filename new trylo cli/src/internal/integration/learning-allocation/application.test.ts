import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { captureLearningAllocation, commitLearningAllocation } from "../../learning/control/allocation-application.js";
import type { AllocationApplicationInput, AllocationFundingBinding } from "../../learning/control/allocation-application-contract.js";
import type { LearningAllocationOffer } from "../../learning/control/allocation-contract.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { centralLearningSpent, type CentralLearningAgentDomain, type CentralLearningAllowance, type CoordinationAction } from "../../learning/control/coordination-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import { allocateLearningPortfolio } from "../../learning/control/portfolio-allocation.js";
import { planSequentialAllocation } from "../../learning/control/sequential-allocation.js";
import { createLearningAllocationApplication } from "./application.js";

const now = () => "2026-11-04T03:00:00.000Z";
const resources = (tokens: number, calls = 1, steps = 1) => ({ tokens, calls, steps });
const zero = () => resources(0, 0, 0);
const domains: readonly CentralLearningAgentDomain[] = ["prompt", "tool", "skill", "workflow", "collaboration"];
// Independent host authorization for this local harness, fixed before any model quote is constructed.
// These are test-only per-grant ceilings; neither proposal reserves nor predicted value can enlarge them.
const HOST_FIXTURE_ALLOWANCE: CentralLearningAllowance = Object.freeze({ schemaVersion: 2, unit: "total_model_tokens",
  maxTokens: 50_000, maxCalls: 64, maxSteps: 64, maxPromptChars: 10_000 });

async function fixture(run: (fx: Awaited<ReturnType<typeof setup>>) => Promise<void>, tokens = 5000, callsAndSteps = 16) {
  const root = await mkdtemp(path.join(tmpdir(), "allocation-application-"));
  try { await run(await setup(root, tokens, callsAndSteps)); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("allocation-application-"));
    await rm(root, { recursive: true, force: true });
  }
}

async function setup(root: string, tokens: number, callsAndSteps = 16) {
  let sequence = 0;
  const load = async () => {
    const result = await createBoardReader(root).load();
    if (!result.ok) throw new Error(result.reason);
    return result.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning",
      commandId: `fixture:${++sequence}`, issuedAt: now(), action }));
    if (!result.ok) throw new Error(result.reason);
    return result.state;
  };

  for (const domain of domains) {
    const source = domain === "collaboration" ? { teamRunId: "team", taskId: "task", memberId: "member" }
      : { subsystem: domain === "prompt" ? "method" as const : domain, taskId: "task", versionId: `source:${domain}` };
    await act({ kind: "report", issueId: `issue:${domain}`, scope: "workspace:application", problemKey: `problem:${domain}`,
      report: { reportId: `report:${domain}`, source, facts: ["synthetic authorized stage"], evidenceRefs: ["evidence:fixture"] } });
    await act({ kind: "decide", issueId: `issue:${domain}`, expectedRevision: 1, decision: "focused_learning",
      reason: "Bounded local fixture", sourceRefs: ["evidence:fixture"] });
  }

  await act({ kind: "open_budget", expectedSequence: (await load()).sequence,
    budget: { schemaVersion: 1, budgetId: "budget:application", scope: "workspace:application", unit: "total_model_tokens",
      limits: resources(tokens, callsAndSteps, callsAndSteps), authorizationRef: "host:fixture" } });
  const submit = async (input: AllocationApplicationInput, wrap?: (store: BoardStore) => BoardStore) => {
    const result = await withBoardWriter(root, store => commitLearningAllocation({ store: wrap?.(store) ?? store, now, enabled: () => true }, input));
    if ("ok" in result) throw new Error(result.reason);
    return result;
  };

  return { root, load, act, submit };
}

const offer = (domain: CentralLearningAgentDomain): LearningAllocationOffer => ({ offerId: `offer:${domain}`,
  owner: { plane: "agent", domain }, policyRef: `policy:${domain}`, reserve: resources(1000), maxPromptChars: 1000 });

async function request(fx: Awaited<ReturnType<typeof setup>>, selected: readonly CentralLearningAgentDomain[] = domains): Promise<AllocationApplicationInput> {
  const state = await fx.load(), budget = centralBudgetProjection(state, "budget:application")!;
  const offers = selected.map(offer);
  const bindings: AllocationFundingBinding[] = offers.map(item => ({ offerId: item.offerId, offerHash: contentHashOf(item),
    policyRef: item.policyRef, sourceBindingRef: `ready:${item.offerId}`, issueId: `issue:${item.owner.plane === "agent" ? item.owner.domain : "user"}`,
    expectedIssueRevision: 2, grantId: `grant:${item.offerId}`, mode: "fund", chargedAtBasis: zero(),
    authorizedAllowance: { ...HOST_FIXTURE_ALLOWANCE } }));

  return { kind: "portfolio", proposalJson: JSON.stringify({ schemaVersion: 1,
    basis: { scope: budget.budget.scope, boardSequence: state.sequence, budgetId: budget.budget.budgetId,
      utilityUnit: "normalized-net-value", valuationRef: "external-valuation:fixture" }, unit: "total_model_tokens",
    domainRelation: "separable", budget: budget.available,
    groups: offers.map((item, index) => ({ owner: item.owner, tiers: [{ quota: 1, netValue: .1 * (index + 1), offer: item }] })) }),
    bindingsJson: JSON.stringify(bindings), authorizationRef: "host:stage-allocation" };
}

test("five domains share one real Board budget; retry returns history plus the current balance", async () => fixture(async fx => {
  const input = await request(fx), result = await fx.submit(input);

  assert.equal(result.status, "committed");
  const funded = await fx.load();

  assert.equal(funded.centralLearningGrants?.length, 5);
  assert.deepEqual(new Set(funded.centralLearningGrants?.map(item => item.domain)), new Set(domains));
  assert.equal(centralBudgetProjection(funded, "budget:application")?.occupied.tokens, 5000);
  const grant = funded.centralLearningGrants![0]!;

  await fx.act({ kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId: "claim:one", ownerId: "worker",
    expiresAt: "2026-11-04T03:01:00.000Z" });
  await fx.act({ kind: "reserve", grantId: grant.grantId, claimId: "claim:one", reservationId: "reservation:one", maxTokens: 1000 });
  await fx.act({ kind: "settle", grantId: grant.grantId, reservationId: "reservation:one", usage: { kind: "reported", totalTokens: 100 } });
  await fx.act({ kind: "finish", jobId: grant.jobId, claimId: "claim:one", result: { kind: "completed", resultRefs: ["receipt:one"] } });
  const previous = await fx.submit(input);

  assert.equal(previous.status, "previous");

  if (previous.status === "previous") assert.equal(previous.budget.available.tokens, 900);

  assert.equal((await fx.load()).centralLearningGrants?.length, 5);
}));

test("invalid pure proposal is rejected while another real writer remains held", async () => fixture(async fx => {
  const before = await fx.load();
  const app = createLearningAllocationApplication({ boardRoot: fx.root, now, enabled: () => true });
  const result = await withBoardWriter(fx.root, async () => app.commit({ kind: "portfolio", proposalJson: "{}",
    bindingsJson: "[]", authorizationRef: "host:invalid-proposal" }));

  assert.ok(!("ok" in result));
  assert.equal(result.status, "rejected");

  if (result.status === "rejected") assert.equal(result.reason, "allocation_proposal_invalid_or_limited");

  assert.equal((await fx.load()).sequence, before.sequence);
}));

test("captured allocation keeps its original basis after another writer commits", async () => fixture(async fx => {
  const captured = captureLearningAllocation(await request(fx, ["prompt"]));

  assert.ok(captured.ok);
  await fx.act({ kind: "decide", issueId: "issue:tool", expectedRevision: 2, decision: "ordinary_execution",
    reason: "Independent real state change", sourceRefs: ["evidence:fixture"] });
  const before = await fx.load();
  const result = await withBoardWriter(fx.root, store => captured.submit({ store, now, enabled: () => true }));

  assert.ok(!("ok" in result));
  assert.equal(result.status, "stale");
  const after = await fx.load();

  assert.equal(after.sequence, before.sequence);
  assert.equal(after.rewardV2Facts?.length ?? 0, 0);
  assert.equal(after.centralLearningGrants?.length ?? 0, 0);
}));

function loseAcknowledgement(store: BoardStore): BoardStore {
  let writes = 0;
  return { ...store, load: () => store.load(), snapshot: generation => store.snapshot(generation),
    compact: generation => store.compact(generation), close: () => store.close(),

    async apply(command: BoardCommand) {
      const result = await store.apply(command);
      if (++writes === 2) throw new Error("synthetic_lost_ack_after_durable_fund");
      return result;
    } };
}

test("lost acknowledgement resumes only its exact durable prefix without another grant", async () => fixture(async fx => {
  const input = await request(fx), lost = await fx.submit(input, loseAcknowledgement);

  assert.equal(lost.status, "unconfirmed");
  assert.equal((await fx.load()).centralLearningGrants?.length, 1);
  const recovered = await fx.submit(input);

  assert.equal(recovered.status, "committed");
  assert.equal((await fx.load()).centralLearningGrants?.length, 5);
  assert.equal(centralBudgetProjection(await fx.load(), "budget:application")?.occupied.tokens, 5000);
}));

test("an unrelated event after a partial prefix makes the old valuation stale", async () => fixture(async fx => {
  const input = await request(fx);

  await fx.submit(input, loseAcknowledgement);
  await fx.act({ kind: "report", issueId: "issue:new", scope: "workspace:application", problemKey: "new",
    report: { reportId: "report:new", source: { subsystem: "tool", taskId: "task", versionId: "new" },
      facts: ["New observation"], evidenceRefs: ["evidence:new"] } });
  assert.equal((await fx.submit(input)).status, "stale");
  assert.equal((await fx.load()).centralLearningGrants?.length, 1);
}));

test("bindings and owners are checked before even a decision record is appended", async () => fixture(async fx => {
  const input = await request(fx, ["prompt"]), before = (await fx.load()).sequence;
  const bindings = JSON.parse(input.bindingsJson);

  bindings[0].issueId = "issue:tool";
  const result = await fx.submit({ ...input, bindingsJson: JSON.stringify(bindings) });

  assert.equal(result.status, "rejected");

  if (result.status === "rejected") assert.equal(result.reason, "allocation_owner_binding");

  assert.equal((await fx.load()).sequence, before);
}));

for (const [field, ceiling] of [["maxTokens", 999], ["maxCalls", 1], ["maxSteps", 1], ["maxPromptChars", 999]] as const) {
  test(`host ${field} ceiling rejects an oversized quote before audit or funding`, async () => fixture(async fx => {
    const input = await request(fx, ["prompt"]), raw = JSON.parse(input.proposalJson), bindings = JSON.parse(input.bindingsJson);
    const selected = raw.groups[0].tiers[0].offer;

    selected.reserve = resources(1000, 2, 2);
    bindings[0].offerHash = contentHashOf(selected);
    // The host explicitly narrows one previously fixed ceiling; it is not copied from the quoted envelope.
    bindings[0].authorizedAllowance = { ...HOST_FIXTURE_ALLOWANCE, [field]: ceiling };
    const before = await fx.load();
    const result = await fx.submit({ ...input, proposalJson: JSON.stringify(raw), bindingsJson: JSON.stringify(bindings) });

    assert.ok(result.status === "rejected" && result.reason === "allocation_domain_allowance_exceeded");
    const after = await fx.load();

    assert.equal(after.sequence, before.sequence);
    assert.equal(after.rewardV2Facts?.length ?? 0, 0);
    assert.equal(after.centralLearningGrants?.length ?? 0, 0);
  }));
}

test("JSON inputs are captured before an asynchronous load can mutate caller properties", async () => fixture(async fx => {
  const input = { ...await request(fx, ["prompt"]) };
  const original = { ...input };
  let open: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => { open = resolve; });
  const outcome = withBoardWriter(fx.root, store => commitLearningAllocation({ store: { ...store,
    apply: command => store.apply(command), snapshot: generation => store.snapshot(generation), compact: generation => store.compact(generation),
    close: () => store.close(), load: async () => {
      await barrier;
      return store.load();
    } }, now, enabled: () => true }, input));

  await Promise.resolve();
  input.proposalJson = "{}";
  input.bindingsJson = "[]";
  input.authorizationRef = "changed-after-capture";
  open!();
  const result = await outcome;

  assert.ok("status" in result && result.status === "committed");
  assert.equal((await fx.submit(original)).status, "previous");
}));

test("managed continuation adds the next reserve to real charges and requires reconcile", async () => fixture(async fx => {
  const first = await request(fx, ["prompt"]);

  assert.equal((await fx.submit(first)).status, "committed");
  const original = (await fx.load()).centralLearningGrants![0]!;

  await fx.act({ kind: "claim", jobId: original.jobId, expectedAttempt: 0, claimId: "claim:review", ownerId: "review",
    expiresAt: "2026-11-04T03:01:00.000Z" });
  await fx.act({ kind: "reserve", grantId: original.grantId, claimId: "claim:review", reservationId: "reservation:review", maxTokens: 1000 });
  await fx.act({ kind: "settle", grantId: original.grantId, reservationId: "reservation:review", usage: { kind: "reported", totalTokens: 100 } });
  await fx.act({ kind: "finish", jobId: original.jobId, claimId: "claim:review", result: { kind: "yielded", reason: "review boundary" } });
  const build = async (fake = false, authorizedAllowance: CentralLearningAllowance = HOST_FIXTURE_ALLOWANCE) => {
    const input = await request(fx, ["prompt"]), state = await fx.load(), grant = state.centralLearningGrants![0]!;
    const bindings = JSON.parse(input.bindingsJson);
    bindings[0].mode = "extend";
    bindings[0].expectedIssueRevision = state.learningIssues!.find(item => item.issueId === grant.issueId)!.revision;
    bindings[0].chargedAtBasis = fake ? resources(5000, 10, 10) : centralLearningSpent(grant);
    bindings[0].authorizedAllowance = { ...authorizedAllowance };
    return { ...input, bindingsJson: JSON.stringify(bindings) };
  };
  const held = await fx.submit(await build());

  assert.ok(held.status === "rejected" && held.reason === "allocation_reconcile_required");
  let state = await fx.load();

  await fx.act({ kind: "rebudget", grantId: original.grantId, expectedSequence: state.sequence, authorizationRef: "host:reconcile",
    planRef: "reconcile:one", limits: centralLearningSpent(state.centralLearningGrants![0]!) });
  const forged = await fx.submit(await build(true));

  assert.ok(forged.status === "rejected" && forged.reason === "allocation_charge_binding");

  // Each next-stage reserve fits alone; only the real charged lifetime floor makes the requested total exceed host authority.
  for (const [field, ceiling] of [["maxTokens", 1050], ["maxCalls", 1], ["maxSteps", 1]] as const) {
    const before = await fx.load();
    const tooLarge = await fx.submit(await build(false, { ...HOST_FIXTURE_ALLOWANCE, [field]: ceiling }));

    assert.ok(tooLarge.status === "rejected" && tooLarge.reason === "allocation_domain_allowance_exceeded");
    const after = await fx.load();

    assert.equal(after.sequence, before.sequence);
    assert.equal(after.rewardV2Facts?.length, before.rewardV2Facts?.length);
    assert.equal(after.centralLearningGrants?.length, 1);
    assert.equal(after.centralLearningGrants![0]!.allowance.maxTokens, 100);
  }

  const continued = await fx.submit(await build());

  assert.equal(continued.status, "committed");
  state = await fx.load();
  assert.equal(state.centralLearningGrants?.length, 1);
  assert.equal(state.centralLearningGrants![0]!.allowance.maxTokens, 1100);
  assert.equal(state.centralLearningGrants![0]!.reservations.length, 1);
}, 50000));

test("peer User remains a planner input but cannot be funded through an Agent worker", async () => fixture(async fx => {
  const input = await request(fx, ["prompt"]), raw = JSON.parse(input.proposalJson), before = (await fx.load()).sequence;
  raw.groups[0].owner = { plane: "user" };
  raw.groups[0].tiers[0].offer.owner = { plane: "user" };
  const result = await fx.submit({ ...input, proposalJson: JSON.stringify(raw) });
  assert.ok(result.status === "rejected" && result.reason === "allocation_user_binding_unavailable");
  assert.equal((await fx.load()).sequence, before);
}));

test("disabled host APIs create no Board directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "allocation-application-")), root = path.join(parent, "never-created");
  try {
    const app = createLearningAllocationApplication({ boardRoot: root, now });
    assert.equal((await app.inspect("unused")).status, "disabled");
    assert.deepEqual(await app.openBudget("{}", 0), { status: "disabled" });
    assert.equal((await app.commit({ kind: "portfolio", proposalJson: "{}", bindingsJson: "[]", authorizationRef: "host" })).status, "disabled");
    await assert.rejects(stat(root), { code: "ENOENT" });
  } finally {
    assert.equal(path.dirname(path.resolve(parent)), path.resolve(tmpdir()));
    assert.ok(path.basename(parent).startsWith("allocation-application-"));
    await rm(parent, { recursive: true, force: true });
  }
});

test("heterogeneous real token envelopes select two smaller domains instead of overspending", async () => fixture(async fx => {
  const base = await request(fx, ["prompt", "tool", "skill"]), raw = JSON.parse(base.proposalJson);

  for (const group of raw.groups) {
    group.tiers[0].netValue = group.owner.domain === "prompt" ? .9 : .8;
    group.tiers[0].offer.reserve = resources(group.owner.domain === "prompt" ? 8000 : 5000);
  }

  raw.budget = resources(10000, 2, 2);
  const planned = allocateLearningPortfolio(JSON.stringify(raw));

  assert.equal(planned.status, "allocated");

  if (planned.status !== "allocated") return;

  const selected = planned.plan.allocations.flatMap(item => item.offer === null ? [] : [item.offer]);
  const bindings = JSON.parse(base.bindingsJson).filter((item: AllocationFundingBinding) => selected.some(offer => offer.offerId === item.offerId))
    .map((item: AllocationFundingBinding) => ({ ...item, offerHash: contentHashOf(selected.find(offer => offer.offerId === item.offerId)!) }));
  const result = await fx.submit({ ...base, proposalJson: JSON.stringify(raw), bindingsJson: JSON.stringify(bindings) });

  assert.equal(result.status, "committed");
  const state = await fx.load();

  assert.deepEqual(new Set(state.centralLearningGrants?.map(item => item.domain)), new Set(["tool", "skill"]));
  assert.equal(centralBudgetProjection(state, "budget:application")?.occupied.tokens, 10000);
}, 10000));

test("sequential planning funds only the first tranche, never its hypothetical branches", async () => fixture(async fx => {
  const base = await request(fx, ["prompt"]), raw = JSON.parse(base.proposalJson), first = raw.groups[0].tiers[0].offer;
  const next = { ...offer("prompt"), offerId: "next:prompt" }, alternative = { ...offer("tool"), offerId: "next:tool" };
  const outcome = (nextStateId: string, probability = 1) => ({ probability, cost: resources(1000), utilityCost: 0, nextStateId });
  const model = { schemaVersion: 1, modelKind: "declared_finite_observable", basis: raw.basis,
    initialStateId: "root", remaining: resources(2000, 2, 2), horizon: 2, states: [
      { stateId: "root", stopValue: 0, offers: [{ offer: first, outcomes: [outcome("high", .5), outcome("low", .5)] }] },
      { stateId: "high", stopValue: 0, offers: [{ offer: next, outcomes: [outcome("a-done")] }] },
      { stateId: "low", stopValue: 0, offers: [{ offer: alternative, outcomes: [outcome("b-done")] }] },
      { stateId: "a-done", stopValue: 1, offers: [] }, { stateId: "b-done", stopValue: .7, offers: [] },
    ] };
  const result = await fx.submit({ ...base, kind: "sequential", proposalJson: JSON.stringify(model) });

  assert.equal(result.status, "committed");
  const state = await fx.load();

  assert.equal(state.centralLearningGrants?.length, 1);
  assert.equal(state.centralLearningGrants![0]!.domain, "prompt");
  assert.equal(state.centralLearningGrants![0]!.allowance.maxTokens, 1000);
}));

test("future User value cannot finance an Agent first stage without an executable User binding", async () => fixture(async fx => {
  const base = await request(fx, ["prompt"]), raw = JSON.parse(base.proposalJson), first = raw.groups[0].tiers[0].offer;
  const alternative = offer("tool"), user: LearningAllocationOffer = { offerId: "future:user", owner: { plane: "user" },
    policyRef: "policy:future-user", reserve: resources(1000), maxPromptChars: 1000 };
  const outcome = (nextStateId: string) => ({ probability: 1, cost: resources(1000), utilityCost: 0, nextStateId });
  const model = { schemaVersion: 1, modelKind: "declared_finite_observable", basis: raw.basis,
    initialStateId: "root", remaining: resources(2000, 2, 2), horizon: 2, states: [
      { stateId: "root", stopValue: 0, offers: [{ offer: first, outcomes: [outcome("await-user")] },
        { offer: alternative, outcomes: [outcome("agent-only-done")] }] },
      { stateId: "await-user", stopValue: 0, offers: [{ offer: user, outcomes: [outcome("joint-done")] }] },
      { stateId: "agent-only-done", stopValue: 1, offers: [] }, { stateId: "joint-done", stopValue: 2, offers: [] },
    ] };
  const json = JSON.stringify(model), planned = planSequentialAllocation(json);

  assert.equal(planned.status, "planned");

  if (planned.status !== "planned") return;

  assert.ok(planned.plan.decision.kind === "offer" && planned.plan.decision.offer.offerId === first.offerId,
    "the pure numerical API retains User as a peer and values the declared A-to-User continuation");
  const before = await fx.load();
  const result = await fx.submit({ ...base, kind: "sequential", proposalJson: json });
  const after = await fx.load();

  assert.deepEqual({ status: result.status, reason: result.status === "rejected" ? result.reason : undefined,
    auditCount: after.rewardV2Facts?.length ?? 0, grantCount: after.centralLearningGrants?.length ?? 0, sequence: after.sequence },
  { status: "rejected", reason: "allocation_user_binding_unavailable", auditCount: 0, grantCount: 0, sequence: before.sequence });
}));

test("future zero provider envelope cannot finance an Agent first stage", async () => fixture(async fx => {
  const base = await request(fx, ["prompt"]), raw = JSON.parse(base.proposalJson), first = offer("prompt");
  const freeFuture: LearningAllocationOffer = { ...offer("tool"), offerId: "future:zero-tool", reserve: zero() };
  const outcome = (nextStateId: string, cost = resources(1000)) => ({ probability: 1, cost, utilityCost: 0, nextStateId });
  const model = { schemaVersion: 1, modelKind: "declared_finite_observable", basis: raw.basis,
    initialStateId: "root", remaining: resources(2000, 2, 2), horizon: 2, states: [
      { stateId: "root", stopValue: 0, offers: [{ offer: first, outcomes: [outcome("await-free-tool")] },
        { offer: offer("tool"), outcomes: [outcome("agent-only-done")] }] },
      { stateId: "await-free-tool", stopValue: 0, offers: [{ offer: freeFuture, outcomes: [outcome("joint-done", zero())] }] },
      { stateId: "agent-only-done", stopValue: 1, offers: [] }, { stateId: "joint-done", stopValue: 2, offers: [] },
    ] };
  const json = JSON.stringify(model), planned = planSequentialAllocation(json);

  assert.equal(planned.status, "planned");

  if (planned.status !== "planned") return;

  assert.ok(planned.plan.decision.kind === "offer" && planned.plan.decision.offer.offerId === first.offerId);
  assert.equal(planned.plan.netPolicyValue, 2, "the pure numerical API retains declared zero-cost local stages");
  const before = await fx.load();
  const app = createLearningAllocationApplication({ boardRoot: fx.root, now, enabled: () => true });
  const result = await app.commit({ ...base, kind: "sequential", proposalJson: json });
  const after = await fx.load();

  assert.deepEqual({ status: result.status, reason: result.status === "rejected" ? result.reason : undefined,
    auditCount: after.rewardV2Facts?.length ?? 0, grantCount: after.centralLearningGrants?.length ?? 0, sequence: after.sequence },
  { status: "rejected", reason: "allocation_provider_grant_envelope_required", auditCount: 0, grantCount: 0, sequence: before.sequence });
}));

test("future provider envelope above the canonical call cap cannot finance an Agent first stage", async () => fixture(async fx => {
  const base = await request(fx, ["prompt"]), raw = JSON.parse(base.proposalJson), first = offer("prompt");
  const future: LearningAllocationOffer = { ...offer("tool"), offerId: "future:65-tool", reserve: resources(1000, 65, 65) };
  const outcome = (nextStateId: string, cost: ReturnType<typeof resources>) => ({ probability: 1, cost, utilityCost: 0, nextStateId });
  const model = { schemaVersion: 1, modelKind: "declared_finite_observable", basis: raw.basis,
    initialStateId: "root", remaining: resources(2000, 66, 66), horizon: 2, states: [
      { stateId: "root", stopValue: 0, offers: [{ offer: first, outcomes: [outcome("await-tool", first.reserve)] }] },
      { stateId: "await-tool", stopValue: 0, offers: [{ offer: future, outcomes: [outcome("done", future.reserve)] }] },
      { stateId: "done", stopValue: 2, offers: [] },
    ] };
  const json = JSON.stringify(model), planned = planSequentialAllocation(json);

  assert.equal(planned.status, "planned");

  if (planned.status !== "planned") return;

  assert.ok(planned.plan.decision.kind === "offer" && planned.plan.decision.offer.offerId === first.offerId);
  assert.equal(planned.plan.netPolicyValue, 2, "the pure resource model permits 65 calls while a canonical grant cannot");
  const before = await fx.load();

  assert.deepEqual(centralBudgetProjection(before, "budget:application")?.available, resources(5000, 66, 66));
  const app = createLearningAllocationApplication({ boardRoot: fx.root, now, enabled: () => true });
  const result = await app.commit({ ...base, kind: "sequential", proposalJson: json });
  const after = await fx.load();

  assert.deepEqual({ status: result.status, reason: result.status === "rejected" ? result.reason : undefined,
    auditCount: after.rewardV2Facts?.length ?? 0, grantCount: after.centralLearningGrants?.length ?? 0, sequence: after.sequence },
  { status: "rejected", reason: "allocation_provider_grant_envelope_required", auditCount: 0, grantCount: 0, sequence: before.sequence });
}, 5000, 66));

for (const scenario of [
  { name: "positive tokens without a call", cost: resources(1000, 0, 0), future: resources(1000), callsAndSteps: 1 },
  { name: "unequal call and step charges", cost: resources(1000, 1, 0), future: resources(1000, 1, 2), callsAndSteps: 2 },
]) {
  test(`provider charge model rejects ${scenario.name} before financing the first stage`, async () => fixture(async fx => {
    const base = await request(fx, ["prompt"]), raw = JSON.parse(base.proposalJson), first = offer("prompt");
    const future: LearningAllocationOffer = { ...offer("tool"), offerId: "future:charged-tool", reserve: scenario.future };
    const model = { schemaVersion: 1, modelKind: "declared_finite_observable", basis: raw.basis,
      initialStateId: "root", remaining: resources(2000, scenario.callsAndSteps, scenario.callsAndSteps), horizon: 2, states: [
        { stateId: "root", stopValue: 0, offers: [{ offer: first, outcomes: [{ probability: 1, cost: scenario.cost,
          utilityCost: 0, nextStateId: "after-first" }] }] },
        { stateId: "after-first", stopValue: 0, offers: [{ offer: future, outcomes: [{ probability: 1,
          cost: resources(1000), utilityCost: 0, nextStateId: "done" }] }] },
        { stateId: "done", stopValue: 2, offers: [] },
      ] };
    const json = JSON.stringify(model), planned = planSequentialAllocation(json);

    assert.equal(planned.status, "planned", "the general numerical planner retains independent resource axes");

    if (planned.status !== "planned") return;

    assert.ok(planned.plan.decision.kind === "offer" && planned.plan.decision.offer.offerId === first.offerId);
    assert.equal(planned.plan.netPolicyValue, 2, "the forecast needs the supposedly preserved future provider capacity");
    const before = await fx.load();

    assert.deepEqual(centralBudgetProjection(before, "budget:application")?.available,
      resources(2000, scenario.callsAndSteps, scenario.callsAndSteps));
    const app = createLearningAllocationApplication({ boardRoot: fx.root, now, enabled: () => true });
    const result = await app.commit({ ...base, kind: "sequential", proposalJson: json });
    const after = await fx.load();

    assert.deepEqual({ status: result.status, reason: result.status === "rejected" ? result.reason : undefined,
      auditCount: after.rewardV2Facts?.length ?? 0, grantCount: after.centralLearningGrants?.length ?? 0, sequence: after.sequence },
    { status: "rejected", reason: "allocation_provider_charge_model_required", auditCount: 0, grantCount: 0, sequence: before.sequence });
  }, 2000, scenario.callsAndSteps));
}
