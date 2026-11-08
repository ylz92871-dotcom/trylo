import { fields, identity, sequence } from "../../validation/json-shape.js";
import type { BoardState } from "../../learning/control/state.js";
import type { LearningJob } from "../../learning/control/contracts.js";
import type { CentralLearningAgentDomain, CentralLearningGrant, LearningIssue } from "../../learning/control/coordination-contract.js";
import { centralLearningRemaining } from "../../learning/control/coordination-contract.js";
import { isAllocationOffer } from "../../learning/control/allocation-shape.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { centralLearningResourcesFit } from "../../learning/control/central-learning-resources.js";
import { learningIssueOwner } from "../../learning/control/learning-issue-owner.js";
import { isCentralLearningSourceContext } from "../../learning/control/source-context.js";
import type { CentralFundedStage } from "./contracts.js";

/** DTO shape only. Domain implementations separately reconstruct their immutable stage/source binding. */
export function isCentralFundedStage(value: unknown): value is CentralFundedStage {
  return fields(value, ["issueId", "grantId", "expectedIssueRevision", "stageRef", "policyRef", "sourceBindingRef", "offer",
    ...(typeof value === "object" && value !== null && Object.hasOwn(value, "sourceContext") ? ["sourceContext"] : [])])
    && [value.issueId, value.grantId, value.stageRef, value.policyRef, value.sourceBindingRef].every(identity)
    && sequence(value.expectedIssueRevision) && isAllocationOffer(value.offer) && value.offer.policyRef === value.policyRef
    && (!Object.hasOwn(value, "sourceContext") || isCentralLearningSourceContext(value.sourceContext));
}

export type FundedStageInspection = { readonly ok: true; readonly issue: LearningIssue; readonly grant: CentralLearningGrant;
  readonly job: LearningJob } | { readonly ok: false; readonly reason: string };

/** Read the canonical managed relation, never infer a grant from an offer or create another allowance.
 * Exhausted root availability is normal after committing its last grant; only held roots block its execution.
 */
export function inspectCentralFundedStage(board: BoardState, options: {
  readonly scope: string; readonly domain: CentralLearningAgentDomain; readonly input: unknown;
}): FundedStageInspection {
  const { scope, domain, input } = options;
  const failed = (reason: string) => ({ ok: false as const, reason });

  if (!isCentralFundedStage(input) || input.offer.owner.plane !== "agent" || input.offer.owner.domain !== domain) {
    return failed("central_stage_dispatch_invalid");
  }

  const issue = board.learningIssues?.find(item => item.issueId === input.issueId);
  const grant = board.centralLearningGrants?.find(item => item.grantId === input.grantId);
  const job = board.jobs.find(item => item.jobId === grant?.jobId);
  const owner = issue === undefined ? undefined : learningIssueOwner(issue);
  if (issue === undefined || issue.scope !== scope || issue.revision !== input.expectedIssueRevision
    || issue.decision.kind !== "focused_learning" || (owner === "method" ? "prompt" : owner) !== domain) {
    return failed("central_stage_issue_changed");
  }

  if (grant === undefined || job === undefined || grant.scope !== scope || job.scope !== scope
    || grant.issueId !== issue.issueId || issue.grantId !== grant.grantId || issue.jobId !== grant.jobId
    || job.domain !== domain || (grant.domain ?? "collaboration") !== domain
    || grant.focusRevision !== issue.decision.revision || job.coordination?.issueId !== issue.issueId
    || job.coordination.grantId !== grant.grantId || grant.budgetId === undefined
    || grant.authorizationRef === undefined || grant.planRef === undefined) return failed("central_stage_grant_mismatch");

  const root = centralBudgetProjection(board, grant.budgetId);
  const localCompletion = input.offer.reserve.tokens === 0 && input.offer.reserve.calls === 0 && input.offer.reserve.steps === 0;

  // A source-owned, zero-reservation handback consumes no new provider capacity.
  // Root holds still block every new paid action; all identity/claim checks remain.
  if (root === undefined || root.budget.scope !== scope || root.status === "held" && !localCompletion) return failed("central_stage_budget_unavailable");

  if (grant.status !== "open") return failed("central_stage_grant_closed");

  if (grant.allowance.maxPromptChars < input.offer.maxPromptChars
    || !localCompletion && !centralLearningResourcesFit(input.offer.reserve, centralLearningRemaining(grant))) return failed("central_stage_envelope_changed");

  return { ok: true, issue, grant, job };
}
