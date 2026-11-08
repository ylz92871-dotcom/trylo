import { fields, identity, list, sequence } from "../../validation/json-shape.js";
import { LEARNING_DOMAINS } from "./contracts.js";
import { isAllocationBasis, isAllocationOffer, isAllocationOwner, isAllocationResources } from "./allocation-shape.js";
import { isTopicBudgetBid } from "./topic-allocation.js";
import type { TopicPortfolioBridgeInput, TopicPortfolioEnvelopeEntry, TopicPortfolioSidecar } from "./topic-portfolio-bridge-contract.js";

const INPUT_KEYS = ["schemaVersion", "basis", "unit", "domainRelation", "quotaUnit", "budget", "bindings"];
const SIDECAR_KEYS = ["schemaVersion", "domain", "owner", "valuationId", "bidHash", "scope", "boardSequence",
  "evidenceWindowHash", "utilityUnit", "quotaUnit", "tokenAccountingUnit", "policySemantics", "entries"];

/** Strict source-shape boundary; identity/equality checks are performed by the bridge. */
export function readTopicPortfolioBridgeInput(json: string): TopicPortfolioBridgeInput | undefined {
  if (typeof json !== "string" || json.length > 131_072) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return undefined; }
  // Preserve the original full validated source representation for hashing.
  return isBridgeInput(raw) ? raw : undefined;
}

function isBridgeInput(value: unknown): value is TopicPortfolioBridgeInput {
  return fields(value, INPUT_KEYS) && value.schemaVersion === 1 && isAllocationBasis(value.basis)
    && value.unit === "total_model_tokens" && value.domainRelation === "separable" && identity(value.quotaUnit)
    && isAllocationResources(value.budget) && list(value.bindings, 0, 6)
    && value.bindings.every(binding => fields(binding, ["bid", "sidecar"])
      && isTopicBudgetBid(binding.bid) && isTopicPortfolioSidecar(binding.sidecar));
}

function isTopicPortfolioSidecar(value: unknown): value is TopicPortfolioSidecar {
  return fields(value, SIDECAR_KEYS) && value.schemaVersion === 1
    && LEARNING_DOMAINS.some(domain => domain === value.domain) && isAllocationOwner(value.owner)
    && [value.valuationId, value.bidHash, value.scope, value.evidenceWindowHash, value.utilityUnit, value.quotaUnit].every(identity)
    && sequence(value.boardSequence) && value.tokenAccountingUnit === "total_model_tokens"
    && value.policySemantics === "declared_quota_policy_equivalence" && list(value.entries, 1, 7)
    && value.entries.every(isTopicPortfolioEnvelopeEntry);
}

function isTopicPortfolioEnvelopeEntry(value: unknown): value is TopicPortfolioEnvelopeEntry {
  if (fields(value, ["quota", "kind"]) && value.quota === 0 && value.kind === "idle") return true;
  return fields(value, ["quota", "kind", "offer", "envelopeHash"]) && sequence(value.quota)
    && value.quota >= 1 && value.quota <= 6 && value.kind === "funded" && isAllocationOffer(value.offer)
    && value.offer.reserve.tokens > 0 && value.offer.reserve.calls > 0 && value.offer.reserve.steps > 0
    && value.offer.maxPromptChars > 0 && identity(value.envelopeHash);
}
