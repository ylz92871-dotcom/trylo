import type { CentralBudgetProjection, CentralLearningBudgetRootRef, CentralLearningResources } from "../../learning/control/central-budget-contract.js";
import { isCentralLearningBudgetRootRef, centralBudgetReference } from "../../learning/control/central-budget-parse.js";
import { isCentralLearningResources } from "../../learning/control/central-learning-resources.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import type { CentralRuntimeWake } from "../../adapters/central-learning-runtime/contracts.js";
import type { CliContext } from "./context.js";
import type { StoreLoadResult } from "../../learning/control/store-port.js";

type BudgetCommandScope = { readonly workspaceRoot: string };

export type CentralRuntimeBudgetInput =
  | BudgetCommandScope & { readonly action: "budget_inspect" }
  | BudgetCommandScope & { readonly action: "budget_set_limits"; readonly rootRef: CentralLearningBudgetRootRef;
      readonly expectedSequence: number; readonly changeId: string; readonly limits: CentralLearningResources };

export type CentralRuntimeBudgetView = {
  readonly rootRef: CentralLearningBudgetRootRef;
  readonly boardSequence: number;
  readonly limits: CentralLearningResources;
  readonly occupied: CentralLearningResources;
  readonly available: CentralLearningResources;
  readonly status: CentralBudgetProjection["status"];
  readonly holdReason?: CentralBudgetProjection["holdReason"];
};

export type CentralRuntimeBudgetWake = { readonly status: "sent" | "skipped" | "unconfirmed"; readonly reason?: string };

export type CentralRuntimeBudgetReply = {
  readonly schemaVersion: 1;
  readonly domain: "central_runtime_budget";
} & ({ readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly enabled: boolean; readonly budget: CentralRuntimeBudgetView | null;
      readonly mutation?: "applied" | "duplicate"; readonly wake?: CentralRuntimeBudgetWake });

export type CentralRuntimeBudgetNotice = {
  readonly ctx: CliContext;
  readonly workspaceRoot: string;
  readonly rootRef: CentralLearningBudgetRootRef;
  readonly wake: CentralRuntimeWake;
};

export type CentralRuntimeBudgetDependencies = {
  /** Read-boundary fault seam. Omitted production calls use the original Board reader. */
  readonly readBoard?: (boardRoot: string) => Promise<StoreLoadResult>;
  /** Notify the original live owner only. This callback must not resume, attach,
   * start, or enable one; the host's source-notification helper owns transport. */
  readonly notifyExistingEnabled: (input: CentralRuntimeBudgetNotice) => Promise<
    { readonly ok: true; readonly notified: boolean } | { readonly ok: false; readonly reason: string }>;
};

/** A local user command supplies limits and a stable change identity. It never
 * supplies a funding capability, arbitrary Board action or authorization ref. */
export function readCentralRuntimeBudgetInput(value: unknown): CentralRuntimeBudgetInput | undefined {
  if (fields(value, ["workspaceRoot", "action"]) && identity(value.workspaceRoot) && value.action === "budget_inspect") {
    return { workspaceRoot: value.workspaceRoot, action: value.action };
  }

  if (!fields(value, ["workspaceRoot", "action", "rootRef", "expectedSequence", "changeId", "limits"])
    || !identity(value.workspaceRoot) || value.action !== "budget_set_limits" || !isCentralLearningBudgetRootRef(value.rootRef)
    || !sequence(value.expectedSequence) || !centralBudgetReference(value.changeId) || !isCentralLearningResources(value.limits)) return undefined;

  return { workspaceRoot: value.workspaceRoot, action: value.action, rootRef: value.rootRef,
    expectedSequence: value.expectedSequence, changeId: value.changeId, limits: value.limits };
}
