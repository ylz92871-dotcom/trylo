import { domainFailure, type DomainFailure } from "../../../../domains/shared/types.js";
import { editWorkflow, validateWorkflowRevision } from "./inducer.js";
import type { WorkflowBudget, WorkflowDraft, WorkflowFallback } from "./inducer.js";

export type WorkflowMutation =
  | { readonly field: "budget.maxSteps"; readonly value: number }
  | { readonly field: "budget.maxTokens"; readonly value: number }
  | { readonly field: "failureFallback"; readonly value: readonly WorkflowFallback[] };

export type MutationResult =
  | { readonly kind: "draft"; readonly draft: WorkflowDraft }
  | DomainFailure;

export function applyWorkflowMutation(
  draft: WorkflowDraft,
  mutation: WorkflowMutation,
): MutationResult {
  if (!draft.mutableFields.includes(mutation.field)) {
    return domainFailure(
      "mutation_rejected",
      `field ${mutation.field} is not in mutableFields`,
      [mutation.field],
    );
  }

  let budget: WorkflowBudget = draft.budget;
  let failureFallback = draft.failureFallback;

  if (mutation.field === "budget.maxSteps") {
    budget = { ...draft.budget, maxSteps: mutation.value };
  } else if (mutation.field === "budget.maxTokens") {
    budget = { ...draft.budget, maxTokens: mutation.value };
  } else {
    failureFallback = mutation.value;
  }

  const failure = validateWorkflowRevision(draft, { budget, failureFallback });
  if (failure !== undefined) {
    return failure;
  }

  return {
    kind: "draft",
    draft: editWorkflow(draft, { budget, failureFallback }),
  };
}

export function rejectImmutableMutation(field: string): DomainFailure {
  return domainFailure("mutation_rejected", `cannot mutate ${field}`, [field]);
}
