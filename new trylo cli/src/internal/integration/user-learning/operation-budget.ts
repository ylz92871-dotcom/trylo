import type { CentralAccountingReservation } from "../../learning/control/central-accounting-contract.js";
import { centralAccountingSpent } from "../../learning/control/central-accounting-state.js";
import { sha256Hex, shortId } from "../../learning/domains/shared/hash.js";

export type UserOperationCallIdentity = {
  readonly namespace: string;
  readonly logicalCallHash: string;
  readonly reservationId: string;
  readonly legacyReservationId: string;
};

/** Operation names bound a lifetime envelope; logical call names deliberately
 * exclude that envelope so replacing an operation cannot replay the same state. */
export function userOperationCallIdentity(input: { readonly operationRef: string; readonly questionRef: string;
  readonly sourcePrefixRef: string; readonly step: number; readonly nextAction: string }): UserOperationCallIdentity {
  const namespace = operationNamespace(input.operationRef);
  const parts = [input.questionRef, input.sourcePrefixRef, String(input.step), input.nextAction];
  const logicalCallHash = sha256Hex(JSON.stringify(parts));
  return { namespace, logicalCallHash, reservationId: `${namespace}${logicalCallHash}`,
    legacyReservationId: shortId("user-learning-call", parts) };
}

export type UserOperationBudgetInput = {
  /** Canonical rows from the original root, not a local spending counter. */
  readonly reservations: readonly CentralAccountingReservation[];
  readonly ownerId: string;
  readonly operationRef: string;
  readonly maxTotalTokens: number;
  readonly maxCalls: number;
  readonly logicalCall?: Pick<UserOperationCallIdentity, "logicalCallHash"> & { readonly legacyReservationId?: string };
};

export type UserOperationBudget = {
  readonly spent: { readonly tokens: number; readonly calls: number };
  readonly remaining: { readonly tokens: number; readonly calls: number };
  readonly hasOperationReservation: boolean;
  readonly hasUncertainOperationReservation: boolean;
  readonly hasLogicalCallReservation: boolean;
};

/** Read-only projection. Reported actuals use the canonical accounting rule;
 * pending/unknown reservations retain their cap and every reservation keeps its
 * call charge. No reservation is evidence of an unsent operation, while a
 * confirmed zero-token bill still consumed a call and must remain distinguishable. */
export function projectUserOperationBudget(input: UserOperationBudgetInput): UserOperationBudget {
  const owned = input.reservations.filter(row => row.owner.kind === "user_learning" && row.owner.ownerId === input.ownerId);
  const namespace = operationNamespace(input.operationRef);
  const operation = owned.filter(row => row.reservationId.startsWith(namespace));
  const spent = centralAccountingSpent(operation);
  const logicalCall = input.logicalCall;

  return { spent: { tokens: spent.tokens, calls: spent.calls },
    remaining: { tokens: Math.max(0, input.maxTotalTokens - spent.tokens), calls: Math.max(0, input.maxCalls - spent.calls) },
    hasOperationReservation: operation.length > 0,
    hasUncertainOperationReservation: operation.some(row => row.state === "reserved" || row.usage.kind === "unknown"),
    hasLogicalCallReservation: logicalCall !== undefined && owned.some(row =>
      row.reservationId === logicalCall.legacyReservationId
      || /^user-op:[0-9a-f]{64}:[0-9a-f]{64}$/u.test(row.reservationId)
        && row.reservationId.endsWith(`:${logicalCall.logicalCallHash}`)),
  };
}

function operationNamespace(operationRef: string): string {
  return `user-op:${sha256Hex(operationRef)}:`;
}
