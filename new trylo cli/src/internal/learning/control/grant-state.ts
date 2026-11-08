import { MAX_LEARNING_GRANT_FACTS, type LearningGrantDraft, type LearningGrantFact, type LearningGrantFailureCode, type LearningGrantSnapshot } from "./grant-contract.js";
import { isLearningGrantFact } from "./grant-parse.js";

export function learningGrantSnapshots(facts: readonly LearningGrantFact[]): ReadonlyMap<string, LearningGrantSnapshot> | undefined {
  const grants = new Map<string, LearningGrantSnapshot>();
  let previousSequence = 0;

  if (facts.length > MAX_LEARNING_GRANT_FACTS) return undefined;

  for (const fact of facts) {
    if (!isLearningGrantFact(fact) || fact.boardSequence <= previousSequence) return undefined;
    const next = advanceLearningGrant(grants.get(fact.grantId), fact);
    if (!next.ok) return undefined;
    grants.set(fact.grantId, next.snapshot);
    previousSequence = fact.boardSequence;
  }

  return grants;
}

export function validLearningGrantFacts(value: unknown, boardSequence: number): value is readonly LearningGrantFact[] {
  return Array.isArray(value) && value.every(isLearningGrantFact) && value.every(fact => fact.boardSequence <= boardSequence)
    && learningGrantSnapshots(value) !== undefined;
}

export function advanceLearningGrant(previous: LearningGrantSnapshot | undefined, fact: LearningGrantDraft):
  { readonly ok: true; readonly snapshot: LearningGrantSnapshot } | { readonly ok: false; readonly reason: LearningGrantFailureCode } {
  if (fact.kind === "open") return previous !== undefined ? failure("learning_grant_conflict") : { ok: true, snapshot: {
    grantId: fact.grantId, workspaceId: fact.workspaceId, sourceRef: fact.sourceRef, allowance: fact.allowance,
    reservations: [], callsReserved: 0, reportedInputTokens: 0, reportedOutputTokens: 0, reportedTotalTokens: 0, status: "open",
  } };

  if (previous === undefined) return failure("learning_grant_not_found");

  if (fact.kind === "reserve") {
    if (previous.closedReason !== undefined) return failure("learning_grant_closed");

    if (previous.reservations.some(item => item.reservationId === fact.reservationId)) return failure("learning_grant_conflict");

    if (previous.status === "unknown" || previous.status === "in_flight") return failure("learning_grant_unsettled");

    if (previous.status === "overrun" || previous.callsReserved >= previous.allowance.maxCalls
      || fact.maxOutputTokens > previous.allowance.maxOutputTokens - previous.reportedOutputTokens) return failure("learning_grant_exhausted");

    return { ok: true, snapshot: { ...previous, callsReserved: previous.callsReserved + 1, status: "in_flight",
      reservations: [...previous.reservations, { reservationId: fact.reservationId, maxOutputTokens: fact.maxOutputTokens, state: "reserved" }] } };
  }

  if (fact.kind === "close") return previous.closedReason !== undefined ? failure("learning_grant_conflict")
    : { ok: true, snapshot: { ...previous, closedReason: fact.reason, status: previous.status === "open" ? "closed" : previous.status } };

  const reservation = previous.reservations.find(item => item.reservationId === fact.reservationId);
  if (reservation?.state !== "reserved") return failure("learning_grant_conflict");

  const reservations = previous.reservations.map(item => item.reservationId !== fact.reservationId ? item : {
    reservationId: item.reservationId, maxOutputTokens: item.maxOutputTokens,
    ...(fact.usage.kind === "reported" ? { state: "reported" as const, usage: fact.usage } : { state: "unknown" as const, usage: fact.usage }),
  });
  const known = reservations.flatMap(item => item.state === "reported" ? [item.usage] : []);
  const reportedOutputTokens = known.reduce((total, usage) => total + usage.outputTokens, 0);
  const overrun = reservations.some(item => item.state === "reported" ? item.usage.outputTokens > item.maxOutputTokens
    : item.state === "unknown" && (item.usage.observed?.outputTokens ?? 0) > item.maxOutputTokens)
    || reportedOutputTokens > previous.allowance.maxOutputTokens;
  const status = overrun ? "overrun" : reservations.some(item => item.state === "unknown") ? "unknown"
    : reservations.some(item => item.state === "reserved") ? "in_flight" : previous.closedReason === undefined ? "open" : "closed";

  return { ok: true, snapshot: { ...previous, reservations, status, reportedOutputTokens,
    reportedInputTokens: known.reduce((total, usage) => total + usage.inputTokens, 0), reportedTotalTokens: known.reduce((total, usage) => total + usage.totalTokens, 0) } };
}

function failure(reason: LearningGrantFailureCode) { return { ok: false as const, reason }; }
