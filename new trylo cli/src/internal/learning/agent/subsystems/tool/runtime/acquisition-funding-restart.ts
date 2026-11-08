import type { BoardStore } from "../../../../control/store-port.js";
import type { LearningJob } from "../../../../control/contracts.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningFundingClaimMatches, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { contentHashOf } from "../../../../control/hash.js";
import { pipelineFailure } from "./pipeline-assets.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";

/** A stopped attempt has already lost authority to reserve or commit. Its
 * lingering central lease can be yielded without waiting or spending another
 * child attempt. A genuinely live or unrelated owner is never taken over. */
export async function prepareAcquisitionFundingRestart(store: BoardStore, input: { readonly plan: ToolLearningPlan;
  readonly child: LearningJob | undefined; readonly issuedAt: string }) {
  const loaded = await store.load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const identity = toolLearningFundingIdentity(input.plan);
  const grant = loaded.state.centralLearningGrants?.find(row => row.grantId === identity.grantId);
  if (grant === undefined) return { ok: true as const };

  if (!toolFundingGrantMatches(loaded.state, input.plan, grant)) {
    return pipelineFailure("invalid_acquisition_funding", identity.grantId);
  }

  if (grant.status !== "open") return pipelineFailure("learning_grant_closed", grant.grantId);

  const issue = loaded.state.learningIssues?.find(row => row.issueId === identity.issueId);
  if (issue?.decision.kind !== "focused_learning") return pipelineFailure("learning_issue_not_focused", identity.issueId);

  if (grant.claim === undefined) return { ok: true as const };

  const child = input.child === undefined ? undefined : loaded.state.jobs.find(row => row.jobId === input.child!.jobId);
  if (input.child !== undefined && (child === undefined || child.attempt !== input.child.attempt || child.scope !== input.plan.scope || child.domain !== "tool")) {
    return pipelineFailure("stale_acquisition_funding_restart", input.child.jobId);
  }

  const stoppedClaim = child !== undefined && child.state === "waiting_evidence"
    && toolLearningFundingClaimMatches(input.plan, child.jobId, child.attempt, grant.claim);
  if (stoppedClaim) {
    const action = { kind: "finish" as const, jobId: grant.jobId, claimId: grant.claim.claimId,
      result: { kind: "yielded" as const, reason: "stopped_acquisition_attempt_cleanup" } };
    const yielded = await store.apply({ type: "coordinate_learning", commandId: `tool-budget:${contentHashOf({ action, claimStep: grant.claim.step })}`, issuedAt: input.issuedAt, action });
    return yielded.ok ? { ok: true as const } : pipelineFailure(yielded.reason, yielded.detail);
  }

  return Date.parse(grant.claim.expiresAt) > Date.parse(input.issuedAt)
    ? pipelineFailure("learning_claim_active", "The original grant still belongs to another active worker") : { ok: true as const };
}
