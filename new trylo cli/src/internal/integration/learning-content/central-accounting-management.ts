import type { CentralAccountingAction } from "../../learning/control/central-accounting-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";

/** Explicit administrative authorization only. Never expose this capability to a thinking/worker funding port. */
export function setCentralLearningBudgetLimitAtRoot(options: {
  readonly boardRoot: string; readonly issuedAt: string;
  readonly action: Extract<CentralAccountingAction, { readonly kind: "set_budget_limit" }>;
}) {
  return withBoardWriter(options.boardRoot, store => store.apply({ type: "coordinate_learning", issuedAt: options.issuedAt,
    action: options.action, commandId: `central-budget-management:${contentHashOf(options.action)}` }));
}
