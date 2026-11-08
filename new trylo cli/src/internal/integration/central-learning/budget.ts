import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createLearningAllocationApplication } from "../learning-allocation/application.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import type { CentralLearningAllowance } from "../../learning/control/coordination-contract.js";
import type { CentralLearningBudgetRootRef } from "../../learning/control/central-budget-contract.js";
import { isCentralLearningBudgetRootRef } from "../../learning/control/central-budget-parse.js";

export type CentralBudgetOptions = { readonly boardRoot: string; readonly scope: string;
  readonly allowance: CentralLearningAllowance; readonly authorizationRef: string;
  readonly rootRef?: CentralLearningBudgetRootRef;
  readonly now: () => string; readonly enabled: () => boolean };

/** Reuse the scope's fixed canonical root. Neither a new turn, new process nor a
 * repeated flag can reset spent funds or enlarge an already authorized pool. */
export async function ensureCentralLearningBudget(options: CentralBudgetOptions) {
  if (!options.enabled()) return { ok: false as const, reason: "collect_disabled" };

  const application = createLearningAllocationApplication(options);
  let loaded = await createBoardReader(options.boardRoot).load();
  if (!loaded.ok) return loaded;

  const limits = { tokens: options.allowance.maxTokens, calls: options.allowance.maxCalls, steps: options.allowance.maxSteps };
  const previous = loaded.state.centralLearningBudgets?.find(root => root.scope === options.scope);
  const rootRef = options.rootRef;
  if (rootRef !== undefined && (!isCentralLearningBudgetRootRef(rootRef) || rootRef.scope !== options.scope
    || previous?.budgetId !== rootRef.budgetId || previous.openedSequence !== rootRef.openedSequence
    || previous.authorizationRef !== rootRef.authorizationRef)) {
    return { ok: false as const, reason: "learning_budget_binding" };
  }

  // Only a saved exact identity restores an existing root after explicit administration.
  // A fresh flag without that identity retains the original fixed-authorization check.
  if (rootRef === undefined && previous !== undefined && contentHashOf(previous.limits) !== contentHashOf(limits)) {
    return { ok: false as const, reason: "central_learning_fixed_budget_mismatch" };
  }

  const budgetId = previous?.budgetId ?? `central-runtime:${contentHashOf(options.scope)}`;

  if (previous === undefined) {
    const opened = await application.openBudget(JSON.stringify({ schemaVersion: 1, budgetId, scope: options.scope,
      unit: "total_model_tokens", limits, authorizationRef: options.authorizationRef }), loaded.state.sequence);
    if (!("ok" in opened) || !opened.ok) return { ok: false as const,
      reason: "reason" in opened ? opened.reason : "central_learning_budget_not_opened" };
    loaded = await createBoardReader(options.boardRoot).load();
    if (!loaded.ok) return loaded;
  }

  const projection = centralBudgetProjection(loaded.state, budgetId);

  return projection === undefined ? { ok: false as const, reason: "central_learning_budget_unavailable" }
    : { ok: true as const, board: loaded.state, projection, application, rootRef: {
      budgetId: projection.budget.budgetId, scope: projection.budget.scope, openedSequence: projection.budget.openedSequence,
      authorizationRef: projection.budget.authorizationRef,
    } satisfies CentralLearningBudgetRootRef };
}
