import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningFundingClaimMatches, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { ACQUISITION_START_LEASE_MS, acquisitionAdaptationLeaseId, decodeAcquisitionAdaptationLease, type AcquisitionAdaptationLease } from "../domain/evolution/acquisition-lease.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { recordOf } from "../domain/evolution/parse.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";

type Binding = { readonly originalJobId: string; readonly approvalId: string; readonly installationId: string;
  readonly jobId: string; readonly attempt: number; readonly scope: string };

export function readAcquisitionAdaptationLease(state: BoardState, input: Binding) {
  let selected: AcquisitionAdaptationLease | undefined, count = 0;

  for (const asset of state.assets) {
    if (!recordOf(asset.content) || asset.content.type !== "tool_acquisition_adaptation_lease" || asset.content.jobId !== input.jobId || asset.content.attempt !== input.attempt) continue;

    const lease = decodeAcquisitionAdaptationLease(asset.content), proposal = state.proposals.find(row => row.proposalId === asset.createdFromProposalId);
    if (++count > 16 || lease === undefined || asset.versionId !== acquisitionAdaptationLeaseId(lease) || asset.kind !== "workflow" || asset.source !== "inferred"
      || asset.scope !== input.scope || !assetAvailable(state, asset) || proposal?.proposalId !== `proposal:${asset.versionId}` || proposal.domain !== "tool"
      || proposal.source !== "inferred" || proposal.candidateRef !== asset.versionId || proposal.risk !== "low" || proposal.requiredVerifiers.length !== 0
      || proposal.requestedAuthorities.length !== 0 || lease.originalJobId !== input.originalJobId || lease.approvalId !== input.approvalId
      || lease.installationId !== input.installationId || lease.jobId !== input.jobId || lease.attempt !== input.attempt) {
      return pipelineFailure("invalid_acquisition_lease", asset.versionId);
    }

    selected = lease;
  }

  return { ok: true as const, lease: selected, leaseCount: count };
}

export async function saveAcquisitionAdaptationLease(store: BoardStore, input: Binding & { readonly startedAt: string }) {
  const content: AcquisitionAdaptationLease = { type: "tool_acquisition_adaptation_lease", schemaVersion: 1,
    originalJobId: input.originalJobId, approvalId: input.approvalId, installationId: input.installationId, jobId: input.jobId,
    attempt: input.attempt, startedAt: input.startedAt, expiresAt: new Date(Date.parse(input.startedAt) + ACQUISITION_START_LEASE_MS).toISOString() };
  if (decodeAcquisitionAdaptationLease(content) === undefined) return pipelineFailure("invalid_acquisition_lease", input.jobId);

  const loaded = await store.load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const prior = readAcquisitionAdaptationLease(loaded.state, input);
  if (!prior.ok) return prior;

  if (prior.leaseCount >= 16 && !loaded.state.assets.some(row => row.versionId === acquisitionAdaptationLeaseId(content))) {
    return pipelineFailure("acquisition_lease_history_limit", input.jobId);
  }

  return savePipelineAsset(store, { versionId: acquisitionAdaptationLeaseId(content), kind: "workflow", scope: input.scope,
    source: "inferred", content, issuedAt: input.startedAt });
}

/** A central claim supersedes the short pre-funding start lease. Neither an
 * expired claim nor a superseded claim can retain a live model worker. */
export function acquisitionAdaptationClaimActive(state: BoardState, input: Binding & { readonly plan: ToolLearningPlan; readonly now: number }): boolean {
  const original = state.jobs.find(row => row.jobId === input.originalJobId), decision = state.assets.find(row => row.versionId === input.approvalId);
  if (original?.domain !== "tool" || original.scope !== input.scope || !["waiting_approval", "waiting_evidence"].includes(original.state)
    || decision === undefined || decision.scope !== input.scope || !assetAvailable(state, decision) || !recordOf(decision.content)
    || decision.content.type !== "tool_learning_decision" || decision.content.jobId !== input.originalJobId || decision.content.attempt !== original.attempt) return false;

  const lease = readAcquisitionAdaptationLease(state, input);
  if (!lease.ok) return false;

  const grant = state.centralLearningGrants?.find(row => row.grantId === toolLearningFundingIdentity(input.plan).grantId);
  if (grant?.claim !== undefined) return toolFundingGrantMatches(state, input.plan, grant) && grant.status === "open"
    && toolLearningFundingClaimMatches(input.plan, input.jobId, input.attempt, grant.claim) && Date.parse(grant.claim.expiresAt) > input.now;

  // Legacy workers without a start lease retain existing behavior; operator
  // recovery separately refuses to infer an expiry with no durable evidence.
  return lease.lease === undefined || Date.parse(lease.lease.expiresAt) > input.now;
}
