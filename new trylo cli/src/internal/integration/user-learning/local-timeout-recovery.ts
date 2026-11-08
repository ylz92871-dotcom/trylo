import type { CentralAccountingReservation } from "../../learning/control/central-accounting-contract.js";
import type { UserLearningProgress, UserLearningSignal } from "../../learning/domains/user/learning-cycle-contract.js";
import { userOperationCallIdentity } from "./operation-budget.js";

function settledLocalTimeout(row: CentralAccountingReservation, ownerId: string): boolean {
  return row.owner.kind === "user_learning" && row.owner.ownerId === ownerId && row.state === "settled"
    && row.usage.kind === "unknown" && row.usage.reason === "content_model_timeout";
}

/** A failed call can advance its durable step only after its original unknown
 * charge has been retained and acknowledged. Transport loss is not this case. */
export function isAcknowledgedUserLocalTimeout(progress: UserLearningProgress | undefined,
  reservations: readonly CentralAccountingReservation[], ownerId: string): boolean {
  if (progress?.state !== "unknown" || progress.workRef === undefined) return false;

  const namespace = userOperationCallIdentity({ operationRef: progress.workRef, questionRef: progress.questionRef,
    sourcePrefixRef: progress.sourcePrefixRef, step: progress.step, nextAction: progress.nextAction }).namespace;
  const reservationId = progress.committedReservationIds?.at(-1);
  const committed = new Set(progress.committedReservationIds ?? []);

  return reservationId !== undefined && reservationId.startsWith(namespace)
    && !reservations.some(row => row.owner.kind === "user_learning" && row.owner.ownerId === ownerId
      && row.reservationId.startsWith(namespace) && !committed.has(row.reservationId))
    && reservations.some(row => row.reservationId === reservationId && settledLocalTimeout(row, ownerId));
}

/** Compatibility for the removed host-local deadline. This is a failure
 * checkpoint, never a semantic conclusion, consumed evidence, or a refunded bill. */
export function userLocalTimeoutCheckpoint(input: { readonly signal: UserLearningSignal; readonly operationRef: string;
  readonly scopeFingerprint: string; readonly progress?: UserLearningProgress;
  readonly reservations: readonly CentralAccountingReservation[]; readonly ownerId: string; readonly at: number }): UserLearningProgress | undefined {
  const previous = input.progress, step = (previous?.step ?? 0) + 1;
  const identity = userOperationCallIdentity({ operationRef: input.operationRef, questionRef: input.signal.questionRef,
    sourcePrefixRef: input.signal.sourcePrefixRef, step, nextAction: previous?.nextAction ?? input.signal.purpose });
  if (!input.reservations.some(row => row.reservationId === identity.reservationId && settledLocalTimeout(row, input.ownerId))) return undefined;

  return { schemaVersion: 1, questionRef: input.signal.questionRef, sourcePrefixRef: input.signal.sourcePrefixRef,
    scopeFingerprint: input.scopeFingerprint, step, state: "unknown", workRef: input.operationRef,
    understanding: previous?.understanding ?? "尚无可用的用户学习结论。",
    remaining: "原调用被本地超时中断，远端结果与费用未知；原预留费用保留，证据未因失败而消费。",
    nextAction: previous?.nextAction ?? input.signal.purpose,
    consumedEvidenceIds: previous?.consumedEvidenceIds ?? [],
    committedReservationIds: [...(previous?.workRef === input.operationRef ? previous.committedReservationIds ?? [] : []), identity.reservationId],
    ...(previous?.versionId === undefined ? {} : { versionId: previous.versionId }), at: input.at };
}
