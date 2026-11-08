import type { BoardCommand } from "./commands.js";
import type { AllocationApplicationInput, AllocationApplicationResult, PreparedAllocationApplication } from "./allocation-application-contract.js";
import { prepareAllocationApplication } from "./allocation-application-plan.js";
import { allocationAuditCommand, allocationContextFailure, recoverAllocationPrefix } from "./allocation-application-state.js";
import { centralBudgetProjection } from "./central-budget-state.js";
import { reduce } from "./reducer.js";
import type { BoardState } from "./state.js";
import type { BoardStore } from "./store-port.js";

export type AllocationApplicationOptions = { readonly store: BoardStore; readonly now: () => string; readonly enabled?: () => boolean };

type Pending = { readonly command: BoardCommand; readonly grantId?: string };

type Progress = { readonly confirmedGrantIds: string[]; decisionConfirmed: boolean };

type CapturedSubmission = { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly submit: (options: AllocationApplicationOptions, signal?: AbortSignal) => Promise<AllocationApplicationResult> };

/** Pure preparation once, before taking a Board writer. Prepared mutable data never leaves this closure. */
export function captureLearningAllocation(input: AllocationApplicationInput): CapturedSubmission {
  const capture = prepareAllocationApplication(input);
  if (!capture.ok) return { ok: false, reason: capture.reason };
  const prepared = capture.prepared;
  return Object.freeze({ ok: true, submit: (options: AllocationApplicationOptions, signal?: AbortSignal) =>
    commitCaptured(options, prepared, signal) });
}

/**
 * One bounded funding submission. The host owns the writer lease and readiness bindings.
 * This never dispatches a worker, calls a provider, retries an unknown write, or runs a learning loop.
 */
export async function commitLearningAllocation(options: AllocationApplicationOptions, input: AllocationApplicationInput,
  signal?: AbortSignal): Promise<AllocationApplicationResult> {
  if (options.enabled?.() !== true) return { status: "disabled" };
  if (signal?.aborted) return { status: "cancelled" };
  const capture = captureLearningAllocation(input);
  if (!capture.ok) return { status: "rejected", reason: capture.reason };
  return capture.submit(options, signal);
}

/** Only sealed preparation reaches writes; the live Board, ceilings and exact replay prefix still govern admission. */
async function commitCaptured(options: AllocationApplicationOptions, prepared: PreparedAllocationApplication,
  signal?: AbortSignal): Promise<AllocationApplicationResult> {
  if (options.enabled?.() !== true) return { status: "disabled" };

  if (signal?.aborted) return { status: "cancelled" };

  const issuedAt = options.now();
  let loaded;

  try { loaded = await options.store.load(); } catch { return { status: "rejected", reason: "allocation_board_unavailable" }; }

  if (!loaded.ok) return { status: "rejected", reason: loaded.reason };

  const recovery = recoverAllocationPrefix(loaded.state, prepared, issuedAt);
  if (!recovery.ok) return { status: "rejected", reason: recovery.reason, planId: prepared.proposal.planId };

  if (recovery.recorded && recovery.confirmed === prepared.drafts.length) return { status: "previous", planId: prepared.proposal.planId,
    grantIds: prepared.bindings.map(item => item.grantId), budget: recovery.budget, boardSequence: loaded.state.sequence };

  const contextFailure = allocationContextFailure(loaded.state, prepared, recovery);
  if (contextFailure !== undefined) return { status: contextFailure === "allocation_basis_stale" ? "stale" : "rejected",
    reason: contextFailure, planId: prepared.proposal.planId };

  if (prepared.proposal.offers.length === 0) return { status: "idle", proposal: prepared.proposal };

  const pending: Pending[] = [
    ...(recovery.recorded ? [] : [{ command: allocationAuditCommand(prepared, issuedAt) }]),
    ...prepared.drafts.slice(recovery.confirmed).map((draft, offset) => ({ command: { ...draft, issuedAt },
      grantId: prepared.bindings[recovery.confirmed + offset]!.grantId })),
  ];
  const failure = prevalidate(loaded.state, pending);
  if (failure !== undefined) return { status: "rejected", reason: failure, planId: prepared.proposal.planId };

  const progress: Progress = { confirmedGrantIds: prepared.bindings.slice(0, recovery.confirmed).map(item => item.grantId), decisionConfirmed: recovery.recorded };

  return applyPending(options, prepared, pending, progress, signal);
}

function prevalidate(initial: BoardState, pending: readonly Pending[]): string | undefined {
  let state = initial;

  for (const write of pending) {
    const next = reduce(state, write.command);
    if (!next.ok) return next.reason;
    state = next.state;
  }

  return undefined;
}

async function applyPending(options: AllocationApplicationOptions, prepared: PreparedAllocationApplication,
  pending: readonly Pending[], progress: Progress, signal?: AbortSignal): Promise<AllocationApplicationResult> {
  let last: BoardState | undefined;

  for (const write of pending) {
    if (options.enabled?.() !== true || signal?.aborted) return partial(prepared, progress, "partial", "allocation_submission_stopped");

    let result;

    try { result = await options.store.apply(write.command); }
    catch { return partial(prepared, progress, "unconfirmed", "allocation_write_unconfirmed", write.command.commandId); }

    if (!result.ok) return partial(prepared, progress, "state" in result ? "partial" : "unconfirmed", result.reason, write.command.commandId);

    last = result.state;

    if (write.grantId === undefined) progress.decisionConfirmed = true;
    else progress.confirmedGrantIds.push(write.grantId);
  }

  const budget = last === undefined ? undefined : centralBudgetProjection(last, prepared.proposal.basis.budgetId);

  return budget === undefined || last === undefined ? partial(prepared, progress, "unconfirmed", "allocation_projection_unconfirmed")
    : { status: "committed", planId: prepared.proposal.planId, grantIds: progress.confirmedGrantIds, budget, boardSequence: last.sequence };
}

function partial(prepared: PreparedAllocationApplication, progress: Progress, status: "partial" | "unconfirmed", reason: string,
  commandId?: string): AllocationApplicationResult {
  return { status, planId: prepared.proposal.planId, confirmedGrantIds: [...progress.confirmedGrantIds],
    decisionConfirmed: progress.decisionConfirmed, reason, ...(commandId === undefined ? {} : { commandId }) };
}
