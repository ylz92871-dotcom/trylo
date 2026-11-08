import type { LearningAllocationOffer } from "./allocation-contract.js";
import type { CentralLearningAllowance } from "./coordination-contract.js";
import { allocationOwnerKey } from "./allocation-shape.js";
import { canonicalJson, contentHashOf } from "./hash.js";
import { readLearningPortfolio } from "./portfolio-allocation-read.js";
import type { LearningPortfolioGroup, LearningPortfolioRequest } from "./portfolio-allocation-contract.js";
import type { TopicPortfolioBinding, TopicPortfolioBridgeInput, TopicPortfolioBridgeResult, TopicPortfolioProvenance } from "./topic-portfolio-bridge-contract.js";
import { readTopicPortfolioBridgeInput } from "./topic-portfolio-bridge-read.js";

/** Direct field mapping of a producer-supplied total-token cap, never a price conversion or grant. */
export function topicPortfolioEnvelopeOf(offer: LearningAllocationOffer): CentralLearningAllowance {
  return { schemaVersion: 2, unit: "total_model_tokens", maxTokens: offer.reserve.tokens,
    maxCalls: offer.reserve.calls, maxSteps: offer.reserve.steps, maxPromptChars: offer.maxPromptChars };
}

/** No ledger write. Host must persist provenance under valuationRef before treating that identity as recoverable. */
export function bridgeTopicPortfolio(json: string): TopicPortfolioBridgeResult {
  const input = readTopicPortfolioBridgeInput(json);
  if (input === undefined) return { status: "rejected", reason: "topic_portfolio_invalid" };

  const groups: LearningPortfolioGroup[] = [], owners = new Set<string>(), valuations = new Set<string>();

  for (const binding of input.bindings) {
    const key = allocationOwnerKey(binding.sidecar.owner);
    if (owners.has(key) || valuations.has(binding.bid.valuationId) || !bindingMatches(input, binding)) {
      return { status: "rejected", reason: "topic_portfolio_binding" };
    }

    owners.add(key);
    valuations.add(binding.bid.valuationId);
    groups.push({ owner: binding.sidecar.owner, tiers: binding.sidecar.entries.flatMap(entry => entry.kind === "idle" ? []
      : [{ quota: entry.quota, netValue: binding.bid.curve[entry.quota]!.netValue, offer: entry.offer }]) });
  }

  const inputHash = contentHashOf(input), valuationRef = `topic-portfolio:${inputHash}`;
  const proposal: LearningPortfolioRequest = { schemaVersion: 1, basis: { ...input.basis, valuationRef },
    unit: "total_model_tokens", domainRelation: "separable", budget: input.budget, groups };
  const request = readLearningPortfolio(canonicalJson(proposal));

  // Reuse the new allocator's owner/canonical-cap/offer-id rules rather than maintaining a second copy.
  if (request === undefined) return { status: "rejected", reason: "topic_portfolio_binding" };

  const provenance: TopicPortfolioProvenance = { schemaVersion: 1, valuationRef, externalValuationRef: input.basis.valuationRef,
    inputHash, sourceBasis: input.basis, quotaUnit: input.quotaUnit, unit: input.unit,
    sources: input.bindings.map(({ bid, sidecar }) => ({ owner: sidecar.owner, domain: bid.domain, valuationId: bid.valuationId,
      bidHash: contentHashOf(bid), evidenceWindowHash: bid.basis.evidenceWindowHash, sidecarHash: contentHashOf(sidecar), entries: sidecar.entries })) };

  return { status: "ready", request, requestJson: canonicalJson(request), provenance };
}

function bindingMatches(input: TopicPortfolioBridgeInput, { bid, sidecar }: TopicPortfolioBinding): boolean {
  if (bid.scope !== input.basis.scope || bid.basis.boardSequence !== input.basis.boardSequence
    || bid.utilityUnit !== input.basis.utilityUnit || bid.quotaUnit !== input.quotaUnit
    || sidecar.domain !== bid.domain || sidecar.valuationId !== bid.valuationId || sidecar.bidHash !== contentHashOf(bid)
    || sidecar.scope !== bid.scope || sidecar.boardSequence !== bid.basis.boardSequence
    || sidecar.evidenceWindowHash !== bid.basis.evidenceWindowHash || sidecar.utilityUnit !== bid.utilityUnit
    || sidecar.quotaUnit !== bid.quotaUnit || sidecar.entries.length !== bid.curve.length) return false;

  if (sidecar.owner.plane === "user" ? bid.domain !== "user" : bid.domain !== sidecar.owner.domain) return false;

  return sidecar.entries.every((entry, index) => entry.quota === index && (index === 0 ? entry.kind === "idle"
    : entry.kind === "funded" && allocationOwnerKey(entry.offer.owner) === allocationOwnerKey(sidecar.owner)
      && entry.envelopeHash === contentHashOf(topicPortfolioEnvelopeOf(entry.offer))));
}
