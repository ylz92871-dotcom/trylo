import type { BoardState } from "../../../../control/state.js";
import type { BoardStore } from "../../../../control/store-port.js";
import type { CentralLearningClaim } from "../../../../control/coordination-contract.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningFundingClaimMatches } from "../domain/evolution/funding-identity.js";
import { acquisitionRecoveryFromBoard } from "./acquisition-adaptation-recovery-review.js";
import { recoverAcquisitionAdaptation } from "./acquisition-adaptation-recovery.js";
import { acquisitionAdaptationOutcomeFromBoard } from "./acquisition-adaptation-committed.js";
import { acquisitionInquiryBindingFromBoard, acquisitionInquiryOutcomeFromBoard, acquisitionInquirySpecFromBoard } from "./acquisition-inquiry-reader.js";
import { committedInquiryDecision } from "./acquisition-inquiry-committed.js";
import { finishAcquisitionInquiry, proposedAcquisitionInquiryOutcome } from "./acquisition-inquiry-result.js";
import { toolFundingOriginFromBoard } from "./tool-funding-origin.js";
import { pipelineFailure } from "./pipeline-assets.js";

type Input = { readonly boardRoot: string; readonly scope: string; readonly originalJobId: string;
  readonly plan: ToolLearningPlan; readonly claim?: CentralLearningClaim; readonly childJobId?: string; readonly now: () => number };

/** Route an expired descendant to its existing receipt/candidate owner. These
 * calls only materialize confirmed local outcomes; operator fencing of unknown
 * external work remains behind the original exact-review CLI commands. */
export async function recoverExpiredToolChild(board: BoardStore, state: BoardState, input: Input) {
  const children = state.jobs.filter(job => job.domain === "tool" && job.scope === input.scope
    && (input.claim === undefined ? job.jobId === input.childJobId : toolLearningFundingClaimMatches(input.plan, job.jobId, job.attempt, input.claim)));
  if (children.length !== 1) return pipelineFailure("tool_expired_child_binding", "The expired claim does not identify one original child attempt");

  const child = children[0]!, issuedAt = new Date(input.now()).toISOString();
  const refs = [child.jobId, `attempt:${child.attempt}`, child.observationId];

  if (child.jobId.startsWith("tool-adaptation_v1_")) {
    const selected = acquisitionRecoveryFromBoard(state, { boardRoot: input.boardRoot, scope: input.scope, jobId: child.observationId,
      childJobId: child.jobId, attempt: child.attempt, now: input.now });
    if (!selected.ok) return selected;

    const origin = toolFundingOriginFromBoard(state, selected.request.learningPlan);
    if (!origin.ok || origin.rootJobId !== input.originalJobId) return pipelineFailure("tool_expired_child_binding", "Adaptation is outside the original funding lineage");

    const binding = { originalJobId: child.observationId, approvalId: selected.request.approvalId, scope: input.scope,
      workspaceId: selected.view.workspaceId, installationId: selected.installationId, capability: selected.request.capability };
    const known = acquisitionAdaptationOutcomeFromBoard(state, { ...binding, jobId: child.jobId, attempt: child.attempt });
    if (!known.ok) return known;

    const recovered = await recoverAcquisitionAdaptation(board, state, { ...binding, job: child,
      issuedAt });
    if (!recovered.ok) {
      // The original helper returns a confirmed failed outcome as a typed failure.
      // Its terminal write is the independent evidence that local replay finished.
      const fresh = await board.load();
      if (!fresh.ok) return pipelineFailure(fresh.reason, fresh.detail);
      if (known.outcome?.ok !== false || known.outcome.code !== recovered.code
        || fresh.state.jobs.find(job => job.jobId === child.jobId)?.state !== "waiting_evidence") return recovered;
    } else if (!("recovered" in recovered) || !recovered.recovered) {
      return { ok: true as const, confirmed: false as const, child, sourceRefs: [...refs, selected.request.approvalId],
        reason: "tool_expired_adaptation_candidate_or_result_receipt_required",
        operatorRoute: `trylo tools acquire-learning ${child.observationId} --approve ${selected.request.approvalId} --recover-child ${child.jobId} --attempt ${child.attempt}` };
    }

    return { ok: true as const, confirmed: true as const, child, sourceRefs: [...refs, selected.request.approvalId] };
  }

  if (!child.jobId.startsWith("tool-acquisition-inquiry_v1_")) return pipelineFailure("tool_expired_child_binding", "The child has no original acquisition owner");

  const spec = acquisitionInquirySpecFromBoard(state, child.jobId, child.attempt, input.scope);
  if (!spec.ok) return spec;

  if (spec.spec === undefined || spec.spec.rootJobId !== input.originalJobId) return pipelineFailure("tool_expired_child_binding", "The inquiry has no exact original source specification");

  const selected = acquisitionInquiryBindingFromBoard(state, { jobId: spec.spec.originalJobId, scope: input.scope,
    approvalId: spec.spec.approvalId, failureRef: spec.spec.failureRef });
  if (!selected.ok) return selected;

  if (selected.rootJobId !== input.originalJobId || selected.child?.jobId !== child.jobId || selected.child.attempt !== child.attempt) {
    return pipelineFailure("tool_expired_child_binding", "Inquiry ownership changed before local recovery");
  }

  const previous = acquisitionInquiryOutcomeFromBoard(state, child.jobId, child.attempt, input.scope);
  if (!previous.ok) return previous;

  let outcome = previous.outcome;
  if (outcome === undefined) {
    const known = committedInquiryDecision(state, { jobId: child.jobId, attempt: child.attempt,
      plan: selected.request.learningPlan, search: selected.request.search });
    if (!known.ok) return known;
    if (known.decision !== undefined) outcome = proposedAcquisitionInquiryOutcome({ spec: spec.spec, plan: selected.request.learningPlan,
      decision: known.decision, decisionVersionId: known.decisionVersionId!, search: known.search!, occurredAt: known.occurredAt!, failure: selected.failure });
  }

  if (outcome === undefined) return { ok: true as const, confirmed: false as const, child,
    sourceRefs: [...refs, spec.spec.approvalId, spec.spec.failureRef], reason: "tool_expired_inquiry_decision_or_outcome_receipt_required",
    operatorRoute: `trylo tools acquire-learning ${spec.spec.originalJobId} --approve ${spec.spec.approvalId} --reinvestigate-failure ${spec.spec.failureRef}` };

  const finished = await finishAcquisitionInquiry(board, outcome, issuedAt);

  return finished.ok ? { ok: true as const, confirmed: true as const, child, sourceRefs: [...refs, spec.spec.approvalId, spec.spec.failureRef] } : finished;
}
