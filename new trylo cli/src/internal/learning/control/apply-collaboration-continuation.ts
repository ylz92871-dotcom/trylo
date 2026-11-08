import type { CoordinateLearningCommand } from "./coordination-contract.js";
import { centralLearningRemaining, learningDependencyResumable } from "./coordination-contract.js";
import { isCollaborationIncompleteModelFailure } from "./collaboration-failure-continuation-contract.js";
import { collaborationQueryMatchesReservation, collaborationResourceResultMatches } from "./collaboration-resource-relation.js";
import type { CollaborationResourceReceipt } from "../../protocol/collaboration-resource.js";
import { coordinationForJob, commitCoordination } from "./coordination-state.js";
import { centralBudgetProjection } from "./central-budget-state.js";
import { learningIssueOwner } from "./learning-issue-owner.js";
import type { BoardState } from "./state.js";
import { fail } from "./result.js";
import { buildCollaborationFailureContinuation, readCollaborationFailureContinuations } from "./collaboration-failure-continuation.js";
import { isRewardV2Draft, validRewardV2Prefix } from "../reward/v2-facts.js";
import { contentHashOf } from "./hash.js";

type Command = CoordinateLearningCommand & {
  readonly action: Extract<CoordinateLearningCommand["action"], { kind: "resume_incomplete" }>;
};

/** Reopen only an inspected incomplete model boundary on its original purse.
 * Every old failure, reservation and checkpoint remains in the Board history. */
export function applyIncompleteCollaborationContinuation(state: BoardState, command: Command) {
  const action = command.action, current = coordinationForJob(state, action.jobId);
  if (command.commandId !== `central-learning:${contentHashOf(action)}`) {
    return fail(state, "invalid_learning_coordination", "incomplete_continuation_explicit_command_required");
  }
  if (current === undefined) return fail(state, "job_not_found", action.jobId);
  const { issue, job, grant } = current;
  if (state.sequence !== action.expectedSequence || issue.revision !== action.expectedIssueRevision
    || job.attempt !== action.expectedAttempt || grant.grantId !== action.grantId) {
    return fail(state, "learning_claim_conflict", "incomplete_continuation_source_changed");
  }
  if (job.domain !== "collaboration" || grant.domain !== "collaboration" || learningIssueOwner(issue) !== "collaboration"
    || issue.scope !== grant.scope || job.scope !== grant.scope || issue.grantId !== grant.grantId || issue.jobId !== job.jobId) {
    return fail(state, "learning_budget_binding", "incomplete_continuation_original_owner_required");
  }
  if (issue.decision.kind !== "focused_learning" || issue.decision.revision !== grant.focusRevision) {
    return fail(state, "learning_issue_not_focused", issue.issueId);
  }
  if (grant.status !== "closed" || job.state !== "failed" || !isCollaborationIncompleteModelFailure(grant.closedReason)
    || job.breakerOpen || grant.claim !== undefined) {
    return fail(state, "learning_grant_closed", "only_a_terminated_incomplete_generation_can_continue");
  }
  if (grant.reservations.some(item => item.state !== "settled")) {
    return fail(state, "learning_grant_unsettled", "incomplete_continuation_pending_request");
  }
  const last = grant.reservations.at(-1);
  if (last?.reservationId !== action.failedReservationId || last.usage?.kind !== "unknown"
    || last.usage.reason !== grant.closedReason
    || readCollaborationFailureContinuations(state, grant, issue.revision).some(item => item.failedReservationId === last.reservationId)) {
    return fail(state, "learning_claim_conflict", "incomplete_continuation_original_failure_required");
  }
  if ((state.learningDependencies ?? []).some(item => item.grantId === grant.grantId && !learningDependencyResumable(item))
    || state.assets.some(asset => {
      const content = asset.content;
      return asset.scope === grant.scope && typeof content === "object" && content !== null
        && "issueId" in content && content.issueId === issue.issueId
        && "focusRevision" in content && content.focusRevision === grant.focusRevision
        && "schema" in content && (content.schema === "collaboration-plan/v1" || content.schema === "collaboration-experience/v1");
    })) {
    return fail(state, "learning_claim_conflict", "incomplete_continuation_output_or_dependency_requires_inspection");
  }

  const receipts = (state.collaborationRuntimeReceipts ?? []).filter((item): item is CollaborationResourceReceipt =>
    (item.phase === "resource_query" || item.phase === "resource_result") && item.scope === grant.scope
      && item.issueId === issue.issueId && item.jobId === job.jobId && item.grantId === grant.grantId);
  const queries = receipts.filter(item => item.phase === "resource_query"), results = receipts.filter(item => item.phase === "resource_result");
  if (queries.some(query => !results.some(result => collaborationResourceResultMatches(query, result)))
    || results.some(result => !queries.some(query => collaborationResourceResultMatches(query, result)))) {
    return fail(state, "learning_claim_conflict", "incomplete_continuation_unconfirmed_resource_action");
  }
  const checkpoint = results.find(result => result.receiptId === action.checkpointReceiptId);
  const query = checkpoint === undefined ? undefined : queries.find(item => collaborationResourceResultMatches(item, checkpoint));
  if (checkpoint === undefined || query === undefined
    || !grant.reservations.some(reservation => reservation !== last && collaborationQueryMatchesReservation(query, reservation))
    || !state.appliedCommands.some(item => item.commandId === `collaboration-runtime:${checkpoint.receiptId}`)
    || queries.some(item => collaborationQueryMatchesReservation(item, last))) {
    return fail(state, "learning_claim_conflict", "incomplete_continuation_confirmed_checkpoint_required");
  }

  const root = state.centralLearningBudgets?.find(item => item.budgetId === action.rootRef.budgetId);
  if (root === undefined || root.scope !== grant.scope || root.openedSequence !== action.rootRef.openedSequence
    || root.authorizationRef !== action.rootRef.authorizationRef || action.rootRef.scope !== grant.scope
    || grant.budgetId !== root.budgetId || grant.authorizationRef !== root.authorizationRef) {
    return fail(state, "learning_budget_binding", "incomplete_continuation_original_authorization_required");
  }
  const remaining = centralLearningRemaining(grant);
  if (remaining.tokens < 1 || remaining.calls < 1 || remaining.steps < 1) {
    return fail(state, "learning_grant_exhausted", "incomplete_continuation_original_cap_exhausted");
  }
  const { closedReason: _closedReason, ...original } = grant;
  const reopened = { ...original, status: "open" as const };
  const proposed = { ...state, centralLearningGrants: state.centralLearningGrants!.map(item => item.grantId === grant.grantId ? reopened : item) };
  const projection = centralBudgetProjection(proposed, root.budgetId);
  if (projection === undefined || projection.status === "held") {
    return fail(state, "learning_budget_held", "incomplete_continuation_original_commitment_unavailable");
  }
  const draft = buildCollaborationFailureContinuation(command, grant.scope, grant.closedReason);
  const fact = { ...draft, sequence: state.sequence + 1 }, facts = [...(state.rewardV2Facts ?? []), fact];
  if (!isRewardV2Draft(draft) || !validRewardV2Prefix(facts, fact.sequence)) {
    return fail(state, "invalid_learning_coordination", "incomplete_continuation_receipt_capacity");
  }
  // The two existing event types are one normal Board append. No grant schema,
  // cap, counter, charge, dependency or execution permission changes.
  const committed = commitCoordination({ ...state, sequence: fact.sequence, rewardV2Facts: facts }, command,
    { grant: reopened, job: { ...job, state: "queued" } });
  return { ...committed, events: [{ type: "reward_v2_fact_recorded" as const, fact,
    sequence: fact.sequence, commandId: command.commandId, occurredAt: command.issuedAt }, ...committed.events] };
}

