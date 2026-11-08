import type { CollaborationResourceReceipt } from "../../protocol/collaboration-resource.js";
import { contentHashOf } from "./hash.js";
import type { CentralLearningReservation } from "./coordination-contract.js";

/** Exact paid decision identity; it does not infer a response from a token counter. */
export function collaborationQueryMatchesReservation(query: CollaborationResourceReceipt, reservation: CentralLearningReservation): boolean {
  if (query.phase !== "resource_query") return false;
  const prefix = `collaboration-decision:${reservation.claimId}:`, step = reservation.reservationId.slice(prefix.length);
  return reservation.reservationId.startsWith(prefix) && /^(0|[1-9]\d*)$/.test(step) && Number.isSafeInteger(Number(step))
    && query.requestId === `collaboration-resource:${contentHashOf([reservation.claimId, Number(step),
      { kind: "query", owner: query.owner, query: query.query }])}`;
}

/** A resource result has one exact host-recorded query; matching does not imply present availability. */
export function collaborationResourceResultMatches(query: CollaborationResourceReceipt, result: CollaborationResourceReceipt): boolean {
  return query.phase === "resource_query" && result.phase === "resource_result" && query.scope === result.scope
    && query.requestId === result.requestId && query.owner === result.owner && query.issueId === result.issueId
    && query.jobId === result.jobId && query.grantId === result.grantId && query.query === result.query
    && contentHashOf(query.boundary) === contentHashOf(result.boundary);
}
