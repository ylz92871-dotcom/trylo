import type { CentralLearningResources } from "./central-budget-contract.js";
import type { CentralLearningUsage } from "./coordination-contract.js";
import { MAX_CENTRAL_LEARNING_RESOURCE } from "./central-learning-resources.js";

/** Peer consumers of the root. Neither identity is an Agent Learning subsystem or grant. */
export type CentralAccountingOwner = { readonly kind: "central_deliberation" | "user_learning"; readonly ownerId: string };

export type CentralAccountingReservation = {
  readonly reservationId: string; readonly owner: CentralAccountingOwner; readonly maxTokens: number;
  readonly reservedAt: string; readonly reservedSequence: number;
} & ({ readonly state: "reserved"; readonly usage?: never }
  | { readonly state: "settled"; readonly usage: CentralLearningUsage });

export type CentralBudgetLimitChange = {
  readonly changeId: string; readonly limits: CentralLearningResources; readonly authorizationRef: string;
  readonly changedAt: string; readonly changedSequence: number;
};

export type CentralAccountingAction =
  | { readonly kind: "reserve_budget_usage"; readonly budgetId: string; readonly scope: string;
      readonly owner: CentralAccountingOwner; readonly reservationId: string; readonly maxTokens: number; readonly expectedSequence: number }
  | { readonly kind: "settle_budget_usage"; readonly budgetId: string; readonly scope: string;
      readonly owner: CentralAccountingOwner; readonly reservationId: string; readonly usage: CentralLearningUsage }
  | { readonly kind: "set_budget_limit"; readonly budgetId: string; readonly expectedSequence: number;
      readonly changeId: string; readonly limits: CentralLearningResources; readonly authorizationRef: string };

/** Canonical numeric capacity, not a shorter lifetime for an active root.
 * Physical IO limits remain the original Board's responsibility; receipts are never truncated. */
export const MAX_CENTRAL_ACCOUNTING_RESERVATIONS = MAX_CENTRAL_LEARNING_RESOURCE;
export const MAX_CENTRAL_BUDGET_LIMIT_CHANGES = MAX_CENTRAL_LEARNING_RESOURCE;
