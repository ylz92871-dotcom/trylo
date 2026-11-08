import { fields, list } from "../../validation/json-shape.js";
import { allocationCapKey, allocationCount, allocationFinite, allocationOwnerKey, isAllocationBasis,
  isAllocationOffer, isAllocationOwner, isAllocationResources } from "./allocation-shape.js";
import { PORTFOLIO_LIMITS, type LearningPortfolioGroup, type LearningPortfolioRequest, type LearningPortfolioTier } from "./portfolio-allocation-contract.js";

const REQUEST_FIELDS = ["schemaVersion", "basis", "unit", "domainRelation", "budget", "groups"];

/** JSON-only boundary. Accepted values are declared predictions, never certified estimates or grants. */
export function readLearningPortfolio(json: string): LearningPortfolioRequest | undefined {
  if (typeof json !== "string" || json.length > PORTFOLIO_LIMITS.jsonChars) return undefined;

  let raw: unknown;

  try { raw = JSON.parse(json); } catch { return undefined; }

  if ((!fields(raw, REQUEST_FIELDS) && !fields(raw, [...REQUEST_FIELDS, "commonQuantum"]))
    || raw.schemaVersion !== 1 || !isAllocationBasis(raw.basis) || raw.unit !== "total_model_tokens"
    || raw.domainRelation !== "separable" || !isAllocationResources(raw.budget) || !list(raw.groups, 0, PORTFOLIO_LIMITS.groups)) return undefined;

  if (Object.hasOwn(raw, "commonQuantum") && (!isAllocationResources(raw.commonQuantum)
    || (raw.commonQuantum.tokens === 0 && raw.commonQuantum.calls === 0 && raw.commonQuantum.steps === 0))) return undefined;

  const groups: LearningPortfolioGroup[] = [], owners = new Set<string>(), offers = new Set<string>();

  for (const group of raw.groups) {
    if (!fields(group, ["owner", "tiers"]) || !isAllocationOwner(group.owner)
      || owners.has(allocationOwnerKey(group.owner)) || !list(group.tiers, 0, PORTFOLIO_LIMITS.tiers)) return undefined;
    const tiers = readTiers(group.tiers, allocationOwnerKey(group.owner), offers);
    if (tiers === undefined) return undefined;
    owners.add(allocationOwnerKey(group.owner));
    groups.push({ owner: group.owner, tiers });
  }

  groups.sort((left, right) => {
    const a = allocationOwnerKey(left.owner), b = allocationOwnerKey(right.owner);
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return { schemaVersion: 1, basis: raw.basis, unit: "total_model_tokens", domainRelation: "separable", budget: raw.budget, groups,
    ...(isAllocationResources(raw.commonQuantum) ? { commonQuantum: raw.commonQuantum } : {}) };
}

function readTiers(rows: readonly unknown[], ownerKey: string, offers: Set<string>): LearningPortfolioTier[] | undefined {
  const tiers: LearningPortfolioTier[] = [], quotas = new Set<number>(), caps = new Set<string>();

  for (const row of rows) {
    if (!fields(row, ["quota", "netValue", "offer"]) || !allocationCount(row.quota, PORTFOLIO_LIMITS.tiers) || row.quota === 0
      || quotas.has(row.quota) || !allocationFinite(row.netValue, -PORTFOLIO_LIMITS.utilityMagnitude, PORTFOLIO_LIMITS.utilityMagnitude)
      || !isAllocationOffer(row.offer) || allocationOwnerKey(row.offer.owner) !== ownerKey
      || offers.has(row.offer.offerId) || caps.has(allocationCapKey(row.offer))) return undefined;
    quotas.add(row.quota);
    offers.add(row.offer.offerId);
    caps.add(allocationCapKey(row.offer));
    tiers.push({ quota: row.quota, netValue: row.netValue, offer: row.offer });
  }

  return tiers.sort((left, right) => left.quota - right.quota);
}
