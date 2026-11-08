import type { BoardState } from "../../learning/control/state.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";

/** The public budget command and source recovery identify the same native change. */
export const centralBudgetChangeSourceRef = (budgetId: string, changeId: string): string =>
  `central-budget-change:${contentHashOf({ budgetId, changeId })}`;

/** Only the latest committed change is current. Spending, available capacity and
 * the reader's Board prefix are not new source facts and cannot change this body. */
export function latestCentralBudgetChangeSource(board: BoardState, scope: string): {
  readonly sourceRef: string; readonly material: CentralRuntimeMaterial;
} | undefined {
  const roots = (board.centralLearningBudgets ?? []).filter(row => row.scope === scope);
  if (roots.length !== 1) return undefined;

  const root = roots[0]!, change = root.limitChanges?.at(-1);
  if (change === undefined) return undefined;

  const rootRef = { budgetId: root.budgetId, scope: root.scope,
    openedSequence: root.openedSequence, authorizationRef: root.authorizationRef };
  const sourceRef = centralBudgetChangeSourceRef(root.budgetId, change.changeId);
  const text = canonicalJson({ schemaVersion: 1, role: "original_root_budget_limit_change_not_business_evidence", rootRef, change });

  return { sourceRef, material: { ref: `central-runtime-constraint:${contentHashOf(text)}`, kind: "source", text,
    sourceRefs: [root.budgetId, sourceRef] } };
}
