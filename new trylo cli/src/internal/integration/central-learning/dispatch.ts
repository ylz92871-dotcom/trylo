import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { AllocationFundingBinding } from "../../learning/control/allocation-application-contract.js";
import type { CentralLearningDispatchDecision } from "../learning-allocation/evidence-decision-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { createLearningAllocationApplication } from "../learning-allocation/application.js";
import type { CentralFundedStage } from "./contracts.js";
import type { PreparedCentralCandidate } from "./candidates.js";
import { retainCentralSubmission } from "./submission-archive.js";
import { retainFrozenStage } from "./stage-evidence.js";
import { recordCentralStageObservation } from "./observations.js";

/** Commit once, then re-read the exact original source relation before dispatch.
 * previous/partial/unknown never becomes a second execution request. */
export async function dispatchCentralDecision(options: {
  readonly boardRoot: string; readonly authorizationRef: string;
  readonly application: ReturnType<typeof createLearningAllocationApplication>;
  readonly enabled: () => boolean;
  readonly prepared: readonly PreparedCentralCandidate[];
  readonly decision: CentralLearningDispatchDecision;
}, signal: AbortSignal) {
  const next = options.decision.nextStep;
  if (next.kind !== "fund_and_dispatch" && next.kind !== "dispatch_existing") {
    return { status: next.kind, decision: options.decision } as const;
  }

  if (signal.aborted) return { status: "cancelled" as const, decision: options.decision };

  const candidate = options.prepared.find(row => row.stage.offer.offerId === next.evaluation.candidate.opportunity.offer.offerId);
  if (candidate === undefined) return { status: "rejected" as const, reason: "central_prepared_source_missing" };

  const { stage } = candidate, projected = next.evaluation.stage;

  if (next.kind === "fund_and_dispatch") {
    if (next.application === null || projected.status !== "ready") return { status: "rejected" as const, reason: "central_application_missing" };

    const binding: AllocationFundingBinding = { offerId: stage.offer.offerId, offerHash: contentHashOf(stage.offer),
      policyRef: stage.policyRef, sourceBindingRef: stage.source.sourceBindingRef, authorizedAllowance: stage.authorizedAllowance,
      issueId: stage.source.issueId, expectedIssueRevision: projected.expectedIssueRevision, grantId: stage.source.grantId,
      mode: projected.mode, chargedAtBasis: projected.chargedAtBasis };
    const submission = { ...next.application, authorizationRef: options.authorizationRef, bindingsJson: JSON.stringify([binding]) };

    await retainCentralSubmission(options.boardRoot, submission);
    const funding = await options.application.commit(submission, signal);
    if (funding.status !== "committed") return { status: "funding_unconfirmed" as const, funding, decision: options.decision };
  }

  const current = await createBoardReader(options.boardRoot).load();
  if (!current.ok) return { status: "rejected" as const, reason: current.reason };

  const issue = current.state.learningIssues?.find(row => row.issueId === stage.source.issueId);
  if (issue === undefined || issue.grantId !== stage.source.grantId) return { status: "rejected" as const, reason: "central_dispatch_source_changed" };

  const input: CentralFundedStage = { issueId: issue.issueId, grantId: stage.source.grantId, expectedIssueRevision: issue.revision,
    stageRef: stage.stageRef, policyRef: stage.policyRef, sourceBindingRef: stage.source.sourceBindingRef, offer: stage.offer,
    ...(stage.sourceContext === undefined ? {} : { sourceContext: stage.sourceContext }) };
  const retained = await retainFrozenStage({ boardRoot: options.boardRoot, candidate: candidate.candidate, input });
  if (retained.status !== "retained") return { status: "rejected" as const, reason: retained.reason, decision: options.decision };

  const assigned = await recordCentralStageObservation({ boardRoot: options.boardRoot, enabled: options.enabled,
    candidate: candidate.candidate, input, mode: "initial", observed: { outcome: "pending", resultRefs: [],
      sourceRefs: [input.sourceBindingRef, input.stageRef, input.grantId], reason: "funded_stage_outcome_unresolved_not_proof_of_execution" } });
  if (assigned.status !== "written" && assigned.status !== "previous") return { status: "rejected" as const,
    reason: "central_stage_assignment_unconfirmed", decision: options.decision };

  if (signal.aborted || !options.enabled()) return { status: "cancelled" as const, decision: options.decision };

  const result = await candidate.port.dispatch(input, signal);
  const observation = await candidate.port.observe(input, signal);

  return { status: "dispatched" as const, decision: options.decision, input, result, observation, candidate: candidate.candidate };
}
