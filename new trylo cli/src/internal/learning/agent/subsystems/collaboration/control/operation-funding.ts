import { centralLearningSpent, type CentralLearningAllowance, type CentralLearningGrant } from "../../../../control/coordination-contract.js";
import type { CentralFundingPort } from "./contracts.js";

/** A view of this claim's operation, never a second balance or a replacement grant. */
export function createCollaborationOperationFunding(original: CentralFundingPort, claimId: string, allowance: CentralLearningAllowance): CentralFundingPort {
  let reservationTail = Promise.resolve();
  const remaining = (grant: CentralLearningGrant, available: { readonly tokens: number; readonly calls: number; readonly steps: number }) => {
    const reservations = grant.reservations.filter(item => item.claimId === claimId);
    const spent = centralLearningSpent({ ...grant, reservations, steps: reservations.length });
    return { tokens: Math.min(available.tokens, Math.max(0, allowance.maxTokens - spent.tokens)),
      calls: Math.min(available.calls, Math.max(0, allowance.maxCalls - spent.calls)),
      steps: Math.min(available.steps, Math.max(0, allowance.maxSteps - spent.steps)) };
  };

  return {
    async inspect() {
      const state = await original.inspect();
      return state.ok ? { ...state, remaining: remaining(state.grant, state.remaining) } : state;
    },
    async reserve(input) {
      const previousReservation = reservationTail;
      let release!: () => void;

      reservationTail = new Promise<void>(resolve => { release = resolve; });
      await previousReservation;

      try {
        const state = await original.inspect();
        if (!state.ok) return state;

        if (!state.active) return { ok: false, reason: "learning_inactive" };

        const previous = state.grant.reservations.find(item => item.reservationId === input.reservationId);
        const available = remaining(state.grant, state.remaining);
        if (previous === undefined && (available.calls < 1 || available.steps < 1 || input.maxTokens > available.tokens)) {
          return { ok: false, reason: "learning_operation_exhausted" };
        }

        const reserved = await original.reserve(input);

        return reserved.ok ? { ...reserved, remaining: remaining(reserved.grant, reserved.remaining) } : reserved;
      } finally { release(); }
    },
    async settle(input) { const settled = await original.settle(input);
      return settled.ok ? { ...settled, remaining: remaining(settled.grant, settled.remaining) } : settled; },
  };
}
