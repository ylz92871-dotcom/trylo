import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { captureLearningAllocation } from "../../learning/control/allocation-application.js";
import type { AllocationApplicationInput, AllocationApplicationResult } from "../../learning/control/allocation-application-contract.js";
import { isCentralLearningBudgetDraft } from "../../learning/control/central-budget-parse.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { centralLearningSpent, type CoordinateLearningCommand, type CoordinationAction } from "../../learning/control/coordination-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardStore } from "../../learning/control/store-port.js";

type Options = { readonly boardRoot: string; readonly now: () => string; readonly enabled?: () => boolean };

type InvestmentControl = { readonly grantId: string; readonly expectedSequence: number; readonly authorizationRef: string };

type ClosedInvestment = InvestmentControl & { readonly reason: string; readonly planRef: string };

const disabled = () => ({ status: "disabled" as const });

/** Thin host entry. No clock, money, model, worker, or learning loop is created implicitly. */
export function createLearningAllocationApplication(options: Options) {
  const enabled = () => options.enabled?.() === true;
  const send = async (store: BoardStore, action: CoordinationAction) => store.apply(command(action, options.now()));

  return Object.freeze({
    async inspect(budgetId: string) {
      if (!enabled()) return disabled();
      const loaded = await createBoardReader(options.boardRoot).load();
      if (!loaded.ok) return { status: "rejected" as const, reason: loaded.reason };
      const budget = centralBudgetProjection(loaded.state, budgetId);
      return budget === undefined ? { status: "rejected" as const, reason: "learning_budget_not_found" }
        : { status: "ready" as const, boardSequence: loaded.state.sequence, budget };
    },

    async openBudget(json: string, expectedSequence: number) {
      if (!enabled()) return disabled();
      const budget = readBudget(json);
      if (budget === undefined) return { status: "rejected" as const, reason: "invalid_learning_budget" };
      return withBoardWriter(options.boardRoot, async store => enabled() ? send(store, { kind: "open_budget", expectedSequence, budget }) : disabled());
    },

    async commit(input: AllocationApplicationInput, signal?: AbortSignal): Promise<AllocationApplicationResult> {
      if (!enabled()) return disabled();

      if (signal?.aborted) return { status: "cancelled" };

      // Pure planning does not hold the process-wide financial writer. Submission still requires the original basis.
      const captured = captureLearningAllocation(input);
      if (!captured.ok) return { status: "rejected", reason: captured.reason };

      if (signal?.aborted) return { status: "cancelled" };

      const result = await withBoardWriter(options.boardRoot, store => captured.submit({ store, now: options.now, enabled }, signal));

      return "ok" in result ? { status: "unconfirmed", confirmedGrantIds: [], decisionConfirmed: false, reason: result.reason } : result;
    },

    async reconcile(input: InvestmentControl) {
      if (!enabled()) return disabled();

      const { grantId, expectedSequence, authorizationRef } = input;

      return withBoardWriter(options.boardRoot, async store => {
        const loaded = await store.load();
        if (!loaded.ok) return loaded;

        if (!enabled()) return disabled();

        const grant = loaded.state.centralLearningGrants?.find(item => item.grantId === grantId);
        if (grant === undefined) return { status: "rejected" as const, reason: "learning_grant_not_found" };

        const limits = centralLearningSpent(grant);
        const planRef = `allocation-reconcile:${contentHashOf({ grantId, expectedSequence, authorizationRef, limits })}`;

        return send(store, { kind: "rebudget", grantId, expectedSequence, authorizationRef, planRef, limits });
      });
    },

    async closeInvestment(input: ClosedInvestment) {
      if (!enabled()) return disabled();
      const action = { kind: "close_investment" as const, grantId: input.grantId, expectedSequence: input.expectedSequence,
        authorizationRef: input.authorizationRef, reason: input.reason, planRef: input.planRef };
      return withBoardWriter(options.boardRoot, async store => enabled() ? send(store, action) : disabled());
    },
  });
}

function command(action: CoordinationAction, issuedAt: string): CoordinateLearningCommand {
  return { type: "coordinate_learning", commandId: `allocation-control:${contentHashOf(action)}`, issuedAt, action };
}

function readBudget(json: string) {
  if (typeof json !== "string" || json.length > 8192) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return undefined; }
  return isCentralLearningBudgetDraft(raw) ? raw : undefined;
}
