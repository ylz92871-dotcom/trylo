import type { CentralBudgetAction, CentralBudgetBinding, CentralLearningBudget, CentralLearningBudgetDraft, CentralLearningBudgetRootRef } from "./central-budget-contract.js";
import { isCentralLearningResources } from "./central-learning-resources.js";
import { coordinationScopeValid } from "./coordination-scope.js";
import { fields, sequence, text } from "../../validation/json-shape.js";
import { isCentralAccountingAction, validCentralAccountingRows, validCentralBudgetLimitChanges } from "./central-accounting-parse.js";

type Row = Record<string, unknown>;

export const centralBudgetReference = (value: unknown): value is string => text(value, 512) && !/[\u0000-\u001f]/.test(value);
export const centralBudgetSequence = sequence;

export { isCentralLearningResources } from "./central-learning-resources.js";

function budgetBody(value: Row): boolean {
  return value.schemaVersion === 1 && centralBudgetReference(value.budgetId) && coordinationScopeValid(value.scope)
    && value.unit === "total_model_tokens" && isCentralLearningResources(value.limits) && centralBudgetReference(value.authorizationRef);
}

export function isCentralLearningBudgetDraft(value: unknown): value is CentralLearningBudgetDraft {
  return fields(value, ["schemaVersion", "budgetId", "scope", "unit", "limits", "authorizationRef"]) && budgetBody(value);
}

export function isCentralLearningBudgetRootRef(value: unknown): value is CentralLearningBudgetRootRef {
  return fields(value, ["budgetId", "scope", "openedSequence", "authorizationRef"]) && centralBudgetReference(value.budgetId)
    && coordinationScopeValid(value.scope) && centralBudgetSequence(value.openedSequence) && value.openedSequence > 0
    && centralBudgetReference(value.authorizationRef);
}

export function isCentralLearningBudget(value: unknown): value is CentralLearningBudget {
  const optional = typeof value === "object" && value !== null ? ["accounting", "limitChanges"].filter(key => Object.hasOwn(value, key)) : [];
  return fields(value, ["schemaVersion", "budgetId", "scope", "unit", "limits", "authorizationRef", "mode", "openedAt", "openedSequence", ...optional])
    && budgetBody(value) && value.mode === "exclusive_new_funding" && centralBudgetSequence(value.openedSequence) && value.openedSequence > 0
    && typeof value.openedAt === "string" && Number.isFinite(Date.parse(value.openedAt))
    && validCentralAccountingRows(value.accounting) && validCentralBudgetLimitChanges(value.limitChanges);
}

/** All three fields travel together. Legacy grants and funds carry none of them. */
export function hasCentralBudgetBinding(value: Row): value is Row & CentralBudgetBinding {
  return centralBudgetReference(value.budgetId) && centralBudgetReference(value.authorizationRef) && centralBudgetReference(value.planRef);
}

export function validOptionalCentralBudgetBinding(value: Row): boolean {
  return value.budgetId === undefined && value.authorizationRef === undefined && value.planRef === undefined || hasCentralBudgetBinding(value);
}

export function isCentralBudgetAction(value: unknown): value is CentralBudgetAction {
  if (isCentralAccountingAction(value)) return true;

  if (fields(value, ["kind", "expectedSequence", "budget"])) return value.kind === "open_budget"
    && centralBudgetSequence(value.expectedSequence) && isCentralLearningBudgetDraft(value.budget);

  if (fields(value, ["kind", "grantId", "expectedSequence", "reason", "authorizationRef", "planRef"])) return value.kind === "close_investment"
    && centralBudgetSequence(value.expectedSequence) && centralBudgetReference(value.grantId) && text(value.reason, 1000)
    && centralBudgetReference(value.authorizationRef) && centralBudgetReference(value.planRef);

  const promptField = typeof value === "object" && value !== null && Object.hasOwn(value, "maxPromptChars") ? ["maxPromptChars"] : [];

  return fields(value, ["kind", "grantId", "expectedSequence", "limits", "authorizationRef", "planRef", ...promptField])
    && value.kind === "rebudget" && centralBudgetSequence(value.expectedSequence)
    && centralBudgetReference(value.grantId) && isCentralLearningResources(value.limits)
    && centralBudgetReference(value.authorizationRef) && centralBudgetReference(value.planRef)
    && (value.maxPromptChars === undefined || sequence(value.maxPromptChars) && value.maxPromptChars <= 100000);
}
