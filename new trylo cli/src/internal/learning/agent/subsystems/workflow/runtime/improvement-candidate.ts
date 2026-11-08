import { workflowConditionKey } from "../domain/family.js";
import { workflowFailure } from "../domain/trace-parse.js";
import { buildWorkflowImprovement, procedureBehaviorKey, workflowProcessMatches } from "../improvement/index.js";
import type { WorkflowImprovementBoardView } from "./improvement-contracts.js";

/** Both the compatibility proposal and internal research preserve the same
 * lineage/quality rules and reject a renamed prior intervention. */
export function buildWorkflowCandidate(input: Parameters<typeof buildWorkflowImprovement>[0],
  versions: WorkflowImprovementBoardView["versions"]) {
  const built = buildWorkflowImprovement(input);
  if (!built.ok) return built;
  const behavior = procedureBehaviorKey(built.value.proposal.procedure);
  return versions.some(item => workflowProcessMatches(item.artifact.opportunity.task, input.opportunity.task)
    && workflowConditionKey(item.artifact.opportunity.task.conditions) === workflowConditionKey(input.opportunity.task.conditions)
    && procedureBehaviorKey(item.artifact.proposal.procedure) === behavior)
    ? workflowFailure("workflow_improvement_repeated_intervention", "Change an actual intervention; renaming an existing behavior is not new research") : built;
}
