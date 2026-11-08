import type { CentralAccountingAction, CentralAccountingReservation, CentralBudgetLimitChange } from "./central-accounting-contract.js";

/** Explicit host authorization for newly managed learning funds; never execution Permission. */
export type CentralLearningResources = { readonly tokens: number; readonly calls: number; readonly steps: number };

export type CentralLearningBudgetDraft = {
  readonly schemaVersion: 1; readonly budgetId: string; readonly scope: string; readonly unit: "total_model_tokens";
  readonly limits: CentralLearningResources; readonly authorizationRef: string;
};

export type CentralLearningBudget = CentralLearningBudgetDraft & {
  readonly mode: "exclusive_new_funding"; readonly openedAt: string; readonly openedSequence: number;
  /** Optional on old roots. All consumers remain in the original Board budget, with no separate balance. */
  readonly accounting?: readonly CentralAccountingReservation[];
  readonly limitChanges?: readonly CentralBudgetLimitChange[];
};

/** Immutable identity saved after first opening. Current cumulative limits remain in the Board. */
export type CentralLearningBudgetRootRef = Pick<CentralLearningBudget, "budgetId" | "scope" | "openedSequence" | "authorizationRef">;

export type CentralBudgetBinding = { readonly budgetId: string; readonly authorizationRef: string; readonly planRef: string };

export type CentralBudgetAction =
  | CentralAccountingAction
  | { readonly kind: "open_budget"; readonly expectedSequence: number; readonly budget: CentralLearningBudgetDraft }
  | { readonly kind: "rebudget"; readonly grantId: string; readonly expectedSequence: number;
      /** Explicit source-context handoff at a confirmed boundary; omitted preserves the old ceiling. */
      readonly maxPromptChars?: number;
      readonly limits: CentralLearningResources; readonly authorizationRef: string; readonly planRef: string }
  | { readonly kind: "close_investment"; readonly grantId: string; readonly expectedSequence: number;
      readonly reason: string; readonly authorizationRef: string; readonly planRef: string };

export type CentralBudgetProjection = {
  readonly budget: CentralLearningBudget; readonly occupied: CentralLearningResources; readonly available: CentralLearningResources;
  readonly status: "available" | "exhausted" | "held";
  readonly holdReason?: "model_cap_violated" | "budget_overcommitted";
  /** These older, independently authorized purses are deliberately outside this budget. */
  readonly historicalExternalGrantIds: readonly string[];
};

export const MAX_CENTRAL_LEARNING_BUDGETS = 64;
