import assert from "node:assert/strict";
import { test } from "node:test";
import type { LearningAllocationOwner } from "./allocation-contract.js";
import { contentHashOf } from "./hash.js";
import { allocateLearningPortfolio } from "./portfolio-allocation.js";
import type { TopicBudgetBid } from "./topic-bid.js";
import type { TopicPortfolioBinding, TopicPortfolioBridgeInput, TopicPortfolioEnvelopeEntry } from "./topic-portfolio-bridge-contract.js";
import { bridgeTopicPortfolio, topicPortfolioEnvelopeOf } from "./topic-portfolio-bridge.js";

const basis = { scope: "scope", boardSequence: 5, budgetId: "pool", utilityUnit: "normalized-net", valuationRef: "external:valuation" };

function binding(domain: "prompt" | "tool" | "user", values = [0, .4, .6], valuationId = `valuation:${domain}`): TopicPortfolioBinding {
  const owner: LearningAllocationOwner = domain === "user" ? { plane: "user" } : { plane: "agent", domain };
  const bid: TopicBudgetBid = { schemaVersion: 1, valuationId, domain, scope: basis.scope,
    basis: { boardSequence: basis.boardSequence, evidenceWindowHash: `window:${domain}` }, utilityUnit: basis.utilityUnit,
    quotaUnit: "declared-learning-quota", modelKind: "declared_finite_expected_utility", curve: values.map((netValue, quota) => ({ quota, netValue })) };

  return { bid, sidecar: { schemaVersion: 1, domain, owner, valuationId, bidHash: contentHashOf(bid), scope: bid.scope,
    boardSequence: bid.basis.boardSequence, evidenceWindowHash: bid.basis.evidenceWindowHash,
    utilityUnit: bid.utilityUnit, quotaUnit: bid.quotaUnit, tokenAccountingUnit: "total_model_tokens",
    policySemantics: "declared_quota_policy_equivalence", entries: bid.curve.map(point => {
      if (point.quota === 0) return { quota: 0, kind: "idle" };
      const offer = { offerId: `${domain}:${point.quota}`, owner, policyRef: `policy:${domain}:${point.quota}`,
        reserve: { tokens: point.quota * 100, calls: point.quota, steps: point.quota }, maxPromptChars: 1000 };
      return { quota: point.quota, kind: "funded", offer, envelopeHash: contentHashOf(topicPortfolioEnvelopeOf(offer)) };
    }) } };
}

function input(bindings: readonly TopicPortfolioBinding[] = [binding("prompt")]): TopicPortfolioBridgeInput {
  return { schemaVersion: 1, basis, unit: "total_model_tokens", domainRelation: "separable", quotaUnit: "declared-learning-quota",
    budget: { tokens: 300, calls: 3, steps: 3 }, bindings };
}

const bridge = (value: unknown) => bridgeTopicPortfolio(JSON.stringify(value));

test("real TopicBudgetBid plus exact envelopes becomes a physical portfolio without changing old quotes", () => {
  const source = input([binding("prompt"), binding("tool", [0, .3])]), before = JSON.stringify(source);
  const result = bridge(source);

  assert.equal(result.status, "ready");

  if (result.status !== "ready") throw new Error("expected_ready");

  const allocated = allocateLearningPortfolio(result.requestJson);

  assert.equal(allocated.status, "allocated");

  if (allocated.status !== "allocated") throw new Error("expected_allocated");

  assert.ok(Math.abs(allocated.plan.netValue - .9) < 1e-14);
  assert.equal(result.request.basis.valuationRef, `topic-portfolio:${contentHashOf(source)}`);
  assert.equal(result.provenance.externalValuationRef, basis.valuationRef);
  assert.equal(result.provenance.sources[0]!.bidHash, contentHashOf(source.bindings[0]!.bid));
  assert.equal(JSON.stringify(source), before);
});

test("peer User quote remains a peer owner and q0 alone maps to idle", () => {
  const result = bridge(input([binding("user", [0])]));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("expected_ready");
  assert.deepEqual(result.request.groups[0]!.owner, { plane: "user" });
  assert.deepEqual(result.request.groups[0]!.tiers, []);
  assert.equal(result.provenance.sources[0]!.entries[0]!.kind, "idle");
});

test("same numeric offers with different valuation identity cannot alias the derived valuationRef", () => {
  const a = bridge(input([binding("prompt", [0, .4], "valuation:one")]));
  const b = bridge(input([binding("prompt", [0, .4], "valuation:two")]));

  assert.equal(a.status, "ready");
  assert.equal(b.status, "ready");

  if (a.status !== "ready" || b.status !== "ready") throw new Error("expected_ready");

  assert.deepEqual(a.request.groups, b.request.groups);
  assert.notEqual(a.request.basis.valuationRef, b.request.basis.valuationRef);
  assert.notEqual(a.requestJson, b.requestJson);
});

test("every source identity and both abstract and physical units are bound", () => {
  const source = input(), original = source.bindings[0]!;
  const changes = { valuationId: "other", bidHash: "other", evidenceWindowHash: "other", scope: "other",
    boardSequence: 6, utilityUnit: "other", quotaUnit: "other", tokenAccountingUnit: "output_model_tokens" };

  for (const [key, value] of Object.entries(changes)) {
    const modified = { ...source, bindings: [{ bid: original.bid, sidecar: { ...original.sidecar, [key]: value } }] };
    assert.equal(bridge(modified).status, "rejected", key);
  }

  assert.equal(bridge({ ...source, basis: { ...basis, boardSequence: 6 } }).status, "rejected");
  assert.equal(bridge({ ...source, quotaUnit: "other" }).status, "rejected");
  assert.equal(bridge({ ...source, unit: "output_model_tokens" }).status, "rejected");
});

test("exact envelope hashes detect cap or prompt-limit substitution", () => {
  const source = input(), original = source.bindings[0]!, paid = original.sidecar.entries[1]!;
  if (paid.kind !== "funded") throw new Error("expected_funded");
  for (const offer of [{ ...paid.offer, reserve: { ...paid.offer.reserve, tokens: 99 } }, { ...paid.offer, maxPromptChars: 1001 }]) {
    const entries: readonly TopicPortfolioEnvelopeEntry[] = [original.sidecar.entries[0]!, { ...paid, offer }, original.sidecar.entries[2]!];
    assert.equal(bridge({ ...source, bindings: [{ ...original, sidecar: { ...original.sidecar, entries } }] }).status, "rejected");
  }
});

test("point coverage, paid-stage positivity, owner binding and canonical cap rules are strict", () => {
  const source = input(), original = source.bindings[0]!, paid = original.sidecar.entries[1]!;
  if (paid.kind !== "funded") throw new Error("expected_funded");

  const zeroOffer = { ...paid.offer, reserve: { tokens: 0, calls: 1, steps: 1 } };
  const aliasOffer = { ...paid.offer, offerId: "alias", policyRef: "alias", maxPromptChars: 1001 };
  const variants = [original.sidecar.entries.slice(1), [...original.sidecar.entries, paid],
    [paid, original.sidecar.entries[0]!], [original.sidecar.entries[0]!, { ...paid, offer: zeroOffer,
      envelopeHash: contentHashOf(topicPortfolioEnvelopeOf(zeroOffer)) }, original.sidecar.entries[2]!],
    [original.sidecar.entries[0]!, paid, { ...paid, quota: 2, offer: aliasOffer,
      envelopeHash: contentHashOf(topicPortfolioEnvelopeOf(aliasOffer)) }]];

  for (const entries of variants) assert.equal(bridge({ ...source, bindings: [{ ...original, sidecar: { ...original.sidecar, entries } }] }).status, "rejected");

  assert.equal(bridge({ ...source, bindings: [{ ...original, sidecar: { ...original.sidecar, owner: { plane: "user" } } }] }).status, "rejected");
  assert.equal(bridge({ ...source, bindings: [original, original] }).status, "rejected");
});

test("legacy-valid inactive domains and malformed quote points cannot gain an active owner through the bridge", () => {
  const source = input(), original = source.bindings[0]!;
  const inactiveBid = { ...original.bid, domain: "verifier" };
  const inactive = { ...original, bid: inactiveBid, sidecar: { ...original.sidecar, domain: "verifier", bidHash: contentHashOf(inactiveBid) } };

  assert.equal(bridge({ ...source, bindings: [inactive] }).status, "rejected");
  const decreasingBid = { ...original.bid, curve: [{ quota: 0, netValue: 0 }, { quota: 1, netValue: .5 }, { quota: 2, netValue: .1 }] };

  assert.equal(bridge({ ...source, bindings: [{ ...original, bid: decreasingBid }] }).status, "rejected");
  assert.equal(bridge({ ...source, extra: true }).status, "rejected");
});
