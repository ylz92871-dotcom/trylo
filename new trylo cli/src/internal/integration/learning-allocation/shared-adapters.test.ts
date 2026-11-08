import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AllocationApplicationInput, AllocationFundingBinding } from "../../learning/control/allocation-application-contract.js";
import type { CentralLearningAgentDomain } from "../../learning/control/coordination-contract.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import type { LearningAllocationOffer } from "../../learning/control/allocation-contract.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { allocateLearningPortfolio } from "../../learning/control/portfolio-allocation.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createSharedAdapterFixture, type SharedAdapterStage } from "./testing/shared-adapter-fixtures.js";

type Fixture = Awaited<ReturnType<typeof createSharedAdapterFixture>>;

const caps: Readonly<Record<CentralLearningAgentDomain, number>> = { prompt: 2000, tool: 3000, skill: 2500, workflow: 4096, collaboration: 1500 };
const initialValues: Readonly<Record<CentralLearningAgentDomain, number>> = { prompt: .35, tool: .39, skill: .55, workflow: .65, collaboration: .25 };

async function round(fx: Fixture, stages: readonly SharedAdapterStage[], values: Readonly<Partial<Record<CentralLearningAgentDomain, number>>>) {
  const state = await fx.load(), budget = centralBudgetProjection(state, "shared-root");
  assert.ok(budget);
  const offers = new Map<CentralLearningAgentDomain, LearningAllocationOffer>(stages.map(stage => [stage.domain, { offerId: `offer:${stage.domain}`, owner: { plane: "agent", domain: stage.domain },
    policyRef: `policy:accounting:${stage.domain}`, reserve: { tokens: caps[stage.domain], calls: 1, steps: 1 }, maxPromptChars: 4000 } satisfies LearningAllocationOffer]));
  const proposalJson = JSON.stringify({ schemaVersion: 1, basis: { scope: fx.scope, boardSequence: state.sequence, budgetId: "shared-root",
    utilityUnit: "declared-accounting-fixture-value", valuationRef: "fixture:external-expected-net-values" }, unit: "total_model_tokens",
    domainRelation: "separable", budget: budget.available, groups: stages.map(stage => ({ owner: offers.get(stage.domain)!.owner,
      tiers: [{ quota: 1, netValue: values[stage.domain], offer: offers.get(stage.domain)! }] })) });
  const predicted = allocateLearningPortfolio(proposalJson);
  assert.equal(predicted.status, "allocated");
  assert.ok(predicted.status === "allocated");
  const selected = predicted.plan.allocations.flatMap(item => item.offer === null ? [] : [item.offer]);
  const bindings: AllocationFundingBinding[] = selected.map(offer => {
    const owner = offer.owner;
    assert.equal(owner.plane, "agent");
    assert.ok(owner.plane === "agent");
    const stage = stages.find(item => item.domain === owner.domain);
    assert.ok(stage);
    const issue = state.learningIssues?.find(item => item.issueId === stage.issueId);
    assert.ok(issue);
    return { offerId: offer.offerId, offerHash: contentHashOf(offer), policyRef: offer.policyRef, sourceBindingRef: stage.sourceBindingRef,
      authorizedAllowance: stage.authorizedAllowance, issueId: issue.issueId, expectedIssueRevision: issue.revision,
      grantId: stage.grantId, mode: "fund", chargedAtBasis: { tokens: 0, calls: 0, steps: 0 } };
  });
  const input: AllocationApplicationInput = { kind: "portfolio", proposalJson, bindingsJson: JSON.stringify(bindings), authorizationRef: "host:shared-accounting-authorization" };
  const committed = await fx.app.commit(input);
  assert.equal(committed.status, "committed", JSON.stringify(committed));

  return predicted.plan;
}

test("five source-bound adapters compete and reuse settled capacity in one Board and root budget", async t => {
  const parent = path.resolve(tmpdir()), boardRoot = await mkdtemp(path.join(parent, "allocation-shared-adapters-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    assert.ok(path.basename(boardRoot).startsWith("allocation-shared-adapters-"));
    await rm(boardRoot, { recursive: true, force: true });
  });
  const fx = await createSharedAdapterFixture({ boardRoot, scope: path.resolve(boardRoot, "canonical-workspace"), now: () => "2026-11-04T03:00:00.000Z" });
  const opened = await fx.app.openBudget(JSON.stringify({ schemaVersion: 1, budgetId: "shared-root", scope: fx.scope, unit: "total_model_tokens",
    limits: { tokens: 7000, calls: 10, steps: 10 }, authorizationRef: "host:shared-root" }), (await fx.load()).sequence);

  assert.ok("ok" in opened && opened.ok, JSON.stringify(opened));
  const first = await round(fx, fx.stages, initialValues);

  assert.equal(first.used.tokens, 6596);
  assert.ok(Math.abs(first.netValue - 1.2) <= 1e-12);
  assert.deepEqual(first.allocations.filter(item => item.offer !== null).map(item => item.owner.plane === "agent" ? item.owner.domain : "user").sort(), ["skill", "workflow"]);

  for (const stage of fx.stages.filter(item => item.domain === "skill" || item.domain === "workflow")) await stage.consume();

  const settledFirst = centralBudgetProjection(await fx.load(), "shared-root");
  assert.ok(settledFirst);
  assert.equal(settledFirst.available.tokens, 6500);
  assert.equal(fx.accountingCalls(), 2);
  const remaining = fx.stages.filter(item => item.domain !== "skill" && item.domain !== "workflow");
  const second = await round(fx, remaining, { prompt: .9, tool: .8, collaboration: .7 });

  assert.equal(second.used.tokens, 6500);
  assert.ok(Math.abs(second.netValue - 2.4) <= 1e-12);

  for (const stage of remaining) await stage.consume();

  for (const stage of remaining.filter(item => item.domain === "prompt" || item.domain === "tool")) {
    const result = await fx.app.reconcile({ grantId: stage.grantId, expectedSequence: (await fx.load()).sequence, authorizationRef: "host:shared-accounting-authorization" });
    assert.ok("ok" in result && result.ok, JSON.stringify(result));
  }

  const state = await fx.load(), grants = state.centralLearningGrants ?? [], final = centralBudgetProjection(state, "shared-root");
  assert.ok(final);
  assert.equal(grants.length, 5);
  assert.equal(fx.accountingCalls(), 5);
  assert.equal(new Set(grants.map(item => item.grantId)).size, 5);
  assert.deepEqual(new Set(grants.map(item => item.grantId)), new Set(fx.stages.map(item => item.grantId)));
  assert.ok(grants.every(item => item.scope === fx.scope && item.budgetId === "shared-root" && item.reservations.length === 1));
  assert.ok(grants.every(item => { const reservation = item.reservations[0];
    return reservation?.usage?.kind === "reported" && reservation.usage.totalTokens === 250; }));
  assert.equal(grants.reduce((sum, item) => sum + centralLearningSpent(item).tokens, 0), 1250);
  assert.deepEqual(final.occupied, { tokens: 1250, calls: 5, steps: 5 });
  assert.deepEqual(final.available, { tokens: 5750, calls: 5, steps: 5 });
  assert.deepEqual(final.historicalExternalGrantIds, []);
  assert.equal(state.learningGrantFacts?.length ?? 0, 0);
  // Only accounting callbacks ran. Constructed values/caps do not prove a full business review can run or that learning paid off.
});
