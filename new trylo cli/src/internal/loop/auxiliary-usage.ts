import type { SummaryAuthoringContext, SummaryRequestUsage } from "../ports/compaction.js";
import { accumulateUsage, emptyUsage, type ProviderUsage } from "../ports/provider.js";
import { evaluateBudget, streamCostUsd, type BudgetVerdict, type IterationBudget, type UsagePricing } from "../domain/iteration.js";

/** An observation ledger, not an independently spendable allowance. */
export type AuxiliaryUsageLedger = { usage: ProviderUsage; readonly requests: SummaryRequestUsage[] };

export function createAuxiliaryUsageLedger(): AuxiliaryUsageLedger { return { usage: emptyUsage(), requests: [] }; }

export function recordAuxiliaryUsage(ledger: AuxiliaryUsageLedger, receipt: SummaryRequestUsage): void {
  ledger.requests.push(receipt);
  if (receipt.usage !== undefined) ledger.usage = accumulateUsage(ledger.usage, receipt.usage);
}

/** Context and pre-incremented main iterations do not own spending decisions. */
export function spendingVerdict(usage: ProviderUsage, costUsd: number, budget: IterationBudget): BudgetVerdict {
  return evaluateBudget({ iterations: 0, promptTokens: 0, outputTokens: usage.outputTokens, costUsd }, {
    ...(budget.maxOutputTokens === undefined ? {} : { maxOutputTokens: budget.maxOutputTokens }),
    ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd }),
  });
}

export function auxiliarySpendingUnavailable(ledger: AuxiliaryUsageLedger, budget: IterationBudget): boolean {
  return (budget.maxOutputTokens !== undefined || budget.maxCostUsd !== undefined)
    && ledger.requests.some(receipt => receipt.usageStatus !== "reported");
}

export function authoringContext(usage: ProviderUsage, budget: IterationBudget,
  reportRequest: SummaryAuthoringContext["reportRequest"]): SummaryAuthoringContext {
  return { reportRequest, ...(budget.maxOutputTokens === undefined ? {}
    : { maxOutputTokens: Math.max(0, budget.maxOutputTokens - usage.outputTokens) }) };
}

export function auxiliaryUsageFields(ledger: AuxiliaryUsageLedger, mainUsage: ProviderUsage) {
  return ledger.requests.length === 0 ? {} : { mainUsage, auxiliaryUsage: ledger.usage,
    auxiliaryRequests: [...ledger.requests], auxiliaryUsageStatus: ledger.requests.every(receipt => receipt.usageStatus === "reported")
      ? "reported" as const : "partial" as const };
}

export type ParentUsageAccounting = {
  readonly mainUsage?: ProviderUsage;
  readonly auxiliaryUsage?: ProviderUsage;
  readonly auxiliaryRequests?: readonly SummaryRequestUsage[];
  readonly auxiliaryUsageStatus?: "reported" | "partial";
  readonly costUsd?: number;
};

export type ParentUsageState = { usage: ProviderUsage; mainUsage: ProviderUsage; auxiliary: AuxiliaryUsageLedger;
  costUsd: number; readonly pricing?: UsagePricing };

export function createParentUsageState(pricing?: UsagePricing): ParentUsageState {
  return { usage: emptyUsage(), mainUsage: emptyUsage(), auxiliary: createAuxiliaryUsageLedger(), costUsd: 0,
    ...(pricing === undefined ? {} : { pricing }) };
}

function chargeUsage(state: ParentUsageState, usage: ProviderUsage): void {
  state.usage = accumulateUsage(state.usage, usage);
  state.costUsd += streamCostUsd(usage, state.pricing);
}

export function recordMainUsage(state: ParentUsageState, usage: ProviderUsage): void {
  state.mainUsage = accumulateUsage(state.mainUsage, usage);
  chargeUsage(state, usage);
}

export function chargeAuxiliaryUsage(state: ParentUsageState, receipt: SummaryRequestUsage): void {
  recordAuxiliaryUsage(state.auxiliary, receipt);
  if (receipt.usage !== undefined) chargeUsage(state, receipt.usage);
}

export function parentUsageFields(state: ParentUsageState): ParentUsageAccounting {
  return { ...auxiliaryUsageFields(state.auxiliary, state.mainUsage),
    ...(state.pricing === undefined ? {} : { costUsd: state.costUsd }) };
}
