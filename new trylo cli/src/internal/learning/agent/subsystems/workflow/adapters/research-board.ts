import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowResearchCheckpoint } from "../runtime/research-state.js";
import { workflowResearchChain } from "../runtime/research-state.js";
import type { WorkflowImprovementPublishOwner } from "../runtime/improvement-contracts.js";
import { latestWorkflowImprovement, workflowCorrectionAllows } from "../runtime/improvement-lineage.js";
import { saveWorkflowImprovementRecord, workflowImprovementsFromBoard, workflowImprovementRecordId } from "./improvement-board.js";

/** Checkpoints and their original paid step are joined under the existing writer.
 * A stored response grants neither another model call nor adoption authority. */
export async function commitWorkflowResearchCheckpoint(boardRoot: string, checkpoint: WorkflowResearchCheckpoint,
  owner: WorkflowImprovementPublishOwner) {
  const saved = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return workflowFailure(loaded.reason, loaded.detail);

    const originalGrant = loaded.state.centralLearningGrants?.find(item => item.grantId === owner.reservation.grantId);
    const issue = loaded.state.learningIssues?.find(item => item.issueId === originalGrant?.issueId);
    if (issue?.decision.kind !== "focused_learning" || originalGrant?.focusRevision !== issue.decision.revision
      || issue.grantId !== originalGrant.grantId || issue.jobId !== owner.reservation.jobId
      || owner.reservation.expectedIssueRevision !== undefined && issue.revision !== owner.reservation.expectedIssueRevision) {
      return workflowFailure("learning_claim_conflict", "A checkpoint must retain its exact original source basis");
    }

    const view = workflowImprovementsFromBoard(loaded.state, checkpoint.scope, owner.centralScope);
    if (!view.ok) return view;

    const chain = workflowResearchChain(view.value.research ?? [], checkpoint.inputVersionId, checkpoint.grantId);
    if (!chain.ok) return chain;

    const versionId = workflowImprovementRecordId(checkpoint);
    if (chain.value.some(item => item.versionId === versionId)) return { ok: true as const, value: { versionId } };

    const head = chain.value.at(-1);
    if (checkpoint.previousVersionId !== head?.versionId || checkpoint.step !== (head?.record.step ?? -1) + 1
      || head !== undefined && head.record.status !== "continue"
        && !(head.record.status === "waiting_evidence" && head.record.contextRef !== checkpoint.contextRef)) {
      return workflowFailure("workflow_research_checkpoint_conflict", "Another confirmed research step owns this continuation");
    }

    const source = view.value.opportunities.find(item => item.versionId === checkpoint.inputVersionId);
    if (source === undefined || checkpoint.grantId !== owner.reservation.grantId
      || checkpoint.inputVersionId !== owner.reservation.inputVersionId || checkpoint.reservationId !== owner.reservation.reservationId) {
      return workflowFailure("workflow_research_source_conflict", "Checkpoint must retain the original source and its exact paid step");
    }

    const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === checkpoint.grantId);
    const job = loaded.state.jobs.find(item => item.jobId === owner.reservation.jobId);
    const reservation = grant?.reservations.find(item => item.reservationId === checkpoint.reservationId);
    if (owner.signal.aborted || grant?.status !== "open" || grant.domain !== "workflow"
      || grant.scope !== (owner.centralScope ?? checkpoint.scope) || grant.claim?.claimId !== owner.reservation.claimId
      || job?.state !== "running"
      || reservation?.claimId !== owner.reservation.claimId || reservation.state !== "settled" || reservation.usage?.kind !== "reported") {
      return workflowFailure("learning_claim_conflict", "Only the current fenced owner of a confirmed settled research response may checkpoint it");
    }

    // Expiry permits takeover; it does not erase an already-settled response.
    // A replacement changes claimId under this writer and fences the old result.
    const latest = latestWorkflowImprovement(view.value.versions, source.record.opportunity);
    if (latest?.versionId !== source.record.parentVersionId
      || !workflowCorrectionAllows(view.value.versions, view.value.opportunities, source.record.opportunity, source.record.parentVersionId)) {
      return workflowFailure("workflow_improvement_stale_parent", "A new revision or correction replaced the research lineage");
    }

    if (checkpoint.status === "candidate" && (contentHashOf(checkpoint.artifact.opportunity) !== contentHashOf(source.record.opportunity)
      || checkpoint.artifact.parentVersionId !== source.record.parentVersionId)) {
      return workflowFailure("workflow_research_source_conflict", "Candidate cannot replace the nominated task or parent");
    }

    return saveWorkflowImprovementRecord(store, checkpoint, new Date(owner.now()).toISOString(), () => !owner.signal.aborted);
  });
  return "reason" in saved ? workflowFailure(saved.reason, saved.detail) : saved;
}
