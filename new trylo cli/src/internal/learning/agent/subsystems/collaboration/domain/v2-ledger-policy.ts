import { contentHashOf } from "../../../../control/hash.js";
import type { CollaborationCycleV2 } from "./v2-contracts.js";

/** A reported total replaces this call's reservation, including genuine overrun; unknown usage keeps it charged. */
export function settleReservedUsageV2(reserved: CollaborationCycleV2, reservedTokens: number, usage: CollaborationCycleV2["usage"]) {
  const modelTokens = reserved.spent.modelTokens - reservedTokens
    + (usage?.status === "reported" && usage.totalTokens !== undefined ? usage.totalTokens : reservedTokens);
  return { accounting: { spent: { ...reserved.spent, modelTokens }, ...(usage === undefined ? {} : { usage }) },
    overrun: modelTokens > reserved.grant.maxModelTokens };
}

/** Reservations precede model calls. An interrupted reservation remains charged until an actual usage receipt settles it. */
export function cycleTransitionValid(history: readonly CollaborationCycleV2[], next: CollaborationCycleV2): boolean {
  const previous = history.at(-1);
  if (previous === undefined) return next.phase === "running" && next.step === 0
    && next.spent.steps === 0 && next.spent.modelCalls === 0 && next.spent.modelTokens === 0;

  if (previous.requestId !== next.requestId || previous.scope !== next.scope || contentHashOf(previous.grant) !== contentHashOf(next.grant)
    || ["completed", "cancelled"].includes(previous.phase) || next.cursor < previous.cursor) return false;

  if (previous.phase === "waiting_evidence") return next.phase === "running" && next.step === previous.step && next.cursor === previous.cursor
    && contentHashOf(next.spent) === contentHashOf(previous.spent);

  if (next.spent.steps > next.grant.maxSteps || next.spent.modelCalls > next.grant.maxModelCalls
    || (next.spent.modelTokens > next.grant.maxModelTokens && next.phase !== "failed")) return false;

  if (next.phase === "reserved") return previous.phase === "running" && next.step === previous.step + 1
    && next.spent.steps === previous.spent.steps + 1 && next.spent.modelCalls === previous.spent.modelCalls + 1
    && next.spent.modelTokens > previous.spent.modelTokens && next.cursor === previous.cursor
    && next.claimOwner !== undefined && next.claimExpiresAt !== undefined && Date.parse(next.claimExpiresAt) > Date.parse(next.recordedAt);

  if (next.step !== previous.step || next.spent.steps !== previous.spent.steps || next.spent.modelCalls !== previous.spent.modelCalls) return false;

  if (previous.phase !== "reserved") return previous.phase === "running" && next.spent.modelTokens === previous.spent.modelTokens;

  const beforeReservation = history.slice(0, -1).reverse().find(item => item.phase === "running");
  if (beforeReservation === undefined) return false;

  const expected = next.usage?.status === "reported" && next.usage.totalTokens !== undefined
    ? beforeReservation.spent.modelTokens + next.usage.totalTokens : previous.spent.modelTokens;

  return next.spent.modelTokens === expected;
}
