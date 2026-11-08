import { contentHashOf } from "../../../../../control/hash.js";
import { toolLearningJobId, type ToolLearningPlan } from "./pipeline.js";

/** Preserve the original lifetime grant identity across child attempts and recovery. */
export function toolLearningFundingIdentity(plan: ToolLearningPlan) {
  // This selects an identity only. The runtime must prove a descendant's
  // host-written backlink before it can bind or spend the existing grant.
  const identity = contentHashOf([plan.scope, plan.researchOrigin?.rootJobId ?? plan.fundingOrigin?.rootJobId ?? toolLearningJobId(plan)]);
  return { identity, issueId: `tool-issue:${identity}`, grantId: `tool-grant:${identity}`, ownerId: `tool:${identity}` };
}

export function toolLearningFundingClaimId(plan: ToolLearningPlan, parentJobId: string, attempt: number, leaseEpoch?: number): string {
  const legacy = `tool-budget-claim:${toolLearningFundingIdentity(plan).identity}:${contentHashOf(parentJobId).slice(0, 16)}:${attempt}`;
  if (leaseEpoch === undefined) return legacy;
  if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) throw new Error("invalid_tool_learning_claim_epoch");
  return `${legacy}:lease:${leaseEpoch}`;
}

/** Current ownership binds the actual central claim epoch, while old persisted
 * grants remain readable until their existing lease ends. */
export function toolLearningFundingClaimMatches(plan: ToolLearningPlan, parentJobId: string, attempt: number,
  claim: { readonly claimId: string; readonly step: number }): boolean {
  if (!Number.isSafeInteger(claim.step) || claim.step < 1) return false;
  return claim.claimId === toolLearningFundingClaimId(plan, parentJobId, attempt)
    || claim.claimId === toolLearningFundingClaimId(plan, parentJobId, attempt, claim.step);
}

/** Reservations retain their original claim ID after a lease ends. This checks
 * historical parent ownership only, never live authority to reserve or write. */
export function toolLearningFundingClaimBelongsTo(plan: ToolLearningPlan, parentJobId: string, attempt: number, claimId: string): boolean {
  const legacy = toolLearningFundingClaimId(plan, parentJobId, attempt);
  if (claimId === legacy) return true;
  const prefix = `${legacy}:lease:`;
  if (!claimId.startsWith(prefix)) return false;
  const epoch = claimId.slice(prefix.length);
  return /^[1-9][0-9]{0,15}$/.test(epoch) && Number.isSafeInteger(Number(epoch));
}
