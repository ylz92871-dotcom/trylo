import type { CentralAccountingAction, CentralAccountingOwner, CentralAccountingReservation, CentralBudgetLimitChange } from "./central-accounting-contract.js";
import { MAX_CENTRAL_ACCOUNTING_RESERVATIONS, MAX_CENTRAL_BUDGET_LIMIT_CHANGES } from "./central-accounting-contract.js";
import { isCentralLearningUsage } from "./coordination-parse.js";
import { isCentralLearningResources, MAX_CENTRAL_LEARNING_RESOURCE } from "./central-learning-resources.js";
import { coordinationScopeValid } from "./coordination-scope.js";
import { fields, sequence } from "../../validation/json-shape.js";
import { centralBudgetReference as reference } from "./central-budget-parse.js";

const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const tokens = (value: unknown) => sequence(value) && value > 0 && value <= MAX_CENTRAL_LEARNING_RESOURCE;

export function isCentralAccountingOwner(value: unknown): value is CentralAccountingOwner {
  return fields(value, ["kind", "ownerId"]) && (value.kind === "central_deliberation" || value.kind === "user_learning") && reference(value.ownerId);
}

export function sameCentralAccountingOwner(left: CentralAccountingOwner, right: CentralAccountingOwner): boolean {
  return left.kind === right.kind && left.ownerId === right.ownerId;
}

export function isCentralAccountingReservation(value: unknown): value is CentralAccountingReservation {
  return (fields(value, ["reservationId", "owner", "maxTokens", "reservedAt", "reservedSequence", "state"])
      || fields(value, ["reservationId", "owner", "maxTokens", "reservedAt", "reservedSequence", "state", "usage"]))
    && reference(value.reservationId) && isCentralAccountingOwner(value.owner) && tokens(value.maxTokens)
    && date(value.reservedAt) && sequence(value.reservedSequence) && value.reservedSequence > 0
    && (value.state === "reserved" ? !Object.hasOwn(value, "usage") : value.state === "settled" && isCentralLearningUsage(value.usage));
}

export function isCentralBudgetLimitChange(value: unknown): value is CentralBudgetLimitChange {
  return fields(value, ["changeId", "limits", "authorizationRef", "changedAt", "changedSequence"])
    && reference(value.changeId) && isCentralLearningResources(value.limits) && reference(value.authorizationRef)
    && date(value.changedAt) && sequence(value.changedSequence) && value.changedSequence > 0;
}

export function validCentralAccountingRows(value: unknown): value is readonly CentralAccountingReservation[] | undefined {
  return value === undefined || Array.isArray(value) && value.length <= MAX_CENTRAL_ACCOUNTING_RESERVATIONS
    && value.every(isCentralAccountingReservation) && new Set(value.map(item => item.reservationId)).size === value.length;
}

export function validCentralBudgetLimitChanges(value: unknown): value is readonly CentralBudgetLimitChange[] | undefined {
  return value === undefined || Array.isArray(value) && value.length <= MAX_CENTRAL_BUDGET_LIMIT_CHANGES
    && value.every(isCentralBudgetLimitChange) && new Set(value.map(item => item.changeId)).size === value.length;
}

export function isCentralAccountingAction(value: unknown): value is CentralAccountingAction {
  if (fields(value, ["kind", "budgetId", "scope", "owner", "reservationId", "maxTokens", "expectedSequence"])) {
    return value.kind === "reserve_budget_usage" && reference(value.budgetId) && coordinationScopeValid(value.scope)
      && isCentralAccountingOwner(value.owner) && reference(value.reservationId) && tokens(value.maxTokens) && sequence(value.expectedSequence);
  }

  if (fields(value, ["kind", "budgetId", "scope", "owner", "reservationId", "usage"])) {
    return value.kind === "settle_budget_usage" && reference(value.budgetId) && coordinationScopeValid(value.scope)
      && isCentralAccountingOwner(value.owner) && reference(value.reservationId) && isCentralLearningUsage(value.usage);
  }

  return fields(value, ["kind", "budgetId", "expectedSequence", "changeId", "limits", "authorizationRef"])
    && value.kind === "set_budget_limit" && reference(value.budgetId) && sequence(value.expectedSequence)
    && reference(value.changeId) && isCentralLearningResources(value.limits) && reference(value.authorizationRef);
}
