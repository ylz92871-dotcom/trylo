import type { RewardV2Draft } from "../reward/v2-facts.js";
import type { BoardState } from "./state.js";
import type { CentralLearningGrant, CoordinateLearningCommand } from "./coordination-contract.js";
import type { CollaborationFailureContinuation } from "./collaboration-failure-continuation-contract.js";
import { isCollaborationIncompleteModelFailure } from "./collaboration-failure-continuation-contract.js";
import { isCoordinationAction } from "./coordination-parse.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { canonicalJson, contentHashOf } from "./hash.js";

const ALGORITHM = "collaboration-incomplete-continuation/v1";
type Command = CoordinateLearningCommand & { readonly action: Extract<CoordinateLearningCommand["action"], { kind: "resume_incomplete" }> };

/** Uses the existing opaque fact envelope; old readers retain the original grant schema. */
export function buildCollaborationFailureContinuation(command: Command, scope: string,
  failureReason: CollaborationFailureContinuation["failureReason"]): RewardV2Draft {
  const body = { schema: ALGORITHM, action: command.action, failureReason, continuedAt: command.issuedAt,
    commandId: command.commandId, sequence: command.action.expectedSequence + 2 };
  return { id: `collaboration-failure-continuation:${contentHashOf(body)}`, scope,
    algorithmVersion: ALGORITHM, kind: "learning_decision", payloadJson: canonicalJson(body) };
}

/** Only a sealed original resume command can make an incomplete step resumable. */
export function readCollaborationFailureContinuations(state: BoardState, grant: CentralLearningGrant,
  issueRevision: number): readonly CollaborationFailureContinuation[] {
  return (state.rewardV2Facts ?? []).flatMap(fact => {
    if (fact.scope !== grant.scope || fact.algorithmVersion !== ALGORITHM || fact.kind !== "learning_decision") return [];
    let body: unknown;
    try { body = JSON.parse(fact.payloadJson); } catch { return []; }
    if (!fields(body, ["schema", "action", "failureReason", "continuedAt", "commandId", "sequence"])
      || body.schema !== ALGORITHM || !isCoordinationAction(body.action) || body.action.kind !== "resume_incomplete"
      || !isCollaborationIncompleteModelFailure(body.failureReason) || !identity(body.commandId)
      || !identity(body.continuedAt) || !Number.isFinite(Date.parse(body.continuedAt)) || !sequence(body.sequence)
      || body.sequence !== fact.sequence + 1 || body.action.expectedSequence !== fact.sequence - 1
      || body.commandId !== `central-learning:${contentHashOf(body.action)}`
      || fact.id !== `collaboration-failure-continuation:${contentHashOf(body)}`) return [];
    const action = body.action;
    if (action.jobId !== grant.jobId || action.grantId !== grant.grantId || action.expectedIssueRevision !== issueRevision
      || action.rootRef.scope !== grant.scope || action.rootRef.budgetId !== grant.budgetId
      || action.rootRef.authorizationRef !== grant.authorizationRef
      || !state.appliedCommands.some(command => command.commandId === body.commandId && command.sequence === body.sequence)) return [];
    const reservation = grant.reservations.find(item => item.reservationId === action.failedReservationId);
    if (reservation?.usage?.kind !== "unknown" || reservation.state !== "settled" || reservation.usage.reason !== body.failureReason) return [];
    return [{ failedReservationId: action.failedReservationId, failureReason: body.failureReason,
      checkpointReceiptId: action.checkpointReceiptId, evidenceRef: action.recoveryRef, issueRevision,
      continuedAt: body.continuedAt, sequence: body.sequence, commandId: body.commandId }];
  });
}
