import type { BoardStore } from "../../../../control/store-port.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningFundingClaimBelongsTo, toolLearningFundingClaimMatches, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { pipelineFailure } from "./pipeline-assets.js";

/** A committed/fenced child cannot reserve again. Recover only its expired lease or historical slots. */
export async function cleanupStoppedInquiryFunding(store: BoardStore, input: { readonly plan: ToolLearningPlan; readonly jobId: string; readonly attempt: number; readonly issuedAt: string }) {
  const loaded = await store.load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const child = loaded.state.jobs.find(row => row.jobId === input.jobId);
  if (child?.attempt !== input.attempt || !["waiting_approval", "waiting_evidence"].includes(child.state)) return pipelineFailure("inquiry_not_fenced", input.jobId);

  const grant = loaded.state.centralLearningGrants?.find(row => row.grantId === toolLearningFundingIdentity(input.plan).grantId);
  if (grant === undefined) return { ok: true as const };

  const apply = async (action: CoordinationAction, claimStep?: number) => {
    const result = await store.apply({ type: "coordinate_learning", commandId: `tool-budget:${contentHashOf({ action, claimStep: claimStep ?? null })}`, issuedAt: input.issuedAt, action });
    return result.ok ? { ok: true as const } : pipelineFailure(result.reason, result.detail);
  };

  if (grant.status === "open" && grant.claim !== undefined && toolLearningFundingClaimMatches(input.plan, input.jobId, input.attempt, grant.claim)) {
    if (Date.parse(grant.claim.expiresAt) > Date.parse(input.issuedAt)) return pipelineFailure("inquiry_funding_closeout_active", "The exact original inquiry lease has not expired");
    return apply({ kind: "finish", jobId: grant.jobId, claimId: grant.claim.claimId, result: { kind: "yielded", reason: "operator_recovered_expired_inquiry" } }, grant.claim.step);
  }

  for (const reservation of grant.reservations.filter(row => row.state === "reserved" && toolLearningFundingClaimBelongsTo(input.plan, input.jobId, input.attempt, row.claimId))) {
    const settled = await apply({ kind: "settle", grantId: grant.grantId, reservationId: reservation.reservationId, usage: { kind: "unknown", reason: "operator_recovered_expired_inquiry" } });
    if (!settled.ok) return settled;
  }

  return { ok: true as const };
}
